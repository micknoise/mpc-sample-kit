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
 * @param {number} [spec.swing]         0-1, proportion of a step to delay
 *                                      every second step by. 0.5 is hard triplet
 *                                      swing; musical values sit near 0.1-0.3.
 * @param {number} [spec.humanizeMs]    +/- timing jitter in milliseconds
 * @param {number} [spec.humanizeVel]   +/- velocity jitter
 */
export function pattern(spec) {
  const {
    bpm,
    tracks,
    stepsPerBeat = 4,
    swing = 0,
    humanizeMs = 0,
    humanizeVel = 0,
  } = spec;

  if (!(bpm > 0)) throw new Error('bpm must be positive');
  if (!tracks || !Object.keys(tracks).length) throw new Error('pattern needs at least one track');
  if (swing < 0 || swing >= 1) throw new RangeError('swing must be in [0, 1)');

  const parsed = {};
  for (const [name, steps] of Object.entries(tracks)) {
    parsed[name] = typeof steps === 'string' ? parseSteps(steps) : steps;
  }

  const length = Math.max(...Object.values(parsed).map((s) => s.length));

  return { bpm, stepsPerBeat, swing, humanizeMs, humanizeVel, tracks: parsed, length };
}

/** Duration of one step in milliseconds. */
export function stepMs(p) {
  return 60000 / p.bpm / p.stepsPerBeat;
}

/** Total pattern duration in milliseconds for one pass. */
export function patternMs(p) {
  return stepMs(p) * p.length;
}
