// Asset tagging: write <Ralph> in a prompt and the studio swaps in Ralph's
// written description and ships Ralph's reference image with the request.
//
// An asset looks like:
//   { id, tag: 'Ralph', type: 'character', name: 'Ralph the Mechanic',
//     description: 'grizzled 60s mechanic, oil-stained overalls...',
//     images: ['assets/ref_123.png'], primaryImage: 'assets/ref_123.png' }

import { modelCapabilities, refImageCapacity, refTagToken, usesRefTags } from './catalog.js';
import { assetTemplateText, fillTemplate } from './prompts.js';
import { resolveShotReferences } from './references.js';
import { collectAssetReferences, orderEntriesByRole } from './refResolver.js';

export const ASSET_TYPES = [
  { id: 'character', label: 'Character' },
  { id: 'environment', label: 'Environment' },
  { id: 'prop', label: 'Prop' },
  { id: 'style', label: 'Style' },
  { id: 'vehicle', label: 'Vehicle' }
];

// <Ralph> / <Ralph the Mechanic> — letters, digits, spaces, _ and - inside.
// Deliberately does not match <> containing punctuation so stray angle brackets
// in ordinary prose are left alone.
const TAG_PATTERN = /<([A-Za-z0-9][A-Za-z0-9 _-]*)>/g;

/** Normalise a tag for comparison: case- and space-insensitive. */
export function normalizeTag(tag) {
  return String(tag || '').trim().toLowerCase().replace(/\s+/g, '');
}

/** Every <Tag> occurrence in a piece of text, in order, de-duplicated. */
export function extractTags(text) {
  if (!text) return [];
  const found = [];
  const seen = new Set();
  let match;
  TAG_PATTERN.lastIndex = 0;
  while ((match = TAG_PATTERN.exec(text)) !== null) {
    const raw = match[1].trim();
    const key = normalizeTag(raw);
    if (!seen.has(key)) {
      seen.add(key);
      found.push(raw);
    }
  }
  return found;
}

export function findAssetByTag(assetLibrary, tag) {
  const key = normalizeTag(tag);
  return (assetLibrary || []).find(asset => normalizeTag(asset.tag) === key) || null;
}

/**
 * A sensible starting prompt for generating this asset's reference image,
 * derived from its type, name and description.
 *
 * The per-type templates live in prompts.js and are editable per project, so
 * `promptSettings` is threaded through; omitting it uses the shipped defaults.
 */
export function defaultAssetPrompt(asset, promptSettings) {
  if (!asset) return '';
  const name = (asset.name || asset.tag || '').trim();
  const description = (asset.description || '').trim();
  if (!name && !description) return '';

  const template = assetTemplateText(promptSettings, asset.type || 'character');
  // With no description the template's ", ," reads badly — fall back to the name.
  const filled = fillTemplate(template, {
    name: name || description,
    description: description || name
  });
  return description ? filled : filled.replace(/,\s*,/g, ',');
}

/**
 * The single image an asset contributes to a generation.
 *
 * `images` holds every reference generated or uploaded for the asset; the
 * primary is the one the user chose to represent it. Falls back to the first
 * image for assets saved before a primary was picked.
 */
export function assetPrimaryImage(asset) {
  if (!asset) return null;
  return asset.primaryImage || (asset.images || [])[0] || null;
}

/**
 * The reference images sent *into* a generation of this asset's own artwork.
 *
 * These are picked by hand from the asset's reference pool — several at once on
 * models that take several. Assets saved before the multi-select existed carry
 * the old single `useExistingAsReference` flag instead, and are read as "send
 * the primary" so an old project generates what it always generated.
 */
export function assetInputImages(asset) {
  if (!asset) return [];
  if (Array.isArray(asset.inputImages)) return asset.inputImages.filter(Boolean);
  const primary = assetPrimaryImage(asset);
  return asset.useExistingAsReference && primary ? [primary] : [];
}

/**
 * The instruction that stops an LLM paraphrasing a shot's tags away.
 *
 * A shot description is written as "<Sara> runs through <Valley>", and the
 * prompt writer's job is to rewrite that description — which it will happily do
 * by replacing the tag with its own words. That reads fine and silently costs
 * the shot its reference artwork, because only a surviving tag gets expanded
 * and uploaded at generation time.
 *
 * Naming the specific tags beats a general rule: a model told to keep
 * "<Sara>, <Valley>" complies far more reliably than one told to keep "any
 * tags". Empty when the shot has none, so the template line drops out.
 */
export function tagPreservationRule(text) {
  const tags = extractTags(text);
  if (tags.length === 0) return '';
  const list = tags.map(tag => `<${tag}>`).join(', ');
  return `IMPORTANT — keep ${tags.length === 1 ? 'this tag' : 'these tags'} in your output exactly as written, `
    + `angle brackets included, once each, in a natural position: ${list}. `
    + 'They are placeholders the studio expands into full descriptions and reference artwork. '
    + 'Do not translate them into your own wording, do not repeat one, and do not invent new tags.';
}

/**
 * Tags that went into the writer but did not come back out.
 *
 * An instruction is not a guarantee, so the result is checked rather than
 * trusted — losing a tag is invisible until the generation comes back without
 * the character in it.
 */
export function droppedTags(sourceText, resultText) {
  const after = new Set(extractTags(resultText).map(normalizeTag));
  return extractTags(sourceText).filter(tag => !after.has(normalizeTag(tag)));
}

/**
 * The project, as briefing material for the prompt writer.
 *
 * Auto Prompt used to see one shot's four fields and nothing else, which is why
 * its output kept contradicting the shots either side of it and kept inventing
 * descriptions for characters the project already had artwork for. It cannot
 * use a tag it has not been told exists, so the whole library goes in — tag,
 * type, name and description — along with the neighbouring shots for
 * continuity.
 *
 * Returns '' when there is genuinely nothing to say, so the caller can leave
 * the block out rather than send an empty heading.
 */
export function buildAutoPromptContext({ assetLibrary = [], previousShot = null, nextShot = null } = {}) {
  const blocks = [];

  const tagged = (assetLibrary || []).filter(asset => asset && asset.tag);
  if (tagged.length > 0) {
    const lines = tagged.map(asset => {
      const name = (asset.name || '').trim();
      const description = (asset.description || '').trim();
      const detail = [name && `"${name}"`, description].filter(Boolean).join(' — ');
      return `<${asset.tag}> (${asset.type || 'asset'})${detail ? `: ${detail}` : ''}`;
    });
    blocks.push(`--- ASSET TAGS (${tagged.length}) ---\n${lines.join('\n')}`);
  }

  const shotBlock = (shot, heading) => {
    if (!shot) return null;
    // The written prompt is what the neighbouring shot will actually look like;
    // the description is what it is about. Both are useful and they differ.
    const fields = [
      ['Description', shot.description],
      ['Camera/setup', shot.setup],
      ['Image prompt', shot.draftImagePrompt || (shot.imagePrompts || [])[0]?.rawPrompt],
      ['Video prompt', shot.draftVideoPrompt || (shot.videoPrompts || [])[0]?.rawPrompt]
    ]
      .filter(([, value]) => String(value || '').trim())
      .map(([label, value]) => `${label}: ${String(value).trim()}`);
    if (fields.length === 0) return null;
    return `--- ${heading}${shot.name ? ` (${shot.name})` : ''} ---\n${fields.join('\n')}`;
  };

  const previous = shotBlock(previousShot, 'PREVIOUS SHOT');
  const next = shotBlock(nextShot, 'NEXT SHOT');
  if (previous) blocks.push(previous);
  if (next) blocks.push(next);

  return blocks.join('\n\n');
}

/** The text an asset contributes when its tag is substituted into a prompt. */
export function assetPromptText(asset) {
  if (!asset) return '';
  const name = (asset.name || asset.tag || '').trim();
  const description = (asset.description || '').trim();
  if (name && description) return `${name} (${description})`;
  return name || description;
}

/**
 * Locate every <Tag> in `text` and match it against the library, without
 * deciding yet what it should be replaced by.
 *
 * Substitution used to happen here, in the same pass. It cannot any more: what
 * a tag becomes on a model like Seedance depends on which image slot that
 * asset ends up in, and the slots are not known until every image source — the
 * hand-picked ones included — has been ordered and trimmed. So the scan is now
 * a separate step and `renderPromptTags` does the replacing afterwards.
 *
 * `occurrences` carries positions so a caller can highlight tags in place.
 */
export function scanPromptTags(text, assetLibrary) {
  const occurrences = [];
  const assets = [];
  const missing = [];

  if (!text) return { occurrences, assets, missing };

  TAG_PATTERN.lastIndex = 0;
  let match;
  while ((match = TAG_PATTERN.exec(text)) !== null) {
    const raw = match[1].trim();
    const asset = findAssetByTag(assetLibrary, raw);
    occurrences.push({ raw, asset, start: match.index, end: match.index + match[0].length });
    if (asset) {
      if (!assets.some(a => a.id === asset.id)) assets.push(asset);
    } else if (!missing.some(t => normalizeTag(t) === normalizeTag(raw))) {
      missing.push(raw);
    }
  }

  return { occurrences, assets, missing };
}

/**
 * Rewrite `text`, replacing each scanned tag with whatever `render` returns for
 * it. A null or empty return leaves the literal <Tag> in place, which is what
 * an unmatched tag wants: the mistake stays visible in the prompt instead of
 * disappearing into prose.
 */
export function renderPromptTags(text, occurrences, render) {
  let out = '';
  let cursor = 0;
  occurrences.forEach(occurrence => {
    const replacement = render(occurrence);
    out += text.slice(cursor, occurrence.start);
    out += replacement || text.slice(occurrence.start, occurrence.end);
    cursor = occurrence.end;
  });
  return out + text.slice(cursor);
}

/**
 * The images an asset contributes to a generation, one per asset: the primary.
 *
 * `images` is the asset's iteration gallery — the rejected takes — so sending
 * all of them lets a single character with a long history eat every input slot
 * and starve the other tags in the prompt.
 */
function taggedImagePaths(assets) {
  const paths = [];
  const seen = new Set();
  assets.forEach(asset => {
    const imagePath = assetPrimaryImage(asset);
    if (imagePath && !seen.has(imagePath)) {
      seen.add(imagePath);
      paths.push({ path: imagePath, asset });
    }
  });
  return paths;
}

/**
 * Resolve every <Tag> in `text` to its written description.
 *
 * The plain-prose form, for models that read their references as an unlabelled
 * pile. Kept as its own function because it is what most models still want.
 */
export function resolvePromptTags(text, assetLibrary) {
  const scan = scanPromptTags(text, assetLibrary);
  return {
    text: renderPromptTags(text || '', scan.occurrences, occ => (occ.asset ? assetPromptText(occ.asset) : null)),
    imagePaths: taggedImagePaths(scan.assets).map(entry => entry.path),
    assets: scan.assets,
    missing: scan.missing
  };
}

/** Join non-empty prompt fragments with ", ", tolerating stray commas. */
function joinFragments(fragments) {
  return fragments
    .map(part => String(part || '').trim().replace(/^,+|,+$/g, '').trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * Build the exact string sent to a generation model, and decide which
 * reference images travel with it.
 *
 * Ordering is deliberate and never reshuffled: **primaryImagePaths first**,
 * tagged-asset images after. The primary slot is what the user explicitly
 * chose for this generation — the shot's selected still for a video, or the
 * references picked by hand for an image. Tagged assets are supporting
 * material, so when a model accepts only one input (Kling, most i2v models)
 * the explicit choice is the one that survives the trim.
 *
 * Getting this backwards silently swaps a shot's own frame for a character
 * portrait, which is both wrong and expensive, so `imageSources` reports the
 * final list with provenance for the UI to display before anything is spent.
 *
 * On a model that indexes its references by position (Seedance 2.0), that
 * order is not just a priority list — it is the address space the prompt
 * points into, and each <Tag> is replaced by the slot number of its image
 * rather than by its description.
 */
export function composeGenerationPrompt({
  prompt,
  prePrompt = '',
  postPrompt = '',
  assetLibrary = [],
  primaryImagePaths = [],
  attachTaggedImages = true,
  excludedImagePaths = [],
  type = 'image',
  modelId = '',
  // Reference-board wiring (Phase 4). All optional; with every one absent the
  // composition is byte-identical to what it always produced — that is the
  // compat gate the existing tests hold.
  references = [],
  assignments = [],
  shot = null,
  scene = null,
  autoAttachRefs = true
}) {
  const scan = scanPromptTags(prompt, assetLibrary);
  const boardWired = Boolean(shot || (references && references.length) || (assignments && assignments.length));
  const { refKinds } = modelCapabilities(type, modelId);
  // A shot's per-reference opt-outs apply to everything the board contributes,
  // whichever path it arrives by.
  const refExclusions = new Set(shot?.refExclusions || []);

  // 1. Decide the images and their order, before a word of the prompt is
  //    written — on a pointer model the slot number *is* the reference.
  const ordered = [];
  const byPath = new Map();
  const push = (imagePath, origin, label, asset, refId = null) => {
    if (!imagePath || (Array.isArray(excludedImagePaths) && excludedImagePaths.includes(imagePath))) return;
    if (refId && refExclusions.has(refId)) return;
    const existing = byPath.get(imagePath);
    if (existing) {
      // The same file picked by hand *and* pulled in by a tag is one image, but
      // it still has to answer to that tag's pointer, so the asset is recorded
      // against the slot the image already occupies rather than sent twice.
      if (asset && !existing.asset) {
        existing.asset = asset;
        existing.label = `${existing.label} · <${asset.tag}>`;
      }
      return;
    }
    const entry = { path: imagePath, origin, label, asset: asset || null, refId };
    byPath.set(imagePath, entry);
    ordered.push(entry);
  };

  // Explicit beats automatic: hand-picked paths, then shot-pinned edges, then
  // inherited scene/project edges, then whatever a <Tag> drags in.
  primaryImagePaths.forEach(p => push(p, 'primary', type === 'video' ? 'Shot image' : 'Selected reference'));

  if (boardWired && shot) {
    const entries = resolveShotReferences({ shot, scene, references, assignments })
      .filter(entry => entry.enabled && entry.ref.path);
    const pinned = entries.filter(entry => entry.scope === 'shot');
    const inherited = entries.filter(entry => entry.scope !== 'shot');
    orderEntriesByRole(pinned, refKinds).forEach(entry => (
      push(entry.ref.path, 'pinned', entry.ref.name || 'Pinned reference', null, entry.ref.id)
    ));
    orderEntriesByRole(inherited, refKinds).forEach(entry => (
      push(entry.ref.path, 'inherited', entry.ref.name || `${entry.scope} reference`, null, entry.ref.id)
    ));
  }

  if (attachTaggedImages) {
    if (boardWired && autoAttachRefs) {
      // Round-robin by rank across tagged assets: every asset lands its
      // primary before any asset spends spare capacity on a second image —
      // the same fairness rule the one-image-per-asset behaviour existed for,
      // now extended to the model's real slot count.
      const perAsset = scan.assets.map(asset => ({
        asset,
        candidates: collectAssetReferences({ asset, references, refKinds })
          .filter(candidate => !candidate.refId || !refExclusions.has(candidate.refId))
      }));
      const maxRank = perAsset.reduce((max, { candidates }) => Math.max(max, candidates.length), 0);
      for (let rank = 0; rank < maxRank; rank++) {
        perAsset.forEach(({ asset, candidates }) => {
          const candidate = candidates[rank];
          if (!candidate) return;
          const label = candidate.reason === 'primary' ? `<${asset.tag}>` : `<${asset.tag}> · ${candidate.reason}`;
          push(candidate.path, 'auto-tag', label, asset, candidate.refId || null);
        });
      }
    } else {
      taggedImagePaths(scan.assets).forEach(({ path, asset }) => push(path, 'tag', `<${asset.tag}>`, asset));
    }
  }

  const capacity = refImageCapacity(type, modelId);
  const kept = capacity > 0 ? ordered.slice(0, capacity) : [];
  const dropped = ordered.slice(kept.length);

  // 2. Now the slots are fixed, each tag knows what to become.
  const pointerModel = usesRefTags(type, modelId);
  const slotByAssetId = new Map();
  kept.forEach((entry, index) => {
    if (entry.asset && !slotByAssetId.has(entry.asset.id)) slotByAssetId.set(entry.asset.id, index);
  });
  kept.forEach((entry, index) => {
    entry.slot = index;
    entry.token = pointerModel ? refTagToken(type, modelId, index) : '';
  });

  const resolvedText = renderPromptTags(prompt || '', scan.occurrences, occurrence => {
    if (!occurrence.asset) return null; // unknown tag — leave it visible
    if (pointerModel) {
      const slot = slotByAssetId.get(occurrence.asset.id);
      // A tag whose image did not make the cut has no slot to point at, so it
      // falls back to prose. Emitting "@image7" for an image that was never
      // sent is worse than a wordy prompt: the model resolves it to whatever
      // happens to be in slot 7.
      if (slot !== undefined) return refTagToken(type, modelId, slot);
    }
    return assetPromptText(occurrence.asset);
  });

  const finalPrompt = joinFragments([prePrompt, resolvedText, postPrompt]);

  // A composed prompt over the model's documented ceiling is reported, never
  // trimmed: the provider's own behaviour (reject or truncate) is visible and
  // the fix — shorten the prompt — belongs to the user.
  const { promptLimit } = modelCapabilities(type, modelId);
  const promptOverflow = promptLimit && finalPrompt.length > promptLimit
    ? { limit: promptLimit, length: finalPrompt.length }
    : null;

  return {
    prompt: finalPrompt,
    promptOverflow,
    inputImagePaths: kept.map(entry => entry.path),
    imageSources: kept,
    droppedImageSources: dropped,
    droppedImagePaths: dropped.map(entry => entry.path),
    taggedAssets: scan.assets,
    // Assets whose images were left out entirely — the caller may want to warn.
    unusedTaggedAssets: attachTaggedImages
      ? scan.assets.filter(a => {
        const imagePath = assetPrimaryImage(a);
        return imagePath && !kept.some(k => k.path === imagePath);
      })
      : scan.assets,
    attachTaggedImages,
    missingTags: scan.missing,
    // True when tags became "@image2" pointers rather than descriptions — the
    // UI says so, because the prompt reads very differently either way.
    usesRefTags: pointerModel,
    capacity
  };
}
