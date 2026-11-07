// Reads over the v2 document (SCHEMA_V2.md §6 step 2).
//
// Each selector reproduces what the app reads from v1 today — a selected
// path, a prompt-group list, an asset's primary image — but over media, takes
// and looks. They are the seam the App is converted through one read site at
// a time; `selectedPath` exists only for that transition and goes when the
// last path-reading site is gone.
//
// Pure, no React, no caching beyond a per-document index that is rebuilt
// whenever the document object changes.

import { groupSignature } from '../schema/groupKey.js';
import { pathKey } from '../schema/paths.js';

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);

// --- basic lookups ------------------------------------------------------------

export function findShot(state, shotId) {
  for (const scene of list(state?.scenes)) {
    for (const shot of list(scene?.shots)) {
      if (shot?.id === shotId) return shot;
    }
  }
  return null;
}

export function findAsset(state, assetId) {
  return list(state?.assetLibrary).find(asset => asset?.id === assetId) || null;
}

export function mediaById(state, mediaId) {
  const record = mediaId && isObject(state?.media) ? state.media[mediaId] : null;
  return isObject(record) ? record : null;
}

export function takeById(state, takeId) {
  const record = takeId && isObject(state?.takes) ? state.takes[takeId] : null;
  return isObject(record) ? record : null;
}

/** The path a media id stands for, or null. */
export function mediaPath(state, mediaId) {
  return mediaById(state, mediaId)?.path ?? null;
}

// --- takes and selections -------------------------------------------------------

const takeIndexCache = new WeakMap();

/** Every take with its creation order, oldest first; ties keep map order. */
function orderedTakes(state) {
  const takes = isObject(state?.takes) ? state.takes : null;
  if (!takes) return [];
  if (takeIndexCache.has(takes)) return takeIndexCache.get(takes);
  const ordered = Object.values(takes)
    .filter(isObject)
    .map((take, index) => ({ take, index }))
    .sort((a, b) => String(a.take.createdAt || '').localeCompare(String(b.take.createdAt || '')) || a.index - b.index)
    .map(entry => entry.take);
  takeIndexCache.set(takes, ordered);
  return ordered;
}

/**
 * The takes a shot owns, oldest first. `kind` narrows to 'image' or 'video';
 * omit it for all of them.
 */
export function takesForShot(state, shotId, kind = null) {
  return orderedTakes(state).filter(take => (
    take.owner?.shotId === shotId && (kind === null || take.kind === kind)
  ));
}

/** The take a shot's `selection.image` / `selection.video` names, or null. */
export function selectedTake(state, shotId, kind) {
  const shot = findShot(state, shotId);
  return takeById(state, shot?.selection?.[kind]) || null;
}

/**
 * What `shot.selectedImage` / `shot.selectedVideo` returned in v1: the path of
 * the selected take's media, or null. Transitional.
 */
export function selectedPath(state, shotId, kind) {
  const take = selectedTake(state, shotId, kind);
  return take ? mediaPath(state, take.mediaId) : null;
}

/**
 * The v1 prompt-group view of a shot's takes: takes grouped by `groupKey`,
 * groups ordered by their first take's `createdAt`, outputs oldest first.
 *
 * Each group carries the recipe fields a v1 group had (paths restored from
 * media ids), the composed `prompt`, `inputImagePaths`, the `meta` snapshot
 * where a take holds it exactly, and `outputs` as `{ id, takeId, path, name,
 * createdAt }`. Lip-sync groups keep their v1 shape of `{ id, prompt, outputs }`.
 * Imported takes (a gallery pick adopted as a selection) were never in a
 * group and are not here either.
 */
export function groupsForShot(state, shotId, kind) {
  const groups = new Map();
  takesForShot(state, shotId, kind).forEach(take => {
    if (take.purpose === 'imported') return;
    if (!groups.has(take.groupKey)) groups.set(take.groupKey, []);
    groups.get(take.groupKey).push(take);
  });
  return [...groups.entries()].map(([groupKey, takes]) => buildGroupView(state, kind, groupKey, takes));
}

function buildGroupView(state, kind, groupKey, takes) {
  const first = takes[0];
  const path = (mediaId) => mediaPath(state, mediaId);
  const outputs = takes.map(take => ({
    id: take.legacy?.outputId || take.id,
    takeId: take.id,
    path: path(take.mediaId),
    name: take.annotations?.name || '',
    createdAt: take.createdAt
  }));
  const id = first.legacy?.groupId || `group_${kind}_${first.id}`;

  if (first.purpose === 'lipsync') {
    return { id, groupKey, purpose: 'lipsync', prompt: first.recipe?.prompt ?? '', outputs, takes };
  }

  const recipe = first.recipe || {};
  const inputImagePaths = list(first.inputs).map(input => input.url || path(input.mediaId)).filter(Boolean);
  const group = {
    id,
    groupKey,
    purpose: first.purpose,
    rawPrompt: recipe.rawPrompt ?? '',
    model: recipe.model ?? '',
    resolution: recipe.resolution ?? '',
    primaryImagePaths: list(recipe.primaryInputs).map(path).filter(Boolean),
    attachTaggedImages: recipe.attachTaggedImages !== false,
    excludedImagePaths: list(recipe.excludedInputs).map(path).filter(Boolean),
    usePrePrompt: recipe.usePrePrompt !== false,
    usePostPrompt: recipe.usePostPrompt !== false,
    promptOverride: recipe.promptOverride ?? null,
    prompt: recipe.prompt ?? '',
    inputImagePaths,
    outputs,
    takes
  };
  if (recipe.duration !== null && recipe.duration !== undefined) group.duration = recipe.duration;
  if (kind === 'video') group.imageInput = inputImagePaths[0] || '';

  // The snapshot dirty detection compared against: the newest take that holds
  // the group's asset revisions exactly. Group-latest takes carry a copy of it
  // but cannot vouch for it, so they do not get to define the group's meta.
  const exact = [...takes].reverse().find(take => take.assetRevisionsConfidence === 'exact' && isObject(take.assetRevisions));
  if (exact) {
    group.meta = {
      taggedAssetIds: Object.keys(exact.assetRevisions),
      assetStamps: Object.fromEntries(Object.entries(exact.assetRevisions).map(([assetId, stamp]) => [
        assetId, { updatedAt: stamp.updatedAt ?? null, primaryImage: path(stamp.primaryMediaId) }
      ])),
      createdAt: exact.createdAt
    };
  }
  return group;
}

/** The signature a (re)built group would get — the same function the migration used. */
export function groupKeyOf(kind, group) {
  return groupSignature(kind, group);
}

// --- assets and looks -------------------------------------------------------------

/**
 * The look a shot sees for an asset: the one bound in `shot.assetLooks`, else
 * the asset's default. Null when the asset or look does not exist.
 */
export function lookFor(state, assetId, shotId = null) {
  const asset = findAsset(state, assetId);
  if (!asset) return null;
  const shot = shotId ? findShot(state, shotId) : null;
  const lookId = shot?.assetLooks?.[assetId] || asset.defaultLookId;
  return list(asset.looks).find(look => look?.id === lookId) || null;
}

/**
 * A look's images with their media resolved: `{ mediaId, path, primary,
 * enabled, view, media }`, in pool order.
 */
export function lookImages(state, assetId, shotId = null) {
  const look = lookFor(state, assetId, shotId);
  return list(look?.images).map(image => {
    const media = mediaById(state, image?.mediaId);
    return { ...image, path: media?.path ?? null, media };
  });
}

/**
 * What `assetPrimaryImage` returned in v1: the primary, else the first image
 * in the pool, as a path.
 */
export function lookPrimaryPath(state, assetId, shotId = null) {
  const images = lookImages(state, assetId, shotId);
  const primary = images.find(image => image.primary) || images[0] || null;
  return primary?.path ?? null;
}

/**
 * What `assetInputImages` returned in v1: the ticked pool images, in pool
 * order, as paths.
 */
export function lookEnabledPaths(state, assetId, shotId = null) {
  return lookImages(state, assetId, shotId).filter(image => image.enabled && image.path).map(image => image.path);
}

// --- the board and bindings ---------------------------------------------------------

/** Every media on the reference board, oldest first (v1 kept the board in insertion order). */
export function boardMedia(state) {
  return Object.values(isObject(state?.media) ? state.media : {})
    .filter(record => isObject(record) && isObject(record.reference))
    .map((record, index) => ({ record, index }))
    .sort((a, b) => String(a.record.createdAt || '').localeCompare(String(b.record.createdAt || '')) || a.index - b.index)
    .map(entry => entry.record);
}

const pathIndexCache = new WeakMap();

/** The media a path names, by the same identity rule the migration merged on. */
export function mediaByPath(state, path) {
  const media = isObject(state?.media) ? state.media : null;
  if (!media) return null;
  const key = pathKey(path);
  if (!key) return null;
  let index = pathIndexCache.get(media);
  if (!index) {
    index = new Map();
    Object.values(media).forEach(record => {
      if (isObject(record) && typeof record.path === 'string' && !index.has(pathKey(record.path))) {
        index.set(pathKey(record.path), record);
      }
    });
    pathIndexCache.set(media, index);
  }
  return index.get(key) || null;
}

/** Bindings on one target, by order. `targetId` is ignored for project scope. */
export function bindingsFor(state, scope, targetId = null) {
  return list(state?.bindings)
    .filter(binding => binding?.scope === scope && (scope === 'project' || binding.targetId === targetId))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
