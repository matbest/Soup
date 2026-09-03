import { coords, occupiedIndices } from './soup.js';
import { estimateTokens } from './tokens.js';
import * as tools from './tools.js';
import { viPrompt, viTurn, keystrokesFrom } from './vi-soup.js';
import { seeded } from './vi.js';
const { READS, parseReply, runCall, renderResults } = tools;

const schemaFor = (writeOnly, n) => JSON.stringify(writeOnly ? tools.writeSchema(n) : tools.replySchema(n));

// Tierra's slicer, minus the reaper. Sweeps the occupied cells in a random order, one
// cell per tick, then reshuffles. `opts` is read live so the UI can change it mid-run.
//
// Compute is finite. Each sweep every living cell is given the same allowance of tokens,
// which it keeps as credit, and a turn debits what it actually cost — the whole prompt
// and the whole reply. While a cell is still in credit it goes again, so a cheap genome
// takes several turns in the time an expensive one takes none, and a genome dear enough
// to overrun its allowance spends whole sweeps saving up for a single turn.
//
// Nothing is taken from anybody and nothing is decreed. The only rule is that compute
// spent is compute gone. Tierra's slicer allotted time by creature size, and its ancestor
// shrank from 80 instructions to 36.
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
    let looked = 0;
    while (i < 0) {
      if (queue.length === 0) {
        const living = occupiedIndices(soup);
        if (living.length === 0) return null;   // the soup is dead
        soup.sweep++;
        soup.spent = 0;
        soup.income = opts.allowance > 0 ? opts.allowance : 0;
        if (soup.income) for (const j of living) soup.cells[j].credit += soup.income;
        soup.starved = soup.income ? living.filter(j => soup.cells[j].credit <= 0).length : 0;
        queue = shuffle(living);
        // Nobody can afford a turn yet: let the sweeps pass until somebody can.
        if (soup.income && ++looked > 5000) return null;
      }
      const j = queue.pop();
      const c = soup.cells[j];
      if (c.md === null) continue;                            // cleared since the shuffle
      if (opts.allowance > 0 && c.credit <= 0) continue;      // in debt: saving up
      i = j;
    }
    const cell = soup.cells[i];
    const [x, y] = coords(soup, i);
    // Every turn starts in a fresh environment: the cell's own text and the instruction
    // set, with nothing inherited from whichever cell ran last.
    await engine.reset?.();
    if (opts.mode === 'vi') return viStep(i, cell, x, y);
    const messages = prompt(cell.md);
    const ev = { tick: 0, x, y, rounds: [], effects: [], usage: { prompt_tokens: 0, completion_tokens: 0 } };
    const last = Math.max(1, opts.rounds) - 1;
    let repeated = false;
    try {
      for (let r = 0; r <= last; r++) {
        active = i;
        let out;
        // The last round, or one that just repeated itself, cannot read: small models will
        // otherwise list the files over and over and never act.
        const writeOnly = r === last || repeated;
        // The turn's budget covers everything the turn costs: the cell's own text, what it
        // reads, and what it says. A cell too long to afford its own prompt cannot act at
        // all, and so cannot reproduce: length is priced, and past a point it is lethal.
        const promptTokens = messages.reduce((n, m) => n + estimateTokens(m.content), 0);
        if (promptTokens + opts.maxTokens > opts.budget) { ev.overBudget = true; break; }
        try {
          // Under the grammar the reply cannot be malformed. Without it, a reply the parser
          // cannot read is a turn that does nothing, and was paid for.
          out = await engine.complete({ messages, schema: opts.grammar ? schemaFor(writeOnly, Math.max(1, opts.calls ?? 1)) : null, maxTokens: opts.maxTokens, temperature: opts.temperature });
        } finally {
          active = null;
        }
        const u = engine.lastUsage;
        if (u) { ev.usage.prompt_tokens += u.prompt_tokens ?? 0; ev.usage.completion_tokens += u.completion_tokens ?? 0; }
        const cost = (u?.prompt_tokens ?? 0) + (u?.completion_tokens ?? 0);
        soup.spent += cost;
        cell.credit -= cost;
        if (r === last) requeue(i);
        const { thoughts, calls } = parseReply(out);
        const results = calls.map(c => runCall(soup, x, y, c, { noise: opts.noise, readLimit: opts.readLimit }));
        ev.rounds.push({ out, thoughts, calls, results, finish: engine.lastFinish ?? null, reasoning: engine.lastReasoning || '' });
        for (const res of results) if (res.effect) ev.effects.push(res.effect);
        if (!calls.some(c => READS.has(c.tool))) break;
        repeated = ev.rounds.length > 1 && sameCalls(calls, ev.rounds[ev.rounds.length - 2].calls);
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

  // A cell that has not spent its allowance goes again this sweep, behind everyone else.
  function requeue(i) {
    if (opts.allowance > 0 && soup.cells[i].md !== null && soup.cells[i].credit > 0) queue.unshift(i);
  }

  // A vi turn: one call, and whatever comes back is run as keystrokes over the grid.
  async function viStep(i, cell, x, y) {
    const messages = viPrompt(cell.md);
    // The turn budget covers everything a turn costs, and in vi mode the cell's own text
    // is all of the prompt. A genome too long to afford itself cannot act, so it cannot
    // reproduce: length is priced, and past a point it is lethal. It also keeps prefill —
    // one GPU dispatch, whose duration grows with it — from growing without limit.
    const promptTokens = messages.reduce((n, m) => n + estimateTokens(m.content), 0);
    if (opts.budget > 0 && promptTokens + opts.maxTokens > opts.budget) {
      soup.tick++;
      cell.turns++;
      cell.fails++;
      const ev = { tick: soup.tick, x, y, mode: 'vi', keys: '', keyCount: 0, effects: [], viLog: [],
        overBudget: true, usage: null, rounds: [{ out: '', calls: [], results: [] }] };
      cell.last = ev;
      log.push(ev);
      if (log.length > 500) log.shift();
      return ev;
    }
    active = i;
    let out;
    try {
      out = await engine.complete({ messages, maxTokens: opts.maxTokens, temperature: opts.temperature });
    } finally {
      active = null;
    }
    soup.tick++;
    cell.turns++;
    const cost = (engine.lastUsage?.prompt_tokens ?? 0) + (engine.lastUsage?.completion_tokens ?? 0);
    soup.spent += cost;
    cell.credit -= cost;
    requeue(i);
    // The same seed for the replay and for the turn itself, so what is watched is what
    // happens rather than a second roll of the dice.
    const seed = (Math.random() * 0x100000000) >>> 0;
    if (opts.onAnimate) await opts.onAnimate({ x, y, keys: keystrokesFrom(out), seed });
    const r = viTurn(soup, x, y, out, { noise: opts.noise, keyLimit: opts.keyLimit ?? 400, rng: seeded(seed) });
    if (!r.effects.length) cell.fails++;
    const ev = {
      tick: soup.tick, x, y, mode: 'vi', keys: r.keys, keyCount: r.keyCount,
      effects: r.effects, viLog: r.log, usage: engine.lastUsage ?? null,
      rounds: [{ out, calls: [], results: [], finish: engine.lastFinish ?? null }],
    };
    soup.cells[i].last = ev;
    log.push(ev);
    if (log.length > 500) log.shift();
    return ev;
  }

  return { step, log, get active() { return active; } };
}

export { viPrompt };

// What a cell's turn starts from: its own text, then the TOOLS. Nothing else.
export function prompt(md) {
  return [
    { role: 'system', content: '' },
    { role: 'user', content: `${md}\n\n${tools.TOOLS}` },
  ];
}

function sameCalls(a, b) {
  return a.length === b.length && a.every((c, i) => JSON.stringify(c) === JSON.stringify(b[i]));
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
