// A cell is a document, and the document is the whole program. This module turns one
// into the messages a model receives, and nothing more: the host injects no prompt.
//
// Lines reading `system:` or `user:` open sections sent as those messages; text before
// the first label, or a document with no labels, is the user message. A document with no
// system section gets an empty system message, which overrides the model's own default
// ("You are a helpful assistant.") with nothing.
//
// Observations reach a document only through slots it chooses to carry, expanded once,
// without recursion, so the raw text inside {{self}} keeps its slots for echoing.

import { DIR_NAMES } from './soup.js';

const LABEL = /^\s*(system|user):\s*(.*)$/;

export function sections(doc) {
  const out = { system: [], user: [] };
  let current = 'user';
  for (const line of doc.split('\n')) {
    const m = LABEL.exec(line);
    if (m) {
      current = m[1];
      if (m[2]) out[current].push(m[2]);
      continue;
    }
    out[current].push(line);
  }
  return { system: out.system.join('\n').trim(), user: out.user.join('\n').trim() };
}

export function expand(text, slots) {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name) => (name in slots ? slots[name] : whole));
}

export function buildMessages(doc, slots) {
  const s = sections(doc);
  return [
    { role: 'system', content: expand(s.system, slots) },
    { role: 'user', content: expand(s.user, slots) },
  ];
}

// The slots the host offers. `manual` is the verbs' description, `neighbours` maps a
// direction to a document or null.
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
