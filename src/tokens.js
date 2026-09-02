// Rough and honest: the slice is enforced in characters, at four per token.
// Phase 2 can swap in the model's own tokenizer.
export const CHARS_PER_TOKEN = 4;
export const estimateTokens = s => Math.ceil(s.length / CHARS_PER_TOKEN);
export const charBudget = tokens => tokens * CHARS_PER_TOKEN;
