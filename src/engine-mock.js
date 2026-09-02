import { DIR_NAMES } from './soup.js';
import { charBudget } from './tokens.js';

// A fake model. It cannot read the genome; it behaves the way a well-tuned ancestor
// should: copy into an empty neighbour (else any), and occasionally chatter instead.
// Exists so the loop, view and dynamics can be worked on without a GPU, and as the
// control for whether behaviour is coming from the model or from the rules.
export function createMockEngine({ rng = Math.random, chatter = 0.02 } = {}) {
  return {
    name: 'mock',
    instant: true,
    lastUsage: null,
    gpu: null,
    async load() {},
    async complete({ obs, maxTokens }) {
      if (rng() < chatter) {
        return 'Sure! I would be happy to help with that. Could you clarify what you would like me to do?';
      }
      const pool = obs.empty.length ? obs.empty : DIR_NAMES;
      const dir = pool[Math.floor(rng() * pool.length)];
      return JSON.stringify({ action: 'copy', dir }).slice(0, charBudget(maxTokens));
    },
  };
}
