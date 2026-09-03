import { at, coords, occupiedIndices, neighbourCoords, DIR_NAMES } from './soup.js';
import { buildMessages, makeSlots } from './document.js';
import { execute, STRUCTURAL_TAG, MANUAL } from './actions.js';

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
    const { messages, slots } = prompt(soup, x, y, cell.md, opts);
    active = i;
    let out;
    try {
      out = await engine.complete({
        messages,
        doc: cell.md,
        slots,
        structuralTag: STRUCTURAL_TAG,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
      });
    } finally {
      active = null;
    }
    soup.tick++;
    cell.turns++;
    const { text, effects } = execute(soup, x, y, out, { noise: opts.noise });
    if (effects.length === 0) cell.fails++;
    const ev = { tick: soup.tick, x, y, out, text, effects, usage: engine.lastUsage ?? null };
    soup.cells[i].last = ev;   // whoever now occupies the cell, possibly a replacement
    log.push(ev);
    if (log.length > 500) log.shift();
    return ev;
  }

  return { step, log, get active() { return active; } };
}

// Everything the model will see for the cell at (x, y): its own document, with the slots
// it carries expanded. Nothing else.
export function prompt(soup, x, y, doc, opts) {
  const neighbours = {};
  for (const d of DIR_NAMES) {
    const [nx, ny] = neighbourCoords(soup, x, y, d);
    neighbours[d] = at(soup, nx, ny).md;
  }
  const slots = makeSlots({ doc, x, y, neighbours, tokens: opts.maxTokens, manual: MANUAL });
  return { messages: buildMessages(doc, slots), slots };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
