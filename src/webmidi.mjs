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

/** Normalises any of the shapes a port collection has historically taken. */
export function listPorts(collection) {
  if (!collection) return [];

  const candidates = [];

  // Maplike, as the current spec requires.
  if (typeof collection.values === 'function') {
    try {
      const values = collection.values();
      if (values && typeof values[Symbol.iterator] === 'function') candidates.push(...values);
      else if (Array.isArray(values)) candidates.push(...values);   // older drafts
    } catch {
      // fall through to the shapes below
    }
  }

  if (!candidates.length && Array.isArray(collection)) candidates.push(...collection);
  if (!candidates.length && typeof collection.length === 'number') candidates.push(...Array.from(collection));
  if (!candidates.length && typeof collection === 'object') candidates.push(...Object.values(collection));

  return candidates.filter(isPortLike);
}

/** Looks a port up by id without assuming Map.get exists. */
export function findPort(collection, id) {
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
  const outputs = access?.outputs;
  if (!outputs) return true;

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
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = opts;

  if (!output || !legacy) return output;

  const pending = new Set();
  return {
    get id() { return output.id; },
    get name() { return output.name; },
    send(bytes, at) {
      const delay = at == null ? 0 : at - now();
      if (!(delay > 1)) { output.send(bytes); return; }
      const handle = setTimer(() => { pending.delete(handle); output.send(bytes); }, delay);
      pending.add(handle);
    },
    clear() {
      for (const handle of pending) clearTimer(handle);
      pending.clear();
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
export function describePorts(collection) {
  if (!collection) return 'missing';
  const kind = Array.isArray(collection) ? 'array'
    : typeof collection.get === 'function' ? 'maplike'
    : typeof collection.length === 'number' ? 'array-like'
    : 'object';
  let valuesKind = 'none';
  if (typeof collection.values === 'function') {
    try {
      const v = collection.values();
      valuesKind = v == null ? 'returns null'
        : typeof v[Symbol.iterator] === 'function' ? 'iterable'
        : Array.isArray(v) ? 'array' : typeof v;
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
