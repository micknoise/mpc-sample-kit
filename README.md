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
