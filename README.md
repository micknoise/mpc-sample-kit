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
src/            pattern + scheduling core, framework-free ES modules
bin/mpc-seq.mjs CLI: render a pattern and play it
patterns/       example patterns
tools/midi/     mpcmidi — zero-dependency CoreMIDI CLI
docs/           hardware findings, verified vs assumed
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
