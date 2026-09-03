// A bench for the vi emulator: a patch of grid, a keystroke string, and the result.
//
// The state is the starting cells plus the keys typed so far, and every change re-runs
// the whole string from the start. That keeps `run` pure and makes stepping, undoing and
// editing the string all the same operation.

import { run, CELL_KEYS, tokenize } from './vi.js';

const $ = id => document.getElementById(id);

const PRESETS = [
  ['reproduce anywhere', 'gg yG R gg VG p'],
  ['reproduce east', 'ggyGLggVGp'],
  ['reproduce north', 'ggyGKggVGp'],
  ['reproduce two east', 'ggyG2LggVGp'],
  ['append to east', 'ggyGLGp'],
  ['their example', 'jjwwihello<Esc>'],
  ['walk and scribble', 'LLGoscribbled<Esc>'],
  ['delete east', 'LggVGd'],
];

const START = {
  '0,0': '# Cell\nreproduce.',
  '0,-1': 'a neighbour\nwith two lines',
  '1,0': 'old east',
  '2,0': 'far east',
};

export function createViLab() {
  let start = { ...START };
  let keys = '';
  let stepAt = null;   // how many keys to run; null means all of them
  let capturing = false;

  // The bench re-runs the whole string on every change, so R has to land the same way
  // each time or stepping through would show a different world at every keystroke. The
  // seed is the string itself: edit it and the dice change too.
  function seeded(text) {
    let h = 1779033703;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 3432918353) >>> 0;
    return () => {
      h = (h + 0x6D2B79F5) >>> 0;
      let t = Math.imul(h ^ (h >>> 15), 1 | h);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const state = () => run(
    (dx, dy) => (start[`${dx},${dy}`] !== undefined ? { text: start[`${dx},${dy}`], cursor: { line: 0, col: 0 } } : null),
    keys,
    { limit: stepAt === null ? 4000 : stepAt, rng: seeded(keys) },
  );

  function render() {
    const r = state();
    const all = tokenize(keys);
    const shown = stepAt === null ? all.length : Math.min(stepAt, all.length);

    if ($('vi-keys').value !== keys) $('vi-keys').value = keys;
    $('vi-mode').textContent =
      `mode ${r.mode}   cell (${r.at.dx},${r.at.dy})   cursor ${r.cells.get(`${r.at.dx},${r.at.dy}`)?.cursor.line ?? 0},` +
      `${r.cells.get(`${r.at.dx},${r.at.dy}`)?.cursor.col ?? 0}   keys ${shown}/${all.length}   ` +
      `register ${r.register.linewise ? '(lines) ' : ''}${JSON.stringify(r.register.text).slice(0, 50)}`;

    $('vi-stream').innerHTML = '';
    all.forEach((k, i) => {
      const el = document.createElement('span');
      el.className = 'key' + (i < shown ? ' done' : '');
      el.textContent = k === ' ' ? '␣' : k;
      el.addEventListener('click', () => { stepAt = i + 1; render(); });
      $('vi-stream').appendChild(el);
    });

    // A window wide enough for the mother, everything touched, and a ring of empties.
    const xs = [0, r.at.dx, ...[...r.cells.values()].map(c => c.dx)];
    const ys = [0, r.at.dy, ...[...r.cells.values()].map(c => c.dy)];
    const x0 = Math.min(...xs) - 1, x1 = Math.max(...xs) + 1;
    const y0 = Math.min(...ys) - 1, y1 = Math.max(...ys) + 1;

    const grid = $('vi-grid');
    grid.style.gridTemplateColumns = `repeat(${x1 - x0 + 1}, minmax(0, 1fr))`;
    grid.innerHTML = '';
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const id = `${x},${y}`;
        const cell = r.cells.get(id) ?? { dx: x, dy: y, text: start[id] ?? null, cursor: { line: 0, col: 0 }, changed: false };
        const here = x === r.at.dx && y === r.at.dy;
        const el = document.createElement('div');
        el.className = 'vibuf' + (here ? ' here' : '') + (cell.changed ? ' changed' : '') + (x === 0 && y === 0 ? ' mother' : '');
        const head = document.createElement('div');
        head.className = 'vibuf-head';
        head.textContent = `(${x},${y})${x === 0 && y === 0 ? '  mother' : ''}${cell.text === null ? '  empty' : ''}`;
        const body = document.createElement('pre');
        body.className = 'vibuf-body';
        body.innerHTML = withCursor(cell, here, r.mode);
        el.append(head, body);
        grid.appendChild(el);
      }
    }
  }

  // The cell's text with the cursor drawn where it is actually sitting.
  function withCursor(cell, active, mode) {
    const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const lines = (cell.text ?? '').split('\n');
    return lines.map((line, i) => {
      if (!active || i !== cell.cursor.line) return esc(line) || '&nbsp;';
      const c = Math.min(cell.cursor.col, line.length);
      return `${esc(line.slice(0, c))}<span class="cursor${mode === 'insert' ? ' insert' : ''}">${esc(line[c] ?? ' ') || '&nbsp;'}</span>${esc(line.slice(c + 1))}`;
    }).join('\n') || '&nbsp;';
  }

  const setKeys = (next, step = null) => { keys = next; stepAt = step; render(); };

  // Typing straight into the bench: the same keys the model would emit, one at a time,
  // spelled the way vim spells them.
  function onKeyDown(e) {
    if (!capturing) return;
    const named = { Escape: '<Esc>', Enter: '<CR>', Backspace: '<BS>', Tab: '<Tab>' };
    const k = named[e.key] ?? (e.key.length === 1 ? e.key : null);
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
        stepAt = stepAt === null ? 1 : Math.min(stepAt + 1, tokenize(keys).length);
        render();
      });
      $('vi-back').addEventListener('click', () => { stepAt = Math.max(0, (stepAt ?? tokenize(keys).length) - 1); render(); });
      $('vi-clear').addEventListener('click', () => setKeys(''));
      $('vi-reset').addEventListener('click', () => { start = { ...START }; setKeys(''); });
      $('vi-apply').addEventListener('click', () => {
        // Take the result as the new starting point, the way a turn hands on to the next.
        const r = state();
        for (const c of r.cells.values()) {
          if (c.text === null) delete start[`${c.dx},${c.dy}`];
          else start[`${c.dx},${c.dy}`] = c.text;
        }
        setKeys('');
      });
      $('vi-capture').addEventListener('change', () => {
        capturing = $('vi-capture').checked;
        $('vi-mode').classList.toggle('capturing', capturing);
        if (capturing) $('vi-keys').blur();
      });
      window.addEventListener('keydown', onKeyDown);
      render();
    },
    render,
  };
}
