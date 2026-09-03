// The verbs, in three forms that must agree: the schema the grammar enforces, the manual
// a document may carry through {{actions}}, and the executor that applies them.
//
// A reply is free text with any number of <tool_call>{…}</tool_call> blocks. Under the
// structural-tag grammar each block is schema-valid by construction, and there is at
// least one. The text outside the blocks is the document a `place` puts somewhere.

import { DIRS, DIR_NAMES, at, neighbourCoords, place as placeCell, clear as clearCell } from './soup.js';
import { mutate } from './mutate.js';

const TARGETS = [...DIR_NAMES, 'self'];
const obj = (props, required) => ({ type: 'object', properties: props, required, additionalProperties: false });
const target = { enum: TARGETS };
const str = { type: 'string' };

export const VERBS = ['place', 'append', 'prepend', 'delete', 'replace', 'clear'];

export const ACTION_SCHEMA = {
  anyOf: [
    obj({ place: target }, ['place']),
    obj({ append: target, text: str }, ['append', 'text']),
    obj({ prepend: target, text: str }, ['prepend', 'text']),
    obj({ delete: target, key: str }, ['delete', 'key']),
    obj({ replace: target, key: str, text: str }, ['replace', 'key', 'text']),
    obj({ clear: target }, ['clear']),
  ],
};

export const BEGIN = '<tool_call>';
export const END = '</tool_call>';

export const STRUCTURAL_TAG = {
  type: 'structural_tag',
  format: {
    type: 'triggered_tags',
    triggers: [BEGIN],
    tags: [{ type: 'tag', begin: BEGIN, content: { type: 'json_schema', json_schema: ACTION_SCHEMA }, end: END }],
    at_least_one: true,
  },
};

// What {{actions}} expands to. Kept beside the schema so the two cannot drift apart.
export const MANUAL = [
  'You may reply with tool calls. Each is one JSON object:',
  `${BEGIN}{"place":"D"}${END} puts your reply text into cell D.`,
  `${BEGIN}{"append":"D","text":"T"}${END} adds line T to the end of D.`,
  `${BEGIN}{"prepend":"D","text":"T"}${END} adds line T to the top of D.`,
  `${BEGIN}{"delete":"D","key":"K"}${END} removes D's first line containing K.`,
  `${BEGIN}{"replace":"D","key":"K","text":"T"}${END} swaps that line for T.`,
  `${BEGIN}{"clear":"D"}${END} empties D.`,
  'D is N, E, S, W, or self.',
].join('\n');

const BLOCK = /<tool_call>([\s\S]*?)<\/tool_call>/g;

// Split a reply into the document text and the calls found in it. Blocks that are not
// valid JSON (possible only without the grammar) are dropped.
export function parseReply(reply) {
  const calls = [];
  for (const m of reply.matchAll(BLOCK)) {
    try {
      const o = JSON.parse(m[1]);
      const verb = VERBS.find(v => v in o);
      if (verb && TARGETS.includes(o[verb])) calls.push({ verb, target: o[verb], text: o.text, key: o.key });
    } catch { /* not an instruction */ }
  }
  const text = reply.replace(BLOCK, '').trim();
  return { text, calls };
}

// Apply the calls of one reply, in order, from the cell at (x, y). Returns what happened.
export function execute(soup, x, y, reply, { noise = 0 } = {}) {
  const { text, calls } = parseReply(reply);
  const source = at(soup, x, y);
  const effects = [];
  for (const c of calls) {
    const [tx, ty] = c.target === 'self' ? [x, y] : neighbourCoords(soup, x, y, c.target);
    const cell = at(soup, tx, ty);
    const ev = { verb: c.verb, target: c.target, x: tx, y: ty, overwrote: cell.md !== null, ok: true };
    switch (c.verb) {
      case 'place': {
        if (!text) { clearCell(soup, tx, ty); ev.verb = 'clear'; break; }
        const md = mutate(text, noise);
        ev.mutated = md !== source.md;
        placeCell(soup, tx, ty, md, { gen: source.gen + 1 });
        break;
      }
      case 'append':
      case 'prepend': {
        const line = String(c.text ?? '').trim();
        if (!line) { ev.ok = false; break; }
        const lines = cell.md === null ? [] : cell.md.split('\n');
        if (c.verb === 'append') lines.push(line); else lines.unshift(line);
        setText(soup, tx, ty, lines.join('\n'), source);
        break;
      }
      case 'delete':
      case 'replace': {
        if (cell.md === null) { ev.ok = false; break; }
        const lines = cell.md.split('\n');
        const i = findLine(lines, c.key);
        if (i < 0) { ev.ok = false; break; }
        if (c.verb === 'delete') lines.splice(i, 1); else lines[i] = String(c.text ?? '').trim();
        setText(soup, tx, ty, lines.join('\n'), source);
        break;
      }
      case 'clear':
        clearCell(soup, tx, ty);
        break;
    }
    effects.push(ev);
  }
  return { text, effects };
}

function findLine(lines, key) {
  const k = String(key ?? '').trim().toLowerCase();
  if (!k) return -1;
  return lines.findIndex(l => l.toLowerCase().includes(k));
}

// An edit keeps the cell's age and lineage; a birth by editing an empty cell starts one.
function setText(soup, x, y, md, source) {
  const cell = at(soup, x, y);
  if (cell.md === null) placeCell(soup, x, y, md, { gen: source.gen + 1 });
  else if (md.trim() === '') clearCell(soup, x, y);
  else cell.md = md.trim();
}
