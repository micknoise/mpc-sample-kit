// Pad and note mapping for the MPC Sample.
//
// The unit has 16 pads. MPC convention puts bank A on MIDI notes 36-51, which
// is verified working on this hardware: notes 0x24-0x33 all trigger.

export const PAD_COUNT = 16;
export const PAD_BASE_NOTE = 36;

/** Pad number (1-16) to MIDI note. */
export function padToNote(pad) {
  if (!Number.isInteger(pad) || pad < 1 || pad > PAD_COUNT) {
    throw new RangeError(`pad must be an integer 1-${PAD_COUNT}, got ${pad}`);
  }
  return PAD_BASE_NOTE + pad - 1;
}

/** MIDI note to pad number, or null if the note is outside bank A. */
export function noteToPad(note) {
  const pad = note - PAD_BASE_NOTE + 1;
  return pad >= 1 && pad <= PAD_COUNT ? pad : null;
}

// Provisional role -> pad layout. Factory kits differ, so treat this as a
// starting point to be overridden per kit rather than as ground truth; it has
// not yet been confirmed by ear against a specific kit on this unit.
export const DEFAULT_KIT = {
  kick: 1,
  snare: 2,
  clap: 3,
  rim: 4,
  hat: 5,
  hatOpen: 6,
  shaker: 7,
  tamb: 8,
  tomLow: 9,
  tomMid: 10,
  tomHigh: 11,
  ride: 12,
  crash: 13,
  perc1: 14,
  perc2: 15,
  fx: 16,
};

/**
 * Resolves a track name to a MIDI note. Accepts a role name from the kit map,
 * a bare pad number, or "padN".
 */
export function resolveNote(name, kit = DEFAULT_KIT) {
  if (typeof name === 'number') return padToNote(name);
  if (name in kit) return padToNote(kit[name]);
  const m = /^pad\s*(\d+)$/i.exec(name);
  if (m) return padToNote(Number(m[1]));
  throw new Error(`unknown track "${name}" — not in kit map and not a pad number`);
}
