import { createSoup, place, stats, snapshot, coords } from './soup.js';
import { createScheduler } from './scheduler.js';
import { createMockEngine } from './engine-mock.js';
import { createWebLLMEngine, MODELS, describeAdapter } from './engine-webllm.js';
import { createView } from './view.js';
import { estimateTokens } from './tokens.js';

const $ = id => document.getElementById(id);

const opts = { maxTokens: 300, temperature: 0.7, noise: 0, ticksPerFrame: 20 };
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
    console.error('[soup] engine load failed', e.name, err);
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

function describe(ev) {
  if (!ev.effects.length) return `t${ev.tick}: no action`;
  return `t${ev.tick}: ` + ev.effects.map(e =>
    `${e.verb} ${e.target}${e.target === 'self' ? '' : ` (${e.x}, ${e.y})`}` +
    (e.ok === false ? ' [no match]' : '') + (e.mutated ? ' [mutated]' : '') + (e.overwrote && e.verb === 'place' ? ' [overwrote]' : '')
  ).join(', ');
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
  $('output').textContent = describe(ev) + usageText(ev.usage) + '\n\n' + ev.out;
}

// Echo fidelity. Put the current ancestor alone in a scratch grid, give it one turn with
// the real engine, and report what it did and how faithfully it reproduced its text.
async function probe() {
  if (busy || running) return;
  setBusy(true);
  $('probe-v').textContent = 'running';
  try {
    const md = ancestor();
    const scratch = createSoup(3, 3);
    place(scratch, 1, 1, md);
    const sc = createScheduler(scratch, engine, opts);
    const t0 = performance.now();
    const ev = await sc.step();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const exact = ev.text === md;
    const sim = similarity(md, ev.text);
    const fidelity = exact ? 'exact' : `${(sim * 100).toFixed(0)}% of lines kept`;
    $('probe-v').textContent = `${fidelity}, ${ev.effects.length} call${ev.effects.length === 1 ? '' : 's'}, ${secs}s`;
    $('cell-head').textContent = `probe: echo ${fidelity}${usageText(ev.usage)}  ${secs}s`;
    $('genome').value = md;
    $('output').textContent = describe(ev) + '\n\n' + ev.out;
  } finally {
    setBusy(false);
  }
}

// Fraction of the original's lines that appear verbatim in the copy.
function similarity(original, copy) {
  const lines = original.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return 0;
  const have = new Set(copy.split('\n').map(l => l.trim()));
  return lines.filter(l => have.has(l)).length / lines.length;
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
  $('gpu').textContent = navigator.gpu ? `gpu: ${await describeAdapter()}` : 'gpu: WebGPU not available in this browser';
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
window.__soup = { get engine() { return engine; }, get soup() { return soup; }, get sched() { return sched; }, opts };
