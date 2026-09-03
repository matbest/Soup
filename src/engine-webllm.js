import { charBudget } from './tokens.js';

// A small instruct model over WebGPU via WebLLM (MLC). The library is imported on demand
// from jsDelivr so the mock engine never touches the network; weights are fetched from
// HuggingFace on first load and cached by the browser after that.
//
// The slice is enforced natively: max_tokens is the model's own budget, so the model
// simply stops when it is spent, and a reply cut off before its tool call does nothing.
const WEBLLM_URL = 'https://esm.run/@mlc-ai/web-llm@0.2.84';

// Roughly in order of size. VRAM is WebLLM's own estimate.
export const MODELS = [
  'SmolLM2-135M-Instruct-q0f16-MLC',          //  ~0.4 GB
  'SmolLM2-360M-Instruct-q4f16_1-MLC',        //  ~0.4 GB
  'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',        //  ~0.9 GB
  'Llama-3.2-1B-Instruct-q4f16_1-MLC',        //  ~0.9 GB
  'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',        //  ~1.6 GB
  'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC',  //  ~1.6 GB
  'Qwen3-1.7B-q4f16_1-MLC',                   //  ~2.0 GB
  'Llama-3.2-3B-Instruct-q4f16_1-MLC',        //  ~2.3 GB
  'Qwen2.5-3B-Instruct-q4f16_1-MLC',          //  ~2.5 GB
  'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC',    //  ~2.5 GB
  'Qwen3-4B-q4f16_1-MLC',                     //  ~3.4 GB
];

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
      engine = await webllm.CreateMLCEngine(modelId, {
        initProgressCallback: p => onProgress?.(p.text),
      });
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
async function describeAdapter() {
  try {
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!a) return 'no adapter';
    const i = a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : {});
    return [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' ') || 'unknown adapter';
  } catch {
    return 'unknown adapter';
  }
}
