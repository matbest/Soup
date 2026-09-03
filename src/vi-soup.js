// The vi instruction set, wired into the soup.
//
// A turn is one call. The cell's text goes to the model with a short reference for the
// keys, and whatever comes back is run as keystrokes over the grid, starting in that
// cell. There is no looking around first and no tool protocol: the reply is the program.
//
// So a cell's text is not data the model reads about — it is the thing that has to make
// the model emit a working program. A wording that reliably produces `ggyGLggVGp` spreads;
// one that produces something close but wrong does not. That is the selection pressure,
// and it acts on how the instruction string is written.

import { at, wrap } from './soup.js';
import { run, tokenize } from './vi.js';
import { mutate } from './mutate.js';

// Shown after every cell's text. The only thing the host adds.
export const VI_HELP = [
  'VI. Reply with vi keystrokes on one line and nothing else.',
  'h j k l  0 ^ $  w b e  gg G  3j        move the cursor in this cell',
  'H J K L  2L                            move one cell west south north east, and on',
  'i a I A o O  <Esc>                     insert text',
  'x D r{char}  dd dw dG  cc cw C         delete and change',
  'yy Y yG  p P                           yank and paste',
  'V then a motion then d y c p           visual line; p replaces the selection',
].join('\n');

export function viPrompt(md) {
  return [
    { role: 'system', content: '' },
    { role: 'user', content: `${md}\n\n${VI_HELP}` },
  ];
}

// What the model said, as keystrokes. A fenced block or prose around them is stripped and
// the first non-empty line is taken: a reply is a program, and a program is one line.
export function keystrokesFrom(reply) {
  const body = String(reply ?? '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/```/g, '');
  const line = body.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  return line.replace(/^[`'"]|[`'"]$/g, '');
}

// Run one cell's turn. Returns what changed, for the log and the view.
export function viTurn(soup, x, y, reply, { noise = 0, keyLimit = 400 } = {}) {
  const keys = keystrokesFrom(reply);
  const source = at(soup, x, y);

  const result = run(
    (dx, dy) => {
      const c = at(soup, x + dx, y + dy);
      return c.md === null ? null : { text: c.md, cursor: c.cursor };
    },
    keys,
    { limit: keyLimit },
  );

  const effects = [];
  for (const c of result.cells.values()) {
    const [tx, ty] = wrap(soup, x + c.dx, y + c.dy);
    const cell = at(soup, tx, ty);
    // A cell the cursor only visited keeps its text, but remembers where it was left.
    cell.cursor = c.cursor;
    if (!c.changed) continue;

    const was = cell.md;
    if (c.text === null) {
      cell.md = null;
      cell.gen = 0; cell.turns = 0; cell.fails = 0; cell.last = null;
      effects.push({ verb: 'emptied', dx: c.dx, dy: c.dy, x: tx, y: ty, overwrote: was !== null });
      continue;
    }
    // Writing is lossy: this is where variation enters, and it is the instruction string
    // that varies.
    const text = mutate(c.text, noise);
    cell.md = text;
    if (was === null) { cell.born = soup.tick; cell.turns = 0; cell.fails = 0; cell.last = null; }
    if (c.dx !== 0 || c.dy !== 0) cell.gen = source.gen + 1;
    effects.push({
      verb: was === null ? 'wrote' : 'overwrote',
      dx: c.dx, dy: c.dy, x: tx, y: ty,
      copied: text.trim() === source.md?.trim(),
      mutated: text !== c.text,
      chars: text.length,
    });
  }

  return { keys, keyCount: tokenize(keys).length, effects, log: result.log, at: result.at, mode: result.mode };
}
