import { DIR_NAMES } from './soup.js';
import { charBudget } from './tokens.js';

// A fake model. It cannot read the document; it behaves the way a well-formed ancestor
// should: place itself into an empty neighbour (else any). Occasionally it does something
// valid but dumb instead. Exists so the loop, view and dynamics can be worked on without
// a GPU, and as the control for whether behaviour is coming from the model or the rules.
export function createMockEngine({ rng = Math.random, chatter = 0.02 } = {}) {
  return {
    name: 'mock',
    instant: true,
    lastUsage: null,
    gpu: null,
    async load() {},
    async complete({ slots, maxTokens }) {
      const empties = slots.empty === 'none' ? [] : slots.empty.split(', ');
      const pool = empties.length ? empties : DIR_NAMES;
      const dir = pool[Math.floor(rng() * pool.length)];
      const reply = rng() < chatter
        ? { thoughts: 'Sure! Happy to help.', actions: [{ set: dir, key: 'system', value: 'hello' }] }
        : { actions: [{ place: dir }] };
      // The slice. Run out of tokens and the reply is not a reply.
      return JSON.stringify(reply).slice(0, charBudget(maxTokens));
    },
  };
}
