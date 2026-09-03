// A cell is a document, and the document is the whole program. This module turns one
// into the messages a model receives, and nothing more: the host injects no prompt.
//
// A document is a JSON object. `system` and `user` are the only keys the host knows;
// they are sent as those messages with slots expanded, once. Any other key is the
// cell's own state, readable through a slot of the same name. A document that is not
// valid JSON is not dead: its whole text is sent as the user message, slots still
// expand, and `place` still copies it byte for byte. It has only lost its structure.

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

// The document's own fields become slots too, and take precedence over the host's: a
// document that carries its own `actions` field has replaced the manual with its own.
export function buildMessages(md, hostSlots) {
  const doc = parseDoc(md);
  if (!doc) {
    return [
      { role: 'system', content: '' },
      { role: 'user', content: expand(md, hostSlots) },
    ];
  }
  const slots = { ...hostSlots };
  for (const [k, v] of Object.entries(doc)) if (v !== null && v !== undefined) slots[k] = asText(v);
  return [
    { role: 'system', content: expand(asText(doc.system ?? ''), slots) },
    { role: 'user', content: expand(asText(doc.user ?? ''), slots) },
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
