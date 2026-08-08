// Browser glue for the SoundFont output.
//
// Everything that knows the player is SpessaSynth specifically lives here, so
// src/soundfont.mjs stays a plain MIDI-shaped adapter over an injected engine
// and the library can be swapped without touching it.
//
// Imported dynamically by the app, which keeps the ~800KB of vendored player
// off the page until someone actually asks for the SoundFont output. The bare
// "spessasynth_lib" specifier is resolved by the import map in index.html —
// there is no build step here, and there is not going to be one.

import { WorkletSynthesizer } from 'spessasynth_lib';
import { createSoundfontOutput, drumKits } from '../src/soundfont.mjs';

/**
 * Fetches with progress, because a 32MB bank on a slow connection with no
 * feedback is indistinguishable from a page that has hung.
 *
 * Falls back to a plain arrayBuffer() where the response is not streamable or
 * declares no length — progress is a nicety, the download is not.
 */
async function fetchWithProgress(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`soundfont ${response.status} ${response.statusText}`);

  const total = Number(response.headers.get('content-length')) || 0;
  if (!total || !response.body?.getReader) return response.arrayBuffer();

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }

  // One copy into a contiguous buffer; the parser needs an ArrayBuffer anyway.
  const buffer = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  return buffer.buffer;
}

/**
 * Loads a sound bank and returns an output that looks like a MIDI port.
 *
 * @param {AudioContext} context   already resumed
 * @param {object} opts
 * @param {string} opts.soundfontUrl
 * @param {string} opts.workletUrl  the vendored processor, added to the worklet
 * @param {string} [opts.name]      what to call it in the port list
 * @param {number} [opts.gain]      output level, set to match the built-in synth
 * @param {function} [opts.onProgress] (loaded, total) in bytes
 * @returns {Promise<{output:object, synth:object, kits:Array<{program:number,name:string}>}>}
 */
export async function loadSoundfontOutput(context, opts) {
  const { soundfontUrl, workletUrl, name, onProgress, gain = 2.2 } = opts;

  // The processor has to be registered before the node that uses it exists.
  // Adding the same module twice is harmless, so this needs no guard.
  await context.audioWorklet.addModule(workletUrl);

  const bank = await fetchWithProgress(soundfontUrl, onProgress);

  const synth = new WorkletSynthesizer(context);
  await synth.soundBankManager.addSoundBank(bank, 'main');
  await synth.isReady;

  // Levelled against the built-in synth, which came out around 12dB louder on
  // the same pattern. Switching output to compare the two should be a
  // comparison of sound, not of volume. Measured to stay clear of clipping
  // through a fill; the limiter after it catches the rest.
  const level = context.createGain();
  level.gain.value = gain;
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 3;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.15;

  synth.connect(level);
  level.connect(limiter);
  limiter.connect(context.destination);

  return {
    synth,
    output: createSoundfontOutput(context, synth, { name }),
    kits: drumKits(synth.presetList),
  };
}
