#!/usr/bin/env node
// Generates, transforms and plays drum patterns on the MPC Sample.
//
//   mpc-seq --style boom-bap --bars 8
//   mpc-seq --euclid "kick=4/16,snare=2/16@4,hat=7/16" --bpm 128
//   mpc-seq patterns/boom-bap.json --bars 16 --drift 0.4 --fill-every 4
//   mpc-seq --style techno --bars 8 --dry-run
//
// Every stochastic step is seeded, so a given --seed always renders identically.

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { pattern, patternMs } from '../src/pattern.mjs';
import { render, toMpcmidi } from '../src/schedule.mjs';
import { style, styleNames, euclidTrack } from '../src/generate.mjs';
import { ratchetPattern } from '../src/transform.mjs';
import { arrange, arrangementMs, evolve } from '../src/arrange.mjs';
import { withClock } from '../src/clock.mjs';
import { DEFAULT_KIT } from '../src/pads.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MPCMIDI = resolve(here, '../tools/midi/mpcmidi');

const USAGE = `usage: mpc-seq [pattern.json] [options]

source (pick one, or combine a file with overrides)
  --style NAME         start from a style preset
  --euclid SPEC        euclidean tracks, e.g. "kick=4/16,snare=2/16@4,hat=7/16"
  --list-styles        show available styles and exit

shape
  --bpm N              tempo
  --swing F            0-1, delay of every second step (musical: 0.1-0.3)
  --ratchet P          0-1, probability of a hit becoming a roll

dynamics
  --dynamics D         0-1, how much metric position shapes volume (default 0.45)
  --conformity C       0-1, proportion of hits following the metre (default 0.8);
                       the remainder are displaced onto weak steps
  --no-anchor          allow beat 1 itself to be de-accented, dissolving the pulse

kit and sync
  --kit FILE|SPEC      role->pad map, a .json file or "kick=1,snare=4,hat=9"
  --sync               send MIDI clock and transport alongside the notes

arrangement
  --bars N             evolve into an N-bar phrase instead of looping
  --drift F            0-1, how far variations stray (default 0.25)
  --fill-every N       fill on every Nth bar, 0 to disable (default 4)
  --lock a,b           tracks to hold steady while others vary (default kick)
  --repeats N          plain loop count when --bars is not used

  --seed N             seed for all randomness
  --port NAME          MIDI destination (default "MPC Sample")
  --dry-run            print the event list instead of playing`;

function parseArgs(argv) {
  const o = { port: 'MPC Sample' };
  const rest = [];
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${name} expects a number, got "${v}"`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry-run': o.dryRun = true; break;
      case '--list-styles': o.listStyles = true; break;
      case '--sync': o.sync = true; break;
      case '--no-anchor': o.anchorDownbeat = false; break;
      case '--kit': o.kit = argv[++i]; break;
      case '--dynamics': o.dynamics = num(argv[++i], a); break;
      case '--conformity': o.conformity = num(argv[++i], a); break;
      case '--style': o.style = argv[++i]; break;
      case '--euclid': o.euclid = argv[++i]; break;
      case '--port': o.port = argv[++i]; break;
      case '--lock': o.lock = argv[++i].split(/[,\s]+/).filter(Boolean); break;
      case '--bpm': o.bpm = num(argv[++i], a); break;
      case '--swing': o.swing = num(argv[++i], a); break;
      case '--ratchet': o.ratchet = num(argv[++i], a); break;
      case '--bars': o.bars = num(argv[++i], a); break;
      case '--drift': o.drift = num(argv[++i], a); break;
      case '--fill-every': o.fillEvery = num(argv[++i], a); break;
      case '--repeats': o.repeats = num(argv[++i], a); break;
      case '--seed': o.seed = num(argv[++i], a); break;
      case '-h': case '--help': o.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
        rest.push(a);
    }
  }
  return { o, rest };
}

/**
 * Accepts either a path to a kit .json or an inline "kick=1,snare=4" spec.
 *
 * Merged over the default map rather than replacing it, so naming two pads does
 * not silently orphan every other track in the pattern.
 */
function loadKit(arg) {
  if (arg.includes('=')) {
    const kit = {};
    for (const part of arg.split(/[,\s]+/).filter(Boolean)) {
      const m = /^([A-Za-z][\w]*)=(\d+)$/.exec(part);
      if (!m) throw new Error(`bad kit mapping "${part}" — expected name=pad`);
      kit[m[1]] = Number(m[2]);
    }
    return { ...DEFAULT_KIT, ...kit };
  }
  return { ...DEFAULT_KIT, ...JSON.parse(readFileSync(arg, 'utf8')) };
}

/** "kick=4/16,snare=2/16@4,hat=7/16" -> { kick: [...], snare: [...] } */
function parseEuclid(spec) {
  const tracks = {};
  for (const part of spec.split(/[,\s]+/).filter(Boolean)) {
    const m = /^([A-Za-z][\w]*)=(\d+)\/(\d+)(?:@(-?\d+))?$/.exec(part);
    if (!m) throw new Error(`bad euclid spec "${part}" — expected name=pulses/steps[@rotation]`);
    const [, name, pulses, steps, rot] = m;
    tracks[name] = euclidTrack(Number(pulses), Number(steps), {
      rotation: Number(rot ?? 0),
      accentEvery: 4,
    });
  }
  return tracks;
}

let o, rest;
try { ({ o, rest } = parseArgs(process.argv.slice(2))); }
catch (e) { console.error(`mpc-seq: ${e.message}`); process.exit(2); }

if (o.help) { console.log(USAGE); process.exit(0); }
if (o.listStyles) { console.log(styleNames().join('\n')); process.exit(0); }

let spec;
try {
  if (rest.length) spec = JSON.parse(readFileSync(rest[0], 'utf8'));
  else if (o.style) spec = style(o.style);
  else if (o.euclid) spec = { bpm: 120, tracks: {} };
  else { console.error(USAGE); process.exit(2); }

  if (o.euclid) spec.tracks = { ...spec.tracks, ...parseEuclid(o.euclid) };
  if (o.bpm !== undefined) spec.bpm = o.bpm;
  if (o.swing !== undefined) spec.swing = o.swing;
  if (o.kit) spec.kit = loadKit(o.kit);

  spec.dynamics = { ...spec.dynamics };
  if (o.dynamics !== undefined) spec.dynamics.depth = o.dynamics;
  if (o.conformity !== undefined) spec.dynamics.conformity = o.conformity;
  if (o.anchorDownbeat === false) spec.dynamics.anchorDownbeat = false;

  let p = pattern(spec);
  if (o.ratchet) p = ratchetPattern(p, { rollProb: o.ratchet, rand: undefined });

  const seed = o.seed ?? spec.seed ?? 1;
  const renderOpts = {
    kit: spec.kit,
    channel: spec.channel ?? 1,
    gateMs: spec.gateMs ?? 40,
    seed,
  };

  let events, totalMs, label;
  if (o.bars) {
    const sections = evolve(p, {
      bars: o.bars,
      drift: o.drift ?? 0.25,
      fillEvery: o.fillEvery ?? 4,
      lock: o.lock ?? ['kick'],
      seed,
    });
    events = arrange(sections, renderOpts);
    totalMs = arrangementMs(sections);
    label = `${o.bars} bars evolving (drift ${o.drift ?? 0.25}, fill every ${o.fillEvery ?? 4})`;
  } else {
    const repeats = o.repeats ?? spec.repeats ?? 1;
    events = render(p, { ...renderOpts, repeats });
    totalMs = patternMs(p) * repeats;
    label = `${repeats}x loop`;
  }

  if (o.sync) events = withClock(events, p.bpm, totalMs);

  const dyn = p.dynamics;
  console.error(
    `${p.bpm} bpm · ${p.length} steps · ${Object.keys(p.tracks).length} tracks · ` +
    `${label} · dyn ${dyn.depth}/${dyn.conformity}${dyn.anchorDownbeat ? '' : ' unanchored'}` +
    `${o.sync ? ' · +clock' : ''} · ${events.length} events · ${(totalMs / 1000).toFixed(1)}s`,
  );

  const text = toMpcmidi(events);
  if (o.dryRun) { process.stdout.write(text); process.exit(0); }

  const child = spawn(MPCMIDI, ['play', o.port], { stdio: ['pipe', 'inherit', 'inherit'] });
  child.on('error', (e) => {
    console.error(`could not run ${MPCMIDI}: ${e.message}\nBuild it first: cd tools/midi && make`);
    process.exit(1);
  });
  child.stdin.write(text);
  child.stdin.end();
  child.on('exit', (code) => process.exit(code ?? 0));
} catch (e) {
  console.error(`mpc-seq: ${e.message}`);
  process.exit(1);
}
