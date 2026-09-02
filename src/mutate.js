// Cosmic rays. Per-character noise applied by the host when a genome is copied. This is
// Tierra's mutation, not the model's: the copy instruction is hardware, the noise is physics.
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:-\n';
const pick = rng => ALPHABET[Math.floor(rng() * ALPHABET.length)];

export function mutate(text, rate, rng = Math.random) {
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
