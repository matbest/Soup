// A cell is a document, and the document is the whole program. This module turns one
// into what a model receives, and nothing more: the host injects no prompt, and knows
// no field names.
//
// A document is a JSON object. What the model gets is that object, every slot inside
// its strings expanded, serialized, as the single user message. The field names mean
// whatever the document says they mean. A document that is not valid JSON is not dead:
// its whole text is sent with slots expanded, and `place` still copies it byte for
// byte. It has only lost its structure.

import { DIR_NAMES } from './soup.js';

export function parseDoc(md) {
  try {
    const o = JSON.parse(md);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

export function serialize(obj) {
  return JSON.stringify(obj, null, 2);
}

export function expand(text, slots) {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name) => (name in slots ? slots[name] : whole));
}

const asText = v => (typeof v === 'string' ? v : JSON.stringify(v));

// Expand slots in every string inside a value, leaving structure alone.
function expandDeep(v, slots) {
  if (typeof v === 'string') return expand(v, slots);
  if (Array.isArray(v)) return v.map(x => expandDeep(x, slots));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandDeep(x, slots)]));
  return v;
}

// The document's own fields become slots too, and take precedence over the host's: a
// document that carries its own `actions` field has replaced the manual with its own.
// The system turn is sent empty so the model's own default ("You are a helpful
// assistant.") does not stand in for one.
export function buildMessages(md, hostSlots) {
  const doc = parseDoc(md);
  let content;
  if (doc) {
    const slots = { ...hostSlots };
    for (const [k, v] of Object.entries(doc)) if (v !== null && v !== undefined) slots[k] = asText(v);
    content = serialize(expandDeep(doc, slots));
  } else {
    content = expand(md, hostSlots);
  }
  return [
    { role: 'system', content: '' },
    { role: 'user', content },
  ];
}

// The slots the host offers. `manual` is the verbs' description; `neighbours` maps a
// direction to a document string or null.
export function makeSlots({ doc, x, y, neighbours, tokens, manual }) {
  const empty = DIR_NAMES.filter(d => neighbours[d] === null);
  const occupied = DIR_NAMES.filter(d => neighbours[d] !== null);
  const list = a => (a.length ? a.join(', ') : 'none');
  const slots = {
    self: doc,
    pos: `(${x}, ${y})`,
    empty: list(empty),
    occupied: list(occupied),
    tokens: String(tokens),
    actions: manual,
  };
  for (const d of DIR_NAMES) slots[d] = neighbours[d] === null ? '(empty)' : neighbours[d];
  return slots;
}
