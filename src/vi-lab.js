// A bench for the vi emulator: five buffers, a keystroke string, and the result.
//
// The state is the starting buffers plus the keys typed so far, and every change re-runs
// the whole string from the start. That keeps `run` pure and makes stepping, undoing and
// editing the string all the same operation.

import { run, PATHS, CELL_KEYS, tokenize } from './vi.js';

const $ = id => document.getElementById(id);
const LAYOUT = [[null, 'north', null], ['west', 'self', 'east'], [null, 'south', null]];

const PRESETS = [
  ['reproduce east', 'ggyGLggVGp'],
  ['reproduce north', 'ggyGKggVGp'],
  ['append to east', 'ggyGLGp'],
  ['their example', 'jjwwihello<Esc>'],
  ['scribble on north', 'KGoscribbled<Esc>'],
  ['delete east', 'LggVGd'],
];

const START = {
  self: '# Cell\nreproduce.',
  north: 'a neighbour\nwith two lines',
  south: null,
  east: 'old east',
  west: null,
};

export function createViLab() {
  let start = { ...START };
  let keys = '';
  let stepAt = null;   // how many keys to run when stepping; null means all
  let capturing = false;

  function state() {
    const cells = {};
    for (const p of PATHS) cells[p] = start[p] === null ? null : { text: start[p], cursor: { line: 0, col: 0 } };
    const limit = stepAt === null ? 4000 : stepAt;
    return run(cells, keys, { limit });
  }

  function render() {
    const r = state();
    const all = tokenize(keys);
    const shown = stepAt === null ? all.length : Math.min(stepAt, all.length);

    $('vi-keys').value = keys;
    $('vi-mode').textContent =
      `mode ${r.mode}   buffer ${r.at}   cursor ${r.cells[r.at].cursor.line},${r.cells[r.at].cursor.col}   ` +
      `keys ${shown}/${all.length}   register ${r.register.linewise ? '(lines) ' : ''}${JSON.stringify(r.register.text).slice(0, 60)}`;

    $('vi-stream').innerHTML = '';
    all.forEach((k, i) => {
      const el = document.createElement('span');
      el.className = 'key' + (i < shown ? ' done' : '');
      el.textContent = k === ' ' ? '␣' : k;
      el.addEventListener('click', () => { stepAt = i + 1; render(); });
      $('vi-stream').appendChild(el);
    });

    const grid = $('vi-grid');
    grid.innerHTML = '';
    for (const row of LAYOUT) {
      for (const p of row) {
        const cell = document.createElement('div');
        cell.className = 'vibuf' + (p === null ? ' blank' : '') + (p === r.at ? ' here' : '') + (p && r.cells[p].changed ? ' changed' : '');
        if (p) {
          const head = document.createElement('div');
          head.className = 'vibuf-head';
          const keyFor = Object.entries(CELL_KEYS).find(([, v]) => v === p)?.[0];
          head.textContent = `${p}${keyFor ? `  (${keyFor})` : ''}${r.cells[p].text === null ? '  empty' : ''}`;
          const body = document.createElement('pre');
          body.className = 'vibuf-body';
          body.innerHTML = withCursor(r.cells[p], p === r.at, r.mode);
          cell.append(head, body);
        }
        grid.appendChild(cell);
      }
    }
  }

  // The buffer's text with the cursor drawn in, where the cursor is actually sitting.
  function withCursor(cell, active, mode) {
    const lines = (cell.text ?? '').split('\n');
    const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return lines.map((line, i) => {
      if (!active || i !== cell.cursor.line) return esc(line) || '&nbsp;';
      const c = Math.min(cell.cursor.col, line.length);
      const cls = mode === 'insert' ? 'cursor insert' : 'cursor';
      return `${esc(line.slice(0, c))}<span class="${cls}">${esc(line[c] ?? ' ') || '&nbsp;'}</span>${esc(line.slice(c + 1))}`;
    }).join('\n') || '&nbsp;';
  }

  function setKeys(next, { step = null } = {}) { keys = next; stepAt = step; render(); }

  // Typing straight into the bench: the same keys the model would emit, one at a time.
  function onKeyDown(e) {
    if (!capturing) return;
    const map = { Escape: '<Esc>', Enter: '<CR>', Backspace: '<BS>', Tab: '<Tab>' };
    let k = map[e.key] ?? (e.key.length === 1 ? e.key : null);
    if (k === null) return;
    e.preventDefault();
    setKeys(keys + k);
  }

  return {
    mount() {
      for (const [label, s] of PRESETS) {
        const b = document.createElement('button');
        b.textContent = label;
        b.addEventListener('click', () => setKeys(s));
        $('vi-presets').appendChild(b);
      }
      $('vi-keys').addEventListener('input', () => setKeys($('vi-keys').value));
      $('vi-run').addEventListener('click', () => { stepAt = null; render(); });
      $('vi-step').addEventListener('click', () => {
        const total = tokenize(keys).length;
        stepAt = stepAt === null ? 1 : Math.min(stepAt + 1, total);
        render();
      });
      $('vi-back').addEventListener('click', () => { stepAt = Math.max(0, (stepAt ?? tokenize(keys).length) - 1); render(); });
      $('vi-clear').addEventListener('click', () => setKeys(''));
      $('vi-reset').addEventListener('click', () => { start = { ...START }; setKeys(''); });
      $('vi-apply').addEventListener('click', () => {
        // Take the result as the new starting point, the way a turn hands on to the next.
        const r = state();
        for (const p of PATHS) start[p] = r.cells[p].text;
        setKeys('');
      });
      $('vi-capture').addEventListener('change', () => {
        capturing = $('vi-capture').checked;
        $('vi-mode').classList.toggle('capturing', capturing);
      });
      window.addEventListener('keydown', onKeyDown);
      render();
    },
    render,
  };
}
