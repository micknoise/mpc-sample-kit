#!/usr/bin/env node
// Live algorithmic performance: generates bars continuously and streams them to
// the MPC, so the groove can be steered while it plays.
//
//   mpc-live --style boom-bap
//   mpc-live --style techno --drift 0.5 --bpm 130
//
// Type commands while it runs:
//   drift 0.6      how far variations stray
//   bpm 128        tempo, applies from the next bar
//   dyn 0.7        how much metric position shapes volume
//   conf 0.6       proportion of hits following the metre
//   lock kick,hat  hold tracks steady (or "lock none")
//   fill           fill on the next bar
//   voice 0.5      how often an alternate voice (rim, clap) is substituted
//   decol 0.8      how often kick/snare collisions on the beat are broken up
//   shape descend  fill vocabulary: descend, linear, triplet, herta, sparse, roll, auto
//   seed 42        reseed the variation stream
//   ?              show current state
//   quit           stop cleanly
//
// The scheduler hands CoreMIDI absolute timestamps, so timing does not depend on
// this process being scheduled promptly. It only has to stay far enough ahead;
// the look-ahead window is what buys that slack.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

import { pattern, patternMs } from '../src/pattern.mjs';
import { render, toMpcmidi } from '../src/schedule.mjs';
import { style, styleNames } from '../src/generate.mjs';
import { barPattern } from '../src/arrange.mjs';
import { DEFAULT_KIT } from '../src/pads.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MPCMIDI = resolve(here, '../tools/midi/mpcmidi');

const USAGE = `usage: mpc-live [pattern.json] [options]

  --style NAME       start from a style preset
  --bpm N            tempo
  --drift F          0-1, how far variations stray (default 0.3)
  --fill-every N     fill on every Nth bar, 0 to disable (default 4)
  --lock a,b         tracks held steady (default none)
  --dynamics D       0-1, how much metre shapes volume (default 0.45)
  --conformity C     0-1, proportion of hits following the metre (default 0.8)
  --kit FILE         role->pad map
  --seed N           starting seed
  --lookahead MS     how far ahead to schedule (default 2000)
  --port NAME        MIDI destination (default "MPC Sample")`;

function parseArgs(argv) {
  const o = { port: 'MPC Sample', drift: 0.3, fillEvery: 4, lock: [], seed: 1, lookahead: 2000 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--style') o.style = argv[++i];
    else if (a === '--port') o.port = argv[++i];
    else if (a === '--kit') o.kit = argv[++i];
    else if (a === '--lock') o.lock = argv[++i].split(/[,\s]+/).filter(Boolean);
    else if (a === '--bpm') o.bpm = Number(argv[++i]);
    else if (a === '--drift') o.drift = Number(argv[++i]);
    else if (a === '--fill-every') o.fillEvery = Number(argv[++i]);
    else if (a === '--dynamics') o.dynamics = Number(argv[++i]);
    else if (a === '--conformity') o.conformity = Number(argv[++i]);
    else if (a === '--seed') o.seed = Number(argv[++i]);
    else if (a === '--voice-spread') o.voiceSpread = Number(argv[++i]);
    else if (a === '--decollide') o.decollide = Number(argv[++i]);
    else if (a === '--fill-shape') o.fillShape = argv[++i];
    else if (a === '--lookahead') o.lookahead = Number(argv[++i]);
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else rest.push(a);
  }
  return { o, rest };
}

let o, rest;
try { ({ o, rest } = parseArgs(process.argv.slice(2))); }
catch (e) { console.error(`mpc-live: ${e.message}`); process.exit(2); }

if (o.help) { console.log(USAGE); process.exit(0); }

let spec;
try {
  if (rest.length) spec = JSON.parse(readFileSync(rest[0], 'utf8'));
  else if (o.style) spec = style(o.style);
  else { console.error(`${USAGE}\n\nstyles: ${styleNames().join(', ')}`); process.exit(2); }
  if (o.bpm) spec.bpm = o.bpm;
  if (o.kit) spec.kit = { ...DEFAULT_KIT, ...JSON.parse(readFileSync(o.kit, 'utf8')) };
  spec.dynamics = { ...spec.dynamics };
  if (o.dynamics !== undefined) spec.dynamics.depth = o.dynamics;
  if (o.conformity !== undefined) spec.dynamics.conformity = o.conformity;
} catch (e) { console.error(`mpc-live: ${e.message}`); process.exit(1); }

// Mutable performance state, steered by the command line below.
const state = {
  base: pattern(spec),
  drift: o.drift,
  fillEvery: o.fillEvery,
  lock: o.lock.length ? o.lock : (spec.lock ?? []),
  seed: o.seed,
  voiceSpread: o.voiceSpread ?? 0.35,
  decollide: o.decollide ?? 0.6,
  fillShape: o.fillShape ?? 'auto',
  forceFill: false,
  bar: 0,
};

const child = spawn(MPCMIDI, ['play', o.port], { stdio: ['pipe', 'inherit', 'inherit'] });
child.on('error', (e) => {
  console.error(`could not run ${MPCMIDI}: ${e.message}\nBuild it first: cd tools/midi && make`);
  process.exit(1);
});

const t0 = Date.now();
let cursor = 0;         // ms from playback start that we have generated up to
let stopping = false;

function nextBar() {
  const { base, drift, fillEvery, lock, seed, bar } = state;
  const isFill = state.forceFill || (fillEvery > 0 && (bar + 1) % fillEvery === 0);

  const p = barPattern(base, bar, {
    drift, fillEvery, lock, seed,
    forceFill: state.forceFill,
    decollideStrength: state.decollide,
    fillShape: state.fillShape,
    fillShapes: spec.fillShapes,
    kit: spec.kit,
  });
  state.forceFill = false;

  const events = render(p, {
    kit: spec.kit,
    voiceSpread: state.voiceSpread,
    channel: spec.channel ?? 1,
    gateMs: spec.gateMs ?? 40,
    seed: seed + bar,
    startMs: cursor,
  });

  cursor += patternMs(p);
  state.bar++;
  return { events, isFill };
}

// Keep the generated edge at least `lookahead` ms ahead of real time. Checking
// more often than a bar means a tempo or drift change lands quickly rather than
// waiting for a long buffer to drain.
const timer = setInterval(() => {
  if (stopping) return;
  const elapsed = Date.now() - t0;
  while (cursor < elapsed + o.lookahead) {
    const { events, isFill } = nextBar();
    if (!child.stdin.writable) return;
    child.stdin.write(toMpcmidi(events));
    process.stdout.write(`bar ${String(state.bar).padStart(3)}${isFill ? '  fill' : ''}\r`);
  }
}, 100);

// ------------------------------------------------------------------ commands

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '' });

function showState() {
  console.log(
    `\n  bpm ${state.base.bpm}  drift ${state.drift}  fill every ${state.fillEvery}  ` +
    `dyn ${state.base.dynamics.depth}/${state.base.dynamics.conformity}  ` +
    `lock [${state.lock.join(',') || 'none'}]  voice ${state.voiceSpread}  ` +
    `decol ${state.decollide}  fill ${state.fillShape}  seed ${state.seed}  bar ${state.bar}`,
  );
}

function rebuild(changes) {
  state.base = pattern({
    ...spec, ...changes,
    dynamics: { ...state.base.dynamics, ...(changes.dynamics ?? {}) },
    tracks: spec.tracks,
  });
}

rl.on('line', (line) => {
  const [cmd, arg] = line.trim().split(/\s+/);
  const n = Number(arg);
  try {
    switch (cmd) {
      case '': break;
      case 'drift': state.drift = n; break;
      case 'bpm': spec.bpm = n; rebuild({ bpm: n }); break;
      case 'dyn': rebuild({ dynamics: { depth: n } }); break;
      case 'conf': rebuild({ dynamics: { conformity: n } }); break;
      case 'seed': state.seed = n; break;
      case 'voice': state.voiceSpread = n; break;
      case 'decol': state.decollide = n; break;
      case 'shape': state.fillShape = arg || 'auto'; break;
      case 'fill': state.forceFill = true; break;
      case 'lock': state.lock = arg === 'none' || !arg ? [] : arg.split(','); break;
      case '?': showState(); break;
      case 'quit': case 'q': shutdown(); return;
      default: console.log(`unknown command "${cmd}" — try: drift, bpm, dyn, conf, lock, fill, shape, voice, decol, seed, ?, quit`);
    }
    if (cmd && cmd !== '?' && cmd !== 'quit') showState();
  } catch (e) {
    console.log(`bad command: ${e.message}`);
  }
});

function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  rl.close();

  // Let everything already scheduled play out, then silence any hanging notes.
  const tailMs = Math.max(0, cursor - (Date.now() - t0));
  const allNotesOff = [{ ms: cursor + 10, bytes: [0xb0, 0x7b, 0x00] }];
  if (child.stdin.writable) {
    child.stdin.write(toMpcmidi(allNotesOff));
    child.stdin.end();
  }
  console.log(`\nstopping — ${(tailMs / 1000).toFixed(1)}s left to play out`);
  child.on('exit', () => process.exit(0));
}

process.on('SIGINT', shutdown);

console.log(`live: ${o.style ?? rest[0]} at ${state.base.bpm} bpm — type ? for state, quit to stop`);
showState();
