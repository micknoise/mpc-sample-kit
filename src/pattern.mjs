// Step-grid drum patterns.
//
// A pattern is a set of named tracks, each a step string. The notation is
// deliberately plain so it is easy to write, read and generate:
//
//   '.'      rest
//   'x'      accent          (velocity 110)
//   'o'      normal hit      (velocity 90)
//   's'      ghost note      (velocity 45)
//   '1'-'9'  explicit level  (1 = quietest, 9 = loudest)
//   ' ', '|' ignored, so bars can be spaced out for legibility
//
//   const p = pattern({ bpm: 90, tracks: {
//     kick: 'x..o.. x. ..x...o.',
//     hat:  'o.o.o.o.o.o.o.o.',
//   }});

import { DEFAULT_DYNAMICS } from './dynamics.mjs';

export const VELOCITY = { x: 110, o: 90, s: 45 };

const IGNORED = new Set([' ', '|', '-']);

/** Parses one step string into an array of velocities, 0 meaning rest. */
export function parseSteps(str) {
  const out = [];
  for (const ch of str) {
    if (IGNORED.has(ch)) continue;
    if (ch === '.' || ch === '_') { out.push(0); continue; }
    if (ch in VELOCITY) { out.push(VELOCITY[ch]); continue; }
    if (ch >= '1' && ch <= '9') { out.push(Math.round((Number(ch) / 9) * 127)); continue; }
    throw new Error(`unrecognised step character "${ch}" in "${str}"`);
  }
  return out;
}

/**
 * Builds a pattern.
 *
 * @param {object}  spec
 * @param {number}  spec.bpm            beats per minute
 * @param {object}  spec.tracks         track name -> step string
 * @param {number} [spec.stepsPerBeat]  grid resolution, 4 = sixteenth notes
 * @param {number} [spec.swing]         0-1, how far the swung half of each pair
 *                                      is displaced. 1/3 is true triplet swing.
 * @param {number} [spec.swingUnit]     steps per half-pair: 1 swings the 16ths
 *                                      (hip-hop, garage), 2 swings the 8ths
 *                                      (jazz). See swungStep().
 * @param {number} [spec.humanizeMs]    +/- timing jitter in milliseconds
 * @param {number} [spec.humanizeVel]   +/- velocity jitter
 */
export function pattern(spec) {
  const {
    bpm,
    tracks,
    stepsPerBeat = 4,
    beatsPerBar = 4,
    swing = 0,
    swingUnit = 1,
    humanizeMs = 0,
    humanizeVel = 0,
    dynamics = {},
  } = spec;

  if (!(bpm > 0)) throw new Error('bpm must be positive');
  if (!tracks || !Object.keys(tracks).length) throw new Error('pattern needs at least one track');
  if (swing < 0 || swing >= 1) throw new RangeError('swing must be in [0, 1)');
  if (!Number.isInteger(swingUnit) || swingUnit < 1) {
    throw new RangeError('swingUnit must be a positive integer (1 = swing the 16ths, 2 = the 8ths)');
  }

  const parsed = {};
  for (const [name, steps] of Object.entries(tracks)) {
    parsed[name] = typeof steps === 'string' ? parseSteps(steps) : steps;
  }

  const length = Math.max(...Object.values(parsed).map((s) => s.length));

  return {
    bpm, stepsPerBeat, beatsPerBar, swing, swingUnit, humanizeMs, humanizeVel,
    dynamics: { ...DEFAULT_DYNAMICS, ...dynamics },
    tracks: parsed, length,
  };
}

/**
 * Where a step actually falls once swing is applied, in fractional steps.
 *
 * Swing is a time warp within each pair of swing units, not a delay bolted onto
 * alternate steps: the first half of the pair is stretched and the second half
 * compressed by the same proportion. That matters for two reasons.
 *
 * Delaying the second half without compressing it shoves those notes towards
 * the following step — at swing 0.5 on a 16th grid the gap closes to an eighth
 * of a beat and neighbouring tracks flam against each other. Warping keeps the
 * remaining gap at `1 - swing` of a step however hard the swing is pushed.
 *
 * `unit` is how many steps make up half of a swung pair, and it is the setting
 * that decides *what* swings:
 *
 *   unit 1  swings the 16ths — hip-hop, garage, boom bap
 *   unit 2  swings the 8ths  — jazz, and what "swing" usually means
 *
 * At unit 2, swing 1/3 places the second eighth exactly two thirds through the
 * beat: true triplet swing.
 */
export function swungStep(i, swing = 0, unit = 1) {
  if (!swing || unit < 1) return i;

  const pair = unit * 2;
  const base = Math.floor(i / pair) * pair;
  const o = i - base;

  const warped = o < unit
    ? o * (1 + swing)
    : unit * (1 + swing) + (o - unit) * (1 - swing);

  return base + warped;
}

/** Duration of one step in milliseconds. */
export function stepMs(p) {
  return 60000 / p.bpm / p.stepsPerBeat;
}

/** Total pattern duration in milliseconds for one pass. */
export function patternMs(p) {
  return stepMs(p) * p.length;
}
