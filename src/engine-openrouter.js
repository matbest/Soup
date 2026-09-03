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

// A code model is the right shape for an instruction set made of keystrokes, and this one
// is free with a long context. Preselected when the free list loads, if it is still there.
export const PREFERRED = 'cohere/north-mini-code:free';

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

// OpenRouter puts the useful part in a JSON error body; pass it on rather than replacing
// it with a guess.
function safeArgs(a) {
  if (a && typeof a === 'object') return a;
  try { return JSON.parse(a ?? '{}'); } catch { return {}; }
}

function detail(body) {
  try {
    const e = JSON.parse(body).error;
    const meta = e?.metadata ? ` ${JSON.stringify(e.metadata).slice(0, 120)}` : '';
    return `${e?.message ?? body}${meta}`.slice(0, 240);
  } catch {
    return String(body).slice(0, 240) || '(no detail)';
  }
}

export function createOpenRouterEngine(modelId, { onProgress, minIntervalMs = 3500 } = {}) {
  let supportsSchema = false;
  let nextAllowedAt = 0;

  const self = {
    name: modelId,
    instant: false,
    lastUsage: null,
    lastFinish: null,
    lastReasoning: '',
    gpu: 'openrouter',
    lost: null,

    async load() {
      const key = storedKey();
      if (!key) throw new Error('no OpenRouter key: paste one in the setup tab');
      // Check the key before the run rather than in the middle of one, and say what
      // OpenRouter says about it: guessing at an auth failure wastes everyone's time.
      onProgress?.('checking the key');
      const who = await fetch(`${BASE}/key`, { headers: { Authorization: `Bearer ${key}` } });
      const body = await who.text();
      if (!who.ok) throw new Error(`OpenRouter rejected the key (${who.status}): ${detail(body)}`);
      const info = JSON.parse(body).data ?? {};
      onProgress?.(`checking ${modelId}`);
      const models = await freeModels();
      const found = models.find(m => m.id === modelId);
      if (!found) throw new Error(`${modelId} is not in OpenRouter's free list right now`);
      supportsSchema = found.schema;
      const limit = info.limit_remaining != null ? `, ${info.limit_remaining} left` : info.is_free_tier ? ', free tier' : '';
      self.gpu = `openrouter, ${found.ctx.toLocaleString()} ctx${found.schema ? ', schema' : ''}${limit}`;
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
        if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${detail(await r.text())}`);

        const json = await r.json();
        if (json.error) throw new Error(`OpenRouter: ${detail(JSON.stringify(json))}`);
        self.lastUsage = json.usage
          ? { prompt_tokens: json.usage.prompt_tokens ?? 0, completion_tokens: json.usage.completion_tokens ?? 0 }
          : null;
        const choice = json.choices?.[0] ?? {};
        const msg = choice.message ?? {};
        // Why a turn did nothing matters as much as that it did. A reasoning model can
        // spend the whole slice thinking and return an empty content with its thoughts in
        // `reasoning`; a native tool call arrives beside the content rather than in it.
        self.lastFinish = choice.finish_reason ?? choice.native_finish_reason ?? null;
        self.lastReasoning = typeof msg.reasoning === 'string' ? msg.reasoning : '';
        if (msg.content) return msg.content;
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
          return JSON.stringify({ calls: msg.tool_calls.map(t => ({ tool: t.function?.name, ...safeArgs(t.function?.arguments) })) });
        }
        return self.lastReasoning || '';
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
