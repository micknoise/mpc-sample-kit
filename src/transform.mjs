// Pattern transforms.
//
// Two layers: step operators that take and return a velocity array, and pattern
// operators that lift those over a whole pattern. All are pure, and every
// stochastic one takes an explicit RNG so results stay reproducible.

import { rng } from './random.mjs';
import { VELOCITY } from './pattern.mjs';
import { DEFAULT_KIT } from './pads.mjs';

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
 * Stops two tracks landing together on the beat.
 *
 * Kick and snare hitting the same downbeat is the most tiring thing a
 * programmed pattern does — the two transients fuse into one thud and the
 * groove loses its conversation. Drummers avoid it instinctively, placing the
 * snare a sixteenth either side instead.
 *
 * Only *on-beat* collisions are treated. Off-beat coincidences are usually
 * deliberate, and four-on-the-floor styles depend on kick and clap landing
 * together, so those tracks are left out of the default pairing.
 *
 * @param {object} p
 * @param {object} [opts]
 * @param {string[]} [opts.pair]    the two track names, victim second
 * @param {number} [opts.strength]  0-1, how often a collision is broken up
 * @param {number} [opts.seed]
 */
export function decollide(p, opts = {}) {
  const { pair = ['kick', 'snare'], strength = 0.6, seed = 1 } = opts;
  const [aName, bName] = pair;
  if (!strength || !(aName in p.tracks) || !(bName in p.tracks)) return p;

  const rand = rng(seed);
  const a = p.tracks[aName];
  const b = [...p.tracks[bName]];

  for (let i = 0; i < b.length; i++) {
    if (!a[i] || !b[i]) continue;                 // no collision here
    if (i % p.stepsPerBeat !== 0) continue;       // off-beat: leave it alone
    if (rand() >= strength) continue;

    // Nudge to the nearest free step, preferring the one after — pushing the
    // snare late reads as laid-back, pulling it early reads as a mistake.
    const vel = b[i];
    const target = [i + 1, i - 1, i + 2].find(
      (j) => j >= 0 && j < b.length && !b[j] && !a[j],
    );
    b[i] = 0;
    if (target !== undefined) b[target] = vel;
  }

  return { ...p, tracks: { ...p.tracks, [bName]: b } };
}

/**
 * Moves the kick off the last beat of the bar.
 *
 * A kick squarely on beat 4 is limp: it is where the snare wants to be, the two
 * transients fight, and it removes the push into the next bar. Boom bap in
 * particular lives on the kick landing *around* beat 4 rather than on it. The
 * "and" of 4 is the natural home — it pulls the bar forward instead of closing
 * it down.
 *
 * Four-on-the-floor is exempt: if the kick already occupies every beat, then
 * beat 4 is clearly deliberate and removing it would gut the pattern. Testing
 * for that rather than special-casing genres means house and techno keep their
 * pulse without needing to know their names.
 *
 * @param {object} p
 * @param {object} [opts]
 * @param {string} [opts.track]     which track to treat, default kick
 * @param {number} [opts.strength]  0-1, how often a beat-4 hit is moved
 * @param {number} [opts.seed]
 */
export function dodgeLastBeat(p, opts = {}) {
  const { track = 'kick', strength = 0.85, seed = 1 } = opts;
  if (!strength || !(track in p.tracks)) return p;

  const spb = p.stepsPerBeat;
  const steps = [...p.tracks[track]];
  const beats = [];
  for (let i = 0; i < steps.length; i += spb) beats.push(i);

  const lastBeat = beats.at(-1);
  if (lastBeat === undefined || !steps[lastBeat]) return p;
  if (beats.every((i) => steps[i])) return p;          // four-on-the-floor: leave it

  const rand = rng(seed);
  if (rand() >= strength) return p;

  // The "and" of 4 first, then the sixteenth either side of the beat.
  const vel = steps[lastBeat];
  const target = [lastBeat + 2, lastBeat + 1, lastBeat - 1].find(
    (j) => j >= 0 && j < steps.length && !steps[j],
  );
  steps[lastBeat] = 0;
  if (target !== undefined) steps[target] = vel;

  return { ...p, tracks: { ...p.tracks, [track]: steps } };
}

/** The fill vocabulary. `auto` picks one per fill. */
export const FILL_SHAPES = ['descend', 'linear', 'triplet', 'herta', 'sparse', 'roll'];

/** Keeps only the roles the kit actually provides, in the order given. */
const available = (kit, roles) => roles.filter((r) => r in kit);

/**
 * Builds a fill.
 *
 * Fills are generated across the whole kit rather than derived from the
 * pattern's existing tracks. That distinction matters: a pattern typically has
 * only kick, snare and hat, so anything that merely *transforms* those tracks
 * can never reach a tom — which is why fills built that way always come out as
 * snare busywork. Here the tom and crash voices are pulled from the kit and
 * added as new tracks.
 *
 * Six shapes, because a fill that is always a descending tom roll is only
 * marginally less boring than one that is always a snare roll:
 *
 *   descend  falls down the kit, snare into successively lower toms
 *   linear   one voice at a time, kick threaded through the toms
 *   triplet  three-step groupings across the kit, cutting against a 16th grid
 *   herta    four-note kick/snare/snare/tom cell, repeated
 *   sparse   a handful of loud, well-placed hits rather than a roll
 *   roll     dense crescendo on the snare, kick still marking the beats
 *
 * @param {object} p
 * @param {object} [opts]
 * @param {number} [opts.intensity]  0-1, how much of the bar the fill takes and
 *                                   how hard it is hit
 * @param {number} [opts.seed]
 * @param {string} [opts.shape]      a name from FILL_SHAPES, or 'auto'
 * @param {object} [opts.kit]        used to discover which voices exist
 */
export function fill(p, opts = {}) {
  const {
    intensity = 0.6, seed = 7, shape = 'auto', kit = DEFAULT_KIT, maxRun = 3,
    shapes = FILL_SHAPES,
  } = opts;

  const rand = rng(seed);
  const pool = shapes.length ? shapes : FILL_SHAPES;
  const chosen = shape === 'auto' ? pool[Math.floor(rand() * pool.length)] : shape;

  const { length, stepsPerBeat } = p;


  // How much of the bar the fill occupies. A light fill is the last couple of
  // beats; a heavy one takes the whole bar.
  const nominal = Math.round(length * (0.25 + 0.75 * intensity));
  // Nudge the entry point by up to a beat either way. A fill that always starts
  // on the same subdivision announces itself long before it arrives.
  const jitter = Math.round((rand() * 2 - 1) * stepsPerBeat * 0.5);
  const region = Math.min(length, Math.max(2, nominal + jitter));
  const from = length - region;

  // Keep the groove up to the fill, then clear it so the fill replaces rather
  // than layers on top of what was already playing.
  const tracks = {};
  for (const [name, steps] of Object.entries(p.tracks)) {
    tracks[name] = steps.map((v, i) => (i >= from ? 0 : v));
  }
  const track = (name) => (tracks[name] ??= new Array(length).fill(0));
  const put = (name, i, v) => {
    if (!name || i < 0 || i >= length) return;
    track(name)[i] = Math.max(1, Math.min(127, Math.round(v)));
  };

  const toms = available(kit, ['tomHigh', 'tomMid', 'tomLow']);
  const snare = 'snare' in kit ? 'snare' : Object.keys(p.tracks)[0];
  const kick = 'kick' in kit ? 'kick' : null;

  // Two fills of the same shape should still not be the same fill. Direction is
  // the cheapest strong variation available: running *up* the kit into the
  // snare feels like a question, running down feels like an answer.
  const ascending = rand() < 0.35;
  const ladder = ascending ? [...toms].reverse().concat(snare) : [snare, ...toms];

  // Fills get louder as they go — that rise is most of what makes one feel like
  // it is leading somewhere rather than just being busy.
  const vel = (i, base = 68) => {
    const t = region > 1 ? (i - from) / (region - 1) : 1;
    return base + t * (120 - base) * (0.55 + intensity * 0.45);
  };

  // Hits land on every step when the fill is intense, every other when it is not.
  const stride = intensity > 0.55 ? 1 : 2;
  const beats = (fn) => {
    for (let i = from; i < length; i++) if (i % stepsPerBeat === 0) fn(i);
  };

  switch (chosen) {
    case 'descend': {
      // Walk down the ladder, spending an equal slice of the region on each.
      for (let i = from; i < length; i += stride) {
        const slot = Math.min(ladder.length - 1, Math.floor(((i - from) / region) * ladder.length));
        put(ladder[slot], i, vel(i));
      }
      if (kick) beats((i) => put(kick, i, vel(i) * 0.8));
      break;
    }

    case 'linear': {
      // Strictly one voice at a time, kick included — the defining feature of a
      // linear fill, and why it sounds articulate rather than thick.
      const cycle = kick ? [kick, ...ladder] : ladder;
      for (let i = from; i < length; i++) {
        put(cycle[(i - from) % cycle.length], i, vel(i));
      }
      break;
    }

    case 'triplet': {
      // Three-step cells over a four-step grid, so the accents rotate against
      // the metre instead of lining up with it.
      const cell = [snare, toms[0] ?? snare, toms[1] ?? toms[0] ?? snare];
      for (let i = from; i < length; i++) {
        const v = vel(i, 60) * ((i - from) % 3 === 0 ? 1 : 0.78);
        put(cell[(i - from) % 3], i, v);
      }
      if (kick) beats((i) => put(kick, i, vel(i) * 0.85));
      break;
    }

    case 'herta': {
      // A four-note cell built around the kick, repeated and rising.
      const cell = [kick ?? snare, snare, snare, toms[1] ?? toms[0] ?? snare];
      for (let i = from; i < length; i++) {
        const pos = (i - from) % 4;
        put(cell[pos], i, vel(i, 66) * (pos === 0 ? 1 : 0.82));
      }
      break;
    }

    case 'sparse': {
      // Few hits, hard. Reaches for the low end first, which is what makes a
      // sparse fill land rather than sound like something is missing.
      const low = [...toms].reverse();
      const picks = [0, 0.35, 0.6, 0.85].map((f) => from + Math.round(f * (region - 1)));
      picks.forEach((i, n) => {
        const voice = n === 0 ? (low[0] ?? snare) : (n % 2 ? snare : low[n % low.length] ?? snare);
        put(voice, i, Math.min(127, vel(i, 92)));
        if (kick && n % 2 === 0) put(kick, i, vel(i, 88));
      });
      break;
    }

    case 'roll':
    default: {
      // A proper crescendo roll, with the kick still holding the floor so the
      // bar does not lose its bottom.
      for (let i = from; i < length; i++) {
        const voice = rand() < 0.18 ? (toms[0] ?? snare) : snare;
        put(voice, i, vel(i, 52));
      }
      if (kick) beats((i) => put(kick, i, vel(i) * 0.9));
      break;
    }
  }

  // Break up anything that sits on one drum too long.
  //
  // More than about three strikes in a row on the same drum stops being a fill
  // and becomes a buzz — it is the single most mechanical thing a generated fill
  // does. Overflow strikes are handed to whichever voice has been quiet longest,
  // which both satisfies the limit and pushes the fill around the kit. Walking
  // left to right and choosing the shortest current run means the fix cannot
  // create a fresh long run behind itself.
  const limitRuns = () => {
    const runs = new Map();

    // Count backwards from the fill's entry point: a run that starts in the
    // groove and continues into the fill is still a run to the listener, so the
    // counter has to arrive pre-loaded rather than starting from zero.
    for (const name of ladder) {
      let back = 0;
      for (let i = from - 1; i >= 0 && tracks[name]?.[i]; i--) back++;
      runs.set(name, back);
    }

    for (let i = from; i < length; i++) {
      for (const name of ladder) {
        if (!tracks[name]?.[i]) continue;

        const run = (runs.get(name) ?? 0) + 1;
        if (run <= maxRun) { runs.set(name, run); continue; }

        const free = ladder
          .filter((n) => n !== name && !tracks[n]?.[i])
          .sort((a, b) => (runs.get(a) ?? 0) - (runs.get(b) ?? 0));
        if (!free.length) { runs.set(name, run); continue; }

        const to = free[0];
        track(to)[i] = tracks[name][i];
        tracks[name][i] = 0;
        runs.set(name, 0);
        runs.set(to, (runs.get(to) ?? 0) + 1);
      }
      for (const name of ladder) if (!tracks[name]?.[i]) runs.set(name, 0);
    }
  };
  if (maxRun > 0 && ladder.length > 1) limitRuns();

  // A crash closes a fill roughly half the time; the rest of the time the
  // landing is left to the downbeat of the next bar (see barPattern).
  //
  // Never on a linear fill: sounding two voices at once is precisely what that
  // shape exists to avoid, and its crash belongs on the following downbeat.
  if (chosen !== 'linear' && 'crash' in kit && rand() < 0.35 + intensity * 0.3) {
    put('crash', length - 1, 108);
  }

  return {
    ...p,
    tracks,
    length: Math.max(...Object.values(tracks).map((s) => s.length)),
    fillShape: chosen,
    fillAscending: ascending,
  };
}
