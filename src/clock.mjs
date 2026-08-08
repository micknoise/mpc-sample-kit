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

// MIDI Machine Control. These are SysEx, so a browser must have asked for
// `requestMIDIAccess({ sysex: true })` or they will be rejected.
//
// Device 0x7F addresses everything listening. The MPC only acts on these if
// "Receive MMC" is enabled in its MIDI/Sync preferences.
const mmc = (cmd, device = 0x7f) => [0xf0, 0x7f, device, 0x06, cmd, 0xf7];

export const MMC = {
  stop: (d) => mmc(0x01, d),
  play: (d) => mmc(0x02, d),
  deferredPlay: (d) => mmc(0x03, d),
  recordStrobe: (d) => mmc(0x06, d),   // punch in
  recordExit: (d) => mmc(0x07, d),     // punch out
  reset: (d) => mmc(0x0d, d),
};

/**
 * The message sequence for capturing a phrase into the MPC's own sequencer.
 *
 * The MPC records what it hears in real time — there is no faster path, since
 * its storage is on an ext4 partition macOS cannot write. So a "dump" is
 * really an arm, a play-through, and a stop.
 *
 * @returns {{ arm: number[][], disarm: number[][] }}
 */
export function recordArming(device = 0x7f) {
  return {
    arm: [MMC.recordStrobe(device), [START]],
    disarm: [[STOP], MMC.recordExit(device), MMC.stop(device)],
  };
}

/** A bare transport stop, for panicking out of a running sequence. */
export function stopAll(channel = 1) {
  return [
    { ms: 0, bytes: [STOP] },
    { ms: 0, bytes: [0xb0 | (channel - 1), 0x7b, 0x00] },
  ];
}
