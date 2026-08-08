// Arrangement: stitching patterns into something that develops over time.
//
// A section is { pattern, repeats }. Sections are rendered back to back into a
// single event list, so the whole arrangement is handed to CoreMIDI in one go
// and stays tight regardless of what the host process is doing.

import { render } from './schedule.mjs';
import { patternMs } from './pattern.mjs';
import { vary, fill, decollide } from './transform.mjs';

/**
 * Renders sections consecutively.
 *
 * @param {Array<{pattern:object, repeats?:number}>} sections
 * @param {object} [opts]  passed through to render(); `repeats` is ignored here
 * @returns {Array<{ms:number, bytes:number[]}>}
 */
export function arrange(sections, opts = {}) {
  const events = [];
  let cursor = 0;
  sections.forEach((section, i) => {
    const repeats = section.repeats ?? 1;
    events.push(...render(section.pattern, {
      ...opts,
      repeats,
      startMs: cursor,
      seed: (opts.seed ?? 1) + i,
    }));
    cursor += patternMs(section.pattern) * repeats;
  });
  events.sort((a, b) => a.ms - b.ms);
  return events;
}

/** Total duration of an arrangement in milliseconds. */
export function arrangementMs(sections) {
  return sections.reduce((t, s) => t + patternMs(s.pattern) * (s.repeats ?? 1), 0);
}

/**
 * Grows a pattern into a phrase that develops, rather than looping unchanged.
 *
 * Each bar is a variation of the *original* rather than of the previous bar, so
 * the groove drifts without wandering off entirely. Every `fillEvery` bars the
 * last bar becomes a fill.
 *
 * @param {object} base
 * @param {object} [opts]
 * @param {number} [opts.bars]       how many bars to produce
 * @param {number} [opts.drift]      0-1, how far variations stray
 * @param {number} [opts.fillEvery]  bar interval for fills, 0 to disable
 * @param {string[]} [opts.lock]     tracks to hold steady, e.g. ['kick']
 * @param {number} [opts.seed]
 * @returns {Array<{pattern:object, repeats:number}>}
 */
export function evolve(base, opts = {}) {
  const {
    bars = 8, drift = 0.25, fillEvery = 4, lock = ['kick'], seed = 1,
    decollideStrength = 0.6, decollidePair = ['kick', 'snare'],
  } = opts;

  return Array.from({ length: bars }, (_, bar) => ({
    pattern: barPattern(base, bar, { drift, fillEvery, lock, seed, decollideStrength, decollidePair }),
    repeats: 1,
  }));
}

/**
 * Builds the pattern for a single bar index.
 *
 * Factored out of evolve so that continuous players can generate bar N on
 * demand without materialising a finite arrangement first — which is what lets
 * playback run indefinitely rather than for a fixed number of bars.
 */
export function barPattern(base, bar, opts = {}) {
  const {
    drift = 0.25, fillEvery = 4, lock = ['kick'], seed = 1, forceFill = false,
    decollideStrength = 0.6, decollidePair = ['kick', 'snare'],
  } = opts;

  const isFill = forceFill || (fillEvery > 0 && (bar + 1) % fillEvery === 0);

  let p;
  if (isFill) {
    p = fill(base, { intensity: 0.5 + drift, seed: seed + bar });
  } else if (bar === 0) {
    // Bar 0 plays the pattern as written, so the listener hears the idea first.
    p = base;
  } else {
    p = vary(base, { amount: drift * (0.4 + Math.min(bar / 8, 1) * 0.6), seed: seed + bar, lock });
  }

  // Applied per bar rather than once up front: variation and fills can both
  // create fresh kick/snare collisions that were not in the original.
  return decollide(p, { pair: decollidePair, strength: decollideStrength, seed: seed + bar });
}

/**
 * Classic song-form chaining from a map of named patterns.
 *
 *   chain({ a: patternA, b: patternB }, 'a a a b')
 */
export function chain(named, form, repeatsEach = 1) {
  const keys = typeof form === 'string' ? form.trim().split(/[\s,]+/) : form;
  return keys.map((k) => {
    if (!(k in named)) throw new Error(`no pattern named "${k}" in form`);
    return { pattern: named[k], repeats: repeatsEach };
  });
}
