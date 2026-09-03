// The toolset: the TOOLS text every cell is shown, and the executor that runs a call.
//
// A cell is a markdown file. Its neighbourhood is five paths: self, north, south, east,
// west. A turn is a small agent loop: the model replies with calls; reads return results
// and it gets another round; writes take effect at once. Nothing is seen unless asked
// for, and every round is paid for in tokens.

import { at, neighbourCoords, place as placeCell, clear as clearCell } from './soup.js';
import { mutate } from './mutate.js';

export const PATHS = ['self', 'north', 'south', 'east', 'west'];
const DIR_OF = { north: 'N', south: 'S', east: 'E', west: 'W' };

export const TOOL_NAMES = new Set([
  'list_files', 'read_file', 'copy_file', 'create_file',
  'replace_text', 'insert_after', 'insert_before', 'append_text', 'delete_file',
]);

export const READS = new Set(['list_files', 'read_file']);

// Shown after every cell's text, verbatim.
export const TOOLS = [
  'TOOLS',
  'Reply with one JSON object: {"thoughts": "...", "calls": [ ... ]}. Thoughts are optional.',
  'Each call names a tool and its arguments. Reads return results and you get another round',
  'to act on them; writes take effect at once. Paths are: self, north, south, east, west.',
  '',
  '{"tool":"list_files","directory":"."}                        which paths exist, and their sizes',
  '{"tool":"read_file","path":P}                                the contents of P',
  '{"tool":"copy_file","src":P,"dst":P}                         copy a file over another; a copy is how you reproduce',
  '{"tool":"create_file","path":P,"content":"..."}              write a new file over P',
  '{"tool":"replace_text","path":P,"old_text":"...","new_text":"..."}   replace the first occurrence',
  '{"tool":"insert_after","path":P,"anchor":"...","text":"..."}       insert a line after the line containing anchor',
  '{"tool":"insert_before","path":P,"anchor":"...","text":"..."}      insert a line before it',
  '{"tool":"append_text","path":P,"text":"..."}                 add a line at the end of P',
  '{"tool":"delete_file","path":P}                              empty P',
].join('\n');

// Read a reply. The shape is whatever the model felt like, so accept the shapes models
// actually produce: our own; {"name","arguments"} as they were trained
// on; {"read_file": {...}} keyed by tool; "tool" followed by an args object; a bare
// array. Anything else, or a cut-off reply, is a turn that does nothing.
export function parseReply(text) {
  let o = null;
  try { o = JSON.parse(text); } catch {
    const a = text.search(/[{[]/), b = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (a >= 0 && b > a) { try { o = JSON.parse(text.slice(a, b + 1)); } catch { /* not a reply */ } }
  }
  const list = Array.isArray(o) ? o
    : o && typeof o === 'object' ? (o.calls ?? o.tool_calls ?? o.actions ?? (TOOL_NAMES.has(o.tool ?? o.name) ? [o] : []))
    : [];
  return { thoughts: typeof o?.thoughts === 'string' ? o.thoughts : '', calls: normalise(Array.isArray(list) ? list : []) };
}

function normalise(list) {
  const out = [];
  const args = v => (typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return {}; } })() : v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (typeof c === 'string' && TOOL_NAMES.has(c)) {
      const next = list[i + 1];
      if (next && typeof next === 'object' && !Array.isArray(next) && !TOOL_NAMES.has(next.tool ?? next.name)) { out.push({ tool: c, ...next }); i++; }
      else out.push({ tool: c });
      continue;
    }
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const name = TOOL_NAMES.has(c.tool) ? c.tool : TOOL_NAMES.has(c.name) ? c.name : TOOL_NAMES.has(c.function?.name) ? c.function.name : null;
    if (name) {
      const a = c.arguments ?? c.args ?? c.parameters ?? c.function?.arguments;
      const { tool, name: _n, function: _f, arguments: _a, args: _g, parameters: _p, ...rest } = c;
      out.push({ ...rest, ...args(a), tool: name });
      continue;
    }
    const k = Object.keys(c).find(k => TOOL_NAMES.has(k));
    if (k) {
      const v = c[k];
      out.push(typeof v === 'string' ? { tool: k, path: v } : { ...args(v), tool: k });
    }
  }
  return out;
}

// Run one call from the cell at (x, y). Returns { ok, output, effect? }; `effect` is the
// write that happened, for the log and the view.
export function runCall(soup, x, y, c, { noise = 0 } = {}) {
  const source = at(soup, x, y);
  const resolve = p => (p === 'self' ? [x, y] : neighbourCoords(soup, x, y, DIR_OF[p]));
  const argPath = p => (PATHS.includes(p) ? p : null);
  const fail = output => ({ ok: false, output });
  const okay = (output, effect) => ({ ok: true, output, effect });

  switch (c.tool) {
    case 'list_files': {
      const lines = [`at (${x}, ${y})`];
      for (const p of PATHS) {
        const cell = at(soup, ...resolve(p));
        lines.push(`${p.padEnd(6)} ${cell.md === null ? 'empty' : `${cell.md.length} bytes`}`);
      }
      return okay(lines.join('\n'));
    }
    case 'read_file': {
      const p = argPath(c.path); if (!p) return fail('no such path');
      const cell = at(soup, ...resolve(p));
      return cell.md === null ? fail(`${p} is empty`) : okay(cell.md);
    }
    case 'copy_file': {
      const src = argPath(c.src), dst = argPath(c.dst);
      if (!src || !dst) return fail('no such path');
      if (src === dst) return fail('src and dst are the same file');
      const from = at(soup, ...resolve(src));
      if (from.md === null) return fail(`${src} is empty`);
      const [tx, ty] = resolve(dst);
      const overwrote = at(soup, tx, ty).md !== null;
      const md = mutate(from.md, noise);
      placeCell(soup, tx, ty, md, { gen: source.gen + 1 });
      return okay(`copied ${md.length} bytes to ${dst}`, { verb: 'copy', target: dst, x: tx, y: ty, overwrote, mutated: md !== from.md });
    }
    case 'create_file': {
      const p = argPath(c.path); if (!p) return fail('no such path');
      const content = String(c.content ?? '').trim();
      if (!content) return fail('content is empty');
      const [tx, ty] = resolve(p);
      const overwrote = at(soup, tx, ty).md !== null;
      placeCell(soup, tx, ty, content, { gen: source.gen + 1 });
      return okay(`wrote ${content.length} bytes to ${p}`, { verb: 'create', target: p, x: tx, y: ty, overwrote });
    }
    case 'replace_text':
    case 'insert_after':
    case 'insert_before':
    case 'append_text': {
      const p = argPath(c.path); if (!p) return fail('no such path');
      const [tx, ty] = resolve(p);
      const cell = at(soup, tx, ty);
      let text = cell.md;
      if (c.tool === 'append_text') {
        const add = String(c.text ?? '').trim();
        if (!add) return fail('text is empty');
        text = text === null ? add : `${text}\n${add}`;
      } else {
        if (text === null) return fail(`${p} is empty`);
        const needle = String(c.tool === 'replace_text' ? c.old_text : c.anchor);
        const i = find(text, needle);
        if (i < 0) return fail(`${c.tool === 'replace_text' ? 'old_text' : 'anchor'} not found in ${p}`);
        if (c.tool === 'replace_text') {
          text = text.slice(0, i) + String(c.new_text ?? '') + text.slice(i + needle.trim().length);
        } else {
          const lineStart = text.lastIndexOf('\n', i) + 1;
          let lineEnd = text.indexOf('\n', i); if (lineEnd < 0) lineEnd = text.length;
          const line = String(c.text ?? '');
          text = c.tool === 'insert_after'
            ? text.slice(0, lineEnd) + '\n' + line + text.slice(lineEnd)
            : text.slice(0, lineStart) + line + '\n' + text.slice(lineStart);
        }
      }
      return okay(`${p} is now ${text.trim().length} bytes`, setText(soup, tx, ty, text, source, p));
    }
    case 'delete_file': {
      const p = argPath(c.path); if (!p) return fail('no such path');
      const [tx, ty] = resolve(p);
      const was = at(soup, tx, ty).md !== null;
      clearCell(soup, tx, ty);
      return okay(`${p} emptied`, { verb: 'delete', target: p, x: tx, y: ty, overwrote: was });
    }
    default:
      return fail('no such tool');
  }
}

// Exact first, then ignoring surrounding whitespace, then ignoring case. Returns the
// index of the match in the haystack, or -1.
function find(hay, needle) {
  const n = needle.trim();
  if (!n) return -1;
  let i = hay.indexOf(needle);
  if (i < 0) i = hay.indexOf(n);
  if (i < 0) i = hay.toLowerCase().indexOf(n.toLowerCase());
  return i;
}

// An edit keeps the cell's age and lineage; editing an empty cell into existence starts
// one; editing a cell down to nothing empties it.
function setText(soup, x, y, text, source, p) {
  const cell = at(soup, x, y);
  const was = cell.md !== null;
  const md = text.trim();
  if (!md) { clearCell(soup, x, y); return { verb: 'edit', target: p, x, y, overwrote: was, emptied: true }; }
  if (!was) placeCell(soup, x, y, md, { gen: source.gen + 1 });
  else cell.md = md;
  return { verb: 'edit', target: p, x, y, overwrote: false };
}

export function renderResults(calls, results) {
  return 'Results:\n' + results.map((r, k) => {
    const c = calls[k];
    const args = c.tool === 'list_files' ? '.' : c.tool === 'copy_file' ? `${c.src} -> ${c.dst}` : c.path;
    return `${k + 1}. ${c.tool}(${args}) -> ${r.ok ? 'ok' : 'error'}\n${r.output}`;
  }).join('\n\n');
}
