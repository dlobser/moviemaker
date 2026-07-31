// Asset tagging: write <Ralph> in a prompt and the studio swaps in Ralph's
// written description and ships Ralph's reference image with the request.
//
// An asset looks like:
//   { id, tag: 'Ralph', type: 'character', name: 'Ralph the Mechanic',
//     description: 'grizzled 60s mechanic, oil-stained overalls...',
//     images: ['assets/ref_123.png'], primaryImage: 'assets/ref_123.png' }

import { refImageCapacity } from './catalog.js';

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

// Starting prompts for generating an asset's reference image. Reference art
// wants the opposite of a cinematic frame: neutral pose, plain background,
// even light — anything the model can lift the subject cleanly out of.
const ASSET_PROMPT_TEMPLATES = {
  character: (name, description) => `full body character reference sheet of ${name}, ${description}, neutral standing pose, facing camera, plain light grey studio background, soft even lighting, sharp focus, full figure visible`,
  environment: (name, description) => `establishing wide shot of ${name}, ${description}, no people in frame, natural lighting, deep focus`,
  prop: (name, description) => `product photograph of ${name}, ${description}, centred, plain neutral background, soft studio lighting, sharp focus`,
  style: (name, description) => `style reference board: ${description}, cohesive colour palette and texture treatment`,
  vehicle: (name, description) => `three-quarter front view of ${name}, ${description}, plain neutral background, even studio lighting, full vehicle in frame`
};

/**
 * A sensible starting prompt for generating this asset's reference image,
 * derived from its type, name and description.
 */
export function defaultAssetPrompt(asset) {
  if (!asset) return '';
  const name = (asset.name || asset.tag || '').trim();
  const description = (asset.description || '').trim();
  if (!name && !description) return '';

  const template = ASSET_PROMPT_TEMPLATES[asset.type] || ASSET_PROMPT_TEMPLATES.character;
  // With no description the template's ", ," reads badly — fall back to the name.
  if (!description) return template(name, name).replace(/,\s*,/g, ',');
  return template(name || description, description);
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

/** The text an asset contributes when its tag is substituted into a prompt. */
export function assetPromptText(asset) {
  if (!asset) return '';
  const name = (asset.name || asset.tag || '').trim();
  const description = (asset.description || '').trim();
  if (name && description) return `${name} (${description})`;
  return name || description;
}

/**
 * Resolve every <Tag> in `text`.
 *
 * Returns the rewritten prompt, the reference image paths the matched assets
 * contribute (in first-appearance order, de-duplicated), the assets that were
 * used, and any tags with no matching asset so the UI can warn about typos.
 */
export function resolvePromptTags(text, assetLibrary) {
  const resolved = [];
  const missing = [];
  const imagePaths = [];
  const seenPaths = new Set();

  if (!text) {
    return { text: '', imagePaths, assets: resolved, missing };
  }

  TAG_PATTERN.lastIndex = 0;
  const rewritten = text.replace(TAG_PATTERN, (whole, rawTag) => {
    const asset = findAssetByTag(assetLibrary, rawTag);
    if (!asset) {
      if (!missing.some(t => normalizeTag(t) === normalizeTag(rawTag))) missing.push(rawTag.trim());
      return whole; // leave the literal <Tag> so the mistake stays visible
    }
    if (!resolved.some(a => a.id === asset.id)) {
      resolved.push(asset);
      // Exactly one image per asset: the primary. `images` is the asset's
      // iteration gallery — the rejected takes — so sending all of them lets a
      // single character with a long history eat every input slot and starve
      // the other tags in the prompt.
      const imagePath = assetPrimaryImage(asset);
      if (imagePath && !seenPaths.has(imagePath)) {
        seenPaths.add(imagePath);
        imagePaths.push(imagePath);
      }
    }
    return assetPromptText(asset) || whole;
  });

  return { text: rewritten, imagePaths, assets: resolved, missing };
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
  modelId = ''
}) {
  const resolution = resolvePromptTags(prompt, assetLibrary);
  const finalPrompt = joinFragments([prePrompt, resolution.text, postPrompt]);

  // Map each tagged image back to the asset it came from, for labelling.
  const tagByPath = new Map();
  resolution.assets.forEach(asset => {
    const imagePath = assetPrimaryImage(asset);
    if (imagePath && !tagByPath.has(imagePath)) tagByPath.set(imagePath, asset.tag);
  });

  const ordered = [];
  const seen = new Set();
  const push = (imagePath, origin, label) => {
    if (!imagePath || seen.has(imagePath) || (Array.isArray(excludedImagePaths) && excludedImagePaths.includes(imagePath))) return;
    seen.add(imagePath);
    ordered.push({ path: imagePath, origin, label });
  };

  primaryImagePaths.forEach(p => push(p, 'primary', type === 'video' ? 'Shot image' : 'Selected reference'));
  if (attachTaggedImages) {
    resolution.imagePaths.forEach(p => push(p, 'tag', `<${tagByPath.get(p) || '?'}>`));
  }

  const capacity = refImageCapacity(type, modelId);
  const kept = capacity > 0 ? ordered.slice(0, capacity) : [];
  const dropped = ordered.slice(kept.length);

  return {
    prompt: finalPrompt,
    inputImagePaths: kept.map(entry => entry.path),
    imageSources: kept,
    droppedImageSources: dropped,
    droppedImagePaths: dropped.map(entry => entry.path),
    taggedAssets: resolution.assets,
    // Assets whose images were left out entirely — the caller may want to warn.
    unusedTaggedAssets: attachTaggedImages
      ? resolution.assets.filter(a => {
        const imagePath = assetPrimaryImage(a);
        return imagePath && !kept.some(k => k.path === imagePath);
      })
      : resolution.assets,
    attachTaggedImages,
    missingTags: resolution.missing,
    capacity
  };
}
