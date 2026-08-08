// Turns patterns into timestamped MIDI events.
//
// The output is a plain array of { ms, bytes } which both delivery backends
// consume: the mpcmidi CLI on the desktop, and Web MIDI's send(data, timestamp)
// in the browser. Keeping the musical logic here means neither backend has any
// opinion about rhythm.

import { resolveNote, resolveVoices, DEFAULT_KIT, DEFAULT_VOICES } from './pads.mjs';
import { stepMs, patternMs, swungStep } from './pattern.mjs';
import { rng } from './random.mjs';
import { metricWeight, effectiveWeight, applyWeight } from './dynamics.mjs';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Renders a pattern to MIDI events.
 *
 * @param {object} p                pattern from pattern()
 * @param {object} [opts]
 * @param {number} [opts.repeats]   how many times to loop the pattern
 * @param {object} [opts.kit]       role -> pad map
 * @param {number} [opts.channel]   MIDI channel, 1-16
 * @param {number} [opts.gateMs]    note length
 * @param {number} [opts.seed]      PRNG seed for humanisation
 * @param {number} [opts.limbSpread] 0-1, share of humanizeMs that varies per
 *                                   voice rather than being shared across the
 *                                   step. Higher means looser limbs; too high
 *                                   and simultaneous hits flam.
 * @param {number} [opts.startMs]   offset applied to every event
 * @returns {Array<{ms:number, bytes:number[]}>} ascending by ms
 */
export function render(p, opts = {}) {
  const {
    repeats = 1,
    kit = DEFAULT_KIT,
    voices = DEFAULT_VOICES,
    voiceSpread = 0.35,
    limbSpread = 0.25,
    channel = 1,
    gateMs = 40,
    seed = 1,
    startMs = 0,
  } = opts;

  if (channel < 1 || channel > 16) throw new RangeError('channel must be 1-16');

  const rand = rng(seed);
  const { depth, conformity, anchorDownbeat } =
    p.dynamics ?? { depth: 0, conformity: 1, anchorDownbeat: true };
  const noteOn = 0x90 | (channel - 1);
  const noteOff = 0x80 | (channel - 1);
  const step = stepMs(p);
  const loop = patternMs(p);

  // Timing humanisation splits into two parts.
  //
  // Applying the whole amount per event let two voices meant to land *together*
  // drift apart by twice humanizeMs — at free-jazz's 22ms that is a 44ms spread,
  // which the ear hears as a flam rather than as feel. So most of the amount is
  // a per-step offset shared by every voice on that step (where the player put
  // the beat), and only `limbSpread` of it varies per voice (limbs not being
  // perfectly synchronised). Intended-simultaneous hits stay tight while the
  // groove still breathes.
  //
  // Drawn up front rather than inside the track loop so that every track agrees
  // about each step regardless of iteration order.
  const feel = [];
  if (p.humanizeMs) {
    for (let rep = 0; rep < repeats; rep++) {
      const row = new Array(p.length);
      for (let i = 0; i < p.length; i++) {
        row[i] = (rand() * 2 - 1) * p.humanizeMs * (1 - limbSpread);
      }
      feel.push(row);
    }
  }

  // Resolve track names up front so a bad name fails before any sound is made.
  const notes = Object.fromEntries(
    Object.keys(p.tracks).map((name) => [name, resolveNote(name, kit)]),
  );
  const voiceNotes = Object.fromEntries(
    Object.keys(p.tracks).map((name) => [name, resolveVoices(name, kit, voices)]),
  );

  /**
   * Chooses which voice sounds for a hit.
   *
   * Substitution is biased towards quieter hits: ghost notes are where a
   * drummer reaches for the rim or the edge, while accents land on the drum
   * itself. Making it velocity-dependent rather than uniform is most of what
   * stops this sounding like a random sample-swapper.
   */
  const pickVoice = (name, velocity) => {
    const options = voiceNotes[name];
    if (options.length < 2 || !voiceSpread) return notes[name];
    const quietness = 1 - Math.min(velocity, 127) / 127;
    if (rand() >= voiceSpread * (0.35 + quietness)) return notes[name];
    return options[1 + Math.floor(rand() * (options.length - 1))];
  };

  const events = [];
  for (let rep = 0; rep < repeats; rep++) {
    for (const [name, steps] of Object.entries(p.tracks)) {
      for (let i = 0; i < steps.length; i++) {
        const vel = steps[i];
        if (!vel) continue;

        let t = startMs + rep * loop + swungStep(i, p.swing, p.swingUnit) * step;
        if (p.humanizeMs) {
          t += feel[rep][i] + (rand() * 2 - 1) * p.humanizeMs * limbSpread;
        }

        // Metric dynamics first — that is the musical intent. Humanisation is
        // then jitter applied on top, not a substitute for it.
        let v = vel;
        if (depth) {
          const w = effectiveWeight(
            metricWeight(i, p.stepsPerBeat, p.beatsPerBar), conformity, rand, anchorDownbeat,
          );
          v = applyWeight(v, w, depth);
        }
        if (p.humanizeVel) v += Math.round((rand() * 2 - 1) * p.humanizeVel);
        v = clamp(Math.round(v), 1, 127);

        t = Math.max(0, t);
        const sounded = pickVoice(name, v);
        events.push({ ms: t, bytes: [noteOn, sounded, v] });
        events.push({ ms: t + gateMs, bytes: [noteOff, sounded, 0] });
      }
    }
  }

  // CoreMIDI requires ascending timestamps within a packet list.
  events.sort((a, b) => a.ms - b.ms);
  return events;
}

/** Formats events for `mpcmidi play` (one "<ms> <hex>..." line per event). */
export function toMpcmidi(events) {
  return events
    .map((e) => `${e.ms.toFixed(3)} ${e.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`)
    .join('\n') + '\n';
}

/** All-notes-off across the pads, for a clean stop. */
export function panic(channel = 1) {
  return [{ ms: 0, bytes: [0xb0 | (channel - 1), 0x7b, 0x00] }];
}
