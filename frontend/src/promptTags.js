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
      const assetImages = asset.primaryImage
        ? [asset.primaryImage, ...(asset.images || []).filter(p => p !== asset.primaryImage)]
        : (asset.images || []);
      assetImages.forEach(imagePath => {
        if (imagePath && !seenPaths.has(imagePath)) {
          seenPaths.add(imagePath);
          imagePaths.push(imagePath);
        }
      });
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
 * Build the exact string sent to a generation model.
 *
 * Applies the global pre-prompt, the shot prompt with its <Tag>s substituted,
 * and the global post-prompt, then works out which reference images travel with
 * it — tagged assets first, then whatever the user picked by hand, trimmed to
 * what the target model actually accepts.
 */
export function composeGenerationPrompt({
  prompt,
  prePrompt = '',
  postPrompt = '',
  assetLibrary = [],
  manualImagePaths = [],
  type = 'image',
  modelId = ''
}) {
  const resolution = resolvePromptTags(prompt, assetLibrary);
  const finalPrompt = joinFragments([prePrompt, resolution.text, postPrompt]);

  const capacity = refImageCapacity(type, modelId);
  const merged = [];
  [...resolution.imagePaths, ...manualImagePaths].forEach(imagePath => {
    if (imagePath && !merged.includes(imagePath)) merged.push(imagePath);
  });
  const inputImagePaths = capacity > 0 ? merged.slice(0, capacity) : [];

  return {
    prompt: finalPrompt,
    inputImagePaths,
    droppedImagePaths: merged.slice(inputImagePaths.length),
    taggedAssets: resolution.assets,
    missingTags: resolution.missing,
    capacity
  };
}
