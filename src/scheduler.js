import { at, coords, neighbourCoords, occupiedIndices, place, clear, DIR_NAMES } from './soup.js';
import { parseAction, ACTION_SCHEMA } from './parse.js';
import { mutate } from './mutate.js';

// Tierra's slicer, minus the reaper. Sweeps every occupied cell once in a random order,
// one cell per tick, then reshuffles. `opts` is read live so the UI can change it mid-run.
export function createScheduler(soup, engine, opts) {
  let queue = [];
  let active = null;   // index of the cell whose turn is at the model right now
  const log = [];

  async function step() {
    let i = -1;
    while (i < 0) {
      if (queue.length === 0) {
        queue = shuffle(occupiedIndices(soup));
        if (queue.length === 0) return null;   // the soup is dead
        soup.sweep++;
      }
      const j = queue.pop();
      if (soup.cells[j].md !== null) i = j;    // may have been cleared since the shuffle
    }
    const cell = soup.cells[i];
    const [x, y] = coords(soup, i);
    const obs = observe(soup, x, y);
    active = i;
    let out;
    try {
      out = await engine.complete({
        system: cell.md,
        user: renderObs(obs),
        obs,
        schema: ACTION_SCHEMA,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
      });
    } finally {
      active = null;
    }
    soup.tick++;
    cell.turns++;
    const ev = { tick: soup.tick, x, y, out, act: null, usage: engine.lastUsage ?? null };
    const a = parseAction(out);
    if (!a) {
      cell.fails++;
    } else {
      const [tx, ty] = neighbourCoords(soup, x, y, a.dir);
      const overwrote = at(soup, tx, ty).md !== null;
      if (a.action === 'copy') {
        const md = mutate(cell.md, opts.noise);
        place(soup, tx, ty, md, { gen: cell.gen + 1 });
        ev.act = { action: 'copy', dir: a.dir, x: tx, y: ty, mutated: md !== cell.md, overwrote };
      } else if (a.text) {
        place(soup, tx, ty, a.text, { gen: cell.gen + 1 });
        ev.act = { action: 'write', dir: a.dir, x: tx, y: ty, mutated: a.text !== cell.md, overwrote };
      } else {
        clear(soup, tx, ty);                   // writing nothing empties the cell
        ev.act = { action: 'clear', dir: a.dir, x: tx, y: ty, mutated: false, overwrote };
      }
    }
    cell.last = ev;
    log.push(ev);
    if (log.length > 500) log.shift();
    return ev;
  }

  return { step, log, get active() { return active; } };
}

// What a cell is told. Neighbours as two lists (small models pattern-match a list far
// better than a sentence), and the example direction letters rotated every turn so the
// example cannot anchor the choice.
export function observe(soup, x, y) {
  const empty = [], occupied = [];
  for (const d of DIR_NAMES) {
    const [nx, ny] = neighbourCoords(soup, x, y, d);
    (at(soup, nx, ny).md === null ? empty : occupied).push(d);
  }
  const ex = shuffle([...DIR_NAMES]);
  return { x, y, empty, occupied, example: [ex[0], ex[1]] };
}

export function renderObs(o) {
  const list = a => (a.length ? a.join(', ') : 'none');
  return `You are the cell at (${o.x}, ${o.y}). Empty adjacent cells: ${list(o.empty)}. Occupied adjacent cells: ${list(o.occupied)}.\n` +
    'Actions: copy your instructions into an adjacent cell, or write text into one. D is the direction: N, E, S or W. ' +
    `Reply with one JSON object, for example {"action":"copy","dir":"${o.example[0]}"} or {"action":"write","dir":"${o.example[1]}","text":"hello"}.`;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
