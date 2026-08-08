// The General MIDI percussion map.
//
// This is the fallback when there is no MPC to talk to. GM is the one drum
// layout every other device agrees on — soft synths, hardware modules, a DAW's
// stock kit, the browser synth in synth.mjs — so a pattern written for pads
// stays playable when the hardware is not plugged in.
//
// Two things differ from the MPC path and both matter:
//
//   - Notes run 35-81, well past the 36-51 of pad bank A, so kit entries are
//     midiNote() wrappers rather than pad numbers.
//   - Percussion lives on channel 10. Sending GM notes on channel 1 plays a
//     piano, which is the usual reason a "silent" GM device turns out to have
//     been working all along.

import { midiNote } from './pads.mjs';

/** GM percussion is channel 10, by the standard rather than by convention. */
export const GM_CHANNEL = 10;

/** The GM 1 percussion key map, notes 35-81. */
export const GM_NAMES = {
  35: 'acoustic bass drum', 36: 'bass drum 1', 37: 'side stick',
  38: 'acoustic snare', 39: 'hand clap', 40: 'electric snare',
  41: 'low floor tom', 42: 'closed hi-hat', 43: 'high floor tom',
  44: 'pedal hi-hat', 45: 'low tom', 46: 'open hi-hat',
  47: 'low-mid tom', 48: 'hi-mid tom', 49: 'crash cymbal 1',
  50: 'high tom', 51: 'ride cymbal 1', 52: 'chinese cymbal',
  53: 'ride bell', 54: 'tambourine', 55: 'splash cymbal',
  56: 'cowbell', 57: 'crash cymbal 2', 58: 'vibraslap',
  59: 'ride cymbal 2', 60: 'hi bongo', 61: 'low bongo',
  62: 'mute hi conga', 63: 'open hi conga', 64: 'low conga',
  65: 'high timbale', 66: 'low timbale', 67: 'high agogo',
  68: 'low agogo', 69: 'cabasa', 70: 'maracas',
  71: 'short whistle', 72: 'long whistle', 73: 'short guiro',
  74: 'long guiro', 75: 'claves', 76: 'hi wood block',
  77: 'low wood block', 78: 'mute cuica', 79: 'open cuica',
  80: 'mute triangle', 81: 'open triangle',
};

/** The GM instrument name for a note, or null outside the percussion range. */
export function gmName(note) {
  return GM_NAMES[note] ?? null;
}

/**
 * Every role the styles and fills reach for, mapped to its GM note.
 *
 * The roles are the same set as DEFAULT_KIT so that no style loses a track on
 * the way across — a pattern with a ride, three toms and a crash resolves
 * identically, it just lands on GM notes instead of pads.
 *
 * A few are judgement calls rather than transcription: `shaker` becomes the
 * cabasa (70 maracas is the other candidate, but the cabasa reads as a shaker
 * on more sound sets), and `fx` becomes the chinese cymbal, GM having nothing
 * that means "whatever is on pad 16".
 */
export const GM_KIT = {
  kick: midiNote(36),
  snare: midiNote(38),
  clap: midiNote(39),
  rim: midiNote(37),          // side stick
  hat: midiNote(42),
  hatOpen: midiNote(46),
  shaker: midiNote(69),       // cabasa
  tamb: midiNote(54),
  tomLow: midiNote(41),       // low floor tom
  tomMid: midiNote(45),
  tomHigh: midiNote(50),
  ride: midiNote(51),
  crash: midiNote(49),
  perc1: midiNote(56),        // cowbell
  perc2: midiNote(75),        // claves
  fx: midiNote(52),           // chinese cymbal

  // Alternates for GM_VOICES below. Styles never name these, so nothing
  // resolves to one unless substitution reaches for it deliberately.
  snareElectric: midiNote(40),
  hatPedal: midiNote(44),
  rideBell: midiNote(53),
  ride2: midiNote(59),
  kickAcoustic: midiNote(35),
};

/**
 * The one place the GM kit is genuinely richer than sixteen pads: the pedal
 * hat and the second ride/crash exist, so voice substitution has somewhere to
 * go that the pad kit does not. Shaped like DEFAULT_VOICES and passed to
 * render() the same way; roles not listed fall back to the primary.
 */
export const GM_VOICES = {
  snare: ['snare', 'rim', 'clap', 'snareElectric'],
  hat: ['hat', 'hatPedal', 'hatOpen', 'shaker'],
  ride: ['ride', 'rideBell', 'ride2'],
  kick: ['kick', 'kickAcoustic'],
};
