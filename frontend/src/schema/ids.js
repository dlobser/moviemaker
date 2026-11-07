// Id minting for v2 records: `<prefix>_<base36 time>_<4 random>`.
//
// v1 minted most ids as `prefix_<Date.now()>`, which collides as soon as two
// things are made in the same millisecond — a batch of outputs, a scene split
// into shots. The random tail makes a same-millisecond pair distinct, and the
// clock and random source are injectable so a migration run in a test mints
// the same ids every time.

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
export const ID_RANDOM_LENGTH = 4;

/** `prefix_<t36>_<r>` from one clock reading and one random source. */
export function formatId(prefix, timeMs, random = Math.random) {
  let tail = '';
  for (let i = 0; i < ID_RANDOM_LENGTH; i += 1) {
    const slot = Math.floor(Math.max(0, Math.min(0.999999, Number(random()) || 0)) * ALPHABET.length);
    tail += ALPHABET[slot];
  }
  return `${prefix}_${Math.max(0, Math.floor(Number(timeMs) || 0)).toString(36)}_${tail}`;
}

/**
 * A minter that never hands out the same id twice in one run.
 *
 * `now` returns milliseconds, `random` a number in [0, 1). A collision retries
 * with fresh randomness; a random source that cannot move on (a constant, say)
 * gets a base36 sequence appended instead of looping forever.
 */
export function createIdMinter({ now = () => Date.now(), random = Math.random } = {}) {
  const used = new Set();
  let sequence = 0;

  const mint = (prefix) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = formatId(prefix, now(), random);
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
    for (;;) {
      sequence += 1;
      const id = `${formatId(prefix, now(), random)}${sequence.toString(36)}`;
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };

  /** Tell the minter about ids that already exist, so it never reissues one. */
  const reserve = (id) => { if (id) used.add(String(id)); };

  return { mint, reserve, has: (id) => used.has(id) };
}

/** One-off mint with the default clock and randomness. */
export function mintId(prefix, options = {}) {
  return formatId(prefix, (options.now || (() => Date.now()))(), options.random || Math.random);
}

/**
 * A small deterministic PRNG (mulberry32) for tests: the same seed gives the
 * same sequence, and consecutive values differ, so minted ids never collide.
 */
export function seededRandom(seed = 1) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** True when `id` has the v2 shape for `prefix`. */
export function isMintedId(id, prefix = null) {
  if (typeof id !== 'string') return false;
  const match = /^([a-z]+)_[0-9a-z]+_[0-9a-z]{4,}$/.exec(id);
  if (!match) return false;
  return prefix === null || match[1] === prefix;
}
