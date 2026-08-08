// MIDI clock and transport.
//
// Because the scheduler hands CoreMIDI a fully timestamped event list up front,
// clock is just more events in that list — there is no separate timer to drift
// against. The clock ticks and the notes come from the same timebase, so they
// cannot slide apart.

/** MIDI system realtime bytes. */
export const CLOCK = 0xf8;
export const START = 0xfa;
export const CONTINUE = 0xfb;
export const STOP = 0xfc;

/** The MIDI standard: 24 clock ticks per quarter note. */
export const PPQN = 24;

/**
 * Generates clock ticks, optionally wrapped in transport start/stop.
 *
 * @param {number} bpm
 * @param {number} durationMs   how long to run the clock for
 * @param {object} [opts]
 * @param {number} [opts.startMs]
 * @param {boolean} [opts.transport]  emit START before and STOP after
 * @returns {Array<{ms:number, bytes:number[]}>}
 */
export function clockEvents(bpm, durationMs, opts = {}) {
  const { startMs = 0, transport = true } = opts;
  if (!(bpm > 0)) throw new Error('bpm must be positive');

  const tickMs = 60000 / bpm / PPQN;
  const events = [];

  // START must arrive fractionally before the first tick, or a receiver can
  // process them out of order and miss the downbeat.
  if (transport) events.push({ ms: startMs, bytes: [START] });

  const ticks = Math.floor(durationMs / tickMs);
  for (let i = 0; i < ticks; i++) {
    events.push({ ms: startMs + i * tickMs, bytes: [CLOCK] });
  }

  if (transport) events.push({ ms: startMs + durationMs, bytes: [STOP] });
  return events;
}

/** Merges clock into an event list, keeping everything in time order. */
export function withClock(events, bpm, durationMs, opts = {}) {
  const merged = [...events, ...clockEvents(bpm, durationMs, opts)];
  // Stable within a timestamp: transport and clock should precede notes.
  merged.sort((a, b) => a.ms - b.ms || (b.bytes[0] & 0xf8) - (a.bytes[0] & 0xf8));
  return merged;
}

/** A bare transport stop, for panicking out of a running sequence. */
export function stopAll(channel = 1) {
  return [
    { ms: 0, bytes: [STOP] },
    { ms: 0, bytes: [0xb0 | (channel - 1), 0x7b, 0x00] },
  ];
}
