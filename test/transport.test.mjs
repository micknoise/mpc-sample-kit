// node --test
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTransport } from '../src/transport.mjs';

/** A fake MIDI output and clock, so the transport can be driven deterministically. */
function harness(overrides = {}) {
  let clock = 0;
  const sent = [];
  let cleared = 0;
  const timers = new Set();

  const output = {
    send: (bytes, at) => sent.push({ bytes, at: at ?? clock }),
    clear: () => { cleared++; },
  };

  const t = createTransport({
    output,
    nextBar: (i) => ({
      events: [{ ms: 0, bytes: [0x90, 36, 100] }, { ms: 40, bytes: [0x80, 36, 0] }],
      durationMs: 1000,
      index: i,
    }),
    now: () => clock,
    schedule: (fn) => { timers.add(fn); return fn; },
    unschedule: (fn) => { timers.delete(fn); },
    ...overrides,
  });

  return {
    t, sent, output,
    get cleared() { return cleared; },
    get timerCount() { return timers.size; },
    advance(ms) { clock += ms; for (const fn of [...timers]) fn(); },
  };
}

test('play queues only the look-ahead, not everything', () => {
  const h = harness();
  h.t.play();
  // 400ms look-ahead over 1000ms bars means exactly one bar is queued.
  assert.equal(h.t.bar, 1);
  assert.equal(h.sent.length, 2);
});

test('playback continues indefinitely as the clock advances', () => {
  const h = harness();
  h.t.play();
  for (let i = 0; i < 20; i++) h.advance(500);
  assert.ok(h.t.bar >= 10, `expected to keep generating, got ${h.t.bar} bars`);
  assert.equal(h.t.playing, true, 'still running with no fixed end');
});

test('play is idempotent — a second press cannot stack a stream', () => {
  const h = harness();
  assert.equal(h.t.play(), true);
  const afterFirst = h.sent.length;
  assert.equal(h.t.play(), false, 'second play refused');
  assert.equal(h.t.play(), false);
  assert.equal(h.sent.length, afterFirst, 'nothing extra queued');
  assert.equal(h.timerCount, 1, 'only one timer running');
});

test('stop halts generation, clears the queue and sends all-notes-off', () => {
  const h = harness();
  h.t.play();
  h.advance(500);
  const barsAtStop = h.t.bar;

  assert.equal(h.t.stop(), true);
  assert.equal(h.t.playing, false);
  assert.equal(h.cleared, 1, 'queued look-ahead dropped');

  const last = h.sent.at(-1).bytes;
  assert.deepEqual(last, [0xb0, 0x7b, 0x00], 'all notes off');

  h.advance(5000);
  assert.equal(h.t.bar, barsAtStop, 'no further bars generated after stop');
  assert.equal(h.timerCount, 0, 'timer cleared');
});

test('stop is idempotent', () => {
  const h = harness();
  h.t.play();
  assert.equal(h.t.stop(), true);
  assert.equal(h.t.stop(), false);
});

test('play after stop restarts cleanly from bar zero', () => {
  const h = harness();
  h.t.play();
  h.advance(3000);
  h.t.stop();
  assert.equal(h.t.play(), true);
  assert.equal(h.t.bar, 1, 'restarts counting from the beginning');
});

test('transport messages are sent only when asked', () => {
  const plain = harness();
  plain.t.play();
  assert.ok(!plain.sent.some((e) => e.bytes[0] === 0xfa), 'no start by default');

  const sync = harness({ sendTransport: true });
  sync.t.play();
  assert.equal(sync.sent[0].bytes[0], 0xfa, 'start leads');
  sync.t.stop();
  assert.deepEqual(sync.sent.at(-1).bytes, [0xfc], 'stop trails');
});

test('a throwing generator stops playback instead of spinning', () => {
  const errors = [];
  const h = harness({
    nextBar: () => { throw new Error('bad pattern'); },
    onError: (e) => errors.push(e),
  });
  h.t.play();
  assert.equal(h.t.playing, false, 'stopped');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /bad pattern/);
});

test('a zero-length bar is rejected rather than looping forever', () => {
  const errors = [];
  const h = harness({
    nextBar: () => ({ events: [], durationMs: 0 }),
    onError: (e) => errors.push(e),
  });
  h.t.play();
  assert.equal(h.t.playing, false);
  assert.match(errors[0].message, /positive durationMs/);
});

test('events are queued at absolute times that advance monotonically', () => {
  const h = harness();
  h.t.play();
  for (let i = 0; i < 5; i++) h.advance(500);
  const onsets = h.sent.filter((e) => e.bytes[0] === 0x90).map((e) => e.at);
  for (let i = 1; i < onsets.length; i++) {
    assert.ok(onsets[i] > onsets[i - 1], 'each bar lands after the last');
  }
  assert.equal(onsets[1] - onsets[0], 1000, 'bars are spaced by their duration');
});

test('maxBars stops after the requested bars, once they have played out', () => {
  let ended = 0;
  const h = harness({ maxBars: 4, onEnd: () => { ended++; } });
  h.t.play();

  h.advance(500);
  assert.equal(h.t.playing, true, 'still running while bars remain');

  for (let i = 0; i < 12; i++) h.advance(500);
  assert.equal(h.t.bar, 4, 'generated exactly the requested bars');
  assert.equal(h.t.playing, false, 'stopped itself');
  assert.equal(ended, 1, 'onEnd fired once');

  for (let i = 0; i < 5; i++) h.advance(500);
  assert.equal(ended, 1, 'and not again');
});

test('maxBars waits for the tail rather than cutting it off', () => {
  // Bars are 1000ms and the look-ahead is 400ms, so the second bar is not
  // queued until the clock is within 400ms of it.
  const h = harness({ maxBars: 2 });
  h.t.play();
  assert.equal(h.t.bar, 1, 'only the first bar fits in the look-ahead');

  h.advance(1200);
  assert.equal(h.t.bar, 2, 'second and final bar now queued');
  assert.equal(h.t.playing, true, 'still playing — the tail has not sounded yet');

  h.advance(500);           // clock 1700, last bar due at 2150
  assert.equal(h.t.playing, true, 'must not cut the final bar short');

  h.advance(600);           // clock 2300
  assert.equal(h.t.playing, false, 'stops once the last bar has played out');
});

test('a burst of missed ticks is bounded by maxBarsPerTick', () => {
  const h = harness({ maxBarsPerTick: 3 });
  h.t.play();
  h.advance(100000);        // simulate the tab being suspended for a long time
  assert.ok(h.t.bar <= 4, `generated ${h.t.bar} bars, expected the guard to hold`);
  assert.equal(h.t.playing, true, 'survives the stall rather than dying');
});
