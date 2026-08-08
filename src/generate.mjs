// Pattern generators.
//
// Everything here returns velocity arrays (0 = rest), which is what pattern()
// accepts alongside step strings. Generators are pure and take an explicit RNG
// so output is reproducible.

import { VELOCITY } from './pattern.mjs';
import { rng } from './random.mjs';

export { rng };

const rotateArr = (arr, n) => {
  const len = arr.length;
  if (!len) return arr;
  const k = ((n % len) + len) % len;
  return arr.slice(k).concat(arr.slice(0, k));
};

/**
 * Euclidean rhythm: distributes `pulses` as evenly as possible across `steps`.
 *
 * This is Bjorklund's algorithm proper, not the Bresenham approximation. The
 * approximation produces valid Euclidean necklaces but often lands on a
 * *rotation* of the canonical one — E(3,8) came out as `x..x.x..` rather than
 * the tresillo everyone recognises. For named rhythms that distinction matters.
 *
 * euclid(3, 8)  -> x..x..x.   tresillo
 * euclid(5, 8)  -> x.xx.xx.   cinquillo
 * euclid(7, 16) -> x..x.x.x..x.x.x.
 */
export function euclid(pulses, steps, rotation = 0) {
  if (!Number.isInteger(steps) || steps <= 0) throw new RangeError('steps must be a positive integer');
  const p = Math.max(0, Math.min(pulses, steps));
  if (p === 0) return new Array(steps).fill(false);
  if (p === steps) return new Array(steps).fill(true);

  // Repeatedly fold the shorter group into the longer, which is what makes the
  // spacing maximally even.
  let a = Array.from({ length: p }, () => [true]);
  let b = Array.from({ length: steps - p }, () => [false]);

  while (b.length > 1) {
    const m = Math.min(a.length, b.length);
    const merged = [];
    for (let i = 0; i < m; i++) merged.push(a[i].concat(b[i]));
    const remainder = a.length > m ? a.slice(m) : b.slice(m);
    a = merged;
    b = remainder;
  }

  return rotateArr([...a.flat(), ...b.flat()], rotation);
}

/**
 * Converts a boolean grid to velocities.
 *
 * @param {boolean[]} hits
 * @param {object} [opts]
 * @param {number} [opts.hit]          velocity for a normal hit
 * @param {number} [opts.accent]       velocity for an accented hit
 * @param {number} [opts.accentEvery]  accent every Nth step (0 = never)
 * @param {number} [opts.accentOffset] where the accent cycle starts
 */
export function toVelocities(hits, opts = {}) {
  const { hit = VELOCITY.o, accent = VELOCITY.x, accentEvery = 0, accentOffset = 0 } = opts;
  return hits.map((on, i) => {
    if (!on) return 0;
    if (accentEvery && (i - accentOffset) % accentEvery === 0) return accent;
    return hit;
  });
}

/** Euclidean rhythm straight to velocities. */
export function euclidTrack(pulses, steps, opts = {}) {
  return toVelocities(euclid(pulses, steps, opts.rotation ?? 0), opts);
}

/**
 * Random track at a target density.
 *
 * @param {number} steps
 * @param {number} density  0-1, the proportion of steps that should sound
 * @param {object} [opts]
 * @param {function} [opts.rand]    RNG
 * @param {number[]} [opts.weights] per-step weighting, so hits can favour
 *                                  strong beats. Length is cycled.
 */
export function randomTrack(steps, density, opts = {}) {
  const { rand = rng(), weights = null, hit = VELOCITY.o, accent = VELOCITY.x } = opts;
  const out = new Array(steps).fill(0);
  for (let i = 0; i < steps; i++) {
    const w = weights ? weights[i % weights.length] : 1;
    if (rand() < density * w) out[i] = rand() < 0.25 ? accent : hit;
  }
  return out;
}

// Weightings that bias random generation towards musically strong positions of
// a 16-step bar. Handy as the `weights` argument above.
export const WEIGHTS = {
  downbeats: [1.6, 0.3, 0.7, 0.3, 1.2, 0.3, 0.7, 0.3, 1.4, 0.3, 0.7, 0.3, 1.2, 0.3, 0.7, 0.5],
  offbeats: [0.3, 0.6, 1.2, 0.6, 0.3, 0.6, 1.2, 0.6, 0.3, 0.6, 1.2, 0.6, 0.3, 0.6, 1.2, 0.8],
  even: [1],
};

/**
 * Style presets — starting points rather than finished beats, chosen because
 * they respond well to the transforms in transform.mjs.
 *
 * Each returns a full pattern spec ready for pattern().
 */
export const STYLES = {
  // The kick deliberately avoids beat 4 (step 12). Boom bap works by landing
  // around it — here on the "a" of 1 and the "and" of 3 — which keeps the
  // backbeat clear and pushes into the next bar.
  'boom-bap': () => ({
    bpm: 88, swing: 0.18, humanizeMs: 6, humanizeVel: 12,
    lock: [],
    tracks: { kick: 'x..o..s...o.....', snare: '....x..s|....x.s.', hat: 'o.oo o.o.|o.oo o.o.' },
  }),
  techno: () => ({
    bpm: 132, swing: 0, humanizeMs: 1, humanizeVel: 4,
    lock: ['kick'],
    tracks: { kick: 'x...x...x...x...', hat: '..o...o...o...o.', clap: '....x.......x...' },
  }),
  house: () => ({
    bpm: 124, swing: 0.08, humanizeMs: 2, humanizeVel: 6,
    lock: ['kick'],
    tracks: { kick: 'x...x...x...x...', hatOpen: '..o...o...o...o.', clap: '....x.......x...', shaker: 'ssssssssssssssss' },
  }),
  dnb: () => ({
    bpm: 174, swing: 0.05, humanizeMs: 3, humanizeVel: 10,
    lock: [],
    tracks: { kick: 'x.......|..x.....', snare: '....x...|....x...', hat: 'o.o.o.o.|o.o.o.o.' },
  }),
  trap: () => ({
    bpm: 140, swing: 0, humanizeMs: 2, humanizeVel: 8,
    lock: [],
    tracks: { kick: 'x.....x.|..x.....', snare: '....x.......x...', hat: 'oooooooooooooooo' },
  }),
  afrobeat: () => ({
    bpm: 108, swing: 0.12, humanizeMs: 8, humanizeVel: 14,
    lock: ['rim'],
    tracks: { kick: 'x..x..x.|x..x..x.', rim: '..x..x..|..x..x..', shaker: 'o.o.o.o.|o.o.o.o.' },
  }),
  // Swung ride with the classic skip note, hi-hat closing on 2 and 4, and a
  // snare that comps against the ride rather than marking the backbeat.
  //
  // The kick stays out of the way, catching beat 1 and a syncopation. It is
  // deliberately *not* on all four: feathering the bass drum is a real bebop
  // technique, but it means a barely-audible cushion under the ride, and a
  // sampler triggered at any usable velocity turns that into four-on-the-floor
  // — which is the opposite of the intended effect.
  jazz: () => ({
    bpm: 132, swing: 1 / 3, swingUnit: 2, humanizeMs: 12, humanizeVel: 18,
    dynamics: { depth: 0.5, conformity: 0.7 },
    // The ride ostinato is the groove's identity - a jazz drummer keeps it
    // going and comps against it. Letting drift mutate the ride turns the
    // pattern into unrelated cymbal hits. The kick stays free to move.
    lock: ['ride'],
    // Tom rolls across the kit are not the jazz vocabulary; comping figures are.
    fillShapes: ['sparse', 'triplet'],
    tracks: {
      ride: 'x...o.o.x...o.o.',
      hat: '....o.......o...',
      kick: 'x.........o.....',
      snare: '..s...x....s..o.',
    },
  }),

  // Far out: the pulse is deliberately unanchored, conformity is low enough
  // that accents land almost anywhere, and the timing is loose. Push --drift
  // up and this stops resembling a bar at all, which is the point.
  'free-jazz': () => ({
    bpm: 148, swing: 0.28, swingUnit: 2, humanizeMs: 22, humanizeVel: 30,
    dynamics: { depth: 0.7, conformity: 0.35, anchorDownbeat: false },
    lock: [],
    tracks: {
      ride: 'x.oo.x.o.oxo.x.o',
      snare: '.x..s.x..o.x.s.x',
      tomLow: '..o....x...o..x.',
      kick: 'x...s..x..s...x.',
      crash: 'x.............o.',
    },
  }),

  garage: () => ({
    bpm: 134, swing: 0.32, humanizeMs: 4, humanizeVel: 10,
    lock: ['kick'],
    tracks: { kick: 'x.........x...o.', snare: '....x.......x...', hat: 'o.oo.o.oo.o.o.o.' },
  }),
};

export const styleNames = () => Object.keys(STYLES);

export function style(name) {
  const make = STYLES[name];
  if (!make) throw new Error(`unknown style "${name}" — try one of: ${styleNames().join(', ')}`);
  return make();
}
