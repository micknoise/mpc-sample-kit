// Continuous look-ahead transport.
//
// Queueing a whole phrase up front makes Stop impossible: Web MIDI cannot
// un-send timestamped messages, so by the time the user clicks, the notes have
// already gone. Instead this queues a fraction of a second at a time and tops
// the queue up on a timer.
//
// Three things fall out of that:
//   - Stop is immediate, bar a few hundred milliseconds of tail.
//   - Playback can run indefinitely; nothing has to know a total length.
//   - Control changes take effect on the next bar, not the next Play.
//
// The timer only has to stay *ahead*, not be punctual — delivery timing belongs
// to the MIDI layer. That tolerance is what makes this survive a busy main
// thread.
//
// Dependencies are injected so this can be driven by a fake clock in tests.

const PANIC = (channel = 1) => [0xb0 | (channel - 1), 0x7b, 0x00];
const TRANSPORT_STOP = [0xfc];
const TRANSPORT_START = [0xfa];

/**
 * @param {object}   opts
 * @param {object}   opts.output          anything with send(bytes, at) and optional clear()
 * @param {function} opts.nextBar         (index) => { events, durationMs }
 * @param {number}   [opts.lookaheadMs]   how far ahead to queue
 * @param {number}   [opts.tickMs]        how often to top up
 * @param {number}   [opts.leadMs]        delay before the first note
 * @param {number}   [opts.maxBarsPerTick] guard against runaway loops
 * @param {boolean}  [opts.sendTransport] emit MIDI start/stop
 * @param {number}   [opts.maxBars]      stop after this many bars (0 = forever)
 * @param {function} [opts.onEnd]        called once a bounded run finishes
 * @param {function} [opts.now]           clock, defaults to performance.now
 * @param {function} [opts.schedule]      setInterval
 * @param {function} [opts.unschedule]    clearInterval
 * @param {function} [opts.onError]
 * @param {function} [opts.onBar]
 */
export function createTransport(opts) {
  const {
    output,
    nextBar,
    lookaheadMs = 400,
    tickMs = 80,
    leadMs = 150,
    maxBarsPerTick = 8,
    sendTransport = false,
    maxBars = 0,
    onEnd = () => {},
    now = () => performance.now(),
    schedule = setInterval,
    unschedule = clearInterval,
    onError = () => {},
    onBar = () => {},
  } = opts;

  let playing = false;
  let timer = null;
  let barIndex = 0;
  let playhead = 0;
  let startTime = 0;

  function tick() {
    if (!playing) return;

    // A bounded run — used when capturing a fixed number of bars into the MPC's
    // sequencer. Once every bar is queued we stop generating but keep the
    // transport alive until the last one has actually played out, otherwise the
    // stop would cut off the tail we just scheduled.
    if (maxBars && barIndex >= maxBars) {
      if (now() >= startTime + playhead) { stop(); onEnd(); }
      return;
    }

    let generated = 0;

    while (startTime + playhead < now() + lookaheadMs && generated < maxBarsPerTick) {
      let bar;
      try {
        bar = nextBar(barIndex);
      } catch (e) {
        onError(e);
        stop();
        return;
      }
      if (!bar || !(bar.durationMs > 0)) {   // a zero-length bar would spin forever
        onError(new Error('nextBar must return a positive durationMs'));
        stop();
        return;
      }

      const base = startTime + playhead;
      for (const e of bar.events) output.send(e.bytes, base + e.ms);

      playhead += bar.durationMs;
      barIndex++;
      generated++;
      onBar(barIndex);
    }
  }

  function play() {
    if (playing) return false;             // never stack a second stream on top
    playing = true;
    barIndex = 0;
    playhead = 0;
    startTime = now() + leadMs;

    if (sendTransport) output.send(TRANSPORT_START, startTime);
    tick();
    timer = schedule(tick, tickMs);
    return true;
  }

  function stop() {
    if (!playing) return false;
    playing = false;
    if (timer !== null) { unschedule(timer); timer = null; }

    // clear() drops whatever is still queued; the panic catches any note left
    // hanging because its note-off was in the part we just dropped.
    output.clear?.();
    output.send(PANIC());
    if (sendTransport) output.send(TRANSPORT_STOP);
    return true;
  }

  return {
    play,
    stop,
    tick,
    get playing() { return playing; },
    get bar() { return barIndex; },
  };
}
