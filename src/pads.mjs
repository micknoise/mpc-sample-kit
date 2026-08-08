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
 * Alternate voices for a role.
 *
 * A real drummer does not hit the same spot on the same drum every time. Rim
 * clicks, edge hits and claps stand in for the snare constantly, and it is a
 * large part of why programmed beats sound static by comparison. Listed
 * primary-first; the primary is what plays unless a substitution is made.
 */
export const DEFAULT_VOICES = {
  snare: ['snare', 'rim', 'clap'],
  hat: ['hat', 'hatOpen', 'shaker'],
  kick: ['kick'],
};

/**
 * Resolves a track name to a MIDI note. Accepts a role name from the kit map,
 * a bare pad number, or "padN". Kit entries may be an array, in which case the
 * first entry is the primary voice.
 */
export function resolveNote(name, kit = DEFAULT_KIT) {
  if (typeof name === 'number') return padToNote(name);
  if (name in kit) {
    const v = kit[name];
    return padToNote(Array.isArray(v) ? v[0] : v);
  }
  const m = /^pad\s*(\d+)$/i.exec(name);
  if (m) return padToNote(Number(m[1]));
  throw new Error(`unknown track "${name}" — not in kit map and not a pad number`);
}

/**
 * All notes available to a track, primary first.
 *
 * Roles missing from the voice map, or whose alternates are not in the kit,
 * fall back to just the primary — so a custom kit never breaks playback.
 */
export function resolveVoices(name, kit = DEFAULT_KIT, voices = DEFAULT_VOICES) {
  const primary = resolveNote(name, kit);

  if (name in kit && Array.isArray(kit[name])) {
    return kit[name].map((pad) => padToNote(pad));
  }
  const roles = voices[name];
  if (!roles) return [primary];

  const notes = [];
  for (const role of roles) {
    if (!(role in kit)) continue;
    const note = resolveNote(role, kit);
    if (!notes.includes(note)) notes.push(note);
  }
  return notes.length ? notes : [primary];
}
