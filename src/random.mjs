// Shared deterministic PRNG.
//
// Lives on its own so that pattern, dynamics, generation and scheduling can all
// share it without importing each other. Determinism is the point: any phrase
// worth keeping must be reproducible from its seed alone.

/** mulberry32 — small, fast, good enough for musical randomness. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
