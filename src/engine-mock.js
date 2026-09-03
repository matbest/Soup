import { charBudget } from './tokens.js';

// A fake model. It cannot read the markdown; it plays the loop the way a well-formed
// ancestor should: list the files, then copy self into an empty neighbour (else any).
// Occasionally it does something valid but dumb instead. Exists so the loop, view and
// dynamics can be worked on without a GPU, and as the control for whether behaviour is
// coming from the model or from the rules.
const NEIGHBOURS = ['north', 'south', 'east', 'west'];

export function createMockEngine({ rng = Math.random, chatter = 0.02 } = {}) {
  const self = {
    name: 'mock',
    instant: true,
    lastUsage: null,
    gpu: null,
    async load() {},
    async unload() {},
    async reset() {},
    async complete({ messages, mode, maxTokens }) {
      const promptText = messages[messages.length - 1].content.replace(/\r\n?/g, '\n');
      // In vi mode it answers only with keystrokes, and only if the cell still carries
      // some. A cell whose keys have been cut off by the budget gets prose back, which is
      // what a real model would give it.
      if (mode === 'vi') {
        const block = /```[a-z]*\n([\s\S]*?)```/i.exec(promptText);
        if (!block) {
          self.lastUsage = { prompt_tokens: Math.ceil(promptText.length / 4), completion_tokens: 12 };
          return 'I am not sure what to do here.';
        }
        let keys = block[1].trim().split('\n')[0];
        if (keys && rng() < chatter * 5) {
          const i = Math.floor(rng() * keys.length);
          keys = keys.slice(0, i) + 'qzx'[Math.floor(rng() * 3)] + keys.slice(i + 1);
        }
        self.lastUsage = { prompt_tokens: Math.ceil(promptText.length / 4), completion_tokens: Math.ceil(keys.length / 4) + 4 };
        return '```\n' + keys + '\n```';
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
      const out = JSON.stringify(reply).slice(0, charBudget(maxTokens));
      self.lastUsage = { prompt_tokens: Math.ceil(promptText.length / 4), completion_tokens: Math.ceil(out.length / 4) };
      return out;
    },
  };
  return self;
}
