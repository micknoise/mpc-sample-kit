// node --test
//
// The synth is driven through a fake AudioContext, which is enough to check
// everything that is not a matter of taste: that a note-on schedules sources at
// the right time, that note-offs are ignored, that Stop actually silences the
// look-ahead, and that no note in the GM range throws on the way through.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSynthOutput } from '../src/synth.mjs';
import { GM_KIT, GM_CHANNEL } from '../src/gm.mjs';
import { resolveNote } from '../src/pads.mjs';

function fakeContext({ currentTime = 0, sampleRate = 48000, timestamp = null } = {}) {
  const started = [];

  const param = (value = 0) => ({
    value,
    setValueAtTime(v) { assert.ok(Number.isFinite(v)); return this; },
    // Web Audio throws on an exponential ramp to zero, so the envelopes must
    // never ask for one — that is a real bug class, not a fake-only concern.
    exponentialRampToValueAtTime(v, t) {
      assert.notEqual(v, 0, 'exponential ramp to zero');
      assert.ok(Number.isFinite(t));
      return this;
    },
    linearRampToValueAtTime() { return this; },
  });

  const node = (extra = {}) => ({ connect() {}, disconnect() {}, ...extra });

  const source = (kind) => {
    const s = node({
      kind,
      startedAt: null,
      stoppedAt: null,
      frequency: param(440),
      playbackRate: param(1),
      start(when) {
        assert.equal(s.startedAt, null, 'start called twice');
        assert.ok(Number.isFinite(when) && when >= 0, `bad start time ${when}`);
        s.startedAt = when;
        started.push(s);
      },
      // Spec: a later stop() replaces the earlier one.
      stop(when) {
        assert.notEqual(s.startedAt, null, 'stop before start');
        s.stoppedAt = when;
      },
    });
    return s;
  };

  return {
    currentTime,
    sampleRate,
    started,
    destination: node(),
    getOutputTimestamp: timestamp ? () => timestamp : undefined,
    createGain: () => node({ gain: param(1) }),
    createBiquadFilter: () => node({ type: '', frequency: param(1000), Q: param(1) }),
    createOscillator: () => source('osc'),
    createBufferSource: () => source('buffer'),
    createDynamicsCompressor: () => node({
      threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
    }),
    createBuffer: (channels, length, rate) => ({
      duration: length / rate,
      getChannelData: () => new Float32Array(length),
    }),
  };
}

const noteOn = (note, velocity = 100, channel = GM_CHANNEL) =>
  [0x90 | (channel - 1), note, velocity];

test('a note-on schedules audio sources', () => {
  const context = fakeContext();
  const out = createSynthOutput(context, { now: () => 0 });
  out.send(noteOn(36));
  assert.ok(context.started.length > 0, 'kick made no sound');
});

test('it looks enough like a MIDI output to be used as one', () => {
  const out = createSynthOutput(fakeContext(), { now: () => 0 });
  assert.equal(typeof out.id, 'string');
  assert.equal(typeof out.name, 'string');
  assert.equal(typeof out.send, 'function');
  assert.equal(typeof out.clear, 'function');
});

test('note-offs and zero-velocity note-ons are ignored', () => {
  const context = fakeContext();
  const out = createSynthOutput(context, { now: () => 0 });
  out.send([0x89, 38, 0]);
  out.send(noteOn(38, 0));
  out.send([]);
  assert.equal(context.started.length, 0);
});

test('it plays whatever channel it is sent, being a drum machine', () => {
  // Refusing notes on the "wrong" channel would produce an output that looks
  // connected and is silent, which is the hardest failure to diagnose.
  for (const channel of [1, 10, 16]) {
    const context = fakeContext();
    const out = createSynthOutput(context, { now: () => 0 });
    out.send(noteOn(38, 100, channel));
    assert.ok(context.started.length > 0, `channel ${channel} was dropped`);
  }
});

test('scheduled notes land at the requested time on the audio clock', () => {
  const context = fakeContext({ currentTime: 5 });
  const out = createSynthOutput(context, { now: () => 1000 });

  out.send(noteOn(36), 1250);                    // 250ms into the future
  const first = Math.min(...context.started.map((s) => s.startedAt));
  assert.ok(Math.abs(first - 5.25) < 1e-6, `scheduled at ${first}, wanted 5.25`);
});

test('a timestamp already in the past plays now rather than never', () => {
  const context = fakeContext({ currentTime: 5 });
  const out = createSynthOutput(context, { now: () => 1000 });
  out.send(noteOn(36), 400);
  for (const s of context.started) assert.ok(s.startedAt >= 5, `${s.startedAt} is in the past`);
});

test('getOutputTimestamp is used to line the two clocks up when present', () => {
  const context = fakeContext({
    currentTime: 5,
    timestamp: { contextTime: 4.9, performanceTime: 1000 },
  });
  const out = createSynthOutput(context, { now: () => 1000 });

  out.send(noteOn(36), 1500);                    // 500ms out, from performanceTime
  const first = Math.min(...context.started.map((s) => s.startedAt));
  assert.ok(Math.abs(first - 5.4) < 1e-6, `scheduled at ${first}, wanted 5.4`);
});

test('clear silences everything already scheduled', () => {
  const context = fakeContext({ currentTime: 2 });
  const out = createSynthOutput(context, { now: () => 0 });

  for (let i = 0; i < 8; i++) out.send(noteOn(36 + i), i * 100);
  assert.ok(context.started.length > 0);

  out.clear();
  for (const s of context.started) {
    assert.ok(s.stoppedAt <= 2, `${s.kind} still runs until ${s.stoppedAt}`);
  }
});

test('all-notes-off clears, as the transport panic expects', () => {
  const context = fakeContext({ currentTime: 2 });
  const out = createSynthOutput(context, { now: () => 0 });

  out.send(noteOn(36), 500);
  out.send([0xb0, 0x7b, 0x00]);
  for (const s of context.started) assert.ok(s.stoppedAt <= 2);
});

test('every GM percussion note has a voice and none of them throw', () => {
  for (let note = 35; note <= 81; note++) {
    const context = fakeContext();
    const out = createSynthOutput(context, { now: () => 0 });
    out.send(noteOn(note));
    assert.ok(context.started.length > 0, `note ${note} is silent`);
  }
});

test('notes outside the percussion range still make a sound', () => {
  for (const note of [0, 34, 82, 127]) {
    const context = fakeContext();
    const out = createSynthOutput(context, { now: () => 0 });
    out.send(noteOn(note));
    assert.ok(context.started.length > 0, `note ${note} is silent`);
  }
});

test('the whole GM kit plays through it at any velocity', () => {
  for (const role of Object.keys(GM_KIT)) {
    for (const velocity of [1, 45, 90, 127]) {
      const context = fakeContext();
      const out = createSynthOutput(context, { now: () => 0 });
      out.send(noteOn(resolveNote(role, GM_KIT), velocity));
      assert.ok(context.started.length > 0, `${role} at velocity ${velocity} is silent`);
    }
  }
});

test('close tears down without throwing', () => {
  const context = fakeContext();
  const out = createSynthOutput(context, { now: () => 0 });
  out.send(noteOn(36));
  out.close();
  assert.doesNotThrow(() => out.close());
});
