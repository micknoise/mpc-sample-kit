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

/**
 * A kit entry expressed as a raw MIDI note rather than as a pad.
 *
 * Bank A covers notes 36-51, which is every pad the unit has and therefore
 * everything a kit needed to say — until the target stopped being the MPC. A
 * General MIDI device puts its crash at 49 but its tambourine at 54 and its
 * cowbell at 56, so a role map that can only name pads cannot describe one.
 *
 * Wrapping rather than allowing bare numbers keeps `kick: 1` unambiguous: it
 * has always meant pad 1, and silently reinterpreting it as note 1 would
 * retune every existing kit file.
 */
export function midiNote(n) {
  if (!Number.isInteger(n) || n < 0 || n > 127) {
    throw new RangeError(`midi note must be an integer 0-127, got ${n}`);
  }
  return { midi: n };
}

const isNoteEntry = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && 'midi' in v;

/** One kit entry — a pad number or a midiNote() — to a MIDI note. */
function entryToNote(entry) {
  if (isNoteEntry(entry)) return midiNote(entry.midi).midi;
  return padToNote(entry);
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
 * a bare pad number, "padN", or "noteN" for a device addressed by note rather
 * than by pad. Kit entries may be an array, in which case the first entry is
 * the primary voice.
 */
export function resolveNote(name, kit = DEFAULT_KIT) {
  if (typeof name === 'number') return padToNote(name);
  if (name in kit) {
    const v = kit[name];
    return entryToNote(Array.isArray(v) ? v[0] : v);
  }
  const pad = /^pad\s*(\d+)$/i.exec(name);
  if (pad) return padToNote(Number(pad[1]));
  const note = /^note\s*(\d+)$/i.exec(name);
  if (note) return midiNote(Number(note[1])).midi;
  throw new Error(`unknown track "${name}" — not in kit map and not a pad number`);
}

/**
 * How a kit addresses a role: the note it resolves to, and the pad number if
 * that is what it is.
 *
 * `pad` is null for a kit that names notes directly, which is not the same
 * question as whether the note happens to fall inside bank A: General MIDI's
 * snare is note 38, and calling that "pad 2" would be a display that lies. So
 * the entry's own form decides, not the range it lands in.
 */
export function voiceInfo(name, kit = DEFAULT_KIT) {
  const note = resolveNote(name, kit);
  const entry = Array.isArray(kit[name]) ? kit[name][0] : kit[name];
  const byNote = isNoteEntry(entry) || /^note\s*\d+$/i.test(String(name));
  return { note, pad: byNote ? null : noteToPad(note) };
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
    return kit[name].map(entryToNote);
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
