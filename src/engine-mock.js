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
    async reset() {},
    async complete({ messages, maxTokens }) {
      const promptText = messages[messages.length - 1].content;
      // In vi mode it does what a real model asked for keystrokes would do at its best:
      // find the keystrokes written in the cell's own text and echo them, with a chance
      // of getting one character wrong.
      if (/^VI\. Reply with vi keystrokes/m.test(promptText)) {
        const genome = promptText.split(/^VI\./m)[0];
        const found = genome.match(/^[a-zA-Z0-9<>$^{}\[\]]{4,40}$/m);
        let keys = found ? found[0] : '';
        if (keys && rng() < chatter * 5) {
          const i = Math.floor(rng() * keys.length);
          keys = keys.slice(0, i) + 'qzx'[Math.floor(rng() * 3)] + keys.slice(i + 1);
        }
        return keys;
      }
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
