// An engine that runs the cells on OpenRouter's free models instead of the visitor's GPU.
// Same interface as the local ones, and a better fit for the rule that every turn starts
// in a fresh environment: the API is stateless, so nothing can carry over even in
// principle. No WebGPU, no watchdog, and models far larger than a laptop can hold.
//
// The costs are different rather than absent. The free tier is rate limited, so the soup
// runs at the API's pace rather than the card's; and a cell's text leaves the machine,
// which the local engines never do.
//
// The key is the visitor's own, pasted in and kept in localStorage on their machine. It
// is never committed, and a published copy of this page must ask each visitor for theirs
// rather than carry one.

const BASE = 'https://openrouter.ai/api/v1';
const KEY_STORE = 'soup.openrouter.key';
export const PREFIX = 'or:';

export const storedKey = () => {
  try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; }
};

export const storeKey = key => {
  try { key ? localStorage.setItem(KEY_STORE, key.trim()) : localStorage.removeItem(KEY_STORE); } catch { /* private mode */ }
};

// Which free models exist changes week to week, so ask rather than hardcode. Sorted with
// the ones that can be held to a JSON schema first: they make far better cells.
export async function freeModels() {
  const r = await fetch(`${BASE}/models`);
  if (!r.ok) throw new Error(`OpenRouter model list: ${r.status}`);
  const { data } = await r.json();
  return (data || [])
    .filter(m => ['0', '0.0', '0e0'].includes(String(m.pricing?.prompt ?? '1')))
    .map(m => ({
      id: m.id,
      ctx: m.context_length || 0,
      schema: (m.supported_parameters || []).includes('structured_outputs'),
    }))
    .sort((a, b) => (b.schema - a.schema) || a.id.localeCompare(b.id));
}

export function createOpenRouterEngine(modelId, { onProgress, minIntervalMs = 3500 } = {}) {
  let supportsSchema = false;
  let nextAllowedAt = 0;

  const self = {
    name: modelId,
    instant: false,
    lastUsage: null,
    gpu: 'openrouter',
    lost: null,

    async load() {
      if (!storedKey()) throw new Error('no OpenRouter key: paste one in the setup tab');
      onProgress?.(`checking ${modelId}`);
      const models = await freeModels();
      const found = models.find(m => m.id === modelId);
      if (!found) throw new Error(`${modelId} is not in OpenRouter's free list right now`);
      supportsSchema = found.schema;
      self.gpu = `openrouter, ${found.ctx.toLocaleString()} ctx${found.schema ? ', schema' : ''}`;
    },

    async unload() {},

    // Nothing to reset: each request carries its whole conversation and the service keeps
    // no state between them.
    async reset() {},

    async complete({ messages, schema, maxTokens, temperature }) {
      const key = storedKey();
      if (!key) throw new Error('no OpenRouter key: paste one in the setup tab');

      const body = {
        model: modelId,
        messages: messages.filter(m => m.content),   // an empty system turn is not useful here
        max_tokens: maxTokens,
        temperature,
      };
      // Only ask for a schema where the model can actually be held to one; elsewhere the
      // tolerant parser is the backstop, and a reply it cannot read is a turn that did nothing.
      if (schema && supportsSchema) {
        body.response_format = { type: 'json_schema', json_schema: { name: 'reply', schema: JSON.parse(schema) } };
      }

      for (let attempt = 0; ; attempt++) {
        await pace();
        const r = await fetch(`${BASE}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
            'X-Title': 'Soup',
          },
          body: JSON.stringify(body),
        });

        if (r.status === 429 || r.status === 503) {
          if (attempt >= 3) throw new Error(`OpenRouter is rate limiting this key (${r.status}); slow the run down or wait`);
          const wait = Number(r.headers.get('retry-after')) * 1000 || 5000 * (attempt + 1);
          onProgress?.(`rate limited, waiting ${Math.round(wait / 1000)}s`);
          nextAllowedAt = Date.now() + wait;
          continue;
        }
        if (r.status === 401 || r.status === 403) throw new Error('OpenRouter rejected the key');
        if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${(await r.text()).slice(0, 160)}`);

        const json = await r.json();
        if (json.error) throw new Error(`OpenRouter: ${String(json.error.message ?? json.error).slice(0, 160)}`);
        self.lastUsage = json.usage
          ? { prompt_tokens: json.usage.prompt_tokens ?? 0, completion_tokens: json.usage.completion_tokens ?? 0 }
          : null;
        return json.choices?.[0]?.message?.content ?? '';
      }
    },
  };

  // The free tier counts requests, and a turn is several. Keep a floor between them so a
  // run paces itself instead of being throttled.
  async function pace() {
    const wait = nextAllowedAt - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    nextAllowedAt = Date.now() + minIntervalMs;
  }

  return self;
}
