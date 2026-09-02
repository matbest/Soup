import { at, coords, neighbourCoords, occupiedIndices, place, DIR_NAMES } from './soup.js';
import { parseWrite } from './parse.js';

// Tierra's slicer, minus the reaper. Sweeps every occupied cell once in a random order,
// one cell per tick, then reshuffles. `opts` is read live so the UI can change it mid-run.
export function createScheduler(soup, engine, opts) {
  let queue = [];
  const log = [];

  async function step() {
    if (queue.length === 0) {
      queue = shuffle(occupiedIndices(soup));
      if (queue.length === 0) return null;   // the soup is dead
      soup.sweep++;
    }
    const i = queue.pop();
    const cell = soup.cells[i];
    const [x, y] = coords(soup, i);
    const obs = observe(soup, x, y);
    const out = await engine.complete({
      system: cell.md,
      user: renderObs(obs),
      obs,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
    });
    soup.tick++;
    cell.turns++;
    const ev = { tick: soup.tick, x, y, out, write: null };
    const w = parseWrite(out);
    if (w) {
      const [tx, ty] = neighbourCoords(soup, x, y, w.dir);
      const target = at(soup, tx, ty);
      ev.write = { dir: w.dir, x: tx, y: ty, mutated: w.md !== cell.md, overwrote: target.md !== null };
      place(soup, tx, ty, w.md, { gen: cell.gen + 1 });
    } else {
      cell.fails++;
    }
    cell.last = ev;
    log.push(ev);
    if (log.length > 500) log.shift();
    return ev;
  }

  return { step, log };
}

export function observe(soup, x, y) {
  const neighbours = {};
  for (const d of DIR_NAMES) {
    const [nx, ny] = neighbourCoords(soup, x, y, d);
    neighbours[d] = at(soup, nx, ny).md === null ? 'empty' : 'occupied';
  }
  return { x, y, neighbours };
}

export function renderObs(o) {
  const n = o.neighbours;
  return `You are the cell at (${o.x}, ${o.y}). Adjacent cells: N is ${n.N}, E is ${n.E}, S is ${n.S}, W is ${n.W}.\nTake your turn now.`;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
