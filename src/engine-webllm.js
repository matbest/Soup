import { charBudget } from './tokens.js';

// A small instruct model over WebGPU via WebLLM (MLC). The library is imported on demand
// from jsDelivr so the mock engine never touches the network; weights are fetched from
// HuggingFace on first load and cached by the browser after that.
//
// The slice is enforced natively: max_tokens is the model's own budget; a reply cut off
// mid-object is not a reply.
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

// The largest model that reproduces reliably without tripping the Windows GPU watchdog on
// a small discrete card. Bigger ones are better agents but their prefill dispatch can run
// past the 2-second limit, at which point the card is reset and everything here dies with
// it. See the README.
export const DEFAULT_MODEL = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';

export function createWebLLMEngine(modelId, { onProgress } = {}) {
  let engine = null;
  const self = {
    name: modelId,
    instant: false,
    lastUsage: null,
    get raw() { return engine; },
    gpu: null,
    lost: null,   // why the GPU device has gone, once it has
    async load() {
      if (!navigator.gpu) throw new Error('WebGPU is not available in this browser');
      self.gpu = await describeAdapter();
      // The runtime under WebLLM destroys its device on any buffer error (out of memory,
      // validation, internal) and then disposes everything it holds; WebLLM keeps its
      // references, so the next call fails on whatever freed object it touches first.
      // The actual error only goes to console.error, just before. Catch it there.
      captureGpuErrors(reason => { if (!self.lost) { self.lost = reason; onProgress?.(`GPU error: ${reason}`); } });
      const webllm = await import(WEBLLM_URL);
      try {
        // Prompts here are a few hundred tokens; the models ship with 32k windows. A small
        // window keeps the KV cache, and every attention dispatch, small.
        engine = await webllm.CreateMLCEngine(modelId, {
          initProgressCallback: p => onProgress?.(p.text),
        }, { context_window_size: 4096 });
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
    async unload() {
      try { await engine?.unload(); } catch { /* already gone */ }
      engine = null;
    },
    // A watchdog reset disposes everything the runtime holds, and there is no way back
    // through the old objects. Build a whole new engine on the same (still present)
    // adapter instead, so one reset costs a model load rather than the run.
    async recover() {
      engine = null;
      self.lost = null;
      const webllm = await import(WEBLLM_URL);
      engine = await webllm.CreateMLCEngine(modelId, {
        initProgressCallback: p => onProgress?.(`recovering: ${p.text}`),
      }, { context_window_size: 4096 });
    },
    // Start a turn from nothing: drop the conversation and the KV cache the last cell
    // left behind. WebLLM would reset anyway when it sees a different conversation, but
    // a cell's turn should not depend on that noticing.
    async reset() {
      try { await engine?.resetChat(); } catch { /* nothing to reset */ }
    },
    async complete({ messages, schema, maxTokens, temperature }) {
      const gaveUp = () => {
        const e = new Error(`${self.lost} If it recurs: update the GPU driver, try a smaller model, or raise the watchdog limit (TdrDelay).`);
        e.deviceLost = true;
        return e;
      };
      if (self.lost) throw gaveUp();
      let r;
      try {
        r = await engine.chat.completions.create({
          response_format: schema ? { type: 'json_object', schema } : undefined,
          messages, max_tokens: maxTokens, temperature, top_p: 1,
        });
      } catch (err) {
        if (self.lost) throw gaveUp();
        // A watchdog reset frees everything the runtime holds, and the wrapper for
        // whichever object the call touched first is what complains: the matcher, the
        // tokenizer, a tensor. The console line naming the real cause may not have
        // arrived yet, so treat these as the same event and let the page rebuild.
        if (/deleted|disposed/i.test(err?.message ?? String(err))) {
          self.lost = 'the GPU device was lost (the runtime found its objects freed).';
          throw gaveUp();
        }
        throw err;
      }
      self.lastUsage = r.usage ?? null;
      const text = r.choices?.[0]?.message?.content ?? '';
      // Belt and braces: never return more than the slice, whatever the model says.
      return text.slice(0, charBudget(maxTokens) * 2);
    },
  };
  return self;
}

// The runtime reports GPU errors and its own device loss only through console.error.
// Wrap it once and pass on anything that looks like either.
let capturing = false;
function captureGpuErrors(onError) {
  if (capturing) return;
  capturing = true;
  const original = console.error.bind(console);
  console.error = (...args) => {
    original(...args);
    for (const a of args) {
      const name = a?.constructor?.name ?? '';
      if (/^GPU(OutOfMemory|Validation|Internal)?Error$/.test(name) || /GPUDeviceLostInfo/.test(name)) {
        onError(`${name.replace(/^GPU|Error$/g, '') || 'device lost'}: ${a.message ?? a.reason ?? ''}`.trim());
      } else if (typeof a === 'string' && /device (was )?lost/i.test(a)) {
        onError('the GPU device was lost. On Windows this is usually the GPU watchdog (TDR) resetting the card because a dispatch ran over its 2-second limit: DXGI_ERROR_DEVICE_HUNG in the console.');
      }
    }
  };
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
