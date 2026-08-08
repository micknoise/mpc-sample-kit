// node --test
import test from 'node:test';
import assert from 'node:assert/strict';

import { euclid, euclidTrack, randomTrack, rng, style, styleNames } from '../src/generate.mjs';
import { pattern, parseSteps, stepMs, patternMs, swungStep } from '../src/pattern.mjs';
import { render } from '../src/schedule.mjs';
import {
  rotate, thin, densify, upsample, ratchetPattern, decollide, dodgeLastBeat, fill, FILL_SHAPES,
} from '../src/transform.mjs';
import { arrange, arrangementMs, evolve, chain, barPattern } from '../src/arrange.mjs';
import { padToNote, noteToPad, resolveNote, resolveVoices } from '../src/pads.mjs';
import { metricWeight, effectiveWeight, applyWeight } from '../src/dynamics.mjs';
import { clockEvents, withClock, CLOCK, START, STOP } from '../src/clock.mjs';

const show = (bools) => bools.map((b) => (b ? 'x' : '.')).join('');

test('euclid matches canonical necklaces', () => {
  assert.equal(show(euclid(3, 8)), 'x..x..x.', 'tresillo');
  assert.equal(show(euclid(5, 8)), 'x.xx.xx.', 'cinquillo');
  assert.equal(show(euclid(2, 5)), 'x.x..');
  assert.equal(show(euclid(7, 16)), 'x..x.x.x..x.x.x.');
});

test('euclid always emits exactly the requested pulse count', () => {
  for (let steps = 1; steps <= 32; steps++) {
    for (let pulses = 0; pulses <= steps; pulses++) {
      const hits = euclid(pulses, steps).filter(Boolean).length;
      assert.equal(hits, pulses, `E(${pulses},${steps})`);
      assert.equal(euclid(pulses, steps).length, steps);
    }
  }
});

test('euclid clamps out-of-range pulses and rejects bad steps', () => {
  assert.equal(euclid(99, 8).filter(Boolean).length, 8);
  assert.equal(euclid(-4, 8).filter(Boolean).length, 0);
  assert.throws(() => euclid(3, 0), RangeError);
});

test('euclid rotation preserves pulse count', () => {
  for (const r of [-5, -1, 0, 1, 3, 17]) {
    assert.equal(euclid(5, 16, r).filter(Boolean).length, 5);
  }
});

test('step strings parse, ignoring spacing characters', () => {
  assert.deepEqual(parseSteps('x.o.'), [110, 0, 90, 0]);
  assert.equal(parseSteps('x... | x... | x... | x...').length, 16);
  assert.throws(() => parseSteps('xyz'), /unrecognised step character/);
});

test('pattern validates its inputs', () => {
  assert.throws(() => pattern({ bpm: 0, tracks: { kick: 'x' } }), /bpm/);
  assert.throws(() => pattern({ bpm: 120, tracks: {} }), /at least one track/);
  assert.throws(() => pattern({ bpm: 120, swing: 1, tracks: { kick: 'x' } }), RangeError);
});

test('timing maths', () => {
  const p = pattern({ bpm: 120, tracks: { kick: 'x...x...x...x...' } });
  assert.equal(stepMs(p), 125);          // 120bpm, 4 steps per beat
  assert.equal(patternMs(p), 2000);      // one bar
});

test('render emits paired note on/off in ascending time order', () => {
  const p = pattern({ bpm: 120, tracks: { kick: 'x...x...x...x...' } });
  const ev = render(p, { gateMs: 40 });
  assert.equal(ev.length, 8);            // 4 hits, on + off
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i].ms >= ev[i - 1].ms, 'ascending');
  assert.equal(ev.filter((e) => (e.bytes[0] & 0xf0) === 0x90).length, 4);
  assert.equal(ev.filter((e) => (e.bytes[0] & 0xf0) === 0x80).length, 4);
});

test('render is deterministic under a fixed seed and varies with it', () => {
  const p = pattern({ bpm: 96, humanizeMs: 8, humanizeVel: 20, tracks: { kick: 'x.x.x.x.' } });
  const a = render(p, { seed: 42 });
  const b = render(p, { seed: 42 });
  const c = render(p, { seed: 43 });
  assert.deepEqual(a, b, 'same seed reproduces exactly');
  assert.notDeepEqual(a, c, 'different seed differs');
});

test('swing delays only every second step', () => {
  const straight = render(pattern({ bpm: 120, tracks: { kick: 'xxxx' } }), {});
  const swung = render(pattern({ bpm: 120, swing: 0.5, tracks: { kick: 'xxxx' } }), {});
  const onsets = (ev) => ev.filter((e) => (e.bytes[0] & 0xf0) === 0x90).map((e) => e.ms);
  assert.deepEqual(onsets(straight), [0, 125, 250, 375]);
  assert.deepEqual(onsets(swung), [0, 187.5, 250, 437.5]);
});

test('velocities stay inside the legal MIDI range', () => {
  const p = pattern({ bpm: 120, humanizeVel: 500, tracks: { kick: 'xxxxxxxx' } });
  for (const e of render(p, { seed: 3 })) {
    if ((e.bytes[0] & 0xf0) === 0x90) assert.ok(e.bytes[2] >= 1 && e.bytes[2] <= 127, `vel ${e.bytes[2]}`);
  }
});

test('pad and note mapping round-trips across bank A', () => {
  for (let pad = 1; pad <= 16; pad++) assert.equal(noteToPad(padToNote(pad)), pad);
  assert.equal(padToNote(1), 36);
  assert.equal(padToNote(16), 51);
  assert.equal(noteToPad(35), null);
  assert.throws(() => padToNote(17), RangeError);
});

test('track names resolve from kit roles, pad numbers and padN', () => {
  assert.equal(resolveNote('kick'), 36);
  assert.equal(resolveNote(3), 38);
  assert.equal(resolveNote('pad 5'), 40);
  assert.throws(() => resolveNote('kazoo'), /unknown track/);
});

test('transforms preserve length and rotate cyclically', () => {
  const steps = parseSteps('x..o..s.');
  assert.deepEqual(rotate(steps, 8), steps, 'full turn is identity');
  assert.deepEqual(rotate(rotate(steps, 3), -3), steps);
  assert.equal(thin(steps, 1, rng(1)).filter(Boolean).length, 0, 'thin(1) empties');
  assert.equal(densify(steps, 1, rng(1)).filter(Boolean).length, steps.length, 'densify(1) fills');
});

test('upsample doubles resolution and keeps original hits on even steps', () => {
  const steps = parseSteps('x.o.');
  const up = upsample(steps, { rollProb: 0 });
  assert.equal(up.length, 8);
  assert.deepEqual(up.filter((_, i) => i % 2 === 0), steps);
});

test('ratchetPattern keeps musical duration constant', () => {
  const p = pattern({ bpm: 120, tracks: { kick: 'x.x.x.x.' } });
  const r = ratchetPattern(p, { rollProb: 0.5, rand: rng(2) });
  assert.equal(r.stepsPerBeat, p.stepsPerBeat * 2);
  assert.equal(patternMs(r), patternMs(p), 'doubling the grid must not change length');
});

test('arrange lays sections end to end without overlap', () => {
  const p = pattern({ bpm: 120, tracks: { kick: 'x...x...x...x...' } });
  const sections = [{ pattern: p, repeats: 2 }, { pattern: p, repeats: 1 }];
  assert.equal(arrangementMs(sections), 6000);
  const ev = arrange(sections, {});
  assert.ok(Math.max(...ev.map((e) => e.ms)) < 6000 + 50);
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i].ms >= ev[i - 1].ms);
});

test('evolve produces the requested bar count and leaves bar 1 as written', () => {
  const p = pattern({ bpm: 90, tracks: { kick: 'x..x..x.', snare: '....x...' } });
  const sections = evolve(p, { bars: 8, fillEvery: 4, seed: 5 });
  assert.equal(sections.length, 8);
  assert.deepEqual(sections[0].pattern.tracks, p.tracks, 'first bar states the idea plainly');
});

test('evolve honours locked tracks', () => {
  const p = pattern({ bpm: 90, tracks: { kick: 'x..x..x.', hat: 'oooooooo' } });
  for (const s of evolve(p, { bars: 6, fillEvery: 0, drift: 1, lock: ['kick'], seed: 9 })) {
    assert.deepEqual(s.pattern.tracks.kick, p.tracks.kick, 'kick must not drift');
  }
});

test('chain expands a written form', () => {
  const a = pattern({ bpm: 120, tracks: { kick: 'x...' } });
  const b = pattern({ bpm: 120, tracks: { kick: '..x.' } });
  const sections = chain({ a, b }, 'a a a b');
  assert.equal(sections.length, 4);
  assert.deepEqual(sections[3].pattern.tracks, b.tracks);
  assert.throws(() => chain({ a }, 'a q'), /no pattern named/);
});

test('metric weight follows the nested hierarchy of the bar', () => {
  const w = (i) => metricWeight(i, 4, 4);
  assert.equal(w(0), 1, 'downbeat is strongest');
  assert.ok(w(8) > w(4), 'beat 3 beats beats 2 and 4');
  assert.ok(w(4) > w(2), 'quarters beat eighths');
  assert.ok(w(2) > w(1), 'eighths beat sixteenths');
  assert.equal(w(4), w(12), 'beats 2 and 4 are equal');
  assert.equal(w(16), w(0), 'weights repeat each bar');
});

test('metric weight generalises to other grids', () => {
  assert.equal(metricWeight(0, 3, 4), 1);
  assert.ok(metricWeight(6, 3, 4) > metricWeight(1, 3, 4));
});

test('dynamics widen velocity spread without leaving MIDI range', () => {
  const spec = { bpm: 120, tracks: { hat: 'oooooooooooooooo' } };
  const flat = render(pattern({ ...spec, dynamics: { depth: 0 } }), { seed: 5 })
    .filter((e) => (e.bytes[0] & 0xf0) === 0x90).map((e) => e.bytes[2]);
  const shaped = render(pattern({ ...spec, dynamics: { depth: 0.45, conformity: 0.8 } }), { seed: 5 })
    .filter((e) => (e.bytes[0] & 0xf0) === 0x90).map((e) => e.bytes[2]);

  assert.equal(new Set(flat).size, 1, 'depth 0 leaves velocities flat');
  assert.ok(new Set(shaped).size > 3, 'shaping produces real variation');
  assert.ok(Math.max(...shaped) > Math.min(...shaped) + 15, 'spread is audible');
  for (const v of shaped) assert.ok(v >= 1 && v <= 127);
});

test('anchorDownbeat controls whether beat 1 can be displaced', () => {
  // conformity 0 forces syncopation at every eligible step.
  const always = () => 0;
  assert.equal(effectiveWeight(1, 0, always, true), 1, 'anchored: beat 1 holds');
  assert.ok(effectiveWeight(1, 0, always, false) < 1, 'unanchored: beat 1 can give way');
  assert.ok(effectiveWeight(0.35, 0, always, true) > 0.35, 'weak steps get leaned on');
});

test('conformity 1 reproduces pure metric weighting', () => {
  // rand() yields [0, 1), so the nearest-to-certain draw is just under 1.
  const never = () => 0.999999;
  for (const w of [0.35, 0.49, 0.63, 0.76]) assert.equal(effectiveWeight(w, 1, never), w);
});

test('downbeat stays the loudest step under normal settings', () => {
  const p = pattern({
    bpm: 120,
    dynamics: { depth: 0.45, conformity: 0.8 },
    tracks: { kick: 'oooooooooooooooo' },
  });
  const vels = render(p, { seed: 11 }).filter((e) => (e.bytes[0] & 0xf0) === 0x90).map((e) => e.bytes[2]);
  assert.equal(vels[0], Math.max(...vels), 'step 0 is the peak');
});

test('clock emits 24 ticks per beat wrapped in transport', () => {
  const ev = clockEvents(120, 2000);          // 120bpm, one 4/4 bar
  assert.equal(ev.filter((e) => e.bytes[0] === CLOCK).length, 96, '4 beats x 24 ppqn');
  assert.equal(ev.filter((e) => e.bytes[0] === START).length, 1);
  assert.equal(ev.filter((e) => e.bytes[0] === STOP).length, 1);
});

test('clock can run without transport messages', () => {
  const ev = clockEvents(120, 1000, { transport: false });
  assert.equal(ev.filter((e) => e.bytes[0] === START || e.bytes[0] === STOP).length, 0);
});

test('withClock keeps events ordered and start ahead of the first note', () => {
  const p = pattern({ bpm: 120, tracks: { kick: 'x...x...x...x...' } });
  const merged = withClock(render(p, {}), 120, patternMs(p));
  for (let i = 1; i < merged.length; i++) assert.ok(merged[i].ms >= merged[i - 1].ms);
  assert.equal(merged[0].bytes[0], START, 'transport start leads');
});

test('voice substitution uses alternates, and only when asked', () => {
  const p = pattern({ bpm: 120, tracks: { snare: 'oooooooooooooooo' } });
  const notesFor = (voiceSpread) => [...new Set(
    render(p, { voiceSpread, seed: 4 })
      .filter((e) => (e.bytes[0] & 0xf0) === 0x90).map((e) => e.bytes[1]),
  )].sort((a, b) => a - b);

  assert.deepEqual(notesFor(0), [37], 'spread 0 always plays the primary');
  assert.ok(notesFor(0.6).length > 1, 'spread substitutes rim and clap');
  assert.ok(notesFor(0.6).includes(37), 'primary still dominates');
});

test('note-off always matches the note that was struck', () => {
  const p = pattern({ bpm: 120, tracks: { snare: 'oooooooo' } });
  const ev = render(p, { voiceSpread: 1, seed: 8 });
  const open = new Map();
  for (const e of ev) {
    const [status, note] = e.bytes;
    if ((status & 0xf0) === 0x90) open.set(note, (open.get(note) ?? 0) + 1);
    else open.set(note, (open.get(note) ?? 0) - 1);
  }
  for (const [note, balance] of open) assert.equal(balance, 0, `note ${note} left hanging`);
});

test('voices fall back to the primary for unknown roles and thin kits', () => {
  assert.deepEqual(resolveVoices('kick'), [36], 'kick has no alternates');
  assert.deepEqual(resolveVoices('ride'), [padToNote(12)], 'role absent from the voice map');
  // A kit lacking the alternates must not break.
  assert.deepEqual(resolveVoices('snare', { snare: 2 }), [37]);
  // An explicit array in the kit wins outright.
  assert.deepEqual(resolveVoices('snare', { snare: [2, 9, 10] }), [37, 44, 45]);
});

test('decollide moves an on-beat snare off the kick', () => {
  const p = pattern({ bpm: 90, tracks: { kick: 'x...x...x...x...', snare: 'x...x...x...x...' } });
  const d = decollide(p, { strength: 1, seed: 2 });
  for (let i = 0; i < d.length; i++) {
    assert.ok(!(d.tracks.kick[i] && d.tracks.snare[i]), `still colliding at step ${i}`);
  }
  assert.equal(d.tracks.snare.filter(Boolean).length, 4, 'hits are moved, not deleted');
});

test('decollide leaves off-beat coincidences and four-on-the-floor claps alone', () => {
  const offbeat = pattern({ bpm: 90, tracks: { kick: '..x.....', snare: '..x.....' } });
  assert.deepEqual(
    decollide(offbeat, { strength: 1 }).tracks.snare, offbeat.tracks.snare,
    'off-beat collisions are usually deliberate',
  );
  const house = pattern({ bpm: 124, tracks: { kick: 'x...x...', clap: 'x...x...' } });
  assert.deepEqual(
    decollide(house, { strength: 1 }).tracks.clap, house.tracks.clap,
    'clap is not in the default pair',
  );
});

test('decollide at strength 0 is a no-op', () => {
  const p = pattern({ bpm: 90, tracks: { kick: 'x...', snare: 'x...' } });
  assert.equal(decollide(p, { strength: 0 }), p);
});

test('jazz styles exist and free-jazz is deliberately unanchored', () => {
  const names = styleNames();
  assert.ok(names.includes('jazz'));
  assert.ok(names.includes('free-jazz'));
  const free = pattern(style('free-jazz'));
  assert.equal(free.dynamics.anchorDownbeat, false);
  assert.ok(free.dynamics.conformity < 0.5, 'accents land almost anywhere');
  assert.ok(pattern(style('jazz')).swing > 0.25, 'jazz is properly swung');
});

test('every style produces a renderable pattern', () => {
  for (const name of styleNames()) {
    const p = pattern(style(name));
    const ev = render(p, { seed: 1 });
    assert.ok(ev.length > 0, `${name} produced no events`);
    for (const e of ev) {
      assert.ok(e.bytes[1] >= 36 && e.bytes[1] <= 51, `${name}: note ${e.bytes[1]} outside bank A`);
    }
  }
});

test('fills reach voices the pattern does not contain', () => {
  // The point of the rewrite: a kick/snare/hat pattern must still produce tom
  // fills, which is impossible if the fill only transforms existing tracks.
  const base = pattern({ bpm: 90, tracks: { kick: 'x...x...', snare: '....x...', hat: 'oooooooo' } });
  assert.ok(!('tomLow' in base.tracks), 'precondition: no toms in the groove');

  const f = fill(base, { shape: 'descend', intensity: 0.9, seed: 5 });
  const sounding = Object.entries(f.tracks).filter(([, s]) => s.some(Boolean)).map(([n]) => n);
  assert.ok(sounding.some((n) => n.startsWith('tom')), `no toms used: ${sounding}`);
});

test('every fill shape spreads across at least three voices', () => {
  const base = pattern({ bpm: 90, tracks: { kick: 'x...x...', snare: '....x...', hat: 'oooooooo' } });
  for (const shape of FILL_SHAPES) {
    const f = fill(base, { shape, intensity: 0.75, seed: 3 });
    const sounding = Object.entries(f.tracks).filter(([, s]) => s.some(Boolean)).map(([n]) => n);
    assert.ok(sounding.length >= 3, `${shape} used only ${sounding.join(',')}`);
    assert.equal(f.fillShape, shape);
  }
});

test('fills are not snare-dominated', () => {
  const base = pattern({ bpm: 90, tracks: { kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'oooooooooooooooo' } });
  for (const shape of FILL_SHAPES) {
    const f = fill(base, { shape, intensity: 0.8, seed: 9 });
    const counts = Object.fromEntries(
      Object.entries(f.tracks).map(([n, s]) => [n, s.filter(Boolean).length]),
    );
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    assert.ok(
      (counts.snare ?? 0) / total <= 0.7,
      `${shape}: snare is ${counts.snare}/${total} of the fill`,
    );
  }
});

test('fills involve the kick', () => {
  const base = pattern({ bpm: 90, tracks: { kick: 'x...x...x...x...', snare: '....x.......x...' } });
  for (const shape of FILL_SHAPES) {
    const f = fill(base, { shape, intensity: 0.8, seed: 4 });
    assert.ok(f.tracks.kick.some(Boolean), `${shape} dropped the kick entirely`);
  }
});

test('a linear fill never sounds two voices at once', () => {
  const base = pattern({ bpm: 90, tracks: { kick: 'x...x...x...x...', snare: '....x.......x...' } });
  const f = fill(base, { shape: 'linear', intensity: 1, seed: 6 });
  const names = Object.keys(f.tracks);
  for (let i = 0; i < f.length; i++) {
    const hits = names.filter((n) => f.tracks[n][i]).length;
    assert.ok(hits <= 1, `step ${i} sounds ${hits} voices — linear means one at a time`);
  }
});

test('fills crescendo', () => {
  const base = pattern({ bpm: 90, tracks: { kick: 'x...x...x...x...', snare: '....x.......x...' } });
  const f = fill(base, { shape: 'descend', intensity: 1, seed: 2 });
  const loudest = (range) => Math.max(...Object.values(f.tracks)
    .flatMap((s) => s.slice(...range).filter(Boolean)), 0);
  assert.ok(loudest([12, 16]) > loudest([0, 4]), 'the end should be louder than the start');
});

test('fill intensity controls how much of the bar it takes', () => {
  const base = pattern({ bpm: 90, tracks: { kick: 'x...x...x...x...', snare: '....x.......x...' } });
  const span = (intensity) => {
    const f = fill(base, { shape: 'roll', intensity, seed: 1 });
    const hits = f.tracks.snare.flatMap((v, i) => (v ? [i] : []));
    return hits.length ? f.length - Math.min(...hits) : 0;
  };
  assert.ok(span(0.9) > span(0.2), 'a heavier fill starts earlier');
});

test('fills are deterministic and shape selection responds to the seed', () => {
  const base = pattern({ bpm: 90, tracks: { kick: 'x...x...', snare: '....x...' } });
  assert.deepEqual(
    fill(base, { seed: 12 }).tracks, fill(base, { seed: 12 }).tracks,
    'same seed, same fill',
  );
  const shapes = new Set(Array.from({ length: 24 }, (_, i) => fill(base, { seed: i }).fillShape));
  assert.ok(shapes.size >= 3, `auto should vary the vocabulary, saw ${[...shapes].join(',')}`);
});

test('fills degrade gracefully on a kit with no toms', () => {
  const bare = { kick: 1, snare: 2, hat: 5 };
  const base = pattern({ bpm: 90, tracks: { kick: 'x...x...', snare: '....x...' } });
  for (const shape of FILL_SHAPES) {
    const f = fill(base, { shape, intensity: 0.8, seed: 7, kit: bare });
    const used = Object.entries(f.tracks).filter(([, s]) => s.some(Boolean)).map(([n]) => n);
    assert.ok(used.every((n) => n in bare), `${shape} reached outside the kit: ${used}`);
    assert.ok(used.length >= 2, `${shape} produced almost nothing`);
  }
});

test('the bar after a fill lands on a crash', () => {
  const base = pattern({ bpm: 90, tracks: { kick: 'x...x...', snare: '....x...' } });
  const after = barPattern(base, 4, { fillEvery: 4, seed: 1 });   // bar 3 was the fill
  assert.ok(after.tracks.crash?.[0] > 0, 'crash on the downbeat after a fill');

  const ordinary = barPattern(base, 5, { fillEvery: 4, seed: 1 });
  assert.ok(!ordinary.tracks.crash?.[0], 'no crash on an ordinary bar');
});

test('jazz keeps the kick off every beat', () => {
  const p = pattern(style('jazz'));
  const kickHits = p.tracks.kick.flatMap((v, i) => (v ? [i] : []));
  const onEveryBeat = [0, 4, 8, 12].every((i) => p.tracks.kick[i]);
  assert.ok(!onEveryBeat, 'a jazz kick on all four is out of the norm');
  assert.ok(kickHits.length <= 4, 'the kick should stay sparse');
  assert.ok(kickHits.some((i) => i % 4 !== 0), 'and catch a syncopation');
});

test('a syncopated kick is moved off beat 4', () => {
  const p = pattern({ bpm: 88, tracks: { kick: 'x..o......o.x...' } });
  assert.ok(p.tracks.kick[12], 'precondition: kick sits on beat 4');
  const d = dodgeLastBeat(p, { strength: 1, seed: 1 });
  assert.ok(!d.tracks.kick[12], 'beat 4 vacated');
  assert.ok(d.tracks.kick[14], 'moved to the "and" of 4');
  assert.equal(
    d.tracks.kick.filter(Boolean).length, p.tracks.kick.filter(Boolean).length,
    'the hit is moved, not deleted',
  );
});

test('four-on-the-floor keeps its beat-4 kick', () => {
  for (const name of ['techno', 'house']) {
    const p = pattern(style(name));
    const d = dodgeLastBeat(p, { strength: 1, seed: 1 });
    assert.deepEqual(d.tracks.kick, p.tracks.kick, `${name} must keep all four`);
  }
});

test('dodgeLastBeat is a no-op when the kick is already clear of beat 4', () => {
  const p = pattern({ bpm: 88, tracks: { kick: 'x..o......o.....' } });
  assert.equal(dodgeLastBeat(p, { strength: 1 }), p);
});

test('dodgeLastBeat at strength 0, or with no kick track, does nothing', () => {
  const p = pattern({ bpm: 88, tracks: { kick: 'x...x...x..ox...' } });
  assert.equal(dodgeLastBeat(p, { strength: 0 }), p);
  const noKick = pattern({ bpm: 88, tracks: { snare: 'x...x...x...x...' } });
  assert.equal(dodgeLastBeat(noKick, { strength: 1 }), noKick);
});

test('boom-bap ships without a kick on beat 4', () => {
  const p = pattern(style('boom-bap'));
  assert.ok(!p.tracks.kick[12], 'a beat-4 kick is lame, especially here');
  assert.ok(p.tracks.kick[0], 'but beat 1 is still there');
});

test('no style except four-on-the-floor puts the kick on beat 4', () => {
  for (const name of styleNames()) {
    const p = pattern(style(name));
    if (!p.tracks.kick) continue;
    const spb = p.stepsPerBeat;
    const onEveryBeat = [0, spb, 2 * spb, 3 * spb].every((i) => p.tracks.kick[i]);
    if (onEveryBeat) continue;                       // deliberate, exempt
    assert.ok(!p.tracks.kick[3 * spb], `${name} has a limp beat-4 kick`);
  }
});

test('evolved bars stay clear of beat 4', () => {
  const p = pattern(style('boom-bap'));
  for (const s of evolve(p, { bars: 12, drift: 0.9, fillEvery: 0, lock: [], seed: 3 })) {
    assert.ok(!s.pattern.tracks.kick[12], 'variation must not reintroduce it');
  }
});

const longestRun = (steps) => {
  let run = 0, worst = 0;
  for (const v of steps) { run = v ? run + 1 : 0; worst = Math.max(worst, run); }
  return worst;
};

test('no fill stays on one drum for more than three strikes', () => {
  for (const styleName of ['boom-bap', 'techno', 'jazz', 'free-jazz', 'dnb']) {
    const base = pattern(style(styleName));
    for (const shape of FILL_SHAPES) {
      for (let seed = 1; seed <= 20; seed++) {
        for (const intensity of [0.2, 0.5, 0.8, 1]) {
          const f = fill(base, { shape, seed, intensity });
          for (const [name, steps] of Object.entries(f.tracks)) {
            assert.ok(
              longestRun(steps) <= 3,
              `${styleName}/${shape} seed ${seed} i${intensity}: ${name} runs ${longestRun(steps)}`,
            );
          }
        }
      }
    }
  }
});

test('the run limit accounts for a groove run continuing into the fill', () => {
  // Sixteenth snares right up to the fill entry: naively counting only inside
  // the fill region would miss the overlap and allow a run of four.
  const base = pattern({ bpm: 90, tracks: { kick: 'x...x...', snare: 'oooooooo' } });
  const f = fill(base, { shape: 'roll', intensity: 0.5, seed: 3 });
  assert.ok(longestRun(f.tracks.snare) <= 3, `snare runs ${longestRun(f.tracks.snare)}`);
});

test('consecutive fills in a phrase genuinely differ', () => {
  const base = pattern(style('boom-bap'));
  const fills = [3, 7, 11, 15, 19, 23, 27, 31]
    .map((bar) => barPattern(base, bar, { fillEvery: 4, seed: 1, drift: 0.3 }));

  assert.ok(new Set(fills.map((f) => f.fillShape)).size >= 4, 'shapes should vary');
  assert.ok(new Set(fills.map((f) => f.fillAscending)).size === 2, 'direction should vary');

  // No two fills should be byte-identical.
  const signatures = fills.map((f) => JSON.stringify(f.tracks));
  assert.equal(new Set(signatures).size, signatures.length, 'two fills came out identical');
});

test('fill run-limiting can be turned off', () => {
  const base = pattern({ bpm: 90, tracks: { kick: 'x...x...x...x...', snare: '....x.......x...' } });
  const f = fill(base, { shape: 'roll', intensity: 1, seed: 1, maxRun: 0 });
  assert.ok(longestRun(f.tracks.snare) > 3, 'maxRun 0 leaves long runs intact');
});

test('the kick develops by default rather than being frozen', () => {
  // Locking the kick by default meant it never moved however high the drift
  // was pushed, which read as a bug: the pattern appeared not to respond.
  const base = pattern(style('jazz'));
  const kicks = new Set(
    Array.from({ length: 8 }, (_, bar) =>
      barPattern(base, bar, { drift: 0.6, fillEvery: 0, seed: 2 }).tracks.kick.join(',')),
  );
  assert.ok(kicks.size >= 4, `kick barely moved: ${kicks.size} distinct patterns in 8 bars`);
});

test('locking is still available and still absolute', () => {
  const base = pattern(style('jazz'));
  for (let bar = 0; bar < 8; bar++) {
    const p = barPattern(base, bar, { drift: 1, fillEvery: 0, lock: ['kick'], seed: 2 });
    assert.deepEqual(p.tracks.kick, base.tracks.kick, `bar ${bar} drifted despite the lock`);
  }
});

test('swingUnit 2 swings the eighths, unit 1 the sixteenths', () => {
  const s = 1 / 3;
  // Unit 1: every odd sixteenth is displaced.
  assert.equal(swungStep(0, s, 1), 0);
  assert.ok(Math.abs(swungStep(1, s, 1) - 4 / 3) < 1e-9);
  assert.equal(swungStep(2, s, 1), 2);

  // Unit 2: the second eighth of each beat lands two thirds through it, which
  // is what triplet swing means. The eighths on the beat stay put.
  assert.equal(swungStep(0, s, 2), 0);
  assert.ok(Math.abs(swungStep(2, s, 2) - 8 / 3) < 1e-9, 'second eighth at 2.667');
  assert.equal(swungStep(4, s, 2), 4, 'next beat is unmoved');
  assert.ok(Math.abs(swungStep(6, s, 2) - 20 / 3) < 1e-9);
});

test('swing never closes the gap to the next step below 1 - swing', () => {
  // Displacing without compensating pushes swung notes into their neighbour and
  // neighbouring tracks flam. The warp has to preserve a usable gap.
  for (const unit of [1, 2, 4]) {
    for (const swing of [0.1, 0.33, 0.5, 0.75, 0.9]) {
      const pos = Array.from({ length: 32 }, (_, i) => swungStep(i, swing, unit));
      for (let i = 1; i < pos.length; i++) {
        const gap = pos[i] - pos[i - 1];
        assert.ok(gap > 0, `unit ${unit} swing ${swing}: order broken at ${i}`);
        assert.ok(
          gap >= (1 - swing) - 1e-9,
          `unit ${unit} swing ${swing}: gap ${gap.toFixed(3)} at step ${i}`,
        );
      }
    }
  }
});

test('swing preserves bar alignment', () => {
  for (const unit of [1, 2]) {
    for (const swing of [0.2, 1 / 3, 0.5]) {
      for (const i of [0, 4, 8, 12, 16]) {
        if (i % (unit * 2) === 0) {
          assert.equal(swungStep(i, swing, unit), i, `step ${i} should stay put`);
        }
      }
    }
  }
});

test('swing zero and unit validation', () => {
  assert.equal(swungStep(5, 0, 2), 5, 'no swing is identity');
  assert.throws(() => pattern({ bpm: 120, swingUnit: 0, tracks: { kick: 'x' } }), RangeError);
  assert.throws(() => pattern({ bpm: 120, swingUnit: 1.5, tracks: { kick: 'x' } }), RangeError);
});

test('jazz swings the eighths, and its ride actually moves', () => {
  const p = pattern(style('jazz'));
  assert.equal(p.swingUnit, 2, 'jazz must swing the eighths, not the sixteenths');

  // The old behaviour left the ride untouched: every ride hit sits on an even
  // step, and unit-1 swing only displaces odd ones.
  const rideSteps = p.tracks.ride.flatMap((v, i) => (v ? [i] : []));
  const moved = rideSteps.filter((i) => swungStep(i, p.swing, p.swingUnit) !== i);
  assert.ok(moved.length > 0, 'the ride has to swing or it is not jazz');
});

test('no two jazz onsets land close enough to flam', () => {
  const p = pattern({ ...style('jazz'), humanizeMs: 0 });
  const step = stepMs(p);
  const onsets = [...new Set(
    render(p, { seed: 1 }).filter((e) => (e.bytes[0] & 0xf0) === 0x90).map((e) => e.ms),
  )].sort((a, b) => a - b);

  for (let i = 1; i < onsets.length; i++) {
    const gap = onsets[i] - onsets[i - 1];
    assert.ok(gap > 30, `onsets ${gap.toFixed(0)}ms apart reads as a flam, not a rhythm`);
  }
  assert.ok(onsets.length > 6, 'sanity: the pattern produced notes');
  assert.ok(step > 0);
});

test('no style produces flams — hits land together or clearly apart', () => {
  // Two onsets 12-35ms apart are the worst of both worlds: too far to hear as
  // one hit, too close to hear as a rhythm. Applying humanizeMs independently
  // per event caused exactly this, since voices meant to land together drifted
  // apart by up to twice the amount.
  for (const name of styleNames()) {
    const base = pattern(style(name));
    for (let seed = 1; seed <= 12; seed++) {
      for (let bar = 0; bar < 8; bar++) {
        const onsets = render(barPattern(base, bar, { seed, drift: 0.5, fillEvery: 4 }), { seed: seed + bar })
          .filter((e) => (e.bytes[0] & 0xf0) === 0x90)
          .map((e) => e.ms)
          .sort((a, b) => a - b);

        for (let i = 1; i < onsets.length; i++) {
          const gap = onsets[i] - onsets[i - 1];
          assert.ok(
            gap < 12 || gap > 35,
            `${name} bar ${bar} seed ${seed}: onsets ${gap.toFixed(1)}ms apart`,
          );
        }
      }
    }
  }
});

test('humanisation keeps simultaneous hits together', () => {
  const p = pattern({
    bpm: 100, humanizeMs: 30,
    tracks: { kick: 'x...x...', snare: 'x...x...', hat: 'x...x...' },
  });
  const byTime = render(p, { seed: 4 })
    .filter((e) => (e.bytes[0] & 0xf0) === 0x90).map((e) => e.ms).sort((a, b) => a - b);

  // Three voices on each of two steps: within a step they must stay tight even
  // though humanizeMs is large.
  const spread = Math.max(byTime[0], byTime[1], byTime[2]) - Math.min(byTime[0], byTime[1], byTime[2]);
  assert.ok(spread < 30 * 0.5 + 1e-6, `simultaneous hits spread ${spread.toFixed(1)}ms`);
  assert.ok(spread > 0, 'but not perfectly quantised either — limbs are independent');
});

test('limbSpread 0 makes simultaneous hits exactly simultaneous', () => {
  const p = pattern({ bpm: 100, humanizeMs: 30, tracks: { kick: 'x...', snare: 'x...' } });
  const on = render(p, { seed: 4, limbSpread: 0 })
    .filter((e) => (e.bytes[0] & 0xf0) === 0x90).map((e) => e.ms);
  assert.equal(on[0], on[1], 'no per-voice component means perfect alignment');
});

test('the shared feel still moves the beat around', () => {
  const p = pattern({ bpm: 100, humanizeMs: 20, tracks: { kick: 'x...x...x...x...' } });
  const on = render(p, { seed: 6 })
    .filter((e) => (e.bytes[0] & 0xf0) === 0x90).map((e) => e.ms);
  const grid = [0, 600, 1200, 1800];
  assert.ok(on.some((t, i) => Math.abs(t - grid[i]) > 2), 'humanisation should not be a no-op');
});

test('styles declare the track that carries their identity', () => {
  // Freeing every track so the kick could move also freed the jazz ride, and a
  // mutated ride ostinato is no longer a jazz groove.
  assert.deepEqual(style('jazz').lock, ['ride']);
  assert.deepEqual(style('techno').lock, ['kick'], 'four-on-the-floor is the identity');
  for (const name of styleNames()) {
    assert.ok(Array.isArray(style(name).lock), `${name} must declare a lock, even if empty`);
    for (const track of style(name).lock) {
      assert.ok(track in style(name).tracks, `${name} locks "${track}" which it does not have`);
    }
  }
});

test('a locked identity track survives heavy drift while others move', () => {
  const spec = style('jazz');
  const base = pattern(spec);
  const kicks = new Set();
  for (let bar = 0; bar < 8; bar++) {
    const p = barPattern(base, bar, { drift: 0.8, fillEvery: 0, seed: 2, lock: spec.lock });
    assert.deepEqual(p.tracks.ride, base.tracks.ride, `bar ${bar}: the ride drifted`);
    kicks.add(p.tracks.kick.join(','));
  }
  assert.ok(kicks.size >= 4, 'the kick should still develop');
});

test('a style can restrict the fill vocabulary', () => {
  const spec = style('jazz');
  assert.deepEqual(spec.fillShapes, ['sparse', 'triplet']);
  const base = pattern(spec);
  for (let seed = 1; seed <= 20; seed++) {
    const f = fill(base, { seed, shapes: spec.fillShapes });
    assert.ok(spec.fillShapes.includes(f.fillShape), `got ${f.fillShape}`);
  }
});

test('randomTrack respects density bounds', () => {
  assert.equal(randomTrack(16, 0, { rand: rng(1) }).filter(Boolean).length, 0);
  assert.equal(randomTrack(16, 1, { rand: rng(1) }).filter(Boolean).length, 16);
});

test('note-offs can be dropped, halving the message count', () => {
  const p = pattern({ bpm: 120, tracks: { kick: 'x...x...x...x...' } });
  const withOffs = render(p, { seed: 1 });
  const without = render(p, { seed: 1, noteOffs: false });

  assert.equal(withOffs.length, 8);
  assert.equal(without.length, 4, 'exactly the note-ons');
  assert.ok(without.every((e) => (e.bytes[0] & 0xf0) === 0x90));
  assert.deepEqual(
    without.map((e) => e.ms),
    withOffs.filter((e) => (e.bytes[0] & 0xf0) === 0x90).map((e) => e.ms),
    'the notes themselves are unchanged',
  );
});
