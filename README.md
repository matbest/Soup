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

**The window is the turn budget.** A vi cell's own text is the whole of its prompt, and
prefill is one GPU dispatch whose duration grows with it. The *turn budget* covers prompt
and reply together: what fits is sent and the rest is cut, mid-line if that is where the
line falls. A cell is never refused a turn, but a genome longer than the window has a tail
the model never sees.

That makes *where* the keys sit in a file matter. The seed puts its keystrokes on the
first line and so survives being cut; a lineage whose keys drift below the line goes
sterile without anything else changing. It also means length beyond the window is free —
it costs no prompt tokens because it is never sent — so the pressure toward brevity acts
only on the part that fits. And on a small card it is what stops prefill growing until the
Windows watchdog kills the device.

The cell tab draws the prompt white up to the line and red beyond it.

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
  A long run has to pace itself: the **calls/min** dial sets the floor between calls,
  and in vi mode a turn is one call, so it is also turns per minute. It starts at 10. Every refusal widens
  that gap by half again and each success narrows it, so a run finds the pace the service
  will accept rather than being cut off. `Retry-After` is honoured. Running out of the
  day's free allowance pauses the run and saves it rather than failing, so it can be
  picked up later with nothing lost. The status line shows the key's remaining allowance
  and the rate limit the service reports.

  `cohere/north-mini-code:free` is the default whenever a key is stored: a code model is
  the right shape for an instruction set made of keystrokes, it is free with a long
  context, and a hosted model has no GPU watchdog to trip. Without a key the page falls
  back to the local default. The order is: `?engine=` in the URL, then whatever was chosen
  last, then the hosted model, then the local one.
- `webllm`: a small instruct model over WebGPU, loaded in the page and cached by the
  browser. Qwen2.5-0.5B is the working floor; the status line shows which GPU it got.

### Losing the device is survivable

A device loss no longer ends a run. The page builds a fresh engine on the same adapter and
carries on, up to twenty times, and each loss halves what a turn may carry — so a machine
that keeps failing converges on a window it can manage instead of failing the same way
over and over. What it learns is kept in the browser, per model, so reloading the page
starts from the measured rate and the tightened window rather than relearning them by
losing the device again.

### Not running the fans off

A local model runs turn after turn with nothing between them, which on a laptop means the
GPU is held at full tilt for as long as the run lasts. The **rest** dial idles for that
percentage of however long each turn took — proportional rather than a fixed delay, so it
means the same thing on a fast machine as a slow one. At 15% the card is idle roughly a
seventh of the time and the soup takes about a seventh longer. Nothing else changes.

The animation is idle time too: while a turn is being replayed on the grid, the GPU is
doing nothing.

### Carrying on by itself

Add `?resume=1` and a run looks after itself overnight. A device loss is rebuilt in place;
if the browser will not hand back an adapter at all — which happens, and which a person
fixes by reloading the page — the page saves the soup, reloads itself, loads the soup back
and presses Run. Five reloads at most, so a machine that simply cannot run this stops
trying, and only a reload the page asked for resumes a soup: a fresh visit starts fresh.
Without the flag nothing reloads on its own.

### The window fits the machine

A visitor cannot be asked to change a registry key before a web page will work, so the
page measures instead. WebLLM reports how many tokens a second it managed to prefill;
prefill is one GPU dispatch, and Windows resets a card whose dispatch runs past two
seconds. So the prompt window is whichever is smaller: the turn budget, or what this
particular machine can prefill in 1.2 seconds. Until a turn has been timed it assumes a
slow card — guessing high is what loses the device, guessing low only costs a shorter
genome — and each device loss halves the estimate again.

    not yet measured        120 tokens
    a T1000 at 99/s         118 tokens
    a quicker iGPU at 400/s 480 tokens
    a desktop card          900 tokens, the budget rather than the card
    after two device losses  29 tokens

A hosted model has no watchdog, so only the budget applies. The cell tab shows the window
and the measured rate.

### On a slow card

Prefill is one GPU dispatch, and Windows resets the card if a dispatch runs past two
seconds. Measured on a Quadro T1000 driving a 1B model: about **99 prefill tokens a
second**, so the watchdog allows roughly 200 prompt tokens and the full seed's 232 is
already over the line. The card is not being throttled and the weights are in video
memory — sampling it through a turn shows 100% utilisation at 1350 MHz of a 1530 MHz
maximum, drawing 21 W, for about three seconds, and then the device goes. The work really
does take that long, because WebGPU shaders cannot reach the card's tensor cores.

`?seed=min` seeds a 49-token version of the same organism, which prefills in about half a
second. Dropping the slice to 60 tokens shortens decode too. Neither changes the
experiment: it is the same keystrokes and the same instruction set, with less prose around
them.

`tools/GPU watchdog.cmd` puts a switch in the notification area for it: it shows what the
watchdog is set to, offers ten seconds or the Windows default, and explains the trade in
its own words. Reading the setting needs nothing; changing it asks for administrator
rights each time and takes effect at the next restart. It never touches `TdrLevel`, which
is what would stop Windows recovering a hung GPU at all.

The same thing by hand, if you would rather: a `TdrDelay` DWORD
of 10 under `HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers`, and a reboot. That
is a system-wide graphics setting, so it is not something this repo does for you.

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

The seed says what a cell is, how to reproduce, and what the keys do. Nothing else: no
mention that compute is scarce, that shorter runs more often, that copying is imperfect,
or that anything is being selected for. Hinting the answer would decide the experiment.
(A host-supplied system prompt is a separate lever, and there isn't one yet.)

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

A turn plays out on the grid before it is committed: the keystrokes are replayed one
command at a time, the cell's text is drawn small enough to be texture, and a highlight
follows the cursor from cell to cell so it can be seen moving and pasting. The replay
re-runs from the start at each step with the turn's own seed, so `R` falls the same way
in the replay as in the turn that is finally applied — what is watched is what happens.
The **animate** dial is milliseconds between commands, 0 for no replay, and **cell text**
turns the writing in the cells off.

Hovering a cell on the grid shows what is in it and what the model said when it last ran,
without leaving the run tab. Clicking one opens the same thing in full on the cell tab.

The **population** tab lists the distinct texts by how many cells carry them, how old they
are and how deep the lineage runs — click one to load it into the ancestor box. Below it,
a soup can be kept under a name, downloaded, opened from a file, or started again. Named
soups sit beside the automatic saves in `runs/` and are listed newest first; clicking one
loads it back, tick and lineage intact. The naming matters because `latest.json` is
overwritten every twenty ticks, so a run worth returning to needs a name of its own.

### Reading a run

Every cell has a **genotype** name in Tierra's style — `0193-z4yk` — its length, then a
hash of its text, so identical texts share a name and the size of a thing is legible in
it. Ray's creatures were named the same way, `0080aaa` and `0045aaa`, which is why his
famous plot can be read at a glance.

At the close of every sweep a row is written: how many cells are alive, how many kinds
there are, the shortest, median and longest genome, how many were born and how many were
written over, the failure rate, the tokens spent, the prompt window, and the commonest
genotype with its count. Every save writes the log as a spreadsheet beside the soup: `runs/log.csv` for the
automatic one, `runs/<name>.csv` for a named soup. So there is always a plottable file on
disk without anyone pressing anything. The population tab shows the last forty rows and
will download a copy too. The whole history travels inside a saved soup, so a run can be picked
apart afterwards.

Those are the numbers Tierra was read through — size over time above all, since the
result everyone remembers is an ancestor of 80 instructions giving way to parasites of 45
and then to an optimised replicator of 36.

The **vi** tab is a bench for trying it by hand: a window of the grid around the cursor,
the keystroke stream shown key by key (click any key to run up to that point), Step and
Back, presets, and a box to type straight in. *Apply as new start* takes the result as the
next starting point, the way one turn hands on to the next.
