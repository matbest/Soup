import { DIRS } from './soup.js';

// The instruction set, as a JSON schema. It is handed to the model as a grammar
// (constrained decoding), so every completion is a syntactically valid instruction:
// Tierra's property that every bit pattern is an opcode. Two instructions:
//
//   {"action":"copy",  "dir":D}             copy this cell's genome into neighbour D
//   {"action":"write", "dir":D, "text":T}   write the text T into neighbour D
//
// Parsing here is the fallback for engines that cannot be constrained (the mock), and
// for outputs cut off by the slice, which is how an over-long write fails.
export const ACTIONS = ['copy', 'write'];

export const ACTION_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    action: { type: 'string', enum: ACTIONS },
    dir: { type: 'string', enum: Object.keys(DIRS) },
    text: { type: 'string' },
  },
  required: ['action', 'dir'],
});

export function parseAction(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  let o;
  try { o = JSON.parse(text.slice(a, b + 1)); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  if (!ACTIONS.includes(o.action) || !(o.dir in DIRS)) return null;
  if (o.action === 'write') return { action: 'write', dir: o.dir, text: typeof o.text === 'string' ? o.text.trim() : '' };
  return { action: 'copy', dir: o.dir };
}
