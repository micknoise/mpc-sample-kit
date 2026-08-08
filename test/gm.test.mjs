// node --test
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  midiNote, resolveNote, resolveVoices, voiceInfo, noteToPad, padToNote,
  DEFAULT_KIT, DEFAULT_VOICES,
} from '../src/pads.mjs';
import { GM_KIT, GM_VOICES, GM_NAMES, GM_CHANNEL, gmName } from '../src/gm.mjs';
import { render } from '../src/schedule.mjs';
import { pattern } from '../src/pattern.mjs';
import { style, styleNames } from '../src/generate.mjs';
import { barPattern } from '../src/arrange.mjs';
import { createTransport } from '../src/transport.mjs';

test('midiNote rejects anything that is not a MIDI note', () => {
  assert.deepEqual(midiNote(36), { midi: 36 });
  assert.deepEqual(midiNote(0), { midi: 0 });
  assert.deepEqual(midiNote(127), { midi: 127 });
  for (const bad of [-1, 128, 3.5, '36', null, NaN]) {
    assert.throws(() => midiNote(bad), RangeError, `${bad}`);
  }
});

test('a kit entry can name a note instead of a pad', () => {
  const kit = { kick: midiNote(36), tamb: midiNote(54), snare: 2 };
  assert.equal(resolveNote('kick', kit), 36);
  assert.equal(resolveNote('tamb', kit), 54);      // outside bank A entirely
  assert.equal(resolveNote('snare', kit), padToNote(2));
});

test('pad numbers keep meaning pads', () => {
  // The whole point of wrapping notes: kick: 1 has always been pad 1, and
  // reading it as note 1 would silently retune every kit file in the repo.
  assert.equal(resolveNote('kick', { kick: 1 }), 36);
  assert.notEqual(resolveNote('kick', { kick: 1 }), 1);
});

test('"noteN" resolves like "padN" does', () => {
  assert.equal(resolveNote('note54', {}), 54);
  assert.equal(resolveNote('note 54', {}), 54);
  assert.equal(resolveNote('pad2', {}), 37);
  assert.throws(() => resolveNote('note200', {}), RangeError);
});

test('voice arrays may mix pads and notes', () => {
  const kit = { snare: [midiNote(38), midiNote(40), 4] };
  assert.deepEqual(resolveVoices('snare', kit), [38, 40, padToNote(4)]);
});

test('voiceInfo distinguishes a pad from a note that lands in bank A', () => {
  // GM's snare is note 38, which is also pad 3. Calling it "pad 3" in the UI
  // would be a display that lies about what the kit says.
  assert.deepEqual(voiceInfo('snare', GM_KIT), { note: 38, pad: null });
  assert.deepEqual(voiceInfo('snare', DEFAULT_KIT), { note: 37, pad: 2 });
  assert.equal(noteToPad(38), 3);
});

test('the GM kit covers every role the pad kit does', () => {
  for (const role of Object.keys(DEFAULT_KIT)) {
    assert.ok(role in GM_KIT, `GM kit is missing "${role}"`);
  }
});

test('every GM kit entry is a named percussion note', () => {
  for (const [role, entry] of Object.entries(GM_KIT)) {
    const note = resolveNote(role, GM_KIT);
    assert.ok(note >= 35 && note <= 81, `${role} -> ${note} is outside GM percussion`);
    assert.ok(gmName(note), `${role} -> ${note} has no GM name`);
    assert.deepEqual(entry, midiNote(note));
  }
  assert.equal(gmName(38), 'acoustic snare');
  assert.equal(gmName(200), null);
  assert.equal(Object.keys(GM_NAMES).length, 47);      // 35-81 inclusive
});

test('GM roles do not collide, so no two tracks share a sound', () => {
  const notes = Object.keys(GM_KIT).map((role) => resolveNote(role, GM_KIT));
  assert.equal(new Set(notes).size, notes.length);
});

test('GM voice alternates all resolve, and lead with the primary', () => {
  for (const [role, alternates] of Object.entries(GM_VOICES)) {
    const notes = resolveVoices(role, GM_KIT, GM_VOICES);
    assert.equal(notes[0], resolveNote(role, GM_KIT), `${role} must lead with its primary`);
    assert.equal(notes.length, alternates.length);
    for (const note of notes) assert.ok(gmName(note), `${role} substitutes onto an unnamed note`);
  }
});

test('every style renders on the GM kit without losing a track', () => {
  for (const name of styleNames()) {
    const p = pattern(style(name));
    const events = render(p, { kit: GM_KIT, voices: GM_VOICES, channel: GM_CHANNEL, seed: 3 });
    const sounded = new Set(
      events.filter((e) => (e.bytes[0] & 0xf0) === 0x90).map((e) => e.bytes[1]),
    );
    assert.ok(sounded.size >= Object.keys(p.tracks).length, `${name} lost a voice`);
    for (const note of sounded) assert.ok(gmName(note), `${name} sounded note ${note}, not GM`);
  }
});

test('fills and crashes survive the GM kit', () => {
  const base = pattern(style('boom-bap'));
  const bar = barPattern(base, 3, { kit: GM_KIT, fillEvery: 4, seed: 5 });
  const events = render(bar, { kit: GM_KIT, voices: GM_VOICES, channel: GM_CHANNEL });
  assert.ok(events.length > 0);
  for (const e of events) {
    if ((e.bytes[0] & 0xf0) === 0x90) assert.ok(gmName(e.bytes[1]), `note ${e.bytes[1]}`);
  }
});

test('render puts GM percussion on channel 10', () => {
  const p = pattern({ bpm: 90, tracks: { kick: 'x...', snare: '..x.' } });
  const events = render(p, { kit: GM_KIT, channel: GM_CHANNEL, voiceSpread: 0 });

  const ons = events.filter((e) => (e.bytes[0] & 0xf0) === 0x90);
  const offs = events.filter((e) => (e.bytes[0] & 0xf0) === 0x80);
  assert.ok(ons.length && offs.length);
  for (const e of [...ons, ...offs]) assert.equal(e.bytes[0] & 0x0f, 9, 'channel 10 is nibble 9');
  assert.deepEqual(ons.map((e) => e.bytes[1]), [36, 38]);
});

test('the same pattern on the MPC kit stays on channel 1', () => {
  const p = pattern({ bpm: 90, tracks: { kick: 'x...' } });
  const [on] = render(p, { kit: DEFAULT_KIT, voices: DEFAULT_VOICES, voiceSpread: 0 });
  assert.equal(on.bytes[0], 0x90);
  assert.equal(on.bytes[1], 36);
});

test('the transport panics on the channel it played on', () => {
  const sent = [];
  const output = { send: (bytes) => sent.push(bytes), clear() {} };
  let clock = 0;

  const transport = createTransport({
    output,
    channel: GM_CHANNEL,
    now: () => clock,
    schedule: () => 1,
    unschedule: () => {},
    nextBar: () => ({ events: [{ ms: 0, bytes: [0x99, 36, 100] }], durationMs: 500 }),
  });

  transport.play();
  transport.stop();
  assert.deepEqual(sent.at(-1), [0xb9, 0x7b, 0x00], 'all-notes-off must reach channel 10');
});
