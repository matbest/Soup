import { charBudget } from './tokens.js';

// A small instruct model over WebGPU via WebLLM (MLC). The library is imported on demand
// from jsDelivr so the mock engine never touches the network; weights are fetched from
// HuggingFace on first load and cached by the browser after that.
//
// The slice is enforced natively: max_tokens is the model's own budget, so the model
// simply stops when it is spent, and a reply cut off before its tool call does nothing.
const WEBLLM_URL = 'https://esm.run/@mlc-ai/web-llm@0.2.84';

// In order of size. `vram` is WebLLM's own estimate in MB of GPU memory the model needs
// while running. A page cannot ask WebGPU how much memory a device has, so this is the
// only side of the comparison we can show; the other side is the visitor's to know.
export const MODELS = [
  { id: 'SmolLM2-135M-Instruct-q0f16-MLC', vram: 360 },
  { id: 'SmolLM2-360M-Instruct-q4f16_1-MLC', vram: 376 },
  { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', vram: 945 },
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', vram: 879 },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', vram: 1630 },
  { id: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC', vram: 1630 },
  { id: 'Qwen3-1.7B-q4f16_1-MLC', vram: 2037 },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', vram: 2264 },
  { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC', vram: 2505 },
  { id: 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC', vram: 2505 },
  { id: 'Qwen3-4B-q4f16_1-MLC', vram: 3432 },
];

export const vramOf = id => MODELS.find(m => m.id === id)?.vram;

export function createWebLLMEngine(modelId, { onProgress } = {}) {
  let engine = null;
  const self = {
    name: modelId,
    instant: false,
    lastUsage: null,
    get raw() { return engine; },
    gpu: null,
    async load() {
      if (!navigator.gpu) throw new Error('WebGPU is not available in this browser');
      self.gpu = await describeAdapter();
      const webllm = await import(WEBLLM_URL);
      try {
        engine = await webllm.CreateMLCEngine(modelId, {
          initProgressCallback: p => onProgress?.(p.text),
        });
      } catch (err) {
        // The browser's GPU process can drop its WebGPU device; a full restart of the
        // browser brings it back. Say so, instead of WebLLM's paragraph about compatibility.
        const msg = err?.message ?? String(err);
        if (/compatible GPU/i.test(msg)) {
          throw new Error(`no WebGPU device right now (adapter: ${self.gpu}). This usually means the browser's GPU process has dropped it; quit the browser completely and reopen it, then reload.`);
        }
        if (/out of memory|OutOfMemory|device.*lost|allocat/i.test(msg)) {
          const need = vramOf(modelId);
          throw new Error(`the GPU ran out of memory loading this model${need ? ` (it needs about ${(need / 1024).toFixed(1)} GB)` : ''}. Pick a smaller one, or close other GPU-heavy tabs and apps and reload.`);
        }
        throw err;
      }
    },
    async complete({ messages, structuralTag, maxTokens, temperature }) {
      const r = await engine.chat.completions.create({
        response_format: structuralTag ? { type: 'structural_tag', structural_tag: structuralTag } : undefined,
        messages,
        max_tokens: maxTokens,
        temperature,
        top_p: 1,
      });
      self.lastUsage = r.usage ?? null;
      const text = r.choices?.[0]?.message?.content ?? '';
      // Belt and braces: never return more than the slice, whatever the model says.
      return text.slice(0, charBudget(maxTokens) * 2);
    },
  };
  return self;
}

// Which GPU WebGPU hands us. WebLLM asks for "high-performance" itself; on a dual-GPU
// laptop whether that reaches the discrete card is decided by the OS and the browser,
// not by the page, so the best the page can do is say which one it got.
export async function describeAdapter() {
  try {
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!a) return 'no adapter';
    const i = a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : {});
    const name = [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' ') || 'unknown adapter';
    console.log('[soup] WebGPU adapter:', name, i);
    return name;
  } catch {
    return 'unknown adapter';
  }
}
