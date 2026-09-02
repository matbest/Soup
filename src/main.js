import { createSoup, place, stats, snapshot, coords } from './soup.js';
import { createScheduler } from './scheduler.js';
import { createMockEngine } from './engine-mock.js';
import { createWebLLMEngine } from './engine-webllm.js';
import { createView } from './view.js';
import { estimateTokens } from './tokens.js';

const $ = id => document.getElementById(id);

const opts = { maxTokens: 150, temperature: 0.7, ticksPerFrame: 20 };
let ancestor = '';
let soup, engine, sched, running = false;

const view = createView($('grid'), () => soup, { onSelect: showCell });

async function makeEngine(name) {
  const e = name === 'webllm' ? createWebLLMEngine() : createMockEngine();
  $('status').textContent = `loading ${e.name}`;
  try {
    await e.load();
    $('status').textContent = e.name;
    return e;
  } catch (err) {
    $('status').textContent = err.message;
    return createMockEngine();
  }
}

function reset() {
  const n = Number($('size').value);
  soup = createSoup(n, n);
  place(soup, Math.floor(n / 2), Math.floor(n / 2), ancestor);
  sched = createScheduler(soup, engine, opts);
  view.clear();
  view.draw();
  showStats();
  showCell(null);
}

function showStats() {
  const s = stats(soup);
  $('stats').textContent =
    `tick ${s.tick}   sweep ${s.sweep}\n` +
    `occupied ${s.occupied}/${s.total}   genomes ${s.distinct}   dominant ${s.dominant}\n` +
    `mean length ${s.meanLen.toFixed(0)} chars, about ${Math.ceil(s.meanLen / 4)} tokens\n` +
    `fail rate ${(s.failRate * 100).toFixed(1)}%`;
}

function showCell(i) {
  if (i === null) { $('cell-head').textContent = 'click a cell'; $('genome').value = ''; $('output').textContent = ''; return; }
  const c = soup.cells[i];
  const [x, y] = coords(soup, i);
  if (c.md === null) { $('cell-head').textContent = `(${x}, ${y}) empty`; $('genome').value = ''; $('output').textContent = ''; return; }
  $('cell-head').textContent = `(${x}, ${y})  gen ${c.gen}  born t${c.born}  turns ${c.turns}  fails ${c.fails}  ${c.md.length} chars, about ${estimateTokens(c.md)} tokens`;
  $('genome').value = c.md;
  const ev = c.last;
  if (!ev) { $('output').textContent = 'has not taken a turn yet'; return; }
  const head = ev.write
    ? `t${ev.tick}: wrote ${ev.write.dir} to (${ev.write.x}, ${ev.write.y})${ev.write.mutated ? ' [mutated]' : ''}${ev.write.overwrote ? ' [overwrote]' : ''}`
    : `t${ev.tick}: no valid WRITE`;
  $('output').textContent = head + '\n\n' + ev.out;
}

// Yields on a timer, not requestAnimationFrame, so a soup left running in a background
// tab keeps running (throttled, but alive).
const yieldToBrowser = () => new Promise(r => setTimeout(r, 0));

async function loop() {
  while (running) {
    const per = engine.instant ? opts.ticksPerFrame : 1;
    for (let k = 0; k < per && running; k++) {
      const ev = await sched.step();
      if (!ev) { running = false; $('status').textContent = 'soup is dead'; break; }
    }
    view.draw();
    showStats();
    if (view.selected !== null) showCell(view.selected);
    await yieldToBrowser();
  }
  $('run').textContent = 'Run';
}

function bind(id, key) {
  const el = $(id);
  const out = $(id + '-v');
  const apply = () => { opts[key] = Number(el.value); if (out) out.textContent = el.value; };
  el.addEventListener('input', apply);
  apply();
}

async function init() {
  ancestor = (await (await fetch('./ancestor.md')).text()).trim();
  bind('temperature', 'temperature');
  bind('slice', 'maxTokens');
  bind('tpf', 'ticksPerFrame');
  engine = await makeEngine($('engine').value);
  reset();

  $('run').addEventListener('click', () => {
    running = !running;
    $('run').textContent = running ? 'Pause' : 'Run';
    if (running) loop();
  });
  $('step').addEventListener('click', async () => {
    if (running) return;
    const ev = await sched.step();
    view.draw();
    showStats();
    if (ev) view.select(ev.y * soup.w + ev.x);
  });
  $('reset').addEventListener('click', () => { running = false; reset(); });
  $('size').addEventListener('change', () => { running = false; reset(); });
  $('engine').addEventListener('change', async () => { running = false; engine = await makeEngine($('engine').value); reset(); });
  $('export').addEventListener('click', () => {
    const blob = new Blob([snapshot(soup)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `soup-t${soup.tick}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  window.addEventListener('resize', () => view.draw());
}

init();
