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
| `mpcmidi` send + monitor paths are correct | Virtual-source loopback (`testsrc` → `monitor`) captures every packet |
| **USB MIDI must be enabled on the device** | SHIFT + pad 8 (MIDI CONFIG) → MIDI Port → `USB`. Before this, MIDI was silent in both directions despite live endpoints |
| Pads 1–16 respond to notes 36–51 (0x24–0x33) on ch.1 | Full sweep triggers audibly |
| Velocity is honoured | Rendered patterns with ghost notes and accents sound dynamic |
| Device echoes inbound MIDI back out (soft-thru) | Monitor captured our own sweep verbatim on the source port |
| Emits `B0 7B 00` / `B0 40 00` on port switch | All Notes Off + Sustain Off seen at start of capture |
| Timestamped scheduling holds up musically | 144 events over 10.6s via `mpcmidi play`, swung and humanised |

The loopback row matters: it was used to prove that the silence *before* the
MIDI Port setting was changed was a device configuration issue and not a bug in
this tooling.

Note the soft-thru behaviour when writing anything that listens: the device
will echo our own output back at us, so inbound capture is not automatically
evidence of user input.

## Open questions

- Does the MPC Sample transmit MIDI from its own pads? Still unobserved. The
  Akai FAQ notes it "is not compatible for use as a controller with MPC 3
  Software", which hints pad-to-MIDI-out may not be a feature. There is a
  `Pad MIDI Out` setting in the MIDI CONFIG menu still to be tested.
- Can the device's own sequencer record inbound MIDI? If so, patterns generated
  here could be captured to the unit without needing file access at all.
- Does it respond to MIDI clock / transport (0xFA start, 0xF8 clock)?

## Storage — mass storage is not being presented

The reported path is **SHIFT + pad 16 (PROJECT) → encoder → `SD Card Access`**.

Owner has a microSD card in the slot with projects on it, has used this mode,
and has also read the card directly in the MacBook. Projects appear on the
device's own screen but not on the computer.

Established here: while connected, **no block device exists for the MPC at all**
— `diskutil list` and `/dev/disk*` show only the internal drive and an Xcode
simulator image. This rules out a Finder visibility problem, an unmounted
volume, and an unreadable filesystem. The unit is enumerated on USB but is
presenting only its MIDI interface.

So the question is not "why is the volume hidden" but "why is the mass storage
interface absent". Next step is to watch `/dev` in real time while disk mode is
toggled on the device, to see whether it re-enumerates at all.

MPC projects are a `.xpj` project file plus a matching `[ProjectData]` folder;
**both** are required for a project to reopen. Programs are `.xpm`.

## Constraints that shape the design

- Max 128 samples per project, one sample per pad.
- Projects are readable by MPC software 3.8+, but MPC 3 projects cannot be
  imported back onto the unit.
- 16 pads. MPC convention is bank A = MIDI notes 36–51.
