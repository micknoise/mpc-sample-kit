// A sampled General MIDI kit, played from a SoundFont.
//
// The third output, alongside a real MIDI port and the synthesised kit in
// synth.mjs. Where that one is oscillators and noise — recognisably a drum
// machine — this plays actual recordings of actual drums, and comes with the
// GM/GS drum kit list: Standard, Room, Power, Electronic, TR-808, Jazz, Brush,
// Orchestra and whatever else the loaded bank carries.
//
// The engine is injected rather than imported. Two reasons: the SoundFont
// player is a third-party library that only exists in the browser, and keeping
// it out of here means this module stays testable against a fake and the core
// in src/ keeps its "no dependencies" property. The web app supplies the real
// one; see web/vendor.
//
// Scheduling is sample-accurate. The engine takes an AudioContext time per
// event, so the transport's look-ahead timestamps are honoured exactly as the
// built-in synth honours them — no timer, no queue drained by polling.

import { contextTimeFor } from './audioclock.mjs';

/**
 * In the SoundFont spec, percussion presets live in bank 128. That is the
 * convention a GM bank is built to, and what makes "which kits does this file
 * contain?" answerable rather than guesswork.
 */
export const DRUM_BANK = 128;

/**
 * The GM/GS drum kits, by program number on the percussion channel.
 *
 * A fallback for naming: a bank that reports its own presets is preferred, and
 * `drumKits()` uses those. This is what to show when it does not, and it is
 * also the list an external GM sound module will respond to — the same program
 * change reaches a hardware module and this player alike.
 */
export const GM_DRUM_KITS = [
  { program: 0, name: 'standard' },
  { program: 8, name: 'room' },
  { program: 16, name: 'power' },
  { program: 24, name: 'electronic' },
  { program: 25, name: 'TR-808' },
  { program: 32, name: 'jazz' },
  { program: 40, name: 'brush' },
  { program: 48, name: 'orchestra' },
  { program: 56, name: 'sound FX' },
];

/**
 * The drum kits a loaded bank actually contains, lowest program first.
 *
 * Reading them off the bank rather than assuming the GM list means the kit
 * selector describes the file in front of it — a bank with thirteen kits shows
 * thirteen, and a custom one shows its own names.
 *
 * @param {Array<{program:number, bankMSB:number, name:string, isDrum:boolean}>} presets
 */
export function drumKits(presets) {
  if (!Array.isArray(presets)) return GM_DRUM_KITS;

  const kits = presets
    .filter((p) => p && (p.isDrum || p.bankMSB === DRUM_BANK))
    .map((p) => ({ program: p.program, name: (p.name ?? '').trim() || `program ${p.program}` }));

  // De-duplicate by program: a bank may list the same kit under several bank
  // LSBs, which is a distinction the sound does not make.
  const seen = new Map();
  for (const kit of kits) if (!seen.has(kit.program)) seen.set(kit.program, kit);

  return seen.size
    ? [...seen.values()].sort((a, b) => a.program - b.program)
    : GM_DRUM_KITS;
}

/**
 * Wraps a SoundFont engine so it looks like a Web MIDI output.
 *
 * @param {BaseAudioContext} context
 * @param {object} engine   noteOn/noteOff/programChange/controllerChange/stopAll,
 *                          each taking `{ time }` in AudioContext seconds
 * @param {object} [opts]
 * @returns {{id:string, name:string, kind:string, send:function, clear:function, close:function}}
 */
export function createSoundfontOutput(context, engine, opts = {}) {
  const {
    id = 'soundfont',
    name = 'SoundFont — General MIDI',
    now = () => performance.now(),
  } = opts;

  const at = (ms) => ({ time: contextTimeFor(context, ms, now) });

  return {
    id,
    name,
    kind: 'audio clock',

    /**
     * Plain MIDI in, sound out — including program change, so selecting a drum
     * kit is an ordinary MIDI message rather than a special API. The same
     * message sent to a hardware GM module selects the same kit there, which is
     * why the kit selector works for both.
     */
    send(bytes, when) {
      if (!bytes || !bytes.length) return;
      const status = bytes[0] & 0xf0;
      const channel = bytes[0] & 0x0f;

      switch (status) {
        case 0x90:
          // Velocity 0 is a note-off, as it has been since running status.
          if (bytes[2] > 0) engine.noteOn(channel, bytes[1], bytes[2], at(when));
          else engine.noteOff(channel, bytes[1], at(when));
          return;

        case 0x80:
          engine.noteOff(channel, bytes[1], at(when));
          return;

        case 0xc0:
          engine.programChange(channel, bytes[1], at(when));
          return;

        case 0xb0:
          engine.controllerChange(channel, bytes[1], bytes[2] ?? 0, at(when));
          // The transport's panic. Scheduled controller changes are not enough
          // on their own: notes already queued ahead of it would still sound.
          if (bytes[1] === 0x7b || bytes[1] === 0x78) this.clear();
          return;

        default:
          // Clock, transport and SysEx have no meaning to a sound bank.
      }
    },

    /** Kills everything, including whatever the look-ahead already queued. */
    clear() {
      engine.stopAll?.(true);
    },

    close() {
      this.clear();
      engine.destroy?.();
    },
  };
}
