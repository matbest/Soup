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

// Nothing. The cell's text is the entire body sent to the model — no reference block, no
// host paragraph, no system turn. If a cell wants the model to know what the keys are, it
// has to carry that knowledge itself, which makes the knowledge heritable and mutable
// like everything else: a lineage that keeps a good reference reproduces, one that loses
// it drifts.
export function viPrompt(md) {
  return [
    { role: 'system', content: '' },
    { role: 'user', content: md },
  ];
}

// The keystrokes in what the model said. A reply is an ordinary one — some prose, then
// the commands — so the commands are taken from whatever the model marked as code: fenced
// blocks first, then backticked spans, in the order it wrote them.
//
// Failing any marking, the last line is taken if it looks like keys rather than words: no
// spaces, and something in it that is not a lowercase letter. That last test is a guess,
// and it is meant to be a cheap one — `ggyGLggVGp` passes, `reproduce` does not. A reply
// with nothing usable in it runs nothing, because prose executed as vi is destruction,
// and a turn that said nothing usable has still spent its slice.
const FENCE = /```[a-z]*\r?\n([\s\S]*?)```/gi;
const TICKS = /`([^`\n]+)`/g;

export function keystrokesFrom(reply) {
  // Line endings are normalised first: a file saved with CRLF would otherwise miss the
  // fence entirely and every backticked word in the prose would be read as keystrokes.
  // Line endings are normalised first: a file saved with CRLF would otherwise miss the
  // fence entirely and every backticked word in the prose would be read as keystrokes.
  const text = String(reply ?? '').replace(/\r\n?/g, '\n');

  const fenced = [...text.matchAll(FENCE)].map(m => m[1].trim()).filter(Boolean);
  if (fenced.length) return fenced.join('').replace(/\n+/g, '');

  const ticked = [...text.matchAll(TICKS)].map(m => m[1].trim()).filter(Boolean);
  if (ticked.length) return ticked.join('');

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  const looksLikeKeys = last.length >= 2 && last.length <= 200 && !/\s/.test(last) && !/^[a-z]+$/.test(last);
  return looksLikeKeys ? last : '';
}

// Run one cell's turn. Returns what changed, for the log and the view.
export function viTurn(soup, x, y, reply, { noise = 0, keyLimit = 400, rng = Math.random } = {}) {
  const keys = keystrokesFrom(reply);
  const source = at(soup, x, y);

  const result = run(
    (dx, dy) => {
      const c = at(soup, x + dx, y + dy);
      return c.md === null ? null : { text: c.md, cursor: c.cursor };
    },
    keys,
    { limit: keyLimit, rng },
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
