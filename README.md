# mpc-sample-kit

A framework for controlling and automating the **Akai MPC Sample** — the
battery-powered standalone sampler Akai released in March 2026 — with the
long-term goal of driving it from natural language.

Status: **early**, but playing. Patterns generated on the laptop drive the unit
over USB-MIDI with musical timing.

## Quick start

```bash
cd tools/midi && make && cd -
node bin/mpc-seq.mjs patterns/boom-bap.json
```

On the device, **SHIFT + pad 8 (MIDI CONFIG) → MIDI Port → `USB`** first, or
nothing will sound.

## Goals

- Author drum sequences programmatically and schedule them onto the unit.
- Generate drumkits (`.xpm` programs plus samples) from a description.
- Drive the sequencer live from a laptop over USB-MIDI.
- Do as much as possible from a static, client-side HTML app on GitHub Pages,
  with **no backend** — Web MIDI for control, the File System Access API for
  writing projects to the mounted device.
- Let Claude Code act as the natural-language driver via the same core library.

## Layout

```
src/             pattern, dynamics, generation, transforms, arrangement, clock
bin/mpc-seq.mjs  render a pattern or phrase and play it
bin/mpc-live.mjs continuous generation, steerable while running
bin/mpc-kit.mjs  audition pads and save a kit map
web/             Web MIDI browser app (Chromium)
patterns/        example patterns
kits/            saved role->pad maps
tools/midi/      mpcmidi — zero-dependency CoreMIDI CLI
docs/            hardware findings, verified vs assumed
test/            node --test suite
```

The core in `src/` has no Node or browser dependencies, so the same rhythm code
will drive both this CLI and the planned Web MIDI page. Delivery backends stay
dumb: they receive `{ ms, bytes }` and have no opinion about timing.

## Patterns

Step strings, one per track. Written to be easy to read, edit and generate:

| Char | Meaning |
|---|---|
| `.` | rest |
| `x` | accent (velocity 110) |
| `o` | normal hit (90) |
| `s` | ghost note (45) |
| `1`–`9` | explicit level |
| ` ` `\|` | ignored, for spacing bars out |

```json
{
  "bpm": 88,
  "swing": 0.18,
  "humanizeMs": 6,
  "humanizeVel": 12,
  "repeats": 4,
  "tracks": {
    "kick":  "x..o | .... | ..x. | o...",
    "snare": ".... | x..s | .... | x.s.",
    "hat":   "o.oo | o.o. | o.oo | o.o."
  }
}
```

Swing delays every second step; musical values sit around 0.1–0.3. Humanisation
is seeded, so a given `--seed` always renders identically.

```bash
node bin/mpc-seq.mjs patterns/boom-bap.json --bpm 96 --repeats 8
node bin/mpc-seq.mjs patterns/boom-bap.json --dry-run   # inspect events
```

## Generating patterns

Styles are starting points chosen to respond well to the transforms below:

```bash
node bin/mpc-seq.mjs --list-styles
node bin/mpc-seq.mjs --style garage --bars 8
```

Euclidean rhythms distribute pulses as evenly as possible across a bar, which
is where a lot of the interesting material comes from. `name=pulses/steps`,
optionally `@rotation`:

```bash
node bin/mpc-seq.mjs --euclid "kick=4/16,snare=2/16@4,hat=7/16" --bpm 128 --bars 8
```

This is Bjorklund's algorithm proper, so the named rhythms come out canonical —
`E(3,8)` is the tresillo `x..x..x.`, `E(5,8)` the cinquillo `x.xx.xx.`.

## Algorithmic control

`--bars N` grows a one-bar idea into a phrase that develops instead of looping.
Each bar varies the *original* rather than the previous bar, so the groove
drifts without wandering off; bar 1 always plays as written so the listener
hears the idea plainly first.

```bash
node bin/mpc-seq.mjs --style techno --bars 16 --drift 0.4 --fill-every 4 --lock kick
```

| Flag | Effect |
|---|---|
| `--drift` | 0–1, how far variations stray |
| `--fill-every N` | fill on every Nth bar, 0 to disable |
| `--lock a,b` | tracks held steady while others vary |
| `--ratchet P` | probability of a hit becoming a roll |
| `--seed N` | seed for all randomness |

Everything stochastic is seeded, so a phrase you like is reproducible: note the
seed and it renders identically every time.

The building blocks are composable directly from [`src/`](src/transform.mjs) if
the CLI flags are too blunt — `rotate`, `thin`, `densify`, `mutate`, `shade`,
`accentEvery`, `upsample`, `vary`, `fill`, plus `arrange`, `evolve` and `chain`
for song form.

## Dynamics

Flat velocity is the clearest sign a beat was generated rather than played.
Velocities are shaped by **metric position**: the more times a step index
divides by two, the stronger the position, which falls straight out of the
binary structure of the bar and generalises to any grid.

For a 16-step bar the hierarchy is beat 1 (1.00) > beat 3 (0.76) > beats 2 and
4 (0.63) > eighths (0.49) > sixteenths (0.35).

| Flag | Effect |
|---|---|
| `--dynamics D` | how much metric position shapes volume (default 0.45) |
| `--conformity C` | proportion of hits following the metre (default 0.8) |
| `--no-anchor` | let beat 1 be de-accented too, dissolving the pulse |

Conformity is what stops this becoming mechanical: at `0.8`, one hit in five is
displaced onto a weak step instead, which is what syncopation *is*. By default
beat 1 is exempt so the pulse stays anchored; `--no-anchor` removes that
exemption when losing the downbeat is the point.

```bash
node bin/mpc-seq.mjs --style boom-bap --bars 8 --dynamics 0.6 --conformity 0.75
```

## Kits

The role→pad map in [`src/pads.mjs`](src/pads.mjs) is a convention, not
something read off the hardware. Audition the pads and save what you hear:

```bash
node bin/mpc-kit.mjs audition              # plays pads 1-16, announcing each
node bin/mpc-kit.mjs pad 7                 # one pad
node bin/mpc-kit.mjs save kick=1,snare=4,hat=9 --out kits/mine.json
node bin/mpc-seq.mjs --style boom-bap --kit kits/mine.json
```

Kit specs merge over the defaults, so naming two pads does not orphan the rest.

## Clock and transport

`--sync` sends MIDI clock at 24 PPQN wrapped in transport start/stop. Because
the notes and the clock come from the same timestamped event list, they cannot
drift apart.

```bash
node bin/mpc-seq.mjs --style techno --bars 8 --sync
```

## Live performance

`mpc-live` generates bars continuously and streams them ahead of the play
cursor, so the groove can be steered while it runs:

```bash
node bin/mpc-live.mjs --style boom-bap
```

Then type `drift 0.6`, `bpm 128`, `dyn 0.7`, `conf 0.6`, `lock kick,hat`,
`fill`, `seed 42`, `?` or `quit`.

The look-ahead window (default 2s) is what buys the slack: CoreMIDI owns
delivery timing, so this process only has to stay ahead, not be punctual.

## Browser app

[`web/index.html`](web/index.html) is the same core driven by Web MIDI, ready
for GitHub Pages. Serve the repo root — it imports `../src/` directly, and ES
modules will not load over `file://`:

```bash
python3 -m http.server 8765
```

then open `http://localhost:8765/web/`. Chromium only; Safari and Firefox do
not implement Web MIDI.

## Tests

```bash
node --test "test/*.test.mjs"
```

## tools/midi/mpcmidi

A ~140-line C utility so Claude Code can talk MIDI without native npm builds.

```bash
cd tools/midi && make
./mpcmidi list                              # enumerate ports
./mpcmidi send "MPC Sample" 90 24 7F        # note-on, pad 1
./mpcmidi monitor "MPC Sample" 10           # capture for 10s
./mpcmidi testsrc 5                         # virtual source, for self-testing
```

Port names match on a case-insensitive substring, so `mpc` finds `MPC Sample`.

`testsrc` exists to prove the send and receive paths work independently of any
attached hardware — worth running before concluding the device is at fault.

## Platform notes

The browser half is Chromium-only by necessity: Web MIDI and the File System
Access API are both unavailable in Safari and Firefox, and every iOS browser is
forced onto WebKit. See [`docs/hardware-notes.md`](docs/hardware-notes.md).

## Licence

MIT.
