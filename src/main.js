import { createSoup, place, stats, snapshot, coords } from './soup.js';
import { createScheduler, renderObs } from './scheduler.js';
import { parseAction, ACTION_SCHEMA } from './parse.js';
import { createMockEngine } from './engine-mock.js';
import { createWebLLMEngine, MODELS } from './engine-webllm.js';
import { createView } from './view.js';
import { estimateTokens } from './tokens.js';

const $ = id => document.getElementById(id);

const opts = { maxTokens: 60, temperature: 0.7, noise: 0.002, ticksPerFrame: 20 };
let soup, engine, sched, running = false, busy = false;
let inFlight = null;   // the turn currently awaiting the model, if any

const view = createView($('grid'), () => soup, {
  onSelect: showCell,
  getActive: () => (sched ? sched.active : null),
});

const ancestor = () => $('ancestor').value.trim();

async function makeEngine(name) {
  const e = name === 'mock'
    ? createMockEngine()
    : createWebLLMEngine(name, { onProgress: t => { $('status').textContent = t; } });
  setBusy(true);
  $('status').textContent = `loading ${e.name}`;
  try {
    await e.load();
    $('status').textContent = e.gpu ? `${e.name} on ${e.gpu}` : e.name;
    return e;
  } catch (err) {
    $('status').textContent = `${e.name}: ${err.message}`;
    $('engine').value = 'mock';
    return createMockEngine();
  } finally {
    setBusy(false);
  }
}

function setBusy(b) {
  $('status').dataset.busy = b ? '1' : '';
  busy = b;
  for (const id of ['run', 'step', 'reset', 'probe', 'engine', 'size']) $(id).disabled = b;
}

function reset() {
  const n = Number($('size').value);
  soup = createSoup(n, n);
  place(soup, Math.floor(n / 2), Math.floor(n / 2), ancestor());
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

function usageText(u) {
  return u ? `  (${u.prompt_tokens} in, ${u.completion_tokens} out)` : '';
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
  const a = ev.act;
  const head = a
    ? `t${ev.tick}: ${a.action} ${a.dir} to (${a.x}, ${a.y})${a.mutated ? ' [mutated]' : ''}${a.overwrote ? ' [overwrote]' : ''}`
    : `t${ev.tick}: no valid action`;
  $('output').textContent = head + usageText(ev.usage) + '\n\n' + ev.out;
}

// Run the current ancestor a few times against a neighbourhood with one empty cell and
// report whether it produces a valid action and whether it chose that cell. The tuning loop.
async function probe() {
  if (busy || running) return;
  setBusy(true);
  const md = ancestor();
  const obs = { x: 6, y: 6, empty: ['S'], occupied: ['N', 'E', 'W'], example: ['E', 'W'] };
  const K = 3;
  let valid = 0, right = 0;
  const acts = [];
  try {
    for (let k = 0; k < K; k++) {
      $('probe-v').textContent = `${k + 1}/${K}`;
      const out = await engine.complete({ system: md, user: renderObs(obs), obs, schema: ACTION_SCHEMA, maxTokens: opts.maxTokens, temperature: opts.temperature });
      const a = parseAction(out);
      if (a) valid++;
      if (a && a.dir === 'S') right++;
      acts.push(a ? `${a.action} ${a.dir}${a.action === 'write' ? ` "${a.text}"` : ''}` : `invalid: ${out.slice(0, 60)}`);
      $('cell-head').textContent = `probe: ${valid}/${k + 1} valid, ${right}/${k + 1} chose the empty cell${usageText(engine.lastUsage)}`;
      $('genome').value = md;
      $('output').textContent = renderObs(obs) + '\n\n' + acts.join('\n');
    }
  } finally {
    $('probe-v').textContent = `${valid}/${K} valid, ${right}/${K} right`;
    setBusy(false);
  }
}

// Yields on a timer, not requestAnimationFrame, so a soup left running in a background
// tab keeps running (throttled, but alive).
const yieldToBrowser = () => new Promise(r => setTimeout(r, 0));

async function loop() {
  while (running) {
    const per = engine.instant ? opts.ticksPerFrame : 1;
    for (let k = 0; k < per && running; k++) {
      inFlight = sched.step();
      view.draw();   // show the working mark now, even where animation frames are paused
      const ev = await inFlight.finally(() => { inFlight = null; });
      if (!ev) { running = false; $('status').textContent = 'soup is dead'; break; }
    }
    view.draw();
    showStats();
    if (view.selected !== null) showCell(view.selected);
    await yieldToBrowser();
  }
  $('run').textContent = 'Run';
}

// Stop the loop and wait for any turn already at the model, so a reset or engine swap
// never races a write landing in the old soup or leaves a second loop running.
async function stop() {
  running = false;
  $('run').textContent = 'Run';
  await settle();
}

async function settle() {
  if (!inFlight) return;
  setBusy(true);
  try { await inFlight; } catch {} finally { setBusy(false); }
}

function bind(id, key) {
  const el = $(id);
  const out = $(id + '-v');
  const apply = () => { opts[key] = Number(el.value); if (out) out.textContent = el.value; };
  el.addEventListener('input', apply);
  apply();
}

async function init() {
  for (const m of MODELS) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = m.replace(/-(Instruct-)?q\w+-MLC$/, '');
    $('engine').appendChild(o);
  }
  $('ancestor').value = (await (await fetch('./ancestor.md')).text()).trim();
  bind('temperature', 'temperature');
  bind('slice', 'maxTokens');
  bind('noise', 'noise');
  bind('tpf', 'ticksPerFrame');
  engine = await makeEngine($('engine').value);
  reset();

  $('run').addEventListener('click', async () => {
    if (busy) return;
    if (running) { running = false; $('run').textContent = 'Run'; return; }
    await settle();
    running = true;
    $('run').textContent = 'Pause';
    loop();
  });
  $('step').addEventListener('click', async () => {
    if (running || busy) return;
    setBusy(true);
    try {
      inFlight = sched.step();
      view.draw();
      const ev = await inFlight.finally(() => { inFlight = null; });
      view.draw();
      showStats();
      if (ev) view.select(ev.y * soup.w + ev.x);
    } finally {
      setBusy(false);
    }
  });
  $('probe').addEventListener('click', probe);
  $('reset').addEventListener('click', async () => { await stop(); reset(); });
  $('size').addEventListener('change', async () => { await stop(); reset(); });
  $('engine').addEventListener('change', async () => {
    await stop();
    engine = await makeEngine($('engine').value);
    reset();
  });
  $('export').addEventListener('click', () => {
    const blob = new Blob([snapshot(soup)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `soup-t${soup.tick}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  window.addEventListener('resize', () => view.draw());
  requestAnimationFrame(animate);
}

// Redraw only while a cell is at the model, so the working mark turns.
function animate() {
  if (sched && sched.active !== null) view.draw();
  requestAnimationFrame(animate);
}

init();

// Debug hook for in-page experiments (ancestor tuning from the console).
window.__soup = { get engine() { return engine; }, get soup() { return soup; }, opts };
