# Soup

Tierra with one instruction, where the CPU is a language model.

A grid of cells. Each occupied cell holds a Markdown genome. On a cell's turn the host
hands the model that genome as its instructions plus a one-line observation of the four
neighbours, and gives it a fixed slice of output tokens. The host then parses the output
for a single `WRITE` block and copies its body into the named neighbour, overwriting
whatever was there. That is the whole machine.

## Rules (v1)

- Grid is a torus. Neighbourhood is N/E/S/W.
- One instruction:

      WRITE <N|E|S|W>
      <text>
      END

  The first `WRITE` line opens the block; the *last* bare `END` line closes it. A genome may
  say "END" in prose without cutting its own copy short. One write per turn.
- **The slice is the price.** Each turn gets `maxTokens` of output. A genome longer than
  the slice cannot copy itself in one turn: the block is cut off before `END` and nothing
  is written. Length costs reproduction.
- **Overwrite is the only death.** No reaper. A cell dies because a neighbour spent its
  slice writing over it. Nothing is free and nothing is decreed.
- **The model is the only mutation.** There is no mutation operator. Copies are lossy to the
  extent the model is lossy; temperature is the cosmic-ray rate.
- The scheduler sweeps all occupied cells in a random order, one cell per tick, then
  reshuffles. A cell written mid-sweep runs its new genome when its turn comes.

## Engines

- `mock`: no GPU. Behaves as a well-tuned ancestor should: copies the genome to an empty
  neighbour with per-character noise scaled by temperature; occasionally chatters instead.
  Exists to develop the loop without waiting on inference, and as the control for whether
  behaviour comes from the model or from the rules.
- `webllm`: phase 2. A small instruct model over WebGPU, loaded in the page.

## Run

Any static server, e.g. `python -m http.server 8765` in this directory, then open
http://localhost:8765/. ES modules will not load from file://.

## Phases

1. Soup + mock engine (this).
2. Real model via WebLLM; tune the ancestor until it self-copies at temperature 0, then
   raise temperature until it does not.
3. Neighbours' genomes become visible in the observation: the parasite threshold.
4. Explicit conservation: energy balances, inference debits, reproduction splits.
5. Instrumentation: lineage tree, genome length over time, diversity.
