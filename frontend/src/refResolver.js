// Which reference images should travel with a <Tag>.
//
// Before this, a tagged asset contributed exactly one image — its primary —
// regardless of how many input slots the model offered, and the reference
// board's carefully collected metadata (kinds, asset links, free tags) never
// affected a generation at all. This module ranks everything the board knows
// about one asset so composeGenerationPrompt can spend spare capacity on it.

import { assetInputImages, assetPrimaryImage, normalizeTag } from './promptTags.js';

/**
 * Ranked reference candidates for one tagged asset.
 *
 * **A ticked asset is its own answer.** When the asset editor has images ticked,
 * those are the whole candidate list and nothing is inferred around them — an
 * explicit choice is not a hint to be topped up. Before this, ticking governed
 * only the asset's own artwork, and a shot with spare slots quietly filled them
 * with every board reference that mentioned the asset: a character with six
 * sheets on the board sent all six into a fourteen-slot model, which is not
 * what anyone ticking four boxes meant.
 *
 * With nothing ticked there is no explicit choice to honour, so the board's
 * ranking still applies:
 *
 *   1. the asset's primary image        (rank 0 — always first)
 *   2. board refs linked to the asset   (ref.assetId === asset.id)
 *   3. board refs whose tags match      (ref.tags[] contains the asset's tag)
 *
 * Within groups 2 and 3, refs whose kind the model cares about (`refKinds`)
 * come first; ties keep board insertion order. Deduped by path. `capacityHint`
 * caps the list length when given.
 *
 * Returns [{ path, refId?, reason: 'primary'|'ticked'|'linked'|'tag-match', kind?, rank }]
 */
export function collectAssetReferences({ asset, references = [], capacityHint = null, refKinds = null }) {
  if (!asset) return [];
  const out = [];
  const seen = new Set();
  const push = (entry) => {
    if (!entry.path || seen.has(entry.path)) return;
    seen.add(entry.path);
    out.push({ ...entry, rank: out.length });
  };
  const capped = () => (capacityHint != null && capacityHint >= 0 ? out.slice(0, capacityHint) : out);

  const primary = assetPrimaryImage(asset);

  // The ticks, when there are any. The primary leads if it is among them —
  // it is the asset's identity image and the slot order is load-bearing on
  // models that address their references by position.
  const ticked = assetInputImages(asset);
  if (ticked.length > 0) {
    if (primary && ticked.includes(primary)) push({ path: primary, reason: 'primary' });
    ticked.forEach(path => push({ path, reason: 'ticked' }));
    return capped();
  }

  if (primary) push({ path: primary, reason: 'primary' });

  const kindMatches = (ref) => !Array.isArray(refKinds) || refKinds.includes(ref.kind);
  const byKindPreference = (list) => [
    ...list.filter(kindMatches),
    ...list.filter(ref => !kindMatches(ref))
  ];

  const linked = references.filter(ref => ref.assetId && ref.assetId === asset.id);
  byKindPreference(linked).forEach(ref => push({ path: ref.path, refId: ref.id, reason: 'linked', kind: ref.kind }));

  const tagKey = normalizeTag(asset.tag);
  const tagMatched = references.filter(ref => (
    ref.assetId !== asset.id && (ref.tags || []).some(tag => normalizeTag(tag) === tagKey)
  ));
  byKindPreference(tagMatched).forEach(ref => push({ path: ref.path, refId: ref.id, reason: 'tag-match', kind: ref.kind }));

  return capped();
}

// Explicit beats automatic; a subject reference beats a style one on models
// that read characters. Style-first models invert that.
const ROLE_ORDER_DEFAULT = { subject: 0, style: 1, composition: 2 };
const ROLE_ORDER_STYLE_FIRST = { style: 0, subject: 1, composition: 2 };

/**
 * Order resolved shot-reference entries within one scope by role.
 * Stable: equal roles keep their edge order.
 */
export function orderEntriesByRole(entries, refKinds = null) {
  const styleFirst = Array.isArray(refKinds) && refKinds.length === 1 && refKinds[0] === 'style';
  const order = styleFirst ? ROLE_ORDER_STYLE_FIRST : ROLE_ORDER_DEFAULT;
  return [...entries].sort((a, b) => (order[a.role] ?? 1) - (order[b.role] ?? 1));
}
