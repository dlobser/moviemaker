// Guessing which asset a reference belongs to, from its filename.
//
// The board already links references to assets — but only when you say so, or
// when a reference's tags happen to contain the asset's tag. Dump forty photos
// in and nothing connects to anything, because nothing reads the filename, and
// the filename is usually the one place you already wrote the answer down:
// `henry_closeup_02.png`, `Sara-wardrobe-final.jpg`, `garage wide 3.png`.
//
// So this is deliberately dumb. No model, no pixels, no network — normalise the
// filename into words, normalise every asset's tag and name the same way, and
// look for overlap with enough slop to survive typos, plurals and the debris
// that accumulates on the end of a filename.
//
// It PROPOSES. Nothing here writes to the board, because a wrong link is
// invisible: it quietly poisons every future generation of that character and
// you would only notice it in an output, three shots later.

import { normalizeTag } from './promptTags.js';

// Words that appear in filenames and mean nothing about the subject. Without
// this, `henry_ref.png` and `sara_ref.png` both "match" on `ref`.
// `old` and `new` are deliberately absent: they are debris in a filename but
// meaning in a name, and an asset called "old lady" whose only surviving word
// is `lady` will happily claim `lady_in_red.png`.
const NOISE = new Set([
  'img', 'image', 'images', 'photo', 'photos', 'pic', 'pics', 'picture',
  'ref', 'refs', 'reference', 'references', 'screenshot', 'screen', 'shot',
  'final', 'draft', 'copy', 'edit', 'edited', 'test', 'temp',
  'untitled', 'export', 'render', 'output', 'asset', 'file',
  'v', 'ver', 'version', 'rev', 'png', 'jpg', 'jpeg', 'webp', 'gif'
]);

/** `v2`, `rev3` — a version stamp, not a subject. */
const VERSION_STAMP = /^(v|ver|rev|version)\d+$/;

/**
 * A filename or label as comparable words.
 *
 * camelCase is split too, so `HenryCloseup` reads the same as `henry_closeup`.
 * Pure numbers go — a trailing `02` is a take number, not a subject — as do
 * single characters, which match everything and mean nothing.
 */
export function nameTokens(value) {
  return String(value || '')
    .replace(/\.[a-z0-9]{2,4}$/i, '')            // extension
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')      // camelCase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => (
      token.length > 1
      && !/^\d+$/.test(token)
      && !VERSION_STAMP.test(token)
      && !NOISE.has(token)
    ));
}

function bigrams(value) {
  const out = [];
  for (let index = 0; index < value.length - 1; index++) out.push(value.slice(index, index + 2));
  return out;
}

/**
 * Dice coefficient on letter pairs: 1 for identical, degrading gracefully with
 * typos and endings. Chosen over edit distance because it does not punish a
 * long word for one extra letter as harshly, which is what plurals and
 * possessives look like.
 */
export function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map();
  bigrams(a).forEach(gram => counts.set(gram, (counts.get(gram) || 0) + 1));
  let hits = 0;
  const other = bigrams(b);
  other.forEach(gram => {
    const remaining = counts.get(gram) || 0;
    if (remaining > 0) {
      counts.set(gram, remaining - 1);
      hits += 1;
    }
  });
  return (2 * hits) / (bigrams(a).length + other.length);
}

/** How well one asset word is met by the best word in a filename. */
function bestTokenScore(assetToken, refTokens, threshold) {
  let best = 0;
  for (const token of refTokens) {
    if (token === assetToken) return 1;
    // A prefix is how a name gets truncated or suffixed: `henry` in `henrys`,
    // `garage` in `garagewide`. Short prefixes match far too much to trust.
    if (assetToken.length >= 4 && (token.startsWith(assetToken) || assetToken.startsWith(token))) {
      best = Math.max(best, 0.9);
      continue;
    }
    const score = similarity(assetToken, token);
    if (score >= threshold) best = Math.max(best, score);
  }
  return best;
}

/**
 * Score one asset against one filename.
 *
 * A multi-word asset has to be met on every word — `old lady` should not match
 * `lady_in_red` on the strength of `lady` alone — so the score is the weakest
 * link, not the average.
 */
export function scoreAssetAgainstName(asset, refTokens, threshold) {
  const tagTokens = nameTokens(normalizeTag(asset.tag || ''));
  const nameTokensList = nameTokens(asset.name || '');
  const candidates = [tagTokens, nameTokensList].filter(tokens => tokens.length > 0);
  if (candidates.length === 0 || refTokens.length === 0) return 0;

  let best = 0;
  for (const tokens of candidates) {
    const scores = tokens.map(token => bestTokenScore(token, refTokens, threshold));
    best = Math.max(best, Math.min(...scores));
  }
  return best;
}

/**
 * Propose an asset for every reference that has no link yet.
 *
 * `ambiguous` marks the cases where a second asset scored nearly as well — a
 * project with `Sara` and `Sarah` in it, or `Garage` and `Garage Interior`.
 * Those are the ones worth a human glance, so they are flagged rather than
 * silently resolved in favour of whichever sorted first.
 */
export function autoAssignReferences({
  references = [],
  assetLibrary = [],
  threshold = 0.7,
  includeAssigned = false,
  // Wide enough to catch a prefix match sitting just under an exact one —
  // `Sara` scoring 1 beside `Sarah` scoring 0.9 is precisely the pair a person
  // needs to look at, and a tighter margin waves it through.
  ambiguityMargin = 0.12
} = {}) {
  const proposals = [];

  for (const ref of references) {
    if (!includeAssigned && ref.assetId) continue;
    // `name` is the original filename; a reference captured from a generation
    // may only have a path, and its basename is the next best thing.
    const label = ref.name && ref.name !== 'Untitled'
      ? ref.name
      : String(ref.path || '').split('/').pop();
    const refTokens = nameTokens(label);
    if (refTokens.length === 0) continue;

    const scored = assetLibrary
      .map(asset => ({ asset, score: scoreAssetAgainstName(asset, refTokens, threshold) }))
      .filter(entry => entry.score >= threshold)
      .sort((a, b) => b.score - a.score || String(a.asset.tag).localeCompare(String(b.asset.tag)));

    if (scored.length === 0) continue;
    const [winner, runnerUp] = scored;
    proposals.push({
      refId: ref.id,
      refName: label,
      refPath: ref.path,
      assetId: winner.asset.id,
      assetTag: winner.asset.tag,
      score: Math.round(winner.score * 100) / 100,
      ambiguous: Boolean(runnerUp && winner.score - runnerUp.score < ambiguityMargin),
      alternative: runnerUp ? runnerUp.asset.tag : null
    });
  }

  return proposals;
}
