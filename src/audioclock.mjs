// A timer driven by the audio thread.
//
// Measured on an iPhone: dispatching MIDI from setInterval gave a worst case
// around 30ms, against 0.6ms standard deviation for the same burst sent through
// CoreMIDI on a laptop. The echo path is therefore clean and the jitter is ours
// — mobile browsers throttle and coalesce timers, and no amount of look-ahead
// helps because the problem is *when the wake-up happens*, not how far ahead
// the work was queued.
//
// The audio render thread does not have that problem. It runs at real-time
// priority and calls its processor once per render quantum — 128 frames, about
// 2.7ms at 48kHz — regardless of what the main thread is doing. It cannot send
// MIDI itself, but it can wake the main thread punctually, which is the part
// that was failing.
//
// Three tiers, best first:
//
//   AudioWorklet     ~2.7ms, runs on the render thread
//   ScriptProcessor  ~5.8ms at 256 frames, deprecated but present in WebKit
//   timer + frames   the previous behaviour, when there is no audio at all

const WORKLET_SOURCE = `
class MidiTick extends AudioWorkletProcessor {
  process() {
    this.port.postMessage(currentTime);
    return true;   // stay alive; the output is left silent
  }
}
registerProcessor('midi-tick', MidiTick);
`;

/** The plain timer ticker, used when no AudioContext is available. */
export function timerTicker(opts = {}) {
  const {
    setPoll = setInterval,
    clearPoll = clearInterval,
    setFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null,
    cancelFrame = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null,
    pollMs = 4,
  } = opts;

  let poll = null;
  let frame = null;

  return {
    kind: 'timer',
    resolutionMs: pollMs,
    start(fn) {
      if (poll === null) poll = setPoll(fn, pollMs);
      const loop = () => { fn(); frame = setFrame ? setFrame(loop) : null; };
      if (frame === null && setFrame) frame = setFrame(loop);
    },
    stop() {
      if (poll !== null) { clearPoll(poll); poll = null; }
      if (frame !== null && cancelFrame) { cancelFrame(frame); frame = null; }
    },
  };
}

/**
 * Builds the best ticker the platform will give us.
 *
 * @param {AudioContext} context  already resumed — iOS requires a user gesture
 * @returns {Promise<{kind:string, resolutionMs:number, start:function, stop:function}>}
 */
export async function createTicker(context, opts = {}) {
  if (!context) return timerTicker(opts);

  const quantum = 128;
  const rate = context.sampleRate || 48000;

  // Tier 1: AudioWorklet.
  if (context.audioWorklet && typeof AudioWorkletNode === 'function') {
    try {
      const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      await context.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      const node = new AudioWorkletNode(context, 'midi-tick');
      let running = null;
      node.port.onmessage = () => running?.();
      node.connect(context.destination);

      return {
        kind: 'audioworklet',
        resolutionMs: (quantum / rate) * 1000,
        start(fn) { running = fn; },
        stop() { running = null; },
      };
    } catch {
      // fall through to the next tier
    }
  }

  // Tier 2: ScriptProcessor. Deprecated, but WebKit still has it and it fires
  // from the audio thread, which is the property that matters here.
  if (typeof context.createScriptProcessor === 'function') {
    try {
      const size = 256;
      const node = context.createScriptProcessor(size, 1, 1);
      let running = null;
      node.onaudioprocess = () => running?.();
      node.connect(context.destination);

      return {
        kind: 'scriptprocessor',
        resolutionMs: (size / rate) * 1000,
        start(fn) { running = fn; },
        stop() { running = null; },
      };
    } catch {
      // fall through
    }
  }

  return timerTicker(opts);
}

/**
 * Converts a performance.now() timestamp into an AudioContext time.
 *
 * Web MIDI's send() takes the former and the audio graph schedules in the
 * latter, so anything that plays sound rather than sending it needs this
 * bridge — both the built-in synth and the soundfont engine.
 *
 * getOutputTimestamp pairs the two clocks at the same instant, which also
 * accounts for the device's output latency: schedule against that pairing and
 * the note is *audible* when asked for, not merely queued then. Where it is
 * missing, sampling both clocks together is close enough — the error is a
 * render quantum, a couple of milliseconds.
 *
 * Never returns a time in the past: a note that was scheduled late plays now
 * rather than never.
 *
 * @param {BaseAudioContext} context
 * @param {number|null} at          performance.now() milliseconds, or null for now
 * @param {function} [now]          the performance clock, injectable for tests
 */
export function contextTimeFor(context, at, now = () => performance.now()) {
  if (at == null) return context.currentTime;

  let target;
  const stamp = context.getOutputTimestamp?.();
  if (stamp && stamp.performanceTime > 0 && stamp.contextTime > 0) {
    target = stamp.contextTime + (at - stamp.performanceTime) / 1000;
  } else {
    target = context.currentTime + (at - now()) / 1000;
  }
  return Math.max(context.currentTime, target);
}

/**
 * Creates and resumes an AudioContext, which on iOS must happen inside a user
 * gesture. Returns null rather than throwing when Web Audio is unavailable.
 */
export async function openAudioContext(Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext) {
  if (typeof Ctor !== 'function') return null;
  try {
    const context = new Ctor({ latencyHint: 'interactive' });
    if (context.state === 'suspended') await context.resume();
    return context;
  } catch {
    return null;
  }
}
