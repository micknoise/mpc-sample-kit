// node --test
import test from 'node:test';
import assert from 'node:assert/strict';

import { summarise, driftFrom, measureTiming, describeTiming } from '../src/timing.mjs';

test('drift ignores constant latency and measures spacing only', () => {
  const intended = [0, 100, 200, 300];
  // Everything 50ms late but perfectly spaced: inaudible, so zero error.
  assert.deepEqual(driftFrom(intended, [50, 150, 250, 350]), [0, 0, 0]);
});

test('drift catches uneven spacing', () => {
  const intended = [0, 100, 200, 300];
  assert.deepEqual(driftFrom(intended, [0, 110, 195, 300]), [10, -5, 0]);
});

test('drift needs at least two events', () => {
  assert.deepEqual(driftFrom([0], [0]), []);
  assert.deepEqual(driftFrom([], []), []);
});

test('summarise reports mean, worst and spread', () => {
  const s = summarise([10, -20, 5, 0]);
  assert.equal(s.count, 4);
  assert.equal(s.worst, 20, 'worst is the largest absolute error');
  assert.equal(s.mean, 8.8);
  assert.ok(s.sd > 0);
});

test('summarise handles nothing', () => {
  assert.deepEqual(summarise([]), { count: 0, mean: 0, worst: 0, sd: 0 });
});

/** Fake MIDI pair where the echo can be given an arbitrary timing error. */
function rig({ jitter = () => 0, echo = true } = {}) {
  let clock = 0;
  const input = { onmidimessage: null };
  const timers = [];

  const output = {
    send(bytes, at) {
      if ((bytes[0] & 0xf0) !== 0x90) return;
      if (!echo) return;
      const arrival = (at ?? clock) + jitter(bytes);
      timers.push({ at: arrival, fn: () => input.onmidimessage?.({ data: bytes }) });
    },
  };

  return {
    input, output,
    now: () => clock,
    setTimer: (fn, delay) => timers.push({ at: clock + delay, fn }),
    run() {
      timers.sort((a, b) => a.at - b.at);
      while (timers.length) {
        const next = timers.shift();
        clock = Math.max(clock, next.at);
        next.fn();
      }
    },
  };
}

test('a perfect echo measures as tight', async () => {
  const r = rig();
  const p = measureTiming({ output: r.output, input: r.input, count: 8, spacingMs: 100, now: r.now, setTimer: r.setTimer });
  r.run();
  const result = await p;

  assert.equal(result.echo, true);
  assert.equal(result.stats.worst, 0);
  assert.match(describeTiming(result), /tight/);
});

test('a jittery echo is measured and described as such', async () => {
  let i = 0;
  const r = rig({ jitter: () => [0, 25, -20, 30, 0, 18, -22, 27][i++ % 8] });
  const p = measureTiming({ output: r.output, input: r.input, count: 8, spacingMs: 100, now: r.now, setTimer: r.setTimer });
  r.run();
  const result = await p;

  assert.ok(result.stats.worst >= 18, `worst was ${result.stats.worst}`);
  assert.match(describeTiming(result), /loose|unusable/);
});

test('no echo is reported as such rather than as perfect timing', async () => {
  const r = rig({ echo: false });
  const p = measureTiming({ output: r.output, input: r.input, count: 4, spacingMs: 100, now: r.now, setTimer: r.setTimer });
  r.run();
  const result = await p;

  assert.equal(result.echo, false);
  assert.match(describeTiming(result), /no echo received/);
});

test('the input handler is restored afterwards', async () => {
  const r = rig();
  const original = () => {};
  r.input.onmidimessage = original;

  const p = measureTiming({ output: r.output, input: r.input, count: 4, spacingMs: 50, now: r.now, setTimer: r.setTimer });
  r.run();
  await p;

  assert.equal(r.input.onmidimessage, original, 'must not leave the input hijacked');
});

test('measurement works without an input, reporting no echo', async () => {
  const r = rig();
  const p = measureTiming({ output: r.output, input: null, count: 4, spacingMs: 50, now: r.now, setTimer: r.setTimer });
  r.run();
  const result = await p;
  assert.equal(result.echo, false);
});
