// node --test
import test from 'node:test';
import assert from 'node:assert/strict';

import { euclid, euclidTrack, randomTrack, rng } from '../src/generate.mjs';
import { pattern, parseSteps, stepMs, patternMs } from '../src/pattern.mjs';
import { render } from '../src/schedule.mjs';
import { rotate, thin, densify, upsample, ratchetPattern } from '../src/transform.mjs';
import { arrange, arrangementMs, evolve, chain } from '../src/arrange.mjs';
import { padToNote, noteToPad, resolveNote } from '../src/pads.mjs';

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

test('randomTrack respects density bounds', () => {
  assert.equal(randomTrack(16, 0, { rand: rng(1) }).filter(Boolean).length, 0);
  assert.equal(randomTrack(16, 1, { rand: rng(1) }).filter(Boolean).length, 16);
});
