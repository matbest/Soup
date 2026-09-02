// Phase 2. A small instruct model over WebGPU via WebLLM (MLC), imported from a CDN,
// weights cached by the browser. Same interface as the mock.
export function createWebLLMEngine() {
  return {
    name: 'webllm',
    instant: false,
    async load() { throw new Error('WebLLM engine is phase 2, not implemented yet'); },
    async complete() { throw new Error('WebLLM engine is phase 2, not implemented yet'); },
  };
}
