import { DIR_NAMES } from './soup.js';
import { charBudget } from './tokens.js';
import { mutate } from './mutate.js';

// A fake model. It cannot read the document; it behaves the way a well-formed ancestor
// should: echo its raw text and place it into an empty neighbour (else any). `slip` is
// per-character unfaithfulness in the echo, standing in for a real model's copy errors.
// Occasionally it does something valid but dumb instead. Exists so the loop, view and
// dynamics can be worked on without a GPU, and as the control for whether behaviour is
// coming from the model or from the rules.
export function createMockEngine({ rng = Math.random, chatter = 0.02, slip = 0 } = {}) {
  return {
    name: 'mock',
    instant: true,
    lastUsage: null,
    gpu: null,
    async load() {},
    async complete({ doc, slots, maxTokens }) {
      const empties = slots.empty === 'none' ? [] : slots.empty.split(', ');
      const pool = empties.length ? empties : DIR_NAMES;
      const dir = pool[Math.floor(rng() * pool.length)];
      const out = rng() < chatter
        ? `Sure! Happy to help.\n<tool_call>{"append":"${dir}","text":"hello"}</tool_call>`
        : `${mutate(doc, slip, rng)}\n<tool_call>{"place":"${dir}"}</tool_call>`;
      // The slice. Run out of tokens and the tool call is lost with them.
      return out.slice(0, charBudget(maxTokens));
    },
  };
}
