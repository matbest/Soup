import { coords, occupiedIndices } from './soup.js';
import { TOOLS, READS, parseReply, runCall, renderResults } from './tools.js';

// Tierra's slicer, minus the reaper. Sweeps every occupied cell once in a random order,
// one cell per tick, then reshuffles. `opts` is read live so the UI can change it mid-run.
//
// A tick is one cell's turn, and a turn is a small agent loop: the cell's text and the
// TOOLS go to the model; its calls run; if any were reads, the results go back and it
// gets another round, up to `opts.rounds`. Each round is paid for in tokens.
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
    const messages = prompt(cell.md);
    const ev = { tick: 0, x, y, rounds: [], effects: [], usage: { prompt_tokens: 0, completion_tokens: 0 } };
    try {
      for (let r = 0; r < Math.max(1, opts.rounds); r++) {
        active = i;
        let out;
        try {
          // A malformed reply is a turn that does nothing, and was paid for.
          out = await engine.complete({ messages, maxTokens: opts.maxTokens, temperature: opts.temperature });
        } finally {
          active = null;
        }
        const u = engine.lastUsage;
        if (u) { ev.usage.prompt_tokens += u.prompt_tokens ?? 0; ev.usage.completion_tokens += u.completion_tokens ?? 0; }
        const { thoughts, calls } = parseReply(out);
        const results = calls.map(c => runCall(soup, x, y, c, { noise: opts.noise }));
        ev.rounds.push({ out, thoughts, calls, results });
        for (const res of results) if (res.effect) ev.effects.push(res.effect);
        if (!calls.some(c => READS.has(c.tool))) break;
        messages.push({ role: 'assistant', content: out }, { role: 'user', content: renderResults(calls, results) });
      }
    } finally {
      soup.tick++;
      ev.tick = soup.tick;
      cell.turns++;
      if (ev.effects.length === 0) cell.fails++;
      soup.cells[i].last = ev;   // whoever now occupies the cell, possibly a replacement
      log.push(ev);
      if (log.length > 500) log.shift();
    }
    return ev;
  }

  return { step, log, get active() { return active; } };
}

// What a cell's turn starts from: its own text, then the TOOLS. Nothing else.
export function prompt(md) {
  return [
    { role: 'system', content: '' },
    { role: 'user', content: `${md}\n\n${TOOLS}` },
  ];
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
