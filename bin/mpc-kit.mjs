#!/usr/bin/env node
// Kit mapping helpers.
//
//   mpc-kit audition                       play pads 1-16 in turn, announcing each
//   mpc-kit audition --gap 1500 --to 8     slower, first eight pads only
//   mpc-kit pad 7                          play one pad
//   mpc-kit save kick=1,snare=4,hat=9 --out kits/mine.json
//
// The role -> pad map in src/pads.mjs is a convention, not something read off
// the hardware. Audition the pads, note what each one actually is, then save a
// kit file and pass it with `mpc-seq --kit`.

import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { padToNote, PAD_COUNT, DEFAULT_KIT } from '../src/pads.mjs';
import { toMpcmidi } from '../src/schedule.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MPCMIDI = resolve(here, '../tools/midi/mpcmidi');

const USAGE = `usage: mpc-kit <command> [options]

  audition            play each pad in turn, announcing it as it sounds
    --gap MS          time between pads (default 1000)
    --from N --to N   pad range (default 1-16)
  pad N               play a single pad
  save SPEC           write a kit file, e.g. kick=1,snare=4,hat=9
    --out FILE        destination (default kits/custom.json)

  --port NAME         MIDI destination (default "MPC Sample")
  --velocity N        how hard to hit (default 110)`;

function parseArgs(argv) {
  const o = { port: 'MPC Sample', gap: 1000, from: 1, to: PAD_COUNT, velocity: 110 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') o.port = argv[++i];
    else if (a === '--gap') o.gap = Number(argv[++i]);
    else if (a === '--from') o.from = Number(argv[++i]);
    else if (a === '--to') o.to = Number(argv[++i]);
    else if (a === '--velocity') o.velocity = Number(argv[++i]);
    else if (a === '--out') o.out = argv[++i];
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else rest.push(a);
  }
  return { o, rest };
}

function play(events, port) {
  const child = spawn(MPCMIDI, ['play', port], { stdio: ['pipe', 'inherit', 'inherit'] });
  child.on('error', (e) => {
    console.error(`could not run ${MPCMIDI}: ${e.message}\nBuild it first: cd tools/midi && make`);
    process.exit(1);
  });
  child.stdin.write(toMpcmidi(events));
  child.stdin.end();
  return child;
}

let o, rest;
try { ({ o, rest } = parseArgs(process.argv.slice(2))); }
catch (e) { console.error(`mpc-kit: ${e.message}`); process.exit(2); }

if (o.help || !rest.length) { console.log(USAGE); process.exit(o.help ? 0 : 2); }

const cmd = rest[0];

if (cmd === 'audition') {
  if (o.from < 1 || o.to > PAD_COUNT || o.from > o.to) {
    console.error(`mpc-kit: pad range must sit within 1-${PAD_COUNT}`);
    process.exit(2);
  }
  const events = [];
  const schedule = [];
  let t = 0;
  for (let pad = o.from; pad <= o.to; pad++) {
    const note = padToNote(pad);
    events.push({ ms: t, bytes: [0x90, note, o.velocity] });
    events.push({ ms: t + 120, bytes: [0x80, note, 0] });
    schedule.push({ pad, note, at: t });
    t += o.gap;
  }

  console.error(`auditioning pads ${o.from}-${o.to} — listen and note what each one is\n`);
  play(events, o.port);

  // Announce each pad as it sounds. The 100ms offset matches the scheduler's
  // lead-in, so the printed line lands with the sound rather than ahead of it.
  for (const { pad, note, at } of schedule) {
    setTimeout(() => {
      const role = Object.entries(DEFAULT_KIT).find(([, p]) => p === pad)?.[0] ?? '—';
      console.log(`pad ${String(pad).padStart(2)}   note ${note}   currently mapped as: ${role}`);
    }, at + 100);
  }
  setTimeout(() => {
    console.log('\nSave what you heard:  mpc-kit save kick=1,snare=4,... --out kits/mine.json');
  }, t + 200);

} else if (cmd === 'pad') {
  const pad = Number(rest[1]);
  if (!Number.isInteger(pad) || pad < 1 || pad > PAD_COUNT) {
    console.error(`mpc-kit: pad must be 1-${PAD_COUNT}`);
    process.exit(2);
  }
  const note = padToNote(pad);
  console.error(`pad ${pad} (note ${note})`);
  play([{ ms: 0, bytes: [0x90, note, o.velocity] }, { ms: 120, bytes: [0x80, note, 0] }], o.port);

} else if (cmd === 'save') {
  const spec = rest[1];
  if (!spec) { console.error('mpc-kit: save needs a spec, e.g. kick=1,snare=4'); process.exit(2); }
  const kit = {};
  for (const part of spec.split(/[,\s]+/).filter(Boolean)) {
    const m = /^([A-Za-z][\w]*)=(\d+)$/.exec(part);
    if (!m) { console.error(`mpc-kit: bad mapping "${part}" — expected name=pad`); process.exit(2); }
    const pad = Number(m[2]);
    if (pad < 1 || pad > PAD_COUNT) { console.error(`mpc-kit: pad ${pad} out of range`); process.exit(2); }
    kit[m[1]] = pad;
  }
  const out = o.out ?? 'kits/custom.json';
  writeFileSync(out, JSON.stringify(kit, null, 2) + '\n');
  console.log(`wrote ${out}:\n${JSON.stringify(kit, null, 2)}`);
  console.log(`\nUse it:  mpc-seq --style boom-bap --kit ${out}`);

} else {
  console.error(`mpc-kit: unknown command "${cmd}"\n\n${USAGE}`);
  process.exit(2);
}
