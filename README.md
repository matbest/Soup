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

## Design (v4, the current build)

The cell is a markdown file, and the cell is an agent with file tools.

**Document.** Any text. A turn starts from the cell's own text followed by the TOOLS
block, which is the same for every cell and is the only text the host adds. The system
turn is sent empty so the model's own default does not stand in.

**Paths.** A cell's world is five files: `self`, `north`, `south`, `east`, `west`. Nothing
is seen unless read.

**Tools.** Coding-agent shaped, with anchors rather than line numbers:

    list_files(directory)                which paths exist, and their sizes; also position
    read_file(path)                      the contents
    copy_file(src, dst)                  host copy, with noise: how a cell reproduces
    create_file(path, content)           write a new file over path
    replace_text(path, old_text, new_text)   first occurrence; exact, then trimmed, then case-insensitive
    insert_after(path, anchor, text)     a line after the line containing anchor
    insert_before(path, anchor, text)    a line before it
    append_text(path, text)              a line at the end; creates the file if empty
    delete_file(path)                    empty it

**Turn.** A small agent loop. The reply is one JSON object under a schema (constrained
decoding, so it cannot be malformed): optional `thoughts`, then `calls`, at least one.
Calls run in order. Writes take effect at once. If any call was a read, the results go
back to the model as the next message and it gets another round, up to `rounds` per turn.
Every round re-sends the growing conversation: reading is paid for in prompt tokens and
rounds. A missed anchor is an error in the results, so the model can read and retry
within the turn.

**Death.** `copy_file` and `create_file` over an occupied path replace it. `delete_file`
empties it. A file can also be edited down to nothing. No reaper.

**Mutation.** Host noise on `copy_file`, per character, at a rate you set. Plus whatever a
cell writes into itself or its neighbours.

**Everything else as v1:** torus, one cell per tick in a shuffled sweep, the slice as the
per-round price, overwrite as death.

**Ancestor** (`ancestor.md`):

    # Cell

    You are a cell in a grid. Each turn, list the files to find an empty
    neighbour, then copy self into it.

(v2 had the model echo its own text to reproduce; v3 made the cell a JSON object edited by
key with slots for observation. Both were built and replaced the same week; the file-tool
shape is the one the models were trained on.)

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
2c. v3: JSON document, key verbs, host copy. Built, replaced.
2d. v4: markdown file + coding-agent tools, agent loop per turn. Built.
3. Neighbours' genomes become visible in the observation: the parasite threshold.
4. Explicit conservation: energy balances, inference debits, reproduction splits.
5. Instrumentation: lineage tree, genome length over time, diversity.
