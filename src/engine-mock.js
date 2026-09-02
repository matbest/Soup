import { DIR_NAMES } from './soup.js';
import { charBudget } from './tokens.js';

// A fake model. It cannot read the genome; it behaves the way a well-tuned ancestor
// should: pick an empty neighbour (else any), copy the genome with per-character noise
// scaled by temperature, and occasionally chatter instead of writing.
//
// It exists so the loop, view and dynamics can be worked on without a GPU, and as the
// control for whether behaviour is coming from the model or from the rules.
export function createMockEngine({ rng = Math.random, chatter = 0.02, noisePerDegree = 0.002 } = {}) {
  return {
    name: 'mock',
    instant: true,
    async load() {},
    async complete({ system, obs, maxTokens, temperature }) {
      if (rng() < chatter) {
        return 'Sure! I would be happy to help with that. Could you clarify what you would like me to do?';
      }
      const empties = DIR_NAMES.filter(d => obs.neighbours[d] === 'empty');
      const pool = empties.length ? empties : DIR_NAMES;
      const dir = pool[Math.floor(rng() * pool.length)];
      const body = mutate(system, temperature * noisePerDegree, rng);
      const out = `WRITE ${dir}\n${body}\nEND`;
      // The slice. Run out of tokens and the END is lost with them.
      return out.slice(0, charBudget(maxTokens));
    },
  };
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:-\n';
const pick = rng => ALPHABET[Math.floor(rng() * ALPHABET.length)];

function mutate(text, rate, rng) {
  if (rate <= 0) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (rng() >= rate) { out += ch; continue; }
    const r = rng();
    if (r < 0.6) out += pick(rng);            // substitute
    else if (r < 0.8) { /* delete */ }
    else out += ch + pick(rng);               // insert
  }
  return out;
}
