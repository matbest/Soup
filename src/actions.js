// The verbs, in three forms that must agree: the schema the grammar enforces, the manual
// a document may carry through {{actions}}, and the executor that applies them.
//
// A reply is one JSON object: optional `thoughts` (free text, paid for in the slice)
// and `actions`, at least one, executed in order. Under the grammar the reply cannot be
// malformed. Documents are edited by key, never by position: naming a key it has just
// read is the one edit a small model can do reliably.

import { DIR_NAMES, at, neighbourCoords, place as placeCell, clear as clearCell } from './soup.js';
import { parseDoc, serialize } from './document.js';
import { mutate } from './mutate.js';

const TARGETS = [...DIR_NAMES, 'self'];
const obj = (props, required) => ({ type: 'object', properties: props, required, additionalProperties: false });
const target = { enum: TARGETS };
const str = { type: 'string' };
const any = {};

export const VERBS = ['place', 'set', 'append', 'delete', 'clear'];

export const ACTION_SCHEMA = {
  anyOf: [
    obj({ place: target, doc: { type: 'object' } }, ['place']),
    obj({ set: target, key: str, value: any }, ['set', 'key', 'value']),
    obj({ append: target, key: str, value: str }, ['append', 'key', 'value']),
    obj({ delete: target, key: str }, ['delete', 'key']),
    obj({ clear: target }, ['clear']),
  ],
};

export const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    thoughts: str,
    actions: { type: 'array', items: ACTION_SCHEMA, minItems: 1 },
  },
  required: ['actions'],
  additionalProperties: false,
};

// What {{actions}} expands to. Kept beside the schema so the two cannot drift apart.
export const MANUAL = [
  'Reply with one JSON object: {"thoughts": "...", "actions": [ ... ]}. Thoughts are optional. Each action is one of:',
  '{"place":"D"}                         copies this document into cell D.',
  '{"place":"D","doc":{...}}             places the given document into cell D instead.',
  '{"set":"D","key":"K","value":V}       sets field K of D to V.',
  '{"append":"D","key":"K","value":"T"}  adds T to the end of the text field K of D.',
  '{"delete":"D","key":"K"}              removes field K from D.',
  '{"clear":"D"}                         empties cell D.',
  'D is N, E, S, W, or self.',
].join('\n');

// Read a reply. Without the grammar (the mock, a cut-off reply) this may find nothing.
export function parseReply(reply) {
  let o = null;
  try { o = JSON.parse(reply); } catch {
    const a = reply.indexOf('{'), b = reply.lastIndexOf('}');
    if (a >= 0 && b > a) { try { o = JSON.parse(reply.slice(a, b + 1)); } catch { /* not a reply */ } }
  }
  const actions = [];
  if (o && Array.isArray(o.actions)) {
    for (const a of o.actions) {
      if (!a || typeof a !== 'object') continue;
      const verb = VERBS.find(v => v in a);
      if (verb && TARGETS.includes(a[verb])) actions.push({ verb, target: a[verb], key: a.key, value: a.value, doc: a.doc });
    }
  }
  return { thoughts: typeof o?.thoughts === 'string' ? o.thoughts : '', actions };
}

// Apply the actions of one reply, in order, from the cell at (x, y). Returns what happened.
export function execute(soup, x, y, reply, { noise = 0 } = {}) {
  const { thoughts, actions } = parseReply(reply);
  const source = at(soup, x, y);
  const effects = [];
  for (const a of actions) {
    const [tx, ty] = a.target === 'self' ? [x, y] : neighbourCoords(soup, x, y, a.target);
    const cell = at(soup, tx, ty);
    const ev = { verb: a.verb, target: a.target, x: tx, y: ty, overwrote: cell.md !== null, ok: true };
    switch (a.verb) {
      case 'place': {
        // Copy is hardware; the noise is physics. An authored document goes in as given.
        const raw = a.doc && typeof a.doc === 'object' ? serialize(a.doc) : source.md;
        const md = mutate(raw, noise);
        ev.mutated = md !== source.md;
        placeCell(soup, tx, ty, md, { gen: source.gen + 1 });
        break;
      }
      case 'set':
      case 'append':
      case 'delete': {
        const key = String(a.key ?? '').trim();
        if (!key) { ev.ok = false; break; }
        const doc = cell.md === null ? {} : parseDoc(cell.md);
        if (!doc) { ev.ok = false; break; }              // a document without structure has no fields
        if (a.verb === 'set') doc[key] = a.value ?? '';
        else if (a.verb === 'append') {
          const add = String(a.value ?? '');
          const old = doc[key];
          doc[key] = old === undefined || old === '' ? add : `${typeof old === 'string' ? old : JSON.stringify(old)}\n${add}`;
        } else {
          if (!(key in doc)) { ev.ok = false; break; }
          delete doc[key];
        }
        setDoc(soup, tx, ty, serialize(doc), source);
        break;
      }
      case 'clear':
        clearCell(soup, tx, ty);
        break;
    }
    effects.push(ev);
  }
  return { thoughts, effects };
}

// An edit keeps the cell's age and lineage; an edit that creates a document in an
// empty cell starts one.
function setDoc(soup, x, y, md, source) {
  const cell = at(soup, x, y);
  if (cell.md === null) placeCell(soup, x, y, md, { gen: source.gen + 1 });
  else cell.md = md;
}
