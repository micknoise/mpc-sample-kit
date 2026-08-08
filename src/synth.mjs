// A General MIDI drum kit synthesised in the browser.
//
// The fallback of last resort. Selecting a GM note map (see gm.mjs) makes the
// patterns playable on any GM device, but that still assumes there *is* a
// device: on a laptop with nothing plugged in, Web MIDI enumerates no outputs
// at all and the page has nothing to drive. So the kit is synthesised here
// instead, and the app always makes a sound.
//
// The object returned looks like a Web MIDI output — `send(bytes, at)`,
// `clear()`, `id`, `name` — so it drops into the same slot as a real port and
// nothing downstream (transport, scheduler, record) knows the difference.
//
// Timing is the reason this is worth having beyond "something to hear": voices
// are scheduled directly on the audio clock, which is sample-accurate. It is
// the most punctual output in the app, better than either MIDI path, since
// there is no port, no bridge and no timer between the schedule and the sound.
//
// The voices are synthesised rather than sampled — no assets, no network, and
// the whole thing stays a static page. They are recognisably the GM
// instruments, not replacements for the MPC's samples.

import { contextTimeFor } from './audioclock.mjs';

/** Ratios of a classic six-oscillator metallic tone, used for hats and cymbals. */
const METAL_RATIOS = [2, 3, 4.16, 5.43, 6.79, 8.21];

/** Two seconds of white noise, reused by every noise voice. */
function makeNoiseBuffer(context) {
  const length = Math.floor(context.sampleRate * 2);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/**
 * Builds a MIDI-output-shaped drum synth on an existing AudioContext.
 *
 * @param {AudioContext} context   already resumed — iOS requires a user gesture
 * @param {object} [opts]
 * @param {number} [opts.gain]     master level, 0-1
 * @param {function} [opts.now]    performance clock, injectable for tests
 * @returns {{id:string, name:string, kind:string, send:function, clear:function, close:function}}
 */
export function createSynthOutput(context, opts = {}) {
  const {
    id = 'internal-synth',
    name = 'Built-in synth — General MIDI',
    gain = 0.7,
    now = () => performance.now(),
  } = opts;

  const master = context.createGain();
  master.gain.value = gain;

  // Sixteen drum voices hitting at once will clip an unprotected output, and a
  // fill is exactly that. The compressor is doing limiter duty, not colouring.
  let tail = master;
  if (typeof context.createDynamicsCompressor === 'function') {
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    master.connect(limiter);
    tail = limiter;
  }
  tail.connect(context.destination);

  const noiseBuffer = makeNoiseBuffer(context);

  // Everything scheduled and not yet finished, so Stop can cut the look-ahead.
  // Without this, stopping mid-phrase would still play out the few hundred
  // milliseconds already queued — the same problem output.clear() solves for a
  // real MIDI port.
  const live = new Set();

  function track(node) {
    live.add(node);
    node.onended = () => live.delete(node);
  }

  function begin(node, at, duration, offset = 0) {
    node.start(at, offset);
    node.stop(at + duration);
    track(node);
  }

  // ------------------------------------------------------------ building blocks

  /**
   * A percussive amplitude envelope.
   *
   * Exponential rather than linear because that is how a struck drum decays,
   * and because a linear ramp to zero is audible as a click on short voices.
   * Ramps cannot reach true zero, hence the small floor.
   */
  function env(at, { peak, attack = 0.002, hold = 0, decay }) {
    const g = context.createGain();
    const top = Math.max(0.0005, peak);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(top, at + attack);
    if (hold) g.gain.setValueAtTime(top, at + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + hold + decay);
    return g;
  }

  function noise(at, duration, playbackRate = 1) {
    const source = context.createBufferSource();
    source.buffer = noiseBuffer;
    source.loop = true;
    source.playbackRate.value = playbackRate;
    // A random read offset stops repeated hits being bit-identical, which is
    // what makes a fast hat pattern sound like a machine rather than a loop.
    begin(source, at, duration, Math.random() * (noiseBuffer.duration - 0.1));
    return source;
  }

  function osc(type, freq, at, duration) {
    const o = context.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, at);
    begin(o, at, duration);
    return o;
  }

  function filter(type, freq, q = 1) {
    const f = context.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  const chain = (...nodes) => {
    nodes.reduce((from, to) => (from.connect(to), to));
    nodes[nodes.length - 1].connect(master);
  };

  // ------------------------------------------------------------------- voices

  function drum(at, amp, { from, to, bend = 0.09, decay, type = 'sine', click = 0 }) {
    const o = osc(type, from, at, decay + 0.1);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + bend);
    chain(o, env(at, { peak: amp, decay }));
    if (click) {
      chain(noise(at, 0.03), filter('highpass', 1200), env(at, { peak: amp * click, attack: 0.001, decay: 0.015 }));
    }
  }

  function metal(at, amp, { decay, highpass, base = 40, bandpass = 0 }) {
    const out = env(at, { peak: amp, attack: 0.001, decay });
    const hp = filter('highpass', highpass);
    for (const ratio of METAL_RATIOS) {
      const o = osc('square', base * ratio, at, decay + 0.1);
      o.connect(hp);
    }
    if (bandpass) {
      const bp = filter('bandpass', bandpass, 0.7);
      hp.connect(bp); bp.connect(out);
    } else {
      hp.connect(out);
    }
    out.connect(master);
  }

  // Levels are set against the kick by ear on the rendered output, not left at
  // whatever each synthesis method happens to produce. A noise voice measures
  // far quieter than a tuned one at the same peak, so matching the numbers is
  // what puts the backbeat under the kick rather than 15dB below it.
  function snare(at, amp, { tone = 190, decay = 0.16, bright = 1900 }) {
    chain(noise(at, decay + 0.05), filter('bandpass', bright, 0.7), env(at, { peak: amp * 1.6, decay }));
    for (const f of [tone, tone * 1.74]) {
      chain(osc('triangle', f, at, decay), env(at, { peak: amp * 0.45, decay: decay * 0.7 }));
    }
  }

  /**
   * A hand clap is several hands slightly out of step, then a room.
   *
   * Three short bursts a few milliseconds apart followed by a longer tail —
   * without the stagger it is just a noise blip and reads as a snare.
   */
  function clap(at, amp) {
    for (const [offset, level] of [[0, 1.6], [0.011, 1.3], [0.023, 1]]) {
      chain(noise(at + offset, 0.02), filter('bandpass', 1100, 1.2),
        env(at + offset, { peak: amp * level, attack: 0.001, decay: 0.018 }));
    }
    chain(noise(at + 0.03, 0.16), filter('bandpass', 1000, 0.9),
      env(at + 0.03, { peak: amp * 0.9, attack: 0.002, decay: 0.13 }));
  }

  function shaker(at, amp, { decay = 0.06, freq = 6000 }) {
    chain(noise(at, decay + 0.05), filter('highpass', freq),
      env(at, { peak: amp * 0.9, attack: 0.004, decay }));
  }

  function cowbell(at, amp) {
    const out = env(at, { peak: amp * 0.7, attack: 0.001, decay: 0.28 });
    const bp = filter('bandpass', 2640, 1.2);
    for (const f of [587, 845]) osc('square', f, at, 0.4).connect(bp);
    bp.connect(out); out.connect(master);
  }

  function woodblock(at, amp, freq) {
    chain(osc('sine', freq, at, 0.05), env(at, { peak: amp * 0.9, attack: 0.001, decay: 0.03 }));
    chain(noise(at, 0.01), filter('highpass', 3000), env(at, { peak: amp * 0.2, attack: 0.001, decay: 0.008 }));
  }

  const tom = (freq, decay) => (at, amp) =>
    drum(at, amp, { from: freq * 1.6, to: freq, bend: 0.07, decay, click: 0.15 });

  const hand = (freq, decay) => (at, amp) =>
    drum(at, amp, { from: freq * 1.3, to: freq, bend: 0.03, decay, click: 0.25 });

  /**
   * Note to voice.
   *
   * The whole GM percussion range is covered so that a kit map pointing
   * anywhere in 35-81 makes the sound its name promises. Notes outside it fall
   * back to a pitched blip rather than to silence — a wrong note should be
   * audible, since silence is indistinguishable from a broken output.
   */
  const VOICES = {
    35: (at, a) => drum(at, a, { from: 120, to: 42, decay: 0.4, click: 0.1 }),
    36: (at, a) => drum(at, a, { from: 150, to: 48, decay: 0.32, click: 0.25 }),
    37: (at, a) => {                                   // side stick
      chain(osc('triangle', 1700, at, 0.04), env(at, { peak: a * 0.9, attack: 0.001, decay: 0.02 }));
      chain(noise(at, 0.02), filter('bandpass', 2400, 3), env(at, { peak: a * 1.2, attack: 0.001, decay: 0.015 }));
    },
    38: (at, a) => snare(at, a, {}),
    39: clap,
    40: (at, a) => snare(at, a, { tone: 240, decay: 0.12, bright: 2600 }),
    41: tom(90, 0.36),
    42: (at, a) => { metal(at, a * 0.55, { decay: 0.045, highpass: 7000 }); shaker(at, a * 1.3, { decay: 0.035, freq: 9000 }); },
    43: tom(110, 0.34),
    44: (at, a) => { metal(at, a * 0.45, { decay: 0.09, highpass: 6500 }); shaker(at, a * 1.0, { decay: 0.06, freq: 8000 }); },
    45: tom(140, 0.3),
    46: (at, a) => { metal(at, a * 0.45, { decay: 0.4, highpass: 6500 }); shaker(at, a * 0.8, { decay: 0.3, freq: 8000 }); },
    47: tom(175, 0.28),
    48: tom(215, 0.26),
    49: (at, a) => { metal(at, a * 0.2, { decay: 1.5, highpass: 3500 }); shaker(at, a * 0.32, { decay: 1.3, freq: 4000 }); },
    50: tom(260, 0.24),
    51: (at, a) => { metal(at, a * 0.3, { decay: 0.9, highpass: 5500 }); shaker(at, a * 0.38, { decay: 0.5, freq: 7000 }); },
    52: (at, a) => { metal(at, a * 0.2, { decay: 1.1, highpass: 2600 }); shaker(at, a * 0.3, { decay: 0.9, freq: 3200 }); },
    53: (at, a) => metal(at, a * 0.4, { decay: 0.55, highpass: 3000, bandpass: 3400 }),
    54: (at, a) => {                                   // tambourine
      chain(noise(at, 0.16), filter('bandpass', 6500, 1.1), env(at, { peak: a * 1.4, attack: 0.002, decay: 0.13 }));
      metal(at, a * 0.25, { decay: 0.12, highpass: 8000, base: 55 });
    },
    55: (at, a) => { metal(at, a * 0.22, { decay: 0.6, highpass: 5000 }); shaker(at, a * 0.4, { decay: 0.5, freq: 5500 }); },
    56: cowbell,
    57: (at, a) => { metal(at, a * 0.2, { decay: 1.3, highpass: 3200 }); shaker(at, a * 0.32, { decay: 1.1, freq: 3800 }); },
    58: (at, a) => {                                   // vibraslap
      chain(noise(at, 0.5, 0.6), filter('bandpass', 2200, 2), env(at, { peak: a * 0.5, attack: 0.005, decay: 0.45 }));
    },
    59: (at, a) => { metal(at, a * 0.28, { decay: 0.8, highpass: 5000 }); shaker(at, a * 0.34, { decay: 0.45, freq: 6500 }); },
    60: hand(310, 0.16),
    61: hand(230, 0.18),
    62: (at, a) => drum(at, a, { from: 260, to: 250, bend: 0.01, decay: 0.06, click: 0.3 }),
    63: hand(220, 0.22),
    64: hand(160, 0.26),
    65: hand(320, 0.2),
    66: hand(240, 0.24),
    67: (at, a) => woodblock(at, a, 1600),
    68: (at, a) => woodblock(at, a, 1200),
    69: (at, a) => shaker(at, a, { decay: 0.08, freq: 5000 }),
    70: (at, a) => shaker(at, a, { decay: 0.05, freq: 6500 }),
    71: (at, a) => whistle(at, a, 2200, 0.12),
    72: (at, a) => whistle(at, a, 2000, 0.4),
    73: (at, a) => guiro(at, a, 0.08),
    74: (at, a) => guiro(at, a, 0.35),
    75: (at, a) => woodblock(at, a, 2500),
    76: (at, a) => woodblock(at, a, 1800),
    77: (at, a) => woodblock(at, a, 1300),
    78: (at, a) => drum(at, a, { from: 500, to: 320, bend: 0.08, decay: 0.12, type: 'sawtooth' }),
    79: (at, a) => drum(at, a, { from: 320, to: 620, bend: 0.14, decay: 0.2, type: 'sawtooth' }),
    80: (at, a) => metal(at, a * 0.25, { decay: 0.15, highpass: 8000, base: 105 }),
    81: (at, a) => metal(at, a * 0.25, { decay: 1.2, highpass: 8000, base: 105 }),
  };

  function whistle(at, amp, freq, decay) {
    const o = osc('sine', freq, at, decay + 0.05);
    o.frequency.setValueAtTime(freq, at);
    o.frequency.linearRampToValueAtTime(freq * 1.04, at + decay);
    chain(o, env(at, { peak: amp * 0.35, attack: 0.01, hold: decay * 0.6, decay: decay * 0.3 }));
    chain(noise(at, decay), filter('bandpass', freq, 8), env(at, { peak: amp * 0.2, attack: 0.01, decay }));
  }

  // A scrape, so it is noise read slowly with the filter opening across it.
  function guiro(at, amp, decay) {
    const n = noise(at, decay, 0.35);
    const bp = filter('bandpass', 1400, 4);
    bp.frequency.setValueAtTime(1200, at);
    bp.frequency.linearRampToValueAtTime(2600, at + decay);
    chain(n, bp, env(at, { peak: amp * 0.5, attack: 0.005, hold: decay * 0.5, decay: decay * 0.4 }));
  }

  function fallback(at, amp, note) {
    const freq = 440 * 2 ** ((note - 69) / 12);
    chain(osc('triangle', freq, at, 0.25), env(at, { peak: amp * 0.5, decay: 0.2 }));
  }

  // --------------------------------------------------------------- scheduling

  // performance.now() -> AudioContext time. Shared with the soundfont output,
  // which has exactly the same problem.
  const audioTime = (at) => contextTimeFor(context, at, now);

  function play(note, velocity, at) {
    const amp = (Math.min(127, Math.max(1, velocity)) / 127) ** 1.6;
    const voice = VOICES[note];
    if (voice) voice(at, amp);
    else fallback(at, amp, note);
  }

  return {
    id,
    name,
    kind: 'audio clock',

    /**
     * Accepts on any channel rather than only channel 10. This is a drum
     * machine with nothing else to be — refusing notes because the channel is
     * wrong would only produce a silent output that looks connected, which is
     * the failure mode hardest to diagnose from the page.
     */
    send(bytes, at) {
      if (!bytes || !bytes.length) return;
      const status = bytes[0] & 0xf0;

      // Note-offs are dropped: these are one-shots, as the MPC's pads are.
      if (status === 0x90 && bytes[2] > 0) {
        play(bytes[1], bytes[2], audioTime(at));
        return;
      }
      // All-notes-off / all-sound-off, as sent by the transport's panic.
      if (status === 0xb0 && (bytes[1] === 0x7b || bytes[1] === 0x78)) this.clear();
    },

    /** Silences anything already scheduled, including the look-ahead. */
    clear() {
      for (const node of live) {
        try { node.stop(context.currentTime); } catch { /* already finished */ }
      }
      live.clear();
    },

    close() {
      this.clear();
      try { master.disconnect(); tail.disconnect(); } catch { /* already gone */ }
    },
  };
}
