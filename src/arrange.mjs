// Arrangement: stitching patterns into something that develops over time.
//
// A section is { pattern, repeats }. Sections are rendered back to back into a
// single event list, so the whole arrangement is handed to CoreMIDI in one go
// and stays tight regardless of what the host process is doing.

import { render } from './schedule.mjs';
import { patternMs } from './pattern.mjs';
import { vary, fill, decollide, dodgeLastBeat } from './transform.mjs';
import { DEFAULT_KIT } from './pads.mjs';
import { rng } from './random.mjs';

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
 * @param {string[]} [opts.lock]     tracks to hold steady, e.g. ['kick']. Empty by
 *                                  default: freezing the kick stops it developing
 *                                  at all, however high the drift is pushed.
 * @param {number} [opts.seed]
 * @returns {Array<{pattern:object, repeats:number}>}
 */
export function evolve(base, opts = {}) {
  const {
    bars = 8, drift = 0.25, fillEvery = 4, lock = [], seed = 1,
    decollideStrength = 0.6, decollidePair = ['kick', 'snare'],
    fillShape = 'auto', kit = DEFAULT_KIT, dodgeFour = 0.85,
  } = opts;

  return Array.from({ length: bars }, (_, bar) => ({
    pattern: barPattern(base, bar, {
      drift, fillEvery, lock, seed, decollideStrength, decollidePair, fillShape, kit, dodgeFour,
    }),
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
    drift = 0.25, fillEvery = 4, lock = [], seed = 1, forceFill = false,
    decollideStrength = 0.6, decollidePair = ['kick', 'snare'],
    fillShape = 'auto', kit = DEFAULT_KIT, dodgeFour = 0.85,
  } = opts;

  const isFill = forceFill || (fillEvery > 0 && (bar + 1) % fillEvery === 0);

  let p;
  if (isFill) {
    // Vary how much of the bar each fill takes. Holding intensity constant made
    // every fill occupy the same span, which gave them a family resemblance
    // that survived even six different shapes.
    const spread = rng(seed * 7919 + bar)();
    const intensity = Math.min(1, Math.max(0.25, 0.4 + drift * 0.6 + (spread - 0.5) * 0.55));
    p = fill(base, { intensity, seed: seed + bar, shape: fillShape, kit });
  } else if (bar === 0) {
    // Bar 0 plays the pattern as written, so the listener hears the idea first.
    p = base;
  } else {
    p = vary(base, { amount: drift * (0.4 + Math.min(bar / 8, 1) * 0.6), seed: seed + bar, lock });
  }

  // A fill wants somewhere to land. If the previous bar was one, open this bar
  // with a crash so the phrase resolves instead of just stopping being busy.
  const prevWasFill = bar > 0 && fillEvery > 0 && bar % fillEvery === 0;
  if (prevWasFill && !isFill && 'crash' in kit) {
    const crash = [...(p.tracks.crash ?? new Array(p.length).fill(0))];
    crash[0] = 112;
    p = { ...p, tracks: { ...p.tracks, crash } };
  }

  // Applied per bar rather than once up front: variation and fills can both
  // create collisions and a limp beat-4 kick that were not in the original.
  // Kick first, then the snare is placed relative to wherever it ended up.
  p = dodgeLastBeat(p, { strength: dodgeFour, seed: seed + bar });
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
