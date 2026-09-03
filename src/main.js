import { createSoup, place, stats, snapshot, restore, coords } from './soup.js';
import { createScheduler, prompt } from './scheduler.js';
import * as toolset from './tools.js';
const { setTools } = toolset;
import { createMockEngine } from './engine-mock.js';
import { createWebLLMEngine, MODELS, DEFAULT_MODEL, describeAdapter } from './engine-webllm.js';
import { createOpenRouterEngine, freeModels, storedKey, storeKey, PREFIX } from './engine-openrouter.js';
import { createView } from './view.js';
import { estimateTokens } from './tokens.js';

const $ = id => document.getElementById(id);

const opts = { maxTokens: 300, temperature: 0.7, noise: 0, rounds: 4, grammar: true, budget: 1200, readLimit: 600, ticksPerFrame: 20 };
let soup, engine, sched, running = false, busy = false;
let inFlight = null;   // the turn currently awaiting the model, if any

const view = createView($('grid'), () => soup, {
  onSelect: i => { showCell(i); showTab('cell'); },
  getActive: () => (sched ? sched.active : null),
});

const ancestor = () => $('ancestor').value.trim();

async function makeEngine(name) {
  const onProgress = t => { $('status').textContent = t; };
  const e = name === 'mock' ? createMockEngine()
    : name.startsWith(PREFIX) ? createOpenRouterEngine(name.slice(PREFIX.length), { onProgress })
    : createWebLLMEngine(name, { onProgress });
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

// One line for what a turn did: its writes, and how many rounds it took.
function describe(ev) {
  const rounds = `${ev.rounds.length} round${ev.rounds.length === 1 ? '' : 's'}`;
  if (!ev.effects.length) return `t${ev.tick}: no writes, ${rounds}`;
  const writes = ev.effects.map(e =>
    `${e.verb} ${e.target}` +
    (e.mutated ? ' [mutated]' : '') + (e.overwrote && e.verb !== 'edit' ? ' [overwrote]' : '') + (e.emptied ? ' [emptied]' : '')
  ).join(', ');
  return `t${ev.tick}: ${writes}, ${rounds}`;
}

// The whole turn, round by round: what the model said, and what the tools answered.
function transcript(ev) {
  return ev.rounds.map((r, k) => {
    const results = r.results.map((res, j) => {
      const c = r.calls[j];
      const args = c.tool === 'list_files' ? '.' : c.tool === 'copy_file' ? `${c.src} -> ${c.dst}` : c.path;
      return `  ${c.tool}(${args}) -> ${res.ok ? 'ok' : 'error'}: ${res.output.split('\n')[0]}${res.output.includes('\n') ? ' …' : ''}`;
    }).join('\n');
    const why = [r.finish && r.finish !== 'stop' ? `finish: ${r.finish}` : '', r.calls.length ? '' : 'no calls found in this reply'].filter(Boolean).join('   ');
    return `— round ${k + 1} —${why ? `  [${why}]` : ''}\n${r.out || '(empty reply)'}\n${results ? '\n' + results : ''}`;
  }).join('\n\n');
}

// The cell tab: the text, what its last turn did, and (folded) what the model was sent.
function showCell(i) {
  const clear = head => { $('cell-head').textContent = head; $('prompt').textContent = ''; $('genome').textContent = ''; $('output').textContent = ''; };
  if (i === null) { clear('click a cell on the grid'); return; }
  const c = soup.cells[i];
  const [x, y] = coords(soup, i);
  if (c.md === null) { clear(`(${x}, ${y}) empty`); return; }
  $('cell-head').textContent = `(${x}, ${y})  gen ${c.gen}  born t${c.born}  turns ${c.turns}  fails ${c.fails}  ${c.md.length} chars, about ${estimateTokens(c.md)} tokens`;
  $('genome').textContent = c.md;
  $('prompt').textContent = prompt(c.md)[1].content;
  const ev = c.last;
  $('output').textContent = ev ? describe(ev) + usageText(ev.usage) + '\n\n' + transcript(ev) : 'has not taken a turn yet';
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
    $('probe-v').textContent = `${n} write${n === 1 ? '' : 's'}, ${ev.rounds.length} round${ev.rounds.length === 1 ? '' : 's'}, ${secs}s`;
    $('cell-head').textContent = `probe${usageText(ev.usage)}  ${secs}s`;
    $('genome').textContent = md;
    $('prompt').textContent = prompt(md)[1].content;
    $('output').textContent = describe(ev) + '\n\n' + transcript(ev);
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
        // A GPU reset need not end the run: rebuild the engine and keep going. The soup
        // itself is untouched, only the model's device state died.
        if (err?.deviceLost && await recoverEngine()) continue;
        running = false;
        failed(err);
        break;
      }
      if (!ev) { running = false; $('status').textContent = 'soup is dead'; break; }
    }
    view.draw();
    showStats();
    if (view.selected !== null) showCell(view.selected);
    if (soup.tick - lastSaveTick >= 20) { lastSaveTick = soup.tick; save(); }
    await yieldToBrowser();
  }
  save();
  $('run').textContent = 'Run';
}

let recoveries = 0;
let lastSaveTick = 0;

async function recoverEngine() {
  if (!engine.recover || recoveries >= 5) return false;
  recoveries++;
  $('status').textContent = `GPU was reset; rebuilding the model (${recoveries})`;
  console.warn('[soup] GPU was reset; rebuilding the model', recoveries);
  setBusy(true);
  try {
    await engine.recover();
    $('status').textContent = `${engine.name} on ${engine.gpu}  (recovered ${recoveries}x)`;
    return true;
  } catch (err) {
    failed(err);
    return false;
  } finally {
    setBusy(false);
  }
}

// A turn that throws (the engine, the grammar, the GPU) must say so on the page, not
// just in the console, or a stopped spinner is the only sign.
function failed(err) {
  $('status').textContent = `turn failed: ${err?.message ?? err}`;
  console.error('[soup] turn failed', err);
  view.draw();
  save('failed.json', { failed: String(err?.stack ?? err?.message ?? err) });   // the evidence, kept
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
  const mock = $('engine').querySelector('option[value=mock]');
  for (const m of MODELS) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = `${m.id.replace(/-(Instruct-)?q\w+-MLC$/, '')}  ~${(m.vram / 1024).toFixed(1)} GB`;
    $('engine').insertBefore(o, mock);
  }
  // ?engine=<model id or mock> overrides the default: for tests, for machines without a GPU
  // to spare, and for trying any model WebLLM knows that is not in the picker.
  const wanted = new URL(location.href).searchParams.get('engine');
  if (wanted && ![...$('engine').options].some(o => o.value === wanted)) {
    const o = document.createElement('option');
    o.value = wanted;
    o.textContent = wanted.replace(/-MLC$/, '');
    $('engine').insertBefore(o, mock);
  }
  $('engine').value = wanted || DEFAULT_MODEL;
  $('ancestor').value = (await (await fetch('./ancestor.md')).text()).trim();
  // Short TOOLS is the default: prefill is one GPU dispatch, and on a small card a long
  // prompt can run past the Windows watchdog and get the device reset. ?tools=full sends
  // the verbose block instead.
  $('manual').textContent = setTools(new URL(location.href).searchParams.get('tools'));
  for (const b of document.querySelectorAll('nav [role=tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));
  $('gpu').textContent = navigator.gpu ? `gpu: ${await describeAdapter()}` : 'gpu: WebGPU not available in this browser';
  $('orkey').value = storedKey();
  $('orkey').addEventListener('change', () => { storeKey($('orkey').value); loadFreeModels(); });
  $('orload').addEventListener('click', loadFreeModels);
  if (storedKey()) loadFreeModels();
  bind('temperature', 'temperature');
  bind('slice', 'maxTokens');
  bind('noise', 'noise');
  bind('rounds', 'rounds');
  bind('budget', 'budget');
  $('grammar').checked = opts.grammar;
  $('grammar').addEventListener('change', () => { opts.grammar = $('grammar').checked; });
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
      save();
    } catch (err) {
      // A GPU reset should cost a model rebuild, not the run, whether stepping or running.
      if (err?.deviceLost && await recoverEngine()) return;
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
    const old = engine;
    engine = await makeEngine($('engine').value);
    if (old !== engine) await old.unload?.();   // never leave two models on the GPU
    reset();
  });
  $('load').addEventListener('click', () => $('loadfile').click());
  $('loadfile').addEventListener('change', async () => {
    const file = $('loadfile').files[0];
    if (!file) return;
    await stop();
    try {
      loadDump(JSON.parse(await file.text()));
      $('status').textContent = `loaded ${file.name}`;
    } catch (err) {
      failed(err);
    }
    $('loadfile').value = '';
  });
  $('export').addEventListener('click', () => {
    // The transcripts, not just the grid: what a turn did and did not do is the evidence.
    const dump = JSON.stringify({
      engine: engine.name,
      opts,
      soup: JSON.parse(snapshot(soup)),
      turns: sched.log.slice(-40),
    }, null, 2);
    const blob = new Blob([dump], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `soup-t${soup.tick}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  window.addEventListener('resize', () => view.draw());
  requestAnimationFrame(animate);
}

// OpenRouter's free list changes week to week, so ask for it rather than hardcode it.
// Nothing is added to the picker until the visitor has supplied their own key.
async function loadFreeModels() {
  const group = $('or-group');
  group.innerHTML = '';
  $('or-note').textContent = 'fetching the free list';
  try {
    const models = await freeModels();
    for (const m of models) {
      const o = document.createElement('option');
      o.value = PREFIX + m.id;
      o.textContent = `${m.id}${m.schema ? '  (schema)' : ''}`;
      group.appendChild(o);
    }
    $('or-note').textContent = `${models.length} free models, ${models.filter(m => m.schema).length} that can be held to the schema`;
  } catch (err) {
    $('or-note').textContent = err.message;
  }
}

// Everything a run knows, in one object: the grid, the settings, and the recent turns.
// Saved to the dev server so a soup can be reloaded, read and worked on off the page.
function dump() {
  return {
    saved: new Date().toISOString(),
    // Enough to know what produced this without asking: which model, on which device,
    // with which prompt and which settings.
    engine: engine.name,
    device: engine.gpu ?? null,
    tools: toolset.TOOLS.startsWith('TOOLS.') ? 'short' : 'full',
    toolsTokens: Math.ceil(toolset.TOOLS.length / 4),
    url: location.href,
    recoveries,
    deviceLost: engine.lost ?? null,
    opts,
    stats: stats(soup),
    soup: JSON.parse(snapshot(soup)),
    turns: sched.log.slice(-40),
  };
}

function loadDump(data) {
  const s = data?.soup ?? data;
  if (!s?.w || !Array.isArray(s.cells)) throw new Error('not a soup snapshot');
  soup = restore(s);
  sched = createScheduler(soup, engine, opts);
  if ([...$('size').options].some(o => Number(o.value) === soup.w)) $('size').value = String(soup.w);
  view.clear();
  view.draw();
  showStats();
  showCell(null);
}

// The dev server takes POST /save/<name>; a published copy does not, so a failure here is
// not worth reporting more than once.
let saveBroken = false;
async function save(name = 'latest.json', extra = {}) {
  if (saveBroken) return;
  try {
    const r = await fetch(`/save/${name}`, { method: 'POST', body: JSON.stringify({ ...dump(), ...extra }, null, 2) });
    if (!r.ok) throw new Error(`${r.status}`);
  } catch {
    saveBroken = true;
    console.info('[soup] no save endpoint; run `python serve.py` to keep runs on disk');
  }
}

// Redraw only while a cell is at the model, so the working mark turns.
function animate() {
  if (sched && sched.active !== null) view.draw();
  requestAnimationFrame(animate);
}

init();

// Debug hook for in-page experiments.
window.__soup = { get engine() { return engine; }, get soup() { return soup; }, get sched() { return sched; }, opts };
