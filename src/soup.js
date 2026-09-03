// Soup state. Pure data: no DOM, no model.

export const DIRS = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
export const DIR_NAMES = Object.keys(DIRS);

export function createSoup(w, h) {
  // `spent` is the compute this sweep has used, in tokens. Compute is finite, so what one
  // cell spends is not there for another: that is the only thing they compete over apart
  // from space.
  return { w, h, tick: 0, sweep: 0, spent: 0, starved: 0, cells: Array.from({ length: w * h }, emptyCell) };
}

export function emptyCell() {
  // The cursor is part of a cell's state, so where a lineage leaves it is inherited.
  // `credit` is the compute a cell has saved up. A turn debits what it cost, so an
  // expensive cell spends longer earning its next one.
  return { md: null, gen: 0, born: 0, turns: 0, fails: 0, last: null, credit: 0, cursor: { line: 0, col: 0 } };
}

export function wrap(soup, x, y) {
  const { w, h } = soup;
  return [((x % w) + w) % w, ((y % h) + h) % h];
}

export function index(soup, x, y) {
  const [wx, wy] = wrap(soup, x, y);
  return wy * soup.w + wx;
}

export function coords(soup, i) {
  return [i % soup.w, Math.floor(i / soup.w)];
}

export function at(soup, x, y) {
  return soup.cells[index(soup, x, y)];
}

export function neighbourCoords(soup, x, y, dir) {
  const [dx, dy] = DIRS[dir];
  return wrap(soup, x + dx, y + dy);
}

// Put a genome in a cell. This is both seeding and overwriting; there is no other way in.
export function place(soup, x, y, md, { gen = 0 } = {}) {
  const c = at(soup, x, y);
  c.md = md.trim();
  c.gen = gen;
  c.born = soup.tick;
  c.turns = 0;
  c.fails = 0;
  c.last = null;
  c.cursor = { line: 0, col: 0 };
  c.credit = 0;   // born owing nothing and owning nothing
  return c;
}

export function clear(soup, x, y) {
  Object.assign(at(soup, x, y), emptyCell());
}

export function occupiedIndices(soup) {
  const out = [];
  for (let i = 0; i < soup.cells.length; i++) if (soup.cells[i].md !== null) out.push(i);
  return out;
}

// FNV-1a, 32-bit. Identical genomes hash identically, which is all the view needs.
export function hashMd(md) {
  let h = 0x811c9dc5;
  for (let i = 0; i < md.length; i++) {
    h ^= md.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function stats(soup) {
  let occupied = 0, len = 0, fails = 0, turns = 0;
  const genomes = new Map();
  for (const c of soup.cells) {
    if (c.md === null) continue;
    occupied++;
    len += c.md.length;
    fails += c.fails;
    turns += c.turns;
    const k = hashMd(c.md);
    genomes.set(k, (genomes.get(k) || 0) + 1);
  }
  let dominant = 0;
  for (const n of genomes.values()) if (n > dominant) dominant = n;
  return {
    tick: soup.tick,
    sweep: soup.sweep,
    spent: soup.spent ?? 0,
    starved: soup.starved ?? 0,
    income: soup.income ?? 0,
    occupied,
    total: soup.cells.length,
    distinct: genomes.size,
    dominant,
    meanLen: occupied ? len / occupied : 0,
    failRate: turns ? fails / turns : 0,
  };
}

// Put a snapshot back. Anything missing from an older file takes its default, so a
// saved soup keeps working as the format grows.
export function restore(data) {
  const soup = createSoup(data.w, data.h);
  soup.tick = data.tick ?? 0;
  soup.sweep = data.sweep ?? 0;
  soup.spent = data.spent ?? 0;
  (data.cells || []).forEach((c, i) => {
    if (!c || c.md == null || i >= soup.cells.length) return;
    Object.assign(soup.cells[i], emptyCell(), {
      md: c.md, gen: c.gen ?? 0, born: c.born ?? 0, turns: c.turns ?? 0, fails: c.fails ?? 0,
    });
  });
  return soup;
}

// The population by distinct text: how many cells carry it, how long it has been in the
// soup, and how many generations deep. This is the thing to watch — what persists.
export function population(soup, top = 6) {
  const groups = new Map();
  for (const c of soup.cells) {
    if (c.md === null) continue;
    const g = groups.get(c.md) || { md: c.md, n: 0, oldest: Infinity, maxGen: 0 };
    g.n++;
    g.oldest = Math.min(g.oldest, c.born);
    g.maxGen = Math.max(g.maxGen, c.gen);
    groups.set(c.md, g);
  }
  return [...groups.values()].sort((a, b) => b.n - a.n || a.oldest - b.oldest).slice(0, top);
}

export function snapshot(soup) {
  return JSON.stringify({
    w: soup.w, h: soup.h, tick: soup.tick, sweep: soup.sweep, spent: soup.spent ?? 0,
    cells: soup.cells.map(c => ({ md: c.md, gen: c.gen, born: c.born, turns: c.turns, fails: c.fails })),
  });
}
