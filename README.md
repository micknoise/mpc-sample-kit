# mpc-sample-kit

A framework for controlling and automating the **Akai MPC Sample** — the
battery-powered standalone sampler Akai released in March 2026 — with the
long-term goal of driving it from natural language.

Status: **early**. Bring-up and hardware reverse-engineering.

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
tools/midi/     mpcmidi — zero-dependency CoreMIDI CLI (send/monitor/list)
docs/           hardware findings, verified vs assumed
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
