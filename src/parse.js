// The instruction set. One instruction:
//
//   WRITE <N|E|S|W>
//   <text>
//   END
//
// The first WRITE line opens the block; the LAST bare END line closes it, so a genome may
// mention END in prose without terminating its own copy early. One write per turn.
// Returns null when there is no complete block, including when the slice ran out before
// END, which is how a too-long genome fails to reproduce.
export function parseWrite(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let start = -1, dir = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*WRITE\s+([NESW])\s*$/.exec(lines[i]);
    if (m) { start = i; dir = m[1]; break; }
  }
  if (start < 0) return null;
  let end = -1;
  for (let i = lines.length - 1; i > start; i--) {
    if (/^\s*END\s*$/.test(lines[i])) { end = i; break; }
  }
  if (end < 0) return null;
  const md = lines.slice(start + 1, end).join('\n').trim();
  if (!md) return null;
  return { dir, md };
}
