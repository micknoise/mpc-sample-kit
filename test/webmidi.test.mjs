// node --test
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listPorts, findPort, isLegacyAccess, wrapOutput, openAccess, describePorts, getOutputs,
} from '../src/webmidi.mjs';

const port = (id, name) => ({ id, name, send() {} });

// The shapes MIDIAccess.outputs has actually taken in the wild.
const asMap = (ports) => new Map(ports.map((p) => [p.id, p]));
const asArray = (ports) => ports;
const asObject = (ports) => Object.fromEntries(ports.map((p) => [p.id, p]));
const asArrayValues = (ports) => ({ values: () => ports.slice() });   // old draft
const asBrokenValues = () => ({ values: () => undefined });           // the reported failure

test('listPorts handles every collection shape', () => {
  const ports = [port('a', 'MPC Sample'), port('b', 'Other')];
  for (const [label, shape] of Object.entries({ asMap, asArray, asObject, asArrayValues })) {
    assert.deepEqual(listPorts(shape(ports)).map((p) => p.id), ['a', 'b'], label);
  }
});

test('listPorts survives a values() that is not iterable', () => {
  // This is the iPhone failure: spreading the result threw, and the resulting
  // error was reported to the user as "MIDI access denied".
  assert.doesNotThrow(() => listPorts(asBrokenValues()));
  assert.deepEqual(listPorts(asBrokenValues()), []);
});

test('listPorts survives a values() that throws', () => {
  const hostile = { values: () => { throw new TypeError('nope'); } };
  assert.doesNotThrow(() => listPorts(hostile));
  assert.deepEqual(listPorts(hostile), []);
});

test('listPorts on nothing returns nothing', () => {
  assert.deepEqual(listPorts(null), []);
  assert.deepEqual(listPorts(undefined), []);
  assert.deepEqual(listPorts({}), []);
});

test('findPort works with and without Map.get', () => {
  const ports = [port('a', 'MPC Sample'), port('b', 'Other')];
  assert.equal(findPort(asMap(ports), 'b').name, 'Other');
  assert.equal(findPort(asArray(ports), 'b').name, 'Other');
  assert.equal(findPort(asObject(ports), 'a').name, 'MPC Sample');
  assert.equal(findPort(asMap(ports), 'missing'), null);
});

test('findPort tolerates numeric ids', () => {
  const ports = [{ id: 1, name: 'One', send() {} }];
  assert.equal(findPort(ports, '1').name, 'One');
});

test('legacy detection distinguishes the two worlds', () => {
  const ports = [port('a', 'MPC')];
  assert.equal(isLegacyAccess({ outputs: asMap(ports) }), false, 'Maplike is current');
  assert.equal(isLegacyAccess({ outputs: asArray(ports) }), true);
  assert.equal(isLegacyAccess({ outputs: asArrayValues(ports) }), true);
  assert.equal(isLegacyAccess({ outputs: asBrokenValues() }), true);
  assert.equal(isLegacyAccess(null), true);
});

test('wrapOutput leaves a compliant output completely alone', () => {
  const raw = port('a', 'MPC');
  assert.equal(wrapOutput(raw, { legacy: false }), raw, 'Chrome path must be untouched');
});

test('wrapOutput schedules with timers when send ignores timestamps', () => {
  const sent = [];
  const raw = { id: 'a', name: 'MPC', send: (b) => sent.push(b) };

  let clock = 0;
  const timers = [];
  const out = wrapOutput(raw, {
    legacy: true,
    now: () => clock,
    setTimer: (fn, delay) => { timers.push({ fn, at: clock + delay }); return timers.length - 1; },
    clearTimer: (h) => { timers[h] = null; },
  });
  const run = () => { for (const t of timers) if (t && t.at <= clock) { t.fn(); timers[timers.indexOf(t)] = null; } };

  out.send([0x90, 36, 100], 0);      // due now
  out.send([0x90, 38, 100], 500);    // due later
  assert.deepEqual(sent, [[0x90, 36, 100]], 'immediate message goes straight out');

  clock = 500; run();
  assert.equal(sent.length, 2, 'later message fires at its time, not immediately');
});

test('wrapOutput clear cancels queued messages so Stop still works', () => {
  const sent = [];
  const raw = { id: 'a', name: 'MPC', send: (b) => sent.push(b), clear: () => {} };

  let clock = 0;
  const timers = new Map();
  let next = 0;
  const out = wrapOutput(raw, {
    legacy: true,
    now: () => clock,
    setTimer: (fn, delay) => { const h = next++; timers.set(h, { fn, at: clock + delay }); return h; },
    clearTimer: (h) => timers.delete(h),
  });

  out.send([0x90, 36, 100], 1000);
  out.send([0x90, 38, 100], 2000);
  assert.equal(timers.size, 2);

  out.clear();
  assert.equal(timers.size, 0, 'queued notes cancelled');

  clock = 3000;
  for (const t of timers.values()) t.fn();
  assert.equal(sent.length, 0, 'nothing sounds after clear');
});

test('wrapOutput preserves identity fields', () => {
  const raw = { id: 'x', name: 'MPC Sample', send() {} };
  const out = wrapOutput(raw, { legacy: true });
  assert.equal(out.id, 'x');
  assert.equal(out.name, 'MPC Sample');
});

test('describePorts reports the shape rather than guessing', () => {
  const ports = [port('a', 'MPC')];
  assert.match(describePorts(new Map(ports.map((p) => [p.id, p]))), /maplike.*iterable.*1 found/);
  assert.match(describePorts(ports), /array.*1 found/);
  assert.match(describePorts({ values: () => undefined }), /values\(\) returns null.*0 found/);
  assert.match(describePorts({ values: () => { throw new TypeError('x'); } }), /throws TypeError/);
  assert.equal(describePorts(null), 'missing');
});

// A Maplike whose values() returns a bare iterator: next(), no Symbol.iterator.
// This is what the iPhone implementation actually does — it reported
// "maplike, values() object, 0 found".
const asBareIterator = (ports) => ({
  get: (id) => ports.find((p) => p.id === id) ?? undefined,
  values() {
    let i = 0;
    return { next: () => (i < ports.length ? { value: ports[i++], done: false } : { done: true }) };
  },
});

test('a Maplike whose values() is a bare iterator still yields ports', () => {
  const ports = [port('a', 'MPC Sample'), port('b', 'Other')];
  const outputs = asBareIterator(ports);
  assert.deepEqual(listPorts(outputs).map((p) => p.name), ['MPC Sample', 'Other']);
  assert.equal(findPort(outputs, 'b').name, 'Other');
  assert.match(describePorts(outputs), /maplike, values\(\) bare iterator, 2 found/);
});

test('forEach is used when the iterators are unusable', () => {
  const ports = [port('a', 'MPC Sample')];
  const outputs = {
    get: () => undefined,
    values: () => ({}),                        // useless
    forEach: (fn) => ports.forEach((p) => fn(p)),
  };
  assert.deepEqual(listPorts(outputs).map((p) => p.name), ['MPC Sample']);
});

test('entries() is used when values() and forEach are unusable', () => {
  const ports = [port('a', 'MPC Sample')];
  const outputs = {
    get: () => undefined,
    entries: () => ports.map((p) => [p.id, p]),
  };
  assert.deepEqual(listPorts(outputs).map((p) => p.name), ['MPC Sample']);
});

test('an iterator that never finishes cannot hang the page', () => {
  const endless = { values: () => ({ next: () => ({ value: port('x', 'X'), done: false }) }) };
  const got = listPorts(endless);
  assert.ok(got.length > 0 && got.length <= 4096, `drained ${got.length}`);
});

test('outputs exposed as a method, not a property', () => {
  // The 2012 draft. Easy to miss: a function has a length (its arity), so
  // array-like handling yields nothing rather than failing loudly.
  const ports = [port('a', 'MPC Sample')];
  const asMethod = () => ports.slice();

  assert.deepEqual(listPorts(asMethod).map((p) => p.name), ['MPC Sample']);
  assert.equal(findPort(asMethod, 'a').name, 'MPC Sample');
  assert.match(describePorts(asMethod), /method -> array.*1 found/);
});

test('getOutputs finds outputs however the access object exposes them', () => {
  const ports = [port('a', 'MPC Sample')];
  const map = new Map(ports.map((p) => [p.id, p]));

  assert.equal(getOutputs({ outputs: map }), map, 'property form');
  assert.deepEqual(listPorts(getOutputs({ outputs: () => ports })), ports, 'outputs() method');
  assert.deepEqual(listPorts(getOutputs({ getOutputs: () => ports })), ports, 'getOutputs()');
  assert.deepEqual(listPorts(getOutputs({ destinations: ports })), ports, 'destinations');
  assert.equal(getOutputs(null), null);
});

test('a method-based access is treated as legacy', () => {
  const ports = [port('a', 'MPC')];
  assert.equal(isLegacyAccess({ outputs: () => ports }), true);
  assert.equal(isLegacyAccess({ getOutputs: () => ports }), true);
  assert.equal(isLegacyAccess({ outputs: new Map() }), false);
});

test('a throwing outputs method does not take the page down', () => {
  const hostile = { outputs: () => { throw new TypeError('nope'); } };
  assert.doesNotThrow(() => getOutputs(hostile));
  assert.deepEqual(listPorts(getOutputs(hostile)), []);
  assert.equal(isLegacyAccess(hostile), true);
});

test('openAccess falls back when sysex is refused', async () => {
  const calls = [];
  const req = async (opts) => {
    calls.push(opts.sysex);
    if (opts.sysex) throw new Error('SysEx not supported');
    return { outputs: new Map() };
  };
  const { sysex, access } = await openAccess(req);
  assert.deepEqual(calls, [true, false], 'tries sysex first, then without');
  assert.equal(sysex, false);
  assert.ok(access, 'still got usable access');
});

test('openAccess keeps sysex when it is granted', async () => {
  const req = async () => ({ outputs: new Map() });
  const { sysex, legacy } = await openAccess(req);
  assert.equal(sysex, true);
  assert.equal(legacy, false);
});
