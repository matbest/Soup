import { charBudget } from './tokens.js';

// A fake model. It cannot read the markdown; it plays the loop the way a well-formed
// ancestor should: list the files, then copy self into an empty neighbour (else any).
// Occasionally it does something valid but dumb instead. Exists so the loop, view and
// dynamics can be worked on without a GPU, and as the control for whether behaviour is
// coming from the model or from the rules.
const NEIGHBOURS = ['north', 'south', 'east', 'west'];

export function createMockEngine({ rng = Math.random, chatter = 0.02 } = {}) {
  return {
    name: 'mock',
    instant: true,
    lastUsage: null,
    gpu: null,
    async load() {},
    async unload() {},
    async complete({ messages, maxTokens }) {
      let reply;
      if (messages.length <= 2) {
        reply = { calls: [{ tool: 'list_files', directory: '.' }] };
      } else {
        const listing = messages[messages.length - 1].content;
        const empties = NEIGHBOURS.filter(p => new RegExp(`^${p}\\s+empty`, 'm').test(listing));
        const pool = empties.length ? empties : NEIGHBOURS;
        const dst = pool[Math.floor(rng() * pool.length)];
        reply = rng() < chatter
          ? { thoughts: 'Sure! Happy to help.', calls: [{ tool: 'append_text', path: dst, text: 'hello' }] }
          : { calls: [{ tool: 'copy_file', src: 'self', dst }] };
      }
      // The slice. Run out of tokens and the reply is not a reply.
      return JSON.stringify(reply).slice(0, charBudget(maxTokens));
    },
  };
}
