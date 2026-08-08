#!/usr/bin/env node
// Renders a drum pattern and plays it on the MPC Sample.
//
//   bin/mpc-seq.mjs patterns/boom-bap.json
//   bin/mpc-seq.mjs patterns/boom-bap.json --bpm 96 --repeats 4
//   bin/mpc-seq.mjs patterns/boom-bap.json --dry-run
//
// A pattern file is JSON matching the spec accepted by pattern(), plus optional
// "repeats", "kit", "channel" and "gateMs" keys.

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { pattern, patternMs } from '../src/pattern.mjs';
import { render, toMpcmidi } from '../src/schedule.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MPCMIDI = resolve(here, '../tools/midi/mpcmidi');

function parseArgs(argv) {
  const opts = { port: 'MPC Sample', dryRun: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--bpm') opts.bpm = Number(argv[++i]);
    else if (a === '--repeats') opts.repeats = Number(argv[++i]);
    else if (a === '--port') opts.port = argv[++i];
    else if (a === '--seed') opts.seed = Number(argv[++i]);
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else rest.push(a);
  }
  return { opts, rest };
}

const { opts, rest } = parseArgs(process.argv.slice(2));
if (!rest.length) {
  console.error('usage: mpc-seq <pattern.json> [--bpm N] [--repeats N] [--port NAME] [--seed N] [--dry-run]');
  process.exit(2);
}

const spec = JSON.parse(readFileSync(rest[0], 'utf8'));
if (opts.bpm) spec.bpm = opts.bpm;

const p = pattern(spec);
const events = render(p, {
  repeats: opts.repeats ?? spec.repeats ?? 1,
  kit: spec.kit,
  channel: spec.channel ?? 1,
  gateMs: spec.gateMs ?? 40,
  seed: opts.seed ?? spec.seed ?? 1,
});

const bars = (p.length / p.stepsPerBeat / 4).toFixed(2);
const repeats = opts.repeats ?? spec.repeats ?? 1;
console.error(
  `${p.bpm} bpm · ${p.length} steps (${bars} bars) · ${Object.keys(p.tracks).length} tracks · ` +
  `${repeats}x · ${events.length} events · ${((patternMs(p) * repeats) / 1000).toFixed(1)}s`,
);

const text = toMpcmidi(events);
if (opts.dryRun) { process.stdout.write(text); process.exit(0); }

const child = spawn(MPCMIDI, ['play', opts.port], { stdio: ['pipe', 'inherit', 'inherit'] });
child.on('error', (e) => {
  console.error(`could not run ${MPCMIDI}: ${e.message}\nBuild it first: cd tools/midi && make`);
  process.exit(1);
});
child.stdin.write(text);
child.stdin.end();
child.on('exit', (code) => process.exit(code ?? 0));
