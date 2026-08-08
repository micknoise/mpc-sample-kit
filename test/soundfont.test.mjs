// node --test
//
// The adapter is driven through a fake engine, which is what makes it testable
// at all: the real one is a third-party AudioWorklet that only exists in a
// browser. What matters here is the translation — MIDI bytes in, engine calls
// out, at the right times on the right channel.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSoundfontOutput, drumKits, GM_DRUM_KITS, DRUM_BANK,
} from '../src/soundfont.mjs';
import { contextTimeFor } from '../src/audioclock.mjs';
import { GM_CHANNEL } from '../src/gm.mjs';

function fakeEngine() {
  const calls = [];
  const record = (kind) => (...args) => calls.push({ kind, args });
  return {
    calls,
    of: (kind) => calls.filter((c) => c.kind === kind),
    noteOn: record('noteOn'),
    noteOff: record('noteOff'),
    programChange: record('programChange'),
    controllerChange: record('controllerChange'),
    stopAll: record('stopAll'),
    destroy: record('destroy'),
  };
}

const fakeContext = (currentTime = 0) => ({ currentTime, getOutputTimestamp: undefined });
const on = (note, velocity = 100, channel = GM_CHANNEL) => [0x90 | (channel - 1), note, velocity];

test('a note-on reaches the engine on the right channel', () => {
  const engine = fakeEngine();
  const out = createSoundfontOutput(fakeContext(), engine, { now: () => 0 });

  out.send(on(38));
  assert.equal(engine.of('noteOn').length, 1);
  const [channel, note, velocity] = engine.of('noteOn')[0].args;
  assert.equal(channel, 9, 'channel 10 is index 9');
  assert.equal(note, 38);
  assert.equal(velocity, 100);
});

test('note-offs pass through, including velocity-zero note-ons', () => {
  const engine = fakeEngine();
  const out = createSoundfontOutput(fakeContext(), engine, { now: () => 0 });

  out.send([0x89, 38]);
  out.send(on(38, 0));
  assert.equal(engine.of('noteOff').length, 2);
  assert.equal(engine.of('noteOn').length, 0);
});

test('events are scheduled in audio-context seconds, not milliseconds', () => {
  const engine = fakeEngine();
  const out = createSoundfontOutput(fakeContext(5), engine, { now: () => 1000 });

  out.send(on(36), 1250);                       // 250ms into the future
  const [, , , options] = engine.of('noteOn')[0].args;
  assert.ok(Math.abs(options.time - 5.25) < 1e-6, `scheduled at ${options.time}`);
});

test('a timestamp in the past schedules now rather than never', () => {
  const engine = fakeEngine();
  const out = createSoundfontOutput(fakeContext(5), engine, { now: () => 1000 });

  out.send(on(36), 200);
  const [, , , options] = engine.of('noteOn')[0].args;
  assert.equal(options.time, 5);
});

test('program change selects a kit', () => {
  const engine = fakeEngine();
  const out = createSoundfontOutput(fakeContext(), engine, { now: () => 0 });

  out.send([0xc9, 25]);                          // TR-808 on channel 10
  const [channel, program] = engine.of('programChange')[0].args;
  assert.equal(channel, 9);
  assert.equal(program, 25);
});

test('the transport panic stops everything, not just the notes already sounding', () => {
  const engine = fakeEngine();
  const out = createSoundfontOutput(fakeContext(), engine, { now: () => 0 });

  out.send([0xb9, 0x7b, 0x00]);
  assert.equal(engine.of('controllerChange').length, 1);
  assert.equal(engine.of('stopAll').length, 1, 'queued look-ahead must be cut too');
});

test('clock, transport and sysex are ignored rather than misread', () => {
  const engine = fakeEngine();
  const out = createSoundfontOutput(fakeContext(), engine, { now: () => 0 });

  for (const bytes of [[0xf8], [0xfa], [0xfc], [0xf0, 0x7f, 0x7f, 0x06, 0x06, 0xf7], []]) {
    out.send(bytes);
  }
  assert.equal(engine.calls.length, 0);
});

test('close silences and tears down', () => {
  const engine = fakeEngine();
  const out = createSoundfontOutput(fakeContext(), engine, { now: () => 0 });
  out.close();
  assert.equal(engine.of('stopAll').length, 1);
  assert.equal(engine.of('destroy').length, 1);
});

test('it looks enough like a MIDI output to be used as one', () => {
  const out = createSoundfontOutput(fakeContext(), fakeEngine(), { now: () => 0 });
  assert.equal(typeof out.id, 'string');
  assert.equal(typeof out.name, 'string');
  assert.equal(typeof out.send, 'function');
  assert.equal(typeof out.clear, 'function');
});

// ------------------------------------------------------------------ kit list

test('drum kits are read off the bank, lowest program first', () => {
  const kits = drumKits([
    { program: 25, bankMSB: DRUM_BANK, name: 'TR-808', isDrum: true },
    { program: 0, bankMSB: DRUM_BANK, name: 'Standard', isDrum: true },
    { program: 48, bankMSB: 0, name: 'String Ensemble', isDrum: false },
  ]);
  assert.deepEqual(kits, [
    { program: 0, name: 'Standard' },
    { program: 25, name: 'TR-808' },
  ]);
});

test('the same kit under several bank LSBs is listed once', () => {
  const kits = drumKits([
    { program: 0, bankMSB: DRUM_BANK, bankLSB: 0, name: 'Standard', isDrum: true },
    { program: 0, bankMSB: DRUM_BANK, bankLSB: 1, name: 'Standard', isDrum: true },
  ]);
  assert.equal(kits.length, 1);
});

test('a bank with no drum presets falls back to the GM list', () => {
  assert.deepEqual(drumKits([{ program: 0, bankMSB: 0, isDrum: false }]), GM_DRUM_KITS);
  assert.deepEqual(drumKits(null), GM_DRUM_KITS);
  assert.deepEqual(drumKits([]), GM_DRUM_KITS);
});

test('an unnamed preset still gets a label', () => {
  const [kit] = drumKits([{ program: 16, bankMSB: DRUM_BANK, name: '  ', isDrum: true }]);
  assert.equal(kit.name, 'program 16');
});

test('the GM kit list is the standard one', () => {
  assert.deepEqual(GM_DRUM_KITS.map((k) => k.program), [0, 8, 16, 24, 25, 32, 40, 48, 56]);
  assert.equal(GM_DRUM_KITS.find((k) => k.program === 25).name, 'TR-808');
});

// -------------------------------------------------------------- clock bridge

test('contextTimeFor prefers the paired clocks when the context reports them', () => {
  const context = {
    currentTime: 5,
    getOutputTimestamp: () => ({ contextTime: 4.9, performanceTime: 1000 }),
  };
  assert.ok(Math.abs(contextTimeFor(context, 1500, () => 1000) - 5.4) < 1e-6);
});

test('contextTimeFor falls back to sampling both clocks together', () => {
  const context = { currentTime: 5 };
  assert.ok(Math.abs(contextTimeFor(context, 1500, () => 1000) - 5.5) < 1e-6);
});

test('contextTimeFor treats a missing timestamp as now', () => {
  assert.equal(contextTimeFor({ currentTime: 7 }, null, () => 0), 7);
});
