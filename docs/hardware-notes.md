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

## Storage — solved: the data partition is ext4

Disk mode is **SHIFT + pad 16 (PROJECT) → encoder → `SD Card Access`**.

**MIDI and disk mode are mutually exclusive.** The moment disk mode engages,
both CoreMIDI endpoints disappear; `mpcmidi list` returns nothing. Any tool
that drives the unit must treat these as two states, not one.

When disk mode engages, `/dev/disk6` appears — 7.9 GB, FDisk partition scheme:

| Partition | Size | Type | Mounts on macOS? |
|---|---|---|---|
| `disk6s1` | 66 MB | FAT16, volume `boot` | **yes** — `/Volumes/boot` |
| `disk6s2` | 7.9 GB | `Linux` (ext4) | **no** |

This explains the long-standing "projects don't show up in Finder" symptom
completely. The MPC Sample runs embedded Linux and keeps its content on an ext4
partition, which macOS cannot mount natively. Finder shows only the small FAT
partition. Nothing is wrong with the card, the cable or the procedure.

### The transfer area

The FAT partition carries the sanctioned exchange folders, and they are
writable from macOS:

```
/Volumes/boot/MPC-Sample/
├── Projects/
└── Samples/User/
```

Both were empty on first inspection. This is almost certainly the import/export
staging area — meaning **samples can be delivered to the device without any
ext4 access at all**, which is the route drumkit creation should take.

Note the 63 MB usable ceiling on this partition. That is a real constraint on
how much sample content can be staged in one pass.

### Reading ext4, if it ever proves necessary

`/dev/rdisk6s2` is not readable without root. Options, in increasing weight:
export a project from the device into the staging folder and avoid ext4
entirely; macFUSE + `ext4fuse` (read-only, needs a kernel extension, security
approval and a reboot); or a Linux VM with the raw device passed through.
Neither macFUSE, Docker, colima nor lima is currently installed on this Mac.

Writing to ext4 from macOS should be considered off the table — `fuse-ext2` is
known to be unreliable, and this is the device's root filesystem.

### Caution

`disk6s1` is named `boot` and sits next to the device's root filesystem.
Confine all writes to `MPC-Sample/Projects` and `MPC-Sample/Samples/User`.

MPC projects are a `.xpj` project file plus a matching `[ProjectData]` folder;
**both** are required for a project to reopen. Programs are `.xpm`.

## Timing, measured

Established with the **Measure timing** button, which sends a burst at exact
intervals and times the MPC's echo, so the figure covers the whole chain.

| Path | Result |
|---|---|
| Laptop, `mpcmidi` via CoreMIDI | 0.6ms sd — the noise floor |
| iPhone, MIDIWeb Browser | under 5ms |
| iPhone, Web MIDI Browser | 10.9ms mean, 30ms worst |
| iPhone, Web MIDI Browser, native timestamps | 36ms mean, 79ms worst |

The laptop baseline matters most: it proves the MPC's soft-thru and the USB link
contribute almost nothing, so any jitter above that is the sender's.

What did **not** move the Web MIDI Browser figure: a larger look-ahead, caching
bar generation off the main thread, or driving dispatch from an AudioWorklet at
2.7ms. That last one is conclusive — a punctual wake-up producing an unchanged
mean means scheduling was never the bottleneck. The cost is downstream of
`send()`, in the app's JavaScript-to-native bridge, and is not reachable from
JavaScript.

Switching app fixed it. Worth reaching for a measurement early next time rather
than optimising against a guess.

## Constraints that shape the design

- Max 128 samples per project, one sample per pad.
- Projects are readable by MPC software 3.8+, but MPC 3 projects cannot be
  imported back onto the unit.
- 16 pads. MPC convention is bank A = MIDI notes 36–51.
