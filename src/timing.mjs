// Timing measurement.
//
// "The timing is bad" is not something that can be fixed by guessing, and every
// guess costs a round trip to someone with the hardware. This measures the real
// thing instead.
//
// The MPC echoes inbound MIDI straight back out (its soft-thru), so a burst of
// notes sent at exact intervals comes back stamped with when it actually
// arrived. That covers the whole chain — our scheduling, the browser's MIDI
// implementation, and the USB link — rather than just the part we can see.

/** Mean, worst case and standard deviation of a set of errors. */
export function summarise(errors) {
  if (!errors.length) return { count: 0, mean: 0, worst: 0, sd: 0 };
  const abs = errors.map(Math.abs);
  const mean = abs.reduce((a, b) => a + b, 0) / abs.length;
  const variance = abs.reduce((a, b) => a + (b - mean) ** 2, 0) / abs.length;
  return {
    count: errors.length,
    mean: +mean.toFixed(1),
    worst: +Math.max(...abs).toFixed(1),
    sd: +Math.sqrt(variance).toFixed(1),
  };
}

/**
 * Compares when events arrived against when they were meant to.
 *
 * Both series are reduced to offsets from their own first event, so a constant
 * latency — which is inaudible — does not count as error. Only the *spacing*
 * matters, which is what the ear hears as timing.
 */
export function driftFrom(intended, actual) {
  const n = Math.min(intended.length, actual.length);
  if (n < 2) return [];
  const errors = [];
  for (let i = 1; i < n; i++) {
    errors.push((actual[i] - actual[0]) - (intended[i] - intended[0]));
  }
  return errors;
}

/**
 * Sends a burst at exact intervals and measures the echo.
 *
 * @param {object}   opts
 * @param {object}   opts.output      MIDI output (send(bytes, at))
 * @param {object}   opts.input       MIDI input to listen on
 * @param {number}   [opts.count]     how many notes
 * @param {number}   [opts.spacingMs] gap between them
 * @param {number}   [opts.note]      which note to use
 * @param {number}   [opts.channel]   1-16; must be the channel the device is
 *                                    actually listening on, or the burst is
 *                                    measured against an echo that never comes
 * @param {number}   [opts.velocity]  kept low so the test is not deafening
 * @param {function} [opts.now]
 * @param {function} [opts.setTimer]
 * @returns {Promise<{intended:number[], actual:number[], stats:object, echo:boolean}>}
 */
export function measureTiming(opts) {
  const {
    output,
    input,
    count = 16,
    spacingMs = 125,
    note = 36,
    channel = 1,
    velocity = 1,
    noteOffs = true,
    leadMs = 300,
    now = () => performance.now(),
    setTimer = setTimeout,
  } = opts;

  const noteOn = 0x90 | (channel - 1);
  const noteOff = 0x80 | (channel - 1);

  return new Promise((resolve) => {
    const intended = [];
    const actual = [];
    const start = now() + leadMs;

    const onMessage = (e) => {
      // Any channel, deliberately: the burst is the only thing being sent, and
      // a device that echoes onto a different one is still echoing.
      const [status, n] = e.data ?? [];
      if ((status & 0xf0) !== 0x90 || n !== note || e.data[2] === 0) return;
      actual.push(now());
    };

    const previous = input ? input.onmidimessage : null;
    if (input) input.onmidimessage = onMessage;

    for (let i = 0; i < count; i++) {
      const at = start + i * spacingMs;
      intended.push(at);
      output.send([noteOn, note, velocity], at);
      if (noteOffs) output.send([noteOff, note, 0], at + 30);
    }

    // Wait for the burst plus a margin for the echo to come back.
    setTimer(() => {
      if (input) input.onmidimessage = previous;
      resolve({
        intended,
        actual,
        echo: actual.length >= 2,
        stats: summarise(driftFrom(intended, actual)),
      });
    }, leadMs + count * spacingMs + 600);
  });
}

/** Turns a result into something worth reading on a phone screen. */
export function describeTiming(result) {
  if (!result.echo) {
    return 'no echo received — enable MIDI soft-thru on the MPC, or the input port is not readable here';
  }
  const { count, mean, worst, sd } = result.stats;
  const verdict = worst < 5 ? 'tight'
    : worst < 15 ? 'acceptable'
    : worst < 40 ? 'loose'
    : 'unusable';
  return `${count} notes · mean ${mean}ms · worst ${worst}ms · sd ${sd}ms — ${verdict}`;
}
