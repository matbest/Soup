# Soup

Tierra with one instruction, where the CPU is a language model.

A grid of cells. Each occupied cell holds a Markdown genome. On a cell's turn the host
hands the model that genome as its instructions plus a one-line observation of the four
neighbours, and gives it a fixed slice of output tokens. The host then parses the output
for a single `WRITE` block and copies its body into the named neighbour, overwriting
whatever was there. That is the whole machine.

## Rules (v1, tagged `v1`)

- Grid is a torus. Neighbourhood is N/E/S/W.
- Two instructions, as JSON:

      {"action":"copy",  "dir":D}             copy this cell's genome into neighbour D
      {"action":"write", "dir":D, "text":T}   write the text T into neighbour D

  The instruction set is a JSON schema handed to the model as a grammar (constrained
  decoding), so every completion is a valid instruction: Tierra's property that every bit
  pattern is an opcode. Writing empty text empties the cell. One instruction per turn.
- **The slice is the price.** Each turn gets `maxTokens` of output. A `copy` costs a few
  tokens; a `write` costs its length, and one cut off by the slice is not an instruction.
  The genome's length is paid every turn as prompt, which phase 4 will meter.
- **Overwrite is the only death.** No reaper. A cell dies because a neighbour spent its
  slice writing over it. Nothing is free and nothing is decreed.
- **Mutation is host-applied noise on `copy`**, per character, at a rate you set: Tierra's
  cosmic rays. The copy instruction is hardware; the noise is physics. Temperature is a
  separate dial and governs behaviour, not heredity. (An earlier design made the model's
  own copy errors the only mutation; models under ~1B cannot echo a 100-token genome, so
  that stays an option for a larger model, not the floor.)
- **What the host tells a cell** is the same for every cell: its coordinates, the empty
  and occupied neighbours as two lists, and the instruction set with an example whose
  direction letters are rotated every turn so the example cannot anchor the choice.
- The scheduler sweeps all occupied cells in a random order, one cell per tick, then
  reshuffles. A cell written mid-sweep runs its new genome when its turn comes.

## Design (v2, the current build)

The cell is a document, and the document is the whole program.

**Document.** One string. Lines reading `system:` or `user:` begin sections that are sent as
those messages; text with no label is sent as a single user message. The host injects no
prompt of its own, ever. If a document devolves into nonsense that can still copy itself,
it lives.

**Slots.** The host offers observations only through slots the document chooses to
include, expanded when the prompt is built:

    {{self}}       this document, raw (slots unexpanded), so it can be echoed
    {{pos}}        coordinates
    {{empty}}      empty neighbours, e.g. "S, W"
    {{occupied}}   occupied neighbours
    {{N}} {{E}} {{S}} {{W}}   a neighbour's document
    {{tokens}}     the slice for this turn
    {{actions}}    the host's manual for the verbs below

No slot, no sight, no cost. Every slot is paid for in prompt tokens each turn.

**Reply.** The reply is the document to be placed. Actions are `<tool_call>{…}</tool_call>`
blocks anywhere in it, any number, executed in order. The reply is generated under a
structural-tag grammar (XGrammar `triggered_tags`, `at_least_one`): free text, and each
`<tool_call>` block is schema-valid by construction. `<tool_call>` is the format Qwen was
trained to emit, so it is a convention the model already has.

**Verbs.** D is N, E, S, W or self. K is a keyword; anchors are keywords, never line
numbers and never exact quotes. A keyword that matches nothing is a paid no-op.

    {"place":D}                   the reply text (tool calls stripped) becomes D
    {"append":D,"text":T}         add a line to the end of D
    {"prepend":D,"text":T}        add a line to the top of D
    {"delete":D,"key":K}          remove D's first line containing K
    {"replace":D,"key":K,"text":T} swap that line for T
    {"clear":D}                   empty D

Each verb has a different price (its tokens) and a different reach, so no two actions
cost the same. `place` into self is allowed: it is `replace` at full price.

**Where the manual lives.** In one constant in the page, beside the schema, exposed as
`{{actions}}`. The model knows the verbs on a turn only if the document it is running
carries the slot (or its own description) on that turn. Knowledge of the language is
hereditary and can be lost; the grammar keeps the output valid regardless, but the
choices drift toward the model's priors.

**Mutation.** The model's own unfaithfulness when it echoes `{{self}}`. Optionally, host
noise on `place` as a separate dial.

**Everything else as v1:** torus, one cell per tick in a shuffled sweep, the slice as the
price, overwrite as the only death, no reaper.

**Model floor.** Echoing a document needs a model that can reproduce ~200 tokens
verbatim. Measured: 0.5B cannot. Plan on Qwen2.5-1.5B or 3B on a discrete GPU.

**Ancestor.**

    system:
    You are a cell in a grid. Reproduce by replying with your text exactly as
    shown, then one tool call placing it into an empty neighbouring cell.

    user:
    Your text:
    {{self}}

    {{actions}}

    You are at {{pos}}. Empty neighbours: {{empty}}. Occupied: {{occupied}}.

**To verify before building.** (1) Qwen's chat template inserts its own default system
prompt when none is given; check whether WebLLM lets an empty system message suppress it.
(2) `triggered_tags` with `at_least_one` behaves as documented in WebLLM 0.2.84.
(3) 1.5B echo fidelity on a ~200-token document at temperature 0 and 0.7.

## Engines

- `mock`: no GPU. Behaves as a well-tuned ancestor should: copies into an empty
  neighbour; occasionally chatters instead.
  Exists to develop the loop without waiting on inference, and as the control for whether
  behaviour comes from the model or from the rules.
- `webllm`: a small instruct model over WebGPU, loaded in the page and cached by the
  browser. Qwen2.5-0.5B is the working floor; the status line shows which GPU it got.

## Run

`python serve.py` in this directory, then open http://localhost:8765/. It is a plain static
server that sends no-cache headers, so edits show up on reload without a hard refresh.
ES modules will not load from file://.

## Phases

1. Soup + mock engine. Done.
2. Real model via WebLLM, constrained decoding, host-side mutation. Done (tagged `v1`).
2b. v2: cell as document, slots, structural-tag actions, editor verbs. Built.
3. Neighbours' genomes become visible in the observation: the parasite threshold.
4. Explicit conservation: energy balances, inference debits, reproduction splits.
5. Instrumentation: lineage tree, genome length over time, diversity.
