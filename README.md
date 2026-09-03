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

## Design (v3, the current build)

The cell is a document, the document is JSON, and the document is the whole program.

**Document.** A JSON object. `system` and `user` are the only keys the host knows: they are
sent as those messages with slots expanded, once. Any other key is the cell's own state,
readable through a slot of the same name. The host injects no prompt of its own, ever. A
document that is not valid JSON is not dead: its whole text is sent as the user message,
slots still expand, and `place` still copies it byte for byte. It has only lost its
structure.

**Slots.** Observations reach a document only through slots it chooses to carry:

    {{pos}}        coordinates
    {{empty}}      empty neighbours, e.g. "S, W"
    {{occupied}}   occupied neighbours
    {{N}} {{E}} {{S}} {{W}}   a neighbour's document
    {{tokens}}     the slice for this turn
    {{actions}}    the host's manual for the verbs below
    {{self}}       this document, raw
    {{key}}        any field of this document, by name (own fields win over host slots)

No slot, no sight, no cost. Every slot is paid for in prompt tokens each turn.

**Reply.** One JSON object under a schema (constrained decoding, so it cannot be
malformed): optional `thoughts`, free text paid for in the slice, then `actions`, at least
one, executed in order.

    {"thoughts": "...", "actions": [ {"place": "S"} ]}

**Verbs.** D is N, E, S, W or self. Documents are edited by key, never by position: naming
a key it has just read is the one edit a small model can do reliably.

    {"place":D}                          copy this document into D (host copy, with noise)
    {"place":D,"doc":{...}}              place the given document instead
    {"set":D,"key":K,"value":V}          set field K of D
    {"append":D,"key":K,"value":"T"}     add T to the end of text field K of D
    {"delete":D,"key":K}                 remove field K from D
    {"clear":D}                          empty D

A field verb on a document without structure, or a delete of a missing key, is a paid
no-op. Setting a field in an empty cell creates a document there.

**Where the manual lives.** In one constant beside the schema, exposed as `{{actions}}`.
The model knows the verbs on a turn only if the document it is running carries the slot
(or its own `actions` field). Knowledge of the language is hereditary and can be lost;
the grammar keeps the output valid regardless.

**Mutation.** Host noise on the serialized document at `place`, per character, at a rate
you set. Most hits change prose inside a string; some break the JSON, and the document
goes on as plain text. Plus whatever a cell does to itself with `set`/`append`/`delete`
before it copies.

**Everything else as v1:** torus, one cell per tick in a shuffled sweep, the slice as the
price, overwrite as the only death, no reaper.

**Ancestor.**

    {
      "system": "You are a cell in a grid. Each turn, place yourself into an empty neighbouring cell.",
      "user": "{{actions}}\n\nYou are at {{pos}}. Empty neighbours: {{empty}}. Occupied: {{occupied}}."
    }

(v2, where the reply was the document to place and the model had to echo its own text,
was built and abandoned the same day: it doubled the prompt and needed a model that can
reproduce ~200 tokens verbatim. It is in the history.)

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
2b. v2: cell as document, echo-to-reproduce. Built, abandoned.
2c. v3: JSON document, key verbs, host copy. Built.
3. Neighbours' genomes become visible in the observation: the parasite threshold.
4. Explicit conservation: energy balances, inference debits, reproduction splits.
5. Instrumentation: lineage tree, genome length over time, diversity.
