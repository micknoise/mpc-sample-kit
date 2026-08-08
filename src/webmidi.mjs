// Web MIDI compatibility shims.
//
// The spec settled on MIDIAccess.inputs/outputs being Maplike, but that is not
// what every implementation provides. Third-party iOS browsers that bundle
// their own MIDI plumbing — the only way to reach Web MIDI on an iPhone, since
// WebKit declines to ship it — often follow the older draft where the port
// collections are arrays or plain objects. Spreading `access.outputs.values()`
// then throws before a single port is found, and the failure surfaces as
// "MIDI access denied", which points at permissions rather than at the real
// cause.
//
// Everything here degrades: on a compliant implementation the behaviour is
// byte-for-byte what it was, and the fallbacks only engage when needed.

/**
 * Does this look like a MIDI port rather than something we scraped by mistake?
 *
 * The object fallback below reads every own value, which on a collection like
 * `{ values: fn }` would otherwise hand back the method itself as a "port".
 */
const isPortLike = (p) =>
  p && typeof p === 'object' && ('id' in p || 'name' in p || typeof p.send === 'function');

/**
 * Unwraps a collection that is really a method.
 *
 * The 2012 draft exposed outputs as a *function* returning an array, not as a
 * property. That form is easy to miss because a function has a `length` (its
 * arity), so array-like handling silently yields nothing rather than failing.
 */
function unwrap(collection) {
  if (typeof collection !== 'function') return collection;
  try {
    return collection.call(undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Finds the outputs on a MIDIAccess regardless of how it exposes them.
 *
 * Current implementations use an `outputs` property. Older ones used an
 * `outputs()` or `getOutputs()` method, and some early shims called them
 * destinations.
 */
/** As getOutputs, for the input side. */
export function getInputs(access) {
  if (!access) return null;
  const keys = ['inputs', 'getInputs', 'sources'];
  for (const key of keys) {
    const value = access[key];
    if (value != null && typeof value !== 'function') return value;
  }
  for (const key of keys) {
    const fn = access[key];
    if (typeof fn !== 'function') continue;
    try {
      const result = fn.call(access);
      if (result != null) return result;
    } catch { /* try the next form */ }
  }
  return null;
}

export function getOutputs(access) {
  if (!access) return null;

  const keys = ['outputs', 'getOutputs', 'destinations'];

  // Property forms first — a plain collection is unambiguous.
  for (const key of keys) {
    const value = access[key];
    if (value != null && typeof value !== 'function') return value;
  }

  // Then method forms, calling on `access` so `this` is right.
  for (const key of keys) {
    const fn = access[key];
    if (typeof fn !== 'function') continue;
    try {
      const result = fn.call(access);
      if (result != null) return result;
    } catch {
      // try the next form
    }
  }
  return null;
}

/**
 * Empties anything iterator-shaped into an array.
 *
 * Handles three generations: a real iterable, a bare iterator with `next()` but
 * no `Symbol.iterator` (how iteration was written before ES6 settled, and what
 * at least one iOS Web MIDI implementation still returns), and a plain array.
 *
 * The cap exists because a hand-written iterator that never reports `done`
 * would otherwise hang the page.
 */
function drain(it, limit = 4096) {
  if (!it) return [];
  if (typeof it[Symbol.iterator] === 'function') return [...it];
  if (Array.isArray(it)) return it.slice();

  if (typeof it.next === 'function') {
    const out = [];
    try {
      for (let n = it.next(), i = 0; n && !n.done && i < limit; n = it.next(), i++) {
        out.push(n.value);
      }
    } catch {
      // return whatever was collected before it gave up
    }
    return out;
  }
  return [];
}

/** Normalises any of the shapes a port collection has historically taken. */
export function listPorts(source) {
  const collection = unwrap(source);
  if (!collection || typeof collection !== 'object') return [];

  let candidates = [];
  const tryThis = (fn) => {
    if (candidates.length) return;
    try {
      const got = fn();
      if (got && got.length) candidates = got;
    } catch {
      // move on to the next strategy
    }
  };

  // Maplike, current spec — but values() may hand back any of the shapes drain
  // knows about, not necessarily an iterable.
  tryThis(() => (typeof collection.values === 'function' ? drain(collection.values()) : []));

  // forEach is implemented by most Maplike shims even when their iterators are
  // idiosyncratic, so it is a good second bet.
  tryThis(() => {
    if (typeof collection.forEach !== 'function') return [];
    const out = [];
    collection.forEach((v) => out.push(v));
    return out;
  });

  // entries() yields [id, port] pairs.
  tryThis(() => (typeof collection.entries === 'function'
    ? drain(collection.entries()).map((e) => (Array.isArray(e) ? e[1] : e))
    : []));

  // The collection itself may be directly iterable.
  tryThis(() => drain(collection));

  tryThis(() => (Array.isArray(collection) ? collection : []));
  tryThis(() => (typeof collection.length === 'number' ? Array.from(collection) : []));
  tryThis(() => Object.values(collection));

  return candidates.filter(isPortLike);
}

/** Looks a port up by id without assuming Map.get exists. */
export function findPort(source, id) {
  const collection = unwrap(source);
  if (!collection) return null;
  if (typeof collection.get === 'function') {
    const direct = collection.get(id);
    if (direct) return direct;
  }
  return listPorts(collection).find((p) => String(p.id) === String(id)) ?? null;
}

/**
 * True when the implementation predates the Maplike collections.
 *
 * Used as a proxy for "this is an old shim", which also implies scheduled send
 * is unlikely to be honoured — see wrapOutput.
 */
export function isLegacyAccess(access) {
  const outputs = unwrap(getOutputs(access));
  if (!outputs || typeof outputs !== 'object') return true;

  // An Array passes a naive Maplike check — it has a perfectly good values()
  // returning an iterator — so it has to be excluded explicitly. Requiring get()
  // as well is what actually distinguishes Maplike from array-like.
  if (Array.isArray(outputs)) return true;
  if (typeof outputs.get !== 'function' || typeof outputs.values !== 'function') return true;

  try {
    const v = outputs.values();
    return !(v && typeof v[Symbol.iterator] === 'function');
  } catch {
    return true;
  }
}

/**
 * Gives an output a dependable `send(bytes, at)` and `clear()`.
 *
 * Compliant implementations queue a message for a future timestamp. Older shims
 * ignore the second argument and fire immediately, which would collapse a whole
 * bar onto one instant. Where that is suspected, delivery is driven by timers
 * instead, and clear() cancels them so Stop keeps working.
 *
 * On a compliant implementation the original output is returned untouched.
 */
export function wrapOutput(output, opts = {}) {
  const {
    legacy = false,
    now = () => performance.now(),
    setPoll = setInterval,
    clearPoll = clearInterval,
    setFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null,
    cancelFrame = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null,
    pollMs = 4,
    slackMs = 1,
  } = opts;

  if (!output || !legacy) return output;

  // One timer draining a sorted queue, rather than a timer per message.
  //
  // A setTimeout per note means dozens of independent timers competing, each
  // carrying its own scheduling jitter, and on a phone that is audibly loose.
  // A single short-interval poll gives every message the same clock and keeps
  // error bounded by the poll interval instead of compounding per note.
  const queue = [];
  let poll = null;
  let frame = null;

  const stopPolling = () => {
    if (poll !== null) { clearPoll(poll); poll = null; }
    if (frame !== null && cancelFrame) { cancelFrame(frame); frame = null; }
  };

  const dispatch = () => {
    const t = now();
    while (queue.length && queue[0].at <= t + slackMs) output.send(queue.shift().bytes);
    if (!queue.length) stopPolling();
    else if (setFrame) frame = setFrame(dispatch);
  };

  // Driven by a timer *and* by animation frames.
  //
  // Mobile browsers throttle short intervals unpredictably, and a stalled
  // interval means late notes. Animation frames are coarser (about 16ms) but
  // scheduled far more dependably, so running both means whichever fires first
  // delivers, and the worst case is bounded by the better of the two rather
  // than by the timer alone.
  const startPolling = () => {
    if (poll === null) poll = setPoll(dispatch, pollMs);
    if (frame === null && setFrame) frame = setFrame(dispatch);
  };

  return {
    get id() { return output.id; },
    get name() { return output.name; },
    send(bytes, at) {
      if (at == null || at - now() <= slackMs) { output.send(bytes); return; }

      // Insert in time order. Events arrive nearly sorted already, so scanning
      // from the end is effectively O(1) per insert.
      let i = queue.length;
      while (i > 0 && queue[i - 1].at > at) i--;
      queue.splice(i, 0, { bytes, at });

      startPolling();
    },
    clear() {
      queue.length = 0;
      stopPolling();
      output.clear?.();
    },
  };
}

/**
 * A short description of what the implementation actually handed us.
 *
 * If ports still cannot be found on some browser, this is the thing worth
 * reporting — it says which shape the collection took, rather than leaving the
 * failure looking like a permissions problem.
 */
export function describePorts(source) {
  const wasFunction = typeof source === 'function';
  const collection = unwrap(source);
  if (!collection) return wasFunction ? 'method returning nothing' : 'missing';
  const kind = (wasFunction ? 'method -> ' : '') + (Array.isArray(collection) ? 'array'
    : typeof collection.get === 'function' ? 'maplike'
    : typeof collection.length === 'number' ? 'array-like'
    : 'object');
  let valuesKind = 'none';
  if (typeof collection.values === 'function') {
    try {
      const v = collection.values();
      valuesKind = v == null ? 'returns null'
        : typeof v[Symbol.iterator] === 'function' ? 'iterable'
        : Array.isArray(v) ? 'array'
        : typeof v.next === 'function' ? 'bare iterator'
        : typeof v;
    } catch (e) {
      valuesKind = `throws ${e.constructor.name}`;
    }
  }
  return `${kind}, values() ${valuesKind}, ${listPorts(collection).length} found`;
}

/**
 * Requests access, preferring SysEx but never failing for want of it.
 *
 * SysEx is only needed for MMC record-arming. Some implementations reject the
 * option outright rather than merely denying permission, so a refusal must not
 * take note output down with it.
 *
 * @returns {Promise<{access:object, sysex:boolean, legacy:boolean}>}
 */
export async function openAccess(requestMIDIAccess) {
  let access = null;
  let sysex = false;

  try {
    access = await requestMIDIAccess({ sysex: true });
    sysex = true;
  } catch {
    access = await requestMIDIAccess({ sysex: false });
    sysex = false;
  }

  return { access, sysex, legacy: isLegacyAccess(access) };
}
