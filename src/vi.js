// A small vi, enough of one to be a cell's whole instruction set.
//
// The idea: a cell's turn produces a string of keystrokes, and that string is the
// program. Almost every character is a valid command, so a mutated string is still a
// program that does something — Tierra's property, that no bit pattern is illegal, in a
// language people already write in.
//
// The cursor is somewhere on the grid, starting in the cell whose turn it is. h j k l
// move it inside the current cell; H J K L move it one whole cell west, south, north or
// east, and keep going: LL is two cells east. Reach is not bounded by a rule, only by
// what a turn can afford in keystrokes. There is no filesystem and no :w — a buffer is a
// cell, and editing it is the write. One register, belonging to the turn, is what carries
// text from one cell to another.
//
// Cursor position is part of a cell's state, so where a lineage leaves its cursor is
// inherited along with its text.

// Which way each key steps, in cells. R steps to one of the four at random, so a genome
// can reproduce without naming a direction — the way Tierra's allocator placed daughters
// rather than the creature choosing. A lineage that always goes east fills one row of a
// torus and then eats itself; one that goes R spreads.
export const CELL_KEYS = { H: [-1, 0], J: [0, 1], K: [0, -1], L: [1, 0] };
export const RANDOM_KEY = 'R';
const DELTAS = Object.values(CELL_KEYS);

const SPECIAL = { '<Esc>': 'Esc', '<CR>': 'CR', '<Enter>': 'CR', '<BS>': 'BS', '<Tab>': 'Tab', '<Space>': ' ' };

// A keystroke string as the model writes it: literal characters, plus <Esc> and friends
// spelled out in vim's own key notation, and newlines treated as Enter.
export function tokenize(input) {
  const keys = [];
  for (let i = 0; i < input.length; ) {
    if (input[i] === '<') {
      const close = input.indexOf('>', i);
      if (close > i) {
        const name = input.slice(i, close + 1);
        const match = Object.keys(SPECIAL).find(k => k.toLowerCase() === name.toLowerCase());
        if (match) { keys.push(SPECIAL[match]); i = close + 1; continue; }
      }
    }
    keys.push(input[i] === '\n' ? 'CR' : input[i]);
    i++;
  }
  return keys;
}

// A turn's randomness has to be repeatable: the grid replays the keystrokes one at a
// time, re-running from the start each time, and R must fall the same way in the replay
// as it does in the turn that is finally committed.
export function seeded(seed) {
  let h = seed >>> 0;
  return () => {
    h = (h + 0x6D2B79F5) >>> 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const isWord = ch => /[A-Za-z0-9_]/.test(ch);

function makeBuffer(text, cursor) {
  const lines = (text ?? '').split('\n');
  return {
    lines: lines.length ? lines : [''],
    line: clamp(cursor?.line ?? 0, 0, Math.max(0, lines.length - 1)),
    col: Math.max(0, cursor?.col ?? 0),
  };
}

// Run a keystroke string over the grid, starting in the cell at the origin.
//
//   getCell(dx, dy) -> { text, cursor } | null      relative to the cell whose turn it is
//   returns { cells, at, mode, register, log, keys }
//     cells: Map of "dx,dy" -> { dx, dy, text, cursor, changed } for every cell touched
//
// `limit` caps how many keys are executed, so a runaway string costs what it costs and
// then stops.
export function run(getCell, input, { limit = 4000, rng = Math.random } = {}) {
  const bufs = new Map();
  const state = {
    dx: 0, dy: 0,
    mode: 'normal',
    register: { text: '', linewise: false },
    pending: '',        // operator or multi-key prefix, e.g. 'd', 'g'
    count: '',
    opCount: 1,         // the count typed before an operator, kept until its motion lands
    visual: null,       // {line} anchor while in visual-line mode
    log: [],
  };

  const key = (dx, dy) => `${dx},${dy}`;

  // A cell is only fetched when the cursor reaches it, so a turn pays for what it visits.
  function bufAt(dx, dy) {
    const id = key(dx, dy);
    let b = bufs.get(id);
    if (!b) {
      const cell = getCell(dx, dy) ?? null;
      const text = cell?.text ?? null;
      const lines = (text ?? '').split('\n');
      b = {
        dx, dy,
        lines: lines.length ? lines : [''],
        line: clamp(cell?.cursor?.line ?? 0, 0, Math.max(0, lines.length - 1)),
        col: Math.max(0, cell?.cursor?.col ?? 0),
        present: text !== null,
        changed: false,
      };
      bufs.set(id, b);
    }
    return b;
  }

  const buf = () => bufAt(state.dx, state.dy);
  const cur = () => buf().lines[buf().line] ?? '';
  const note = what => state.log.push(`(${state.dx},${state.dy}): ${what}`);
  const touch = () => { const b = buf(); b.changed = true; b.present = true; };

  const keys = tokenize(input).slice(0, limit);
  for (const k of keys) {
    if (state.mode === 'insert') insertKey(k);
    else normalKey(k);
  }

  const cells = new Map();
  for (const [id, b] of bufs) {
    const text = b.lines.join('\n');
    cells.set(id, {
      dx: b.dx, dy: b.dy,
      text: b.present && text.trim() !== '' ? text : null,
      cursor: { line: b.line, col: b.col },
      changed: b.changed,
    });
  }
  return {
    cells,
    at: { dx: state.dx, dy: state.dy },
    mode: state.visual ? 'visual' : state.mode,
    register: state.register,
    log: state.log,
    keys: keys.length,
  };

  // ---- insert mode -------------------------------------------------------------

  function insertKey(key) {
    const b = buf();
    if (key === 'Esc') { state.mode = 'normal'; b.col = Math.max(0, b.col - 1); return; }
    const line = b.lines[b.line] ?? '';
    if (key === 'CR') {
      b.lines.splice(b.line, 1, line.slice(0, b.col), line.slice(b.col));
      b.line++; b.col = 0; touch(); return;
    }
    if (key === 'BS') {
      if (b.col > 0) { b.lines[b.line] = line.slice(0, b.col - 1) + line.slice(b.col); b.col--; touch(); }
      else if (b.line > 0) {
        const prev = b.lines[b.line - 1];
        b.lines.splice(b.line - 1, 2, prev + line);
        b.line--; b.col = prev.length; touch();
      }
      return;
    }
    const ch = key === 'Tab' ? '  ' : key;
    b.lines[b.line] = line.slice(0, b.col) + ch + line.slice(b.col);
    b.col += ch.length;
    touch();
  }

  // ---- normal mode -------------------------------------------------------------

  function normalKey(key) {
    const b = buf();

    if (key === 'Esc') { state.pending = ''; state.count = ''; return; }

    // A count prefix; 0 is a motion unless it continues a count.
    if (/[1-9]/.test(key) || (key === '0' && state.count)) { state.count += key; return; }

    const n = Math.max(1, parseInt(state.count || '1', 10));

    // gg needs a second key.
    if (state.pending === 'g') {
      state.pending = ''; state.count = '';
      if (key === 'g') { b.line = clamp(n - 1, 0, b.lines.length - 1); b.col = 0; }
      return;
    }

    // An operator is waiting for a motion, or for itself doubled (dd, yy, cc).
    if (state.pending && 'dyc'.includes(state.pending)) {   // '' is a substring of everything
      const op = state.pending;
      const total = Math.max(n, state.opCount) === 1 ? 1 : (state.count ? n * state.opCount : state.opCount);
      state.pending = ''; state.count = '';
      if (key === op) return lineOperate(op, total);
      if (key === 'g') { state.pending = 'gop:' + op; return; }   // dgg / ygg
      const target = motionTarget(key, n);
      if (target) return rangeOperate(op, target);
      return;
    }
    if (state.pending.startsWith('gop:')) {
      const op = state.pending.slice(4);
      state.pending = ''; state.count = '';
      if (key === 'g') return rangeOperate(op, { line: clamp(n - 1, 0, b.lines.length - 1), col: 0, linewise: true });
      return;
    }
    if (state.pending === 'r') {
      state.pending = ''; state.count = '';
      const line = cur();
      if (line.length) { b.lines[b.line] = line.slice(0, b.col) + key + line.slice(b.col + 1); touch(); }
      return;
    }

    // Visual line mode: V, a motion, then an operator over the selected lines. `p` over a
    // selection replaces it, which is how one cell's text becomes another's.
    if (state.visual) {
      if (key === 'V' || key === 'Esc') { state.visual = null; return; }
      if ('dyxcp'.includes(key)) {
        const from = Math.min(state.visual.line, b.line);
        const to = Math.max(state.visual.line, b.line);
        state.visual = null;
        return visualOperate(key, from, to);
      }
      const t = motionTarget(key, n);
      if (t) { b.line = t.line; b.col = clamp(t.col, 0, Math.max(0, (b.lines[t.line] ?? '').length)); }
      if (key === 'g') state.pending = 'g';
      return;
    }
    if (key === 'V') { state.visual = { line: b.line }; return; }

    // One whole cell in that direction, and it keeps going: LL is two cells east. These
    // are the only way between cells, and each step costs a keystroke.
    if (key in CELL_KEYS || key === RANDOM_KEY) {
      const [ddx, ddy] = key === RANDOM_KEY ? DELTAS[Math.floor(rng() * DELTAS.length)] : CELL_KEYS[key];
      state.dx += ddx * n;
      state.dy += ddy * n;
      const nb = buf();
      nb.line = clamp(nb.line, 0, nb.lines.length - 1);
      nb.col = clamp(nb.col, 0, Math.max(0, (nb.lines[nb.line] ?? '').length));
      note(`moved ${key} to (${state.dx},${state.dy})`);
      state.count = '';
      return;
    }

    state.count = '';

    switch (key) {
      case 'h': case 'l': case 'j': case 'k': case 'w': case 'b': case 'e':
      case '0': case '^': case '$': case 'G': {
        const t = motionTarget(key, n);
        if (t) { b.line = t.line; b.col = clamp(t.col, 0, Math.max(0, (b.lines[t.line] ?? '').length - (t.exclusiveEnd ? 0 : 1))); }
        return;
      }
      case 'g': state.pending = 'g'; return;
      case 'd': case 'y': case 'c': state.pending = key; state.opCount = n; return;
      case 'r': state.pending = 'r'; return;

      case 'i': state.mode = 'insert'; return;
      case 'a': state.mode = 'insert'; b.col = Math.min(b.col + 1, cur().length); return;
      case 'I': state.mode = 'insert'; b.col = 0; return;
      case 'A': state.mode = 'insert'; b.col = cur().length; return;
      case 'o': b.lines.splice(b.line + 1, 0, ''); b.line++; b.col = 0; state.mode = 'insert'; touch(); return;
      case 'O': b.lines.splice(b.line, 0, ''); b.col = 0; state.mode = 'insert'; touch(); return;

      case 'x': {
        const line = cur();
        if (line.length) {
          const take = Math.min(n, line.length - b.col);
          state.register = { text: line.slice(b.col, b.col + take), linewise: false };
          b.lines[b.line] = line.slice(0, b.col) + line.slice(b.col + take);
          b.col = clamp(b.col, 0, Math.max(0, b.lines[b.line].length - 1));
          touch();
        }
        return;
      }
      case 'D': {
        const line = cur();
        state.register = { text: line.slice(b.col), linewise: false };
        b.lines[b.line] = line.slice(0, b.col); touch(); return;
      }
      case 'C': {
        const line = cur();
        state.register = { text: line.slice(b.col), linewise: false };
        b.lines[b.line] = line.slice(0, b.col); state.mode = 'insert'; touch(); return;
      }
      case 'Y': lineOperate('y', n); return;

      case 'p': case 'P': return paste(key === 'p');
      case 'u': return;   // no undo yet: a turn is short and its cost is already paid
      default: return;    // an unknown key is a no-op, which is what makes noise survivable
    }
  }

  // Where a motion lands. `linewise` marks motions that operate on whole lines.
  function motionTarget(key, n) {
    const b = buf();
    const line = cur();
    switch (key) {
      case 'h': return { line: b.line, col: Math.max(0, b.col - n) };
      case 'l': return { line: b.line, col: Math.min(line.length, b.col + n) };
      case 'j': return { line: clamp(b.line + n, 0, b.lines.length - 1), col: b.col, linewise: true };
      case 'k': return { line: clamp(b.line - n, 0, b.lines.length - 1), col: b.col, linewise: true };
      case '0': return { line: b.line, col: 0 };
      case '^': return { line: b.line, col: Math.max(0, line.search(/\S/)) };
      case '$': return { line: b.line, col: line.length, exclusiveEnd: true };
      case 'G': return { line: state.count ? clamp(n - 1, 0, b.lines.length - 1) : b.lines.length - 1, col: 0, linewise: true };
      case 'w': return { line: b.line, col: wordForward(line, b.col, n), exclusiveEnd: true };
      case 'b': return { line: b.line, col: wordBack(line, b.col, n) };
      case 'e': return { line: b.line, col: wordEnd(line, b.col, n) };
      default: return null;
    }
  }

  // An operator over whole lines selected in visual mode. `p` swaps the selection for the
  // register, which is the natural way to make one cell's text become another's.
  function visualOperate(key, from, to) {
    const b = buf();
    const taken = b.lines.slice(from, to + 1);
    if (key === 'y') { state.register = { text: taken.join('\n'), linewise: true }; b.line = from; note(`yanked ${taken.length} line(s)`); return; }
    if (key === 'p') {
      const reg = state.register;
      if (!reg.text) return;
      const put = reg.linewise ? reg.text.split('\n') : [reg.text];
      b.lines.splice(from, to - from + 1, ...put);
      state.register = { text: taken.join('\n'), linewise: true };   // vi swaps them over
      b.line = clamp(from, 0, b.lines.length - 1); b.col = 0;
      touch();
      note(`replaced ${taken.length} line(s) with ${put.length}`);
      return;
    }
    state.register = { text: taken.join('\n'), linewise: true };
    b.lines.splice(from, to - from + 1, ...(key === 'c' ? [''] : []));
    if (!b.lines.length) b.lines.push('');
    b.line = clamp(from, 0, b.lines.length - 1); b.col = 0;
    if (key === 'c') state.mode = 'insert';
    touch();
    note(`${key === 'c' ? 'changed' : 'deleted'} ${taken.length} line(s)`);
  }

  function lineOperate(op, n) {
    const b = buf();
    const from = b.line;
    const to = clamp(b.line + n - 1, 0, b.lines.length - 1);
    const taken = b.lines.slice(from, to + 1);
    state.register = { text: taken.join('\n'), linewise: true };
    if (op === 'y') { note(`yanked ${taken.length} line(s)`); return; }
    b.lines.splice(from, to - from + 1, ...(op === 'c' ? [''] : []));
    if (!b.lines.length) b.lines.push('');
    b.line = clamp(from, 0, b.lines.length - 1);
    b.col = 0;
    if (op === 'c') state.mode = 'insert';
    touch();
    note(`${op === 'd' ? 'deleted' : 'changed'} ${taken.length} line(s)`);
  }

  function rangeOperate(op, target) {
    const b = buf();
    if (target.linewise) {
      const from = Math.min(b.line, target.line);
      const to = Math.max(b.line, target.line);
      const taken = b.lines.slice(from, to + 1);
      state.register = { text: taken.join('\n'), linewise: true };
      if (op === 'y') { note(`yanked ${taken.length} line(s)`); b.line = from; return; }
      b.lines.splice(from, to - from + 1, ...(op === 'c' ? [''] : []));
      if (!b.lines.length) b.lines.push('');
      b.line = clamp(from, 0, b.lines.length - 1);
      b.col = 0;
      if (op === 'c') state.mode = 'insert';
      touch();
      note(`${op === 'd' ? 'deleted' : 'changed'} ${taken.length} line(s)`);
      return;
    }
    const line = cur();
    const from = Math.min(b.col, target.col);
    const to = Math.max(b.col, target.col);
    state.register = { text: line.slice(from, to), linewise: false };
    if (op === 'y') return;
    b.lines[b.line] = line.slice(0, from) + line.slice(to);
    b.col = from;
    if (op === 'c') state.mode = 'insert';
    touch();
  }

  function paste(after) {
    const b = buf();
    const reg = state.register;
    if (!reg.text) return;
    if (reg.linewise) {
      const at = after ? b.line + 1 : b.line;
      b.lines.splice(at, 0, ...reg.text.split('\n'));
      b.line = at; b.col = 0;
    } else {
      const line = cur();
      const at = after ? Math.min(line.length, b.col + 1) : b.col;
      b.lines[b.line] = line.slice(0, at) + reg.text + line.slice(at);
      b.col = at + reg.text.length - 1;
    }
    touch();
    note(`pasted ${reg.linewise ? reg.text.split('\n').length + ' line(s)' : reg.text.length + ' char(s)'}`);
  }
}

function wordForward(line, col, n) {
  let i = col;
  for (let k = 0; k < n; k++) {
    while (i < line.length && isWord(line[i])) i++;
    while (i < line.length && !isWord(line[i])) i++;
  }
  return Math.min(i, line.length);
}

function wordBack(line, col, n) {
  let i = col;
  for (let k = 0; k < n; k++) {
    while (i > 0 && !isWord(line[i - 1])) i--;
    while (i > 0 && isWord(line[i - 1])) i--;
  }
  return Math.max(0, i);
}

function wordEnd(line, col, n) {
  let i = col;
  for (let k = 0; k < n; k++) {
    i++;
    while (i < line.length && !isWord(line[i])) i++;
    while (i + 1 < line.length && isWord(line[i + 1])) i++;
  }
  return Math.min(i, Math.max(0, line.length - 1));
}
