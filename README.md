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

**Turn.** A small agent loop. The reply is one JSON object: optional `thoughts`, then
`calls`, at least one. The parser accepts the shapes models actually produce; a reply it
cannot read is a turn that does nothing, which is fair, and was paid for. (Constrained
decoding was tried and removed: WebLLM's grammar layer failed on the author's machine and
the recovery code only hid the real errors.)
Calls run in order. Writes take effect at once. If any call was a read, the results go
back to the model as the next message and it gets another round, up to `rounds` per turn.
Every round re-sends the growing conversation: reading is paid for in prompt tokens and
rounds. A missed anchor is an error in the results, so the model can read and retry
within the turn.

**Compute is finite.** Each sweep every living cell is given the same allowance of tokens
(the *tokens/cell* dial; 0 means unlimited). A turn debits what it actually cost, the
whole prompt and the whole reply. While a cell still has credit it goes again, so a cheap
genome takes several turns in the time a dear one takes none, and a genome that overruns
its allowance spends whole sweeps saving up for a single turn. Held still — five wordy
cells and five terse ones, nobody reproducing — the terse ones ran about 22 times as
often. Nothing is taken from anybody and nothing is decreed; the only rule is that compute
spent is compute gone.

**`R` moves one cell in a random direction**, so a genome can reproduce without naming a
way to go. It matters more than it looks: `L` fills one row of the torus and then eats
itself, 12 cells of 144 after 600 ticks, while `R` reaches 118. Tierra had the same
property for the same reason — its allocator placed daughters, the creature never chose —
and the only directional choice in its instruction set was whether a template search ran
forward or backward.

**Death.** `copy_file` and `create_file` over an occupied path replace it. `delete_file`
empties it. A file can also be edited down to nothing. No reaper.

**Mutation.** Host noise on `copy_file`, per character, at a rate you set, and **on by
default**: at zero every copy is exact, nothing varies, and nothing can be selected. A
copy is where variation enters, and the instruction string is what varies.

**What to watch.** The population panel lists the distinct texts in the soup by how many
cells carry them, how long they have been there and how deep their lineage runs. That is
the experiment: a wording that reliably gets the model to copy it spreads, a wording that
gets the model to delete its own children does not, and neither outcome is anybody's
design. Click a genome to load it into the ancestor box and seed a fresh soup from it.

**Calls per round** is a dial. At 1 a round is one decision. Higher, and a cell can act
several times at once — which is how a small model shown a list of nine tools comes to
recite all nine, ending with `delete_file`. Whether that is a failure to prevent or a
pressure to select on is the question the dial leaves open. Plus whatever a
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

## What runs, and why

The model has to be big enough to use the tools and small enough not to hang the GPU, and
on a 4 GB laptop card those two constraints nearly meet.

- **Llama-3.2-1B** with the short TOOLS block is the default, and reproduces: ten minutes
  of continuous running on a Quadro T1000 with no driver resets, 1.9 GB resident, clocks
  at P3 throughout.
- **Qwen2.5-1.5B and up** trip the Windows GPU watchdog (TDR) on that card. Prefill is one
  dispatch, its duration scales with prompt length, and past two seconds Windows decides
  the card has hung and resets it. Everything the runtime holds is then freed, so the next
  call fails with whatever it touches first — `GrammarMatcher instance already deleted`,
  `Tokenizer instance already deleted`, `Object has already been disposed`. Four messages,
  one cause: `DXGI_ERROR_DEVICE_HUNG` in the browser console, and event 4101 in the
  Windows system log. Raising `TdrDelay` to 10 seconds is the fix if you want the bigger
  models; nothing in this repo can work around it.
- **SmolLM2-360M and below** never trip it, and write Python instead of tool calls.

Every turn starts in a fresh environment. The engine's conversation and KV cache are
dropped before a cell runs, so a turn depends on that cell's text and nothing else: no
inheritance from whichever cell happened to run before it, and nothing that accumulates
over an hour.

A turn's cost is still not fixed, which is why an hour of clean running can end in a
reset: each round appends the model's reply and the tool results to the conversation, and
a read returns a neighbour's text. So a turn that reads two grown documents prefills
several times what a plain one does. Two limits keep that bounded, and both are prices
rather than rules:

- **read cap** — a read returns at most 600 characters, then says how many it withheld.
- **turn budget** — the slice covers everything a turn costs: the cell's own text, what
  it reads, and what it says. A conversation grown past it ends the turn, and a cell too
  long to afford its own prompt cannot act at all, so it cannot reproduce. Length is
  priced, and past a point it is lethal.

And a reset is no longer fatal. The runtime cannot be revived, so the page builds a whole
new engine on the same adapter and the run continues, up to five times. The soup itself is
never touched by a reset; only the model's device state dies.

Hence two switches that look like fussiness and are not:

- **Short TOOLS** (`?tools=full` for the verbose one) halves the prompt, which roughly
  halves the prefill dispatch. This is the difference between running and not.
- **Grammar** (constrained decoding, on by default) is what makes a 1B model act at all.
  Without it, it narrates what it would do in prose and the turn does nothing. The token
  masking is CPU-side and costs no GPU time. It was removed once, blamed for the watchdog
  errors above; that was wrong.

`?engine=<model id>` selects any model WebLLM knows, in or out of the picker.

## Engines

- `mock`: no GPU. Behaves as a well-tuned ancestor should: copies into an empty
  neighbour; occasionally chatters instead.
  Exists to develop the loop without waiting on inference, and as the control for whether
  behaviour comes from the model or from the rules.
- `openrouter`: the cells run on OpenRouter's free hosted models instead of the local GPU.
  No WebGPU and no watchdog, models far bigger than a laptop can hold, and a genuinely
  stateless environment per turn. The costs are different rather than absent: the free
  tier is rate limited so the soup runs at the API's pace, and a cell's text leaves the
  machine. The key is the visitor's own, kept in their browser's localStorage; there is
  none in this repo and a published copy must ask each visitor for theirs.
  `cohere/north-mini-code:free` is the default whenever a key is stored: a code model is
  the right shape for an instruction set made of keystrokes, it is free with a long
  context, and a hosted model has no GPU watchdog to trip. Without a key the page falls
  back to the local default. The order is: `?engine=` in the URL, then whatever was chosen
  last, then the hosted model, then the local one.
- `webllm`: a small instruct model over WebGPU, loaded in the page and cached by the
  browser. Qwen2.5-0.5B is the working floor; the status line shows which GPU it got.

## Runs on disk

While `serve.py` is running, the page saves the whole run to `runs/latest.json` every 20
ticks, after every Step, and whenever a Run stops: the grid, the settings, the statistics,
and the last 40 turns with their full transcripts. That is the file to read when you want
to know why a cell did what it did, and **Load** puts a saved soup back so a run can be
continued rather than restarted. **Export** writes the same object to your downloads.

The endpoint is `POST /save/<name>.json`, which only this development server offers; a
published copy of the page has none, so saving quietly does nothing and the run is
otherwise unaffected.

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

## The vi branch

An experiment on branch `vi`: the cell's instruction set is a small vi, and the string the
model returns is keystrokes rather than JSON.

The appeal is Tierra's property. Almost every character is a valid command, so a mutated
keystroke string is still a program that does something — where a mutated JSON call is
usually just malformed. Mutations of the ancestor `ggyGLggVGp` (yank all, move east,
select all, paste over) give: `ggyGKggVGp` reproduces north instead; `ggyGLgVGp` appends
rather than replaces; `ggyGLggVGq` is sterile; `xgyGLggVGp` damages itself and then copies
the damage. All of them run.

The cursor starts in the cell whose turn it is and walks the grid. `h j k l` move it
inside a cell; `H J K L` move it one whole cell west, south, north or east, and keep
going — `LL` is two cells east, `3K` is three cells north. Reach is bounded by nothing but
what a turn can afford in keystrokes, so distance is a price rather than a rule. There is
no filesystem and no `:w`: a cell is a buffer and editing it is the write. One register,
belonging to the turn, carries text between cells. A cell's cursor position is part of its
state, so where a lineage leaves its cursor is inherited with its text.

Special keys are spelled in vim's own key notation (`:help key-notation`): `<Esc>`,
`<CR>`, `<BS>`, `<Tab>`, `<Space>`. Pressing those keys with *type straight in* enabled
appends the same spelling, so what you type by hand and what a model writes are one
language.

### Wired into the soup

Choose **instructions: vi keystrokes** on the run tab (the default on this branch; add
`?mode=tools` for the JSON toolset). A turn is one call, and **the cell's text is the
entire body sent to the model** — no reference block, no host paragraph, no system turn.
The reply comes back as an ordinary one, prose and commands, and the commands are taken
from whatever the model marked as code: fenced blocks first, then backticked spans, and
failing any marking a last line that looks like keys rather than words. A reply with
nothing usable in it runs nothing, because prose executed as vi is destruction, and the
turn has still spent its slice.

Because the cell is everything, the key reference lives in the cell too. The seed mother
(`ancestor-vi.md`) opens with the fenced `ggyGLggVGp` and the instruction to reply with
it, and only then explains what the keys do and what is going on — a model's reply tends
to mirror the shape of what it was given, so the payload goes first and the prose after.
An earlier version led with a table of keys, and a 1B model answered by narrating the
table one key at a time until it ran out of tokens, never reaching the instruction.

The keys are written spread out — `gg yG   L   gg VG p` — because spaces and line breaks
are no-ops in normal mode, and ten dense characters are hard for a small model to copy
exactly: asked for `ggyGLggVGp`, Llama-3.2-1B returned `ggyGggggVp` and pasted over
itself. Spacing costs nothing and every spelling of it runs the same program, which gives
the genome a wide neutral network: many mutations change the text without changing what it
does. That makes the reference heritable and mutable like the rest: a lineage that keeps a good
reference reproduces, one that loses it drifts. That is the whole experiment. A cell's
text is not data the model reads about, it is the thing that has to induce a working
program.

Two dynamics show up within a few hundred ticks. A genome that only goes east fills one
row of the torus and stops, so the soup selects for variation in direction. And the texts
grow: paste-over leaves several copies of the instruction in a cell, which makes the
keystrokes easier for the model to find — a more robust representation of the same
program, arrived at by selection rather than design.

Hovering a cell on the grid shows what is in it and what the model said when it last ran,
without leaving the run tab. Clicking one opens the same thing in full on the cell tab.

The **vi** tab is a bench for trying it by hand: a window of the grid around the cursor,
the keystroke stream shown key by key (click any key to run up to that point), Step and
Back, presets, and a box to type straight in. *Apply as new start* takes the result as the
next starting point, the way one turn hands on to the next.
