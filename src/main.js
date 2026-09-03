import { createSoup, place, stats, snapshot, coords } from './soup.js';
import { createScheduler, prompt } from './scheduler.js';
import { MANUAL } from './actions.js';
import { createMockEngine } from './engine-mock.js';
import { createWebLLMEngine, MODELS, describeAdapter } from './engine-webllm.js';
import { createView } from './view.js';
import { estimateTokens } from './tokens.js';

const $ = id => document.getElementById(id);

const opts = { maxTokens: 300, temperature: 0.7, noise: 0, ticksPerFrame: 20 };
let soup, engine, sched, running = false, busy = false;
let inFlight = null;   // the turn currently awaiting the model, if any

const view = createView($('grid'), () => soup, {
  onSelect: i => { showCell(i); showTab('cell'); },
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
    (e.ok === false ? ' [no effect]' : '') + (e.mutated ? ' [mutated]' : '') + (e.overwrote && e.verb === 'place' ? ' [overwrote]' : '')
  ).join(', ');
}

// The cell tab shows exactly what the model receives for this cell, as it stands now:
// the expanded messages, nothing else. Then its last reply, and the raw document folded away.
function showCell(i) {
  const clear = head => { $('cell-head').textContent = head; $('prompt').textContent = ''; $('genome').textContent = ''; $('output').textContent = ''; };
  if (i === null) { clear('click a cell on the grid'); return; }
  const c = soup.cells[i];
  const [x, y] = coords(soup, i);
  if (c.md === null) { clear(`(${x}, ${y}) empty`); return; }
  $('cell-head').textContent = `(${x}, ${y})  gen ${c.gen}  born t${c.born}  turns ${c.turns}  fails ${c.fails}  ${c.md.length} chars, about ${estimateTokens(c.md)} tokens`;
  $('prompt').textContent = renderMessages(prompt(soup, x, y, c.md, opts).messages);
  $('genome').textContent = c.md;
  const ev = c.last;
  $('output').textContent = ev ? describe(ev) + usageText(ev.usage) + '\n\n' + ev.out : 'has not taken a turn yet';
}

function renderMessages(messages) {
  return messages.map(m => `[${m.role}]\n${m.content || '(empty)'}`).join('\n\n');
}

function showTab(name) {
  for (const b of document.querySelectorAll('nav [role=tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.dataset.panel !== name;
}

// One turn of the current ancestor, alone in a scratch grid, with the real engine:
// what it did, what it cost, how long it took.
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
    let ev;
    try {
      ev = await sc.step();
    } catch (err) {
      $('probe-v').textContent = 'failed';
      failed(err);
      return;
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const n = ev.effects.length;
    $('probe-v').textContent = `${n} action${n === 1 ? '' : 's'}, ${secs}s`;
    $('cell-head').textContent = `probe: ${n} action${n === 1 ? '' : 's'}${usageText(ev.usage)}  ${secs}s`;
    $('prompt').textContent = renderMessages(prompt(scratch, 1, 1, md, opts).messages);
    $('genome').textContent = md;
    $('output').textContent = describe(ev) + '\n\n' + ev.out;
    showTab('cell');
  } finally {
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
      let ev;
      try {
        ev = await inFlight.finally(() => { inFlight = null; });
      } catch (err) {
        running = false;
        failed(err);
        break;
      }
      if (!ev) { running = false; $('status').textContent = 'soup is dead'; break; }
    }
    view.draw();
    showStats();
    if (view.selected !== null) showCell(view.selected);
    await yieldToBrowser();
  }
  $('run').textContent = 'Run';
}

// A turn that throws (the engine, the grammar, the GPU) must say so on the page, not
// just in the console, or a stopped spinner is the only sign.
function failed(err) {
  $('status').textContent = `turn failed: ${err?.message ?? err}`;
  console.error('[soup] turn failed', err);
  view.draw();
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
    o.value = m.id;
    o.textContent = `${m.id.replace(/-(Instruct-)?q\w+-MLC$/, '')}  ~${(m.vram / 1024).toFixed(1)} GB`;
    $('engine').appendChild(o);
  }
  $('ancestor').value = (await (await fetch('./ancestor.json')).text()).trim();
  $('manual').textContent = MANUAL;
  for (const b of document.querySelectorAll('nav [role=tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));
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
      else $('status').textContent = 'soup is dead';
    } catch (err) {
      failed(err);
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
