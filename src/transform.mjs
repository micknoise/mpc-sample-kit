// Pattern transforms.
//
// Two layers: step operators that take and return a velocity array, and pattern
// operators that lift those over a whole pattern. All are pure, and every
// stochastic one takes an explicit RNG so results stay reproducible.

import { rng } from './generate.mjs';
import { VELOCITY } from './pattern.mjs';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------- step level

/** Rotates a track. Positive n moves the pattern earlier in the bar. */
export function rotate(steps, n) {
  const len = steps.length;
  if (!len) return steps;
  const k = ((n % len) + len) % len;
  return steps.slice(k).concat(steps.slice(0, k));
}

export function reverse(steps) {
  return [...steps].reverse();
}

/** Removes hits with probability `prob`. */
export function thin(steps, prob, rand = rng()) {
  return steps.map((v) => (v && rand() < prob ? 0 : v));
}

/** Adds hits on empty steps with probability `prob`. */
export function densify(steps, prob, rand = rng(), velocity = VELOCITY.s) {
  return steps.map((v) => (!v && rand() < prob ? velocity : v));
}

/** Flips steps on or off with probability `prob` — thin and densify at once. */
export function mutate(steps, prob, rand = rng(), velocity = VELOCITY.o) {
  return steps.map((v) => {
    if (rand() >= prob) return v;
    return v ? 0 : velocity;
  });
}

/** Nudges every velocity by up to +/- amount. */
export function shade(steps, amount, rand = rng()) {
  return steps.map((v) => (v ? clamp(Math.round(v + (rand() * 2 - 1) * amount), 1, 127) : 0));
}

/** Accents every Nth sounding step. */
export function accentEvery(steps, n, velocity = VELOCITY.x, offset = 0) {
  if (n <= 0) return [...steps];
  return steps.map((v, i) => (v && (i - offset) % n === 0 ? velocity : v));
}

/**
 * Doubles the grid resolution, optionally turning some hits into rolls.
 *
 * Ratchets need finer timing than the parent grid allows, so this returns a
 * track at twice the resolution. Remember to double stepsPerBeat to match —
 * `ratchetPattern` handles that bookkeeping for you.
 */
export function upsample(steps, { rollProb = 0, rand = rng(), decay = 0.7 } = {}) {
  const out = [];
  for (const v of steps) {
    out.push(v);
    out.push(v && rand() < rollProb ? Math.round(v * decay) : 0);
  }
  return out;
}

/** Keeps only hits that fall on multiples of `n`. */
export function quantiseTo(steps, n) {
  return steps.map((v, i) => (i % n === 0 ? v : 0));
}

// ------------------------------------------------------------- pattern level

/** Applies fn to one named track, returning a new pattern. */
export function mapTrack(p, name, fn) {
  if (!(name in p.tracks)) throw new Error(`pattern has no track "${name}"`);
  return { ...p, tracks: { ...p.tracks, [name]: fn(p.tracks[name]) } };
}

/** Applies fn to every track. */
export function mapTracks(p, fn) {
  const tracks = Object.fromEntries(
    Object.entries(p.tracks).map(([name, steps]) => [name, fn(steps, name)]),
  );
  return { ...p, tracks, length: Math.max(...Object.values(tracks).map((s) => s.length)) };
}

/** Ratchets a pattern, doubling the grid and keeping timing correct. */
export function ratchetPattern(p, opts = {}) {
  const next = mapTracks(p, (steps) => upsample(steps, opts));
  return { ...next, stepsPerBeat: p.stepsPerBeat * 2 };
}

/**
 * Produces a variation of a pattern — the workhorse for evolving a groove.
 *
 * @param {object} p
 * @param {object} [opts]
 * @param {number} [opts.amount]  0-1, overall strength of the variation
 * @param {number} [opts.seed]
 * @param {string[]} [opts.lock]  track names to leave untouched, e.g. ['kick']
 */
export function vary(p, opts = {}) {
  const { amount = 0.2, seed = 1, lock = [] } = opts;
  const rand = rng(seed);
  return mapTracks(p, (steps, name) => {
    if (lock.includes(name)) return steps;
    let out = mutate(steps, amount * 0.35, rand);
    out = shade(out, amount * 30, rand);
    if (rand() < amount * 0.4) out = rotate(out, rand() < 0.5 ? 1 : -1);
    return out;
  });
}

/**
 * Builds a fill from a pattern, typically for the last bar of a phrase.
 *
 * Thins the kick, densifies the snare and pushes velocities up, which reads as
 * a fill across most kits without needing to know the kit layout.
 */
export function fill(p, opts = {}) {
  const { intensity = 0.6, seed = 7, snare = 'snare', kick = 'kick' } = opts;
  const rand = rng(seed);
  return mapTracks(p, (steps, name) => {
    if (name === kick) return thin(steps, intensity * 0.7, rand);
    if (name === snare) return accentEvery(densify(steps, intensity * 0.8, rand, VELOCITY.o), 3);
    return densify(steps, intensity * 0.4, rand);
  });
}
