// node --test
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTicker, timerTicker, openAudioContext } from '../src/audioclock.mjs';

test('with no AudioContext it falls back to timers', async () => {
  const t = await createTicker(null);
  assert.equal(t.kind, 'timer');
});

test('AudioWorklet is preferred when available', async () => {
  let connected = false;
  const ctx = {
    sampleRate: 48000,
    destination: {},
    audioWorklet: { addModule: async () => {} },
  };
  globalThis.Blob = class { constructor() {} };
  globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
  globalThis.AudioWorkletNode = class {
    constructor() { this.port = {}; }
    connect() { connected = true; }
  };

  const t = await createTicker(ctx);
  assert.equal(t.kind, 'audioworklet');
  assert.ok(connected, 'must be connected or the processor never runs');
  assert.ok(t.resolutionMs > 2 && t.resolutionMs < 4, `128 frames at 48k, got ${t.resolutionMs}`);

  delete globalThis.AudioWorkletNode;
});

test('ScriptProcessor is used when AudioWorklet is missing', async () => {
  let connected = false;
  const node = { onaudioprocess: null, connect: () => { connected = true; } };
  const ctx = { sampleRate: 44100, destination: {}, createScriptProcessor: () => node };

  const t = await createTicker(ctx);
  assert.equal(t.kind, 'scriptprocessor');
  assert.ok(connected);
  assert.ok(t.resolutionMs > 5 && t.resolutionMs < 7, `256 frames at 44.1k, got ${t.resolutionMs}`);

  let ticks = 0;
  t.start(() => { ticks++; });
  node.onaudioprocess();
  assert.equal(ticks, 1, 'audio callback drives the tick');

  t.stop();
  node.onaudioprocess();
  assert.equal(ticks, 1, 'stopped means stopped');
});

test('a failing AudioWorklet degrades rather than throwing', async () => {
  const node = { onaudioprocess: null, connect() {} };
  const ctx = {
    sampleRate: 48000,
    destination: {},
    audioWorklet: { addModule: async () => { throw new Error('no worklets here'); } },
    createScriptProcessor: () => node,
  };
  const t = await createTicker(ctx);
  assert.equal(t.kind, 'scriptprocessor', 'falls through to the next tier');
});

test('timerTicker starts and stops cleanly', () => {
  let interval = null;
  const t = timerTicker({
    setPoll: (fn) => { interval = fn; return 1; },
    clearPoll: () => { interval = null; },
    setFrame: null,
    cancelFrame: null,
  });
  let ticks = 0;
  t.start(() => { ticks++; });
  interval();
  assert.equal(ticks, 1);
  t.stop();
  assert.equal(interval, null);
});

test('openAudioContext returns null instead of throwing when unsupported', async () => {
  assert.equal(await openAudioContext(undefined), null);
  assert.equal(await openAudioContext(function Bad() { throw new Error('nope'); }), null);
});

test('openAudioContext resumes a suspended context', async () => {
  let resumed = false;
  const Ctor = function () {
    return { state: 'suspended', resume: async () => { resumed = true; } };
  };
  const ctx = await openAudioContext(Ctor);
  assert.ok(ctx);
  assert.ok(resumed, 'iOS starts suspended until a gesture resumes it');
});
