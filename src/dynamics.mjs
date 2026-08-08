// Metric dynamics — making heavy beats loud and light beats light.
//
// Flat velocity is the single biggest giveaway that a beat was generated rather
// than played. Real drummers lean on the metrically strong positions, and the
// hierarchy is nested: beat 1 is heavier than beat 3, which is heavier than
// beats 2 and 4, which are heavier than the eighths between them, and so on
// down to the sixteenths.
//
// That hierarchy falls straight out of the binary structure of the bar: the
// more times a step index divides by two, the stronger its position. Deriving
// it that way rather than hard-coding a table means it generalises to any grid
// resolution and bar length.

import { rng } from './random.mjs';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Metric strength of a step, from 0 (weakest subdivision) to 1 (downbeat).
 *
 * For a 16-step bar this gives:
 *   step 0  (beat 1)      1.00
 *   step 8  (beat 3)      0.76
 *   step 4  (beats 2/4)   0.63
 *   step 2  (eighths)     0.49
 *   step 1  (sixteenths)  0.35
 */
export function metricWeight(i, stepsPerBeat = 4, beatsPerBar = 4) {
  const stepsPerBar = stepsPerBeat * beatsPerBar;
  const pos = ((i % stepsPerBar) + stepsPerBar) % stepsPerBar;
  if (pos === 0) return 1;

  let level = 0;
  for (let v = pos; v % 2 === 0; v /= 2) level++;
  const maxLevel = Math.log2(stepsPerBar);
  return 0.35 + 0.55 * (level / maxLevel);
}

/**
 * Scales a velocity by its metric position.
 *
 * @param {number} velocity  the written velocity, treated as the intent
 * @param {number} weight    metric weight, 0-1
 * @param {number} depth     0-1, how much the metre is allowed to matter.
 *                           0 leaves velocities untouched, 1 is maximally
 *                           pointed. Around 0.45 reads as a human playing
 *                           with intent rather than a machine.
 */
export function applyWeight(velocity, weight, depth) {
  if (!velocity) return 0;
  return clamp(Math.round(velocity * (1 - depth + depth * weight)), 1, 127);
}

/**
 * Decides the effective weight for a step, allowing for syncopation.
 *
 * With probability `1 - conformity` the metric expectation is inverted and a
 * weak step is leaned on instead — which is what syncopation *is*. Keeping this
 * stochastic per bar rather than fixed means the displacement moves around
 * instead of becoming another rigid pattern.
 *
 * @param {number} weight      metric weight of the step
 * @param {number} conformity  0-1, proportion of steps that follow the metre.
 *                             0.8 gives a strong pulse with occasional kick
 *                             against it; 1 is metronomic; below ~0.6 the
 *                             sense of a downbeat starts to dissolve.
 * @param {function} rand
 */
export function effectiveWeight(weight, conformity, rand, anchorDownbeat = true) {
  // With anchorDownbeat set, beat 1 is exempt from displacement: syncopation
  // reads as syncopation while the pulse is still there to push against.
  // Turning it off lets the downbeat be de-accented too, which dissolves the
  // sense of "one" — genuinely useful when that is the intent, so it is a
  // choice rather than a rule. The RNG is drawn either way so the stream stays
  // aligned regardless of which steps are eligible.
  const roll = rand();
  if (anchorDownbeat && weight >= 1) return weight;
  if (roll < conformity) return weight;

  // Invert, but not fully: a syncopated accent should land clearly above the
  // step's natural weight without necessarily outweighing the downbeat.
  return clamp(0.45 + (1 - weight) * 0.75, 0, 1);
}

/**
 * Applies metric dynamics across a whole track.
 *
 * @param {number[]} steps
 * @param {object} [opts]
 * @param {number} [opts.stepsPerBeat]
 * @param {number} [opts.beatsPerBar]
 * @param {number} [opts.depth]        how much metre shapes velocity
 * @param {number} [opts.conformity]   proportion following the metre
 * @param {function} [opts.rand]
 */
export function shapeTrack(steps, opts = {}) {
  const {
    stepsPerBeat = 4,
    beatsPerBar = 4,
    depth = 0.45,
    conformity = 0.8,
    anchorDownbeat = true,
    rand = rng(),
  } = opts;

  return steps.map((v, i) => {
    if (!v) return 0;
    const w = effectiveWeight(
      metricWeight(i, stepsPerBeat, beatsPerBar), conformity, rand, anchorDownbeat,
    );
    return applyWeight(v, w, depth);
  });
}

/** Default dynamics config, merged with whatever a pattern specifies. */
export const DEFAULT_DYNAMICS = { depth: 0.45, conformity: 0.8, anchorDownbeat: true };
