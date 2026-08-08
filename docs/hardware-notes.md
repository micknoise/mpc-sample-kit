# MPC Sample — hardware findings

Running log of what has been **verified against the actual unit** versus what is
still assumption. Keep the distinction honest; a lot of MPC documentation online
describes the larger MPC standalones and does not transfer.

## Verified on hardware

Date: 2026-08-08. Firmware: latest (per owner). macOS 15 (Darwin 25.5.0), Apple silicon.

| Fact | Evidence |
|---|---|
| Enumerates on USB as `Akai` / `MPC Sample` | `ioreg -p IOUSB`: idVendor `2536` (0x09E8), idProduct `8284` (0x205C) |
| Presents a class-compliant USB-MIDI interface | CoreMIDI exposes one source and one destination, both named `MPC Sample` |
| Both MIDI endpoints report as live | `kMIDIPropertyOffline == 0` on source and destination |
| Does **not** mount as mass storage by default | `diskutil list` shows no external volume while connected |
| Sends **no** MIDI when pads are pressed | 25s capture with owner playing pads: zero bytes |
| Produces **no** sound from inbound note-on | Notes 0x24–0x27 sent on ch.1 and ch.10, velocity 0x7F: silent |
| `mpcmidi` send + monitor paths are correct | Virtual-source loopback (`testsrc` → `monitor`) captures every packet |

The last row matters: the two negative results above it are **not** tool bugs.
The CoreMIDI send and receive paths are proven working independently of the MPC.

## Open questions

- Does the MPC Sample transmit MIDI from its pads at all? The Akai FAQ notes it
  "is not compatible for use as a controller with MPC 3 Software", which hints
  that pad-to-MIDI-out may simply not be a feature.
- Is there a MIDI enable/routing preference on the device gating USB MIDI I/O?
- Does inbound MIDI only sound when a track is selected and its input armed?
- Which storage does `SD Card Access` expose — the microSD only, or the 8GB
  internal drive? Owner reports projects are not visible on either.

## Storage

Reported device path to disk mode: **SHIFT + pad 16 (PROJECT) → encoder →
`SD Card Access`**. Unconfirmed on this unit.

The name suggests only the microSD is exposed, not the 8GB internal drive. If
projects save to internal storage by default, they would never appear on the
mounted volume — which matches the reported symptom exactly. Likely workaround
is to explicitly save/copy the project to the SD card from the device first.

MPC projects are a `.xpj` project file plus a matching `[ProjectData]` folder;
**both** are required for a project to reopen. Programs are `.xpm`.

## Constraints that shape the design

- Max 128 samples per project, one sample per pad.
- Projects are readable by MPC software 3.8+, but MPC 3 projects cannot be
  imported back onto the unit.
- 16 pads. MPC convention is bank A = MIDI notes 36–51.
