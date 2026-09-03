import { createSoup, place, stats, snapshot, restore, population, coords } from './soup.js';
import { createScheduler, prompt } from './scheduler.js';
import * as toolset from './tools.js';
const { setTools } = toolset;
import { createMockEngine } from './engine-mock.js';
import { createWebLLMEngine, MODELS, DEFAULT_MODEL, describeAdapter } from './engine-webllm.js';
import { createOpenRouterEngine, freeModels, storedKey, storeKey, PREFIX, PREFERRED } from './engine-openrouter.js';
import { createView } from './view.js';
import { createViLab } from './vi-lab.js';
import { viPrompt, viPreview } from './vi-soup.js';
import { seeded, tokenize } from './vi.js';
import { estimateTokens } from './tokens.js';

const $ = id => document.getElementById(id);

// Copy noise is the mutation rate, and at zero there is no evolution: every copy is
// exact, so nothing varies and nothing can be selected. It is on by default.
const opts = { mode: 'vi', maxTokens: 300, temperature: 0.7, noise: 0.002, rounds: 4, calls: 1, grammar: true, budget: 1200, readLimit: 600, keyLimit: 400, allowance: 0, rpm: 10, animMs: 55, showText: true, steps: 1 };
let soup, engine, sched, running = false, busy = false;
let inFlight = null;   // the turn currently awaiting the model, if any

let overlay = null;   // the part-finished state of a turn, while it plays out

const view = createView($('grid'), () => soup, {
  onSelect: i => { showCell(i); showTab('cell'); },
  onHover: showTip,
  getActive: () => (sched ? sched.active : null),
  getOverlay: () => overlay,
  showText: () => opts.showText,
});

// Play a turn's keystrokes over the grid, one command at a time, before the soup is
// changed. The replay re-runs from the start at each step with the turn's own seed, so
// what is watched is what will happen. Nothing here alters the soup.
async function playTurn({ x, y, keys, seed }) {
  if (!opts.animMs || !keys) return;
  const n = tokenize(keys).length;
  if (!n) return;
  for (let k = 1; k <= n; k++) {
    overlay = viPreview(soup, x, y, keys, k, seeded(seed));
    view.draw();
    // A pause between commands rather than between keys: gg is one thought, not two.
    const key = tokenize(keys)[k - 1];
    await new Promise(r => setTimeout(r, key === ' ' || key === 'CR' ? 0 : opts.animMs));
    if (!running && !busy) break;   // stopped mid-turn
  }
  overlay = null;
}

const ancestor = () => $('ancestor').value.trim();

async function makeEngine(name) {
  const onProgress = t => { $('status').textContent = t; };
  const e = name === 'mock' ? createMockEngine()
    : name.startsWith(PREFIX) ? createOpenRouterEngine(name.slice(PREFIX.length), { onProgress, getRpm: () => opts.rpm })
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
  opts.onAnimate = playTurn;
  sched = createScheduler(soup, engine, opts);
  view.clear();
  view.draw();
  showStats();
  showCell(null);
}

function showStats() {
  const s = stats(soup);
  $('stats').textContent =
    `tick ${s.tick}   sweep ${s.sweep}` +
    (opts.allowance > 0 ? `   ${Math.round(s.income)} tokens/cell/sweep${s.starved ? `, ${s.starved} in debt` : ''}` : '') + '\n' +
    `occupied ${s.occupied}/${s.total}   genomes ${s.distinct}   dominant ${s.dominant}\n` +
    `mean length ${s.meanLen.toFixed(0)} chars, about ${Math.ceil(s.meanLen / 4)} tokens\n` +
    `fail rate ${(s.failRate * 100).toFixed(1)}%`;
  showPopulation();
}

// What is persisting, and what it says. Click one to seed the ancestor from it.
function showPopulation() {
  $('pop').innerHTML = '';
  for (const g of population(soup)) {
    const el = document.createElement('pre');
    el.className = 'genome';
    el.title = g.md;
    el.textContent = `${String(g.n).padStart(3)} cells  gen ${g.maxGen}  since t${g.oldest}  ${g.md.length}c\n     ${firstLine(g.md)}`;
    el.addEventListener('click', () => { $('ancestor').value = g.md; showTab('setup'); });
    $('pop').appendChild(el);
  }
}

function firstLine(md) {
  const line = md.split('\n').map(l => l.trim()).find(Boolean) || '(blank)';
  return line.length > 64 ? line.slice(0, 64) + '\u2026' : line;
}

function usageText(u) {
  return u ? `  (${u.prompt_tokens} in, ${u.completion_tokens} out)` : '';
}

// One line for what a turn did: its writes, and what it cost.
function describe(ev) {
  if (ev.mode === 'vi') {
    const writes = ev.effects.map(e =>
      `${e.verb} (${e.dx},${e.dy})` + (e.copied ? ' [copy]' : '') + (e.mutated ? ' [mutated]' : '')
    ).join(', ');
    return `t${ev.tick}: ${writes || 'nothing'}, ${ev.keyCount} keys`;
  }
  const rounds = `${ev.rounds.length} round${ev.rounds.length === 1 ? '' : 's'}`;
  if (!ev.effects.length) return `t${ev.tick}: no writes, ${rounds}`;
  const writes = ev.effects.map(e =>
    `${e.verb} ${e.target}` +
    (e.mutated ? ' [mutated]' : '') + (e.overwrote && e.verb !== 'edit' ? ' [overwrote]' : '') + (e.emptied ? ' [emptied]' : '')
  ).join(', ');
  return `t${ev.tick}: ${writes}, ${rounds}`;
}

// The whole turn: for vi, the keystrokes and what they did to the grid.
function transcript(ev) {
  if (ev.mode === 'vi') {
    return `keys: ${ev.keys || '(none)'}\n\n${(ev.viLog || []).join('\n') || '(the keys did nothing)'}` +
      `\n\n— the model's reply —\n${ev.rounds[0]?.out ?? ''}`;
  }
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
  $('prompt').textContent = (opts.mode === 'vi' ? viPrompt : prompt)(c.md)[1].content;
  const ev = c.last;
  $('output').textContent = ev ? describe(ev) + usageText(ev.usage) + '\n\n' + transcript(ev) : 'has not taken a turn yet';
}

let viLab = null;

// What is in a cell, and what the model said when it last ran, without leaving the grid.
function showTip(i, mx, my) {
  const tip = $('tip');
  if (i === null || !soup) { tip.hidden = true; return; }
  const c = soup.cells[i];
  const [x, y] = coords(soup, i);
  if (c.md === null) {
    tip.innerHTML = `<span class="tip-head">(${x}, ${y})  empty</span>`;
  } else {
    const ev = c.last;
    const parts = [
      `<span class="tip-head">(${x}, ${y})  gen ${c.gen}  born t${c.born}  turns ${c.turns}  fails ${c.fails}  ${c.md.length} chars</span>`,
      escape(clip(c.md, 260)),
    ];
    if (ev) {
      const reply = ev.mode === 'vi' ? (ev.rounds?.[0]?.out ?? '') : (ev.rounds?.[ev.rounds.length - 1]?.out ?? '');
      parts.push(
        '<span class="tip-rule">' + '─'.repeat(40) + '</span>',
        `<span class="tip-head">${escape(describe(ev))}${usageText(ev.usage)}</span>`,
        escape(clip(reply, 200)) || '<span class="tip-head">(empty reply)</span>',
      );
    } else {
      parts.push('<span class="tip-head">has not taken a turn yet</span>');
    }
    tip.innerHTML = parts.join('\n');
  }
  // Pinned to the right edge, over the sidebar, never over the grid: a panel that follows
  // the pointer covers the thing being looked at, and because it ignores the pointer the
  // cells underneath still respond, which reads as the grid having gone black.
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const pad = 6;
  const vw = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0, r.width + 2 * pad);
  const vh = Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0, r.height + 2 * pad);
  // Clamped so the result can never be negative, whatever the viewport reports.
  tip.style.left = `${Math.max(pad, vw - r.width - pad)}px`;
  tip.style.top = `${Math.max(pad, Math.min(my - r.height / 2, vh - r.height - pad))}px`;
}

const clip = (t, n) => (t.length > n ? t.slice(0, n) + '\n…' : t);
const escape = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function showTab(name) {
  for (const b of document.querySelectorAll('nav [role=tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.dataset.panel !== name;
  // The vi bench wants the whole screen, so it covers everything else while it is open.
  $('vi-panel').hidden = name !== 'vi';
  if (name === 'vi') {
    if (!viLab) { viLab = createViLab(); viLab.mount(); }
    else viLab.render();
  }
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
    $('prompt').textContent = (opts.mode === 'vi' ? viPrompt : prompt)(md)[1].content;
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
    // A slow engine draws every turn; an instant one would spend all its time drawing.
    const per = engine.instant ? Math.max(20, opts.steps) : 1;
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
        // Being rate limited is not a failure either — the run stops where it is and the
        // soup keeps its state, so it can be started again later without losing anything.
        if (err?.rateLimited) {
          running = false;
          $('status').textContent = `paused: ${err.message}`;
          save();
          break;
        }
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
  // Which engine to start on, in order: what the URL names, then what was chosen last,
  // then the hosted model if there is a key for it, then the local one. A hosted model is
  // the better default where a key exists — no GPU, no watchdog, and far more capable —
  // but the page still has to do something for a visitor without one.
  const url = new URL(location.href).searchParams.get('engine');
  const remembered = (() => { try { return localStorage.getItem('soup.engine'); } catch { return null; } })();
  const wanted = url || remembered || (storedKey() ? PREFIX + PREFERRED : null);
  if (wanted && ![...$('engine').options].some(o => o.value === wanted)) {
    const o = document.createElement('option');
    o.value = wanted;
    o.textContent = wanted.startsWith(PREFIX) ? wanted.slice(PREFIX.length) : wanted.replace(/-MLC$/, '');
    ($('or-group') && wanted.startsWith(PREFIX) ? $('or-group') : $('engine')).appendChild(o);
  }
  $('engine').value = wanted || DEFAULT_MODEL;
  opts.mode = new URL(location.href).searchParams.get('mode') === 'tools' ? 'tools' : 'vi';
  $('mode').value = opts.mode;
  $('mode').addEventListener('change', async () => {
    await stop();
    opts.mode = $('mode').value;
    await loadAncestor();
    reset();
  });
  await loadAncestor();
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
  bind('calls', 'calls');
  bind('keyLimit', 'keyLimit');
  bind('allowance', 'allowance');
  bind('rpm', 'rpm');
  bind('animMs', 'animMs');
  $('showText').checked = opts.showText;
  $('showText').addEventListener('change', () => { opts.showText = $('showText').checked; view.draw(); });
  bind('budget', 'budget');
  $('grammar').checked = opts.grammar;
  $('grammar').addEventListener('change', () => { opts.grammar = $('grammar').checked; });
  bind('steps', 'steps');
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
    const want = Math.max(1, opts.steps);
    try {
      for (let k = 0; k < want; k++) {
        $('step').textContent = want > 1 ? `Step ${k + 1}/${want}` : 'Step';
        inFlight = sched.step();
        view.draw();
        const ev = await inFlight.finally(() => { inFlight = null; });
        view.draw();
        showStats();
        if (!ev) { $('status').textContent = 'soup is dead'; break; }
        view.select(ev.y * soup.w + ev.x);
      }
      save();
    } catch (err) {
      // A GPU reset should cost a model rebuild, not the run, whether stepping or running.
      if (err?.deviceLost && await recoverEngine()) return;
      failed(err);
    } finally {
      $('step').textContent = 'Step';
      setBusy(false);
    }
  });
  $('probe').addEventListener('click', probe);
  $('reset').addEventListener('click', async () => { await stop(); reset(); });
  $('size').addEventListener('change', async () => { await stop(); reset(); });
  $('engine').addEventListener('change', async () => {
    await stop();
    try { localStorage.setItem('soup.engine', $('engine').value); } catch { /* private mode */ }
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
    const preferred = models.find(m => m.id === PREFERRED);
    if (preferred) $('engine').value = PREFIX + PREFERRED;
    $('or-note').textContent =
      `${models.length} free models, ${models.filter(m => m.schema).length} that can be held to the schema` +
      (preferred ? `. ${PREFERRED} selected` : '');
  } catch (err) {
    $('or-note').textContent = err.message;
  }
}

// Each instruction set has its own ancestor: a JSON-tools cell and a vi cell are not
// written in the same language.
async function loadAncestor() {
  const file = opts.mode === 'vi' ? './ancestor-vi.md' : './ancestor.md';
  // Normalised, so a seed saved with Windows line endings still parses the same.
  $('ancestor').value = (await (await fetch(file)).text()).replace(/\r\n?/g, '\n').trim();
}

// Everything a run knows, in one object: the grid, the settings, and the recent turns.
// Saved to the dev server so a soup can be reloaded, read and worked on off the page.
function dump() {
  return {
    saved: new Date().toISOString(),
    // Enough to know what produced this without asking: which model, on which device,
    // with which prompt and which settings.
    mode: opts.mode,
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
  opts.onAnimate = playTurn;
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
