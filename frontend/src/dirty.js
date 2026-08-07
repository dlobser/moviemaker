// Dirty-shot detection: is a shot's selected image/video stale because an
// asset it referenced by <Tag> has changed since the generation ran?
//
// Pure functions, no React — the shot-card badges, the batch filters and the
// pipeline orchestrator all import these instead of growing second
// implementations.
//
// Two eras of data:
//  * Generations after Phase C.1 carry `group.meta` — the tagged asset ids
//    and a snapshot of each asset (updatedAt, primaryImage) at generation
//    time — and assets carry `updatedAt` stamps on shot-visible edits.
//  * Older projects have neither. The BACKWARD-COMPATIBLE FALLBACK recomposes
//    instead: does the stored composed prompt still contain the asset's
//    current "name (description)" substitution? Description drift breaks
//    containment. This misses renames and reverted edits — accepted; the
//    forward path takes over from the first regeneration onward.
//
// Deliberate scope (what does NOT dirty a shot): global pre/post prompt
// changes (that is intentional retuning and would flag every shot at once),
// board changes that do not move an asset's effective primary, asset
// generation-settings changes, prompt-snippet edits. A missing/renamed tag is
// not dirty either — it surfaces separately as `missingTags`.

import { assetPromptText, assetPrimaryImage, extractTags, findAssetByTag } from './promptTags.js';

/** The prompt group that produced the currently selected output, if any. */
export function groupForSelection(groups = [], selectedPath) {
  if (!selectedPath) return null;
  return groups.find(group => (group.outputs || []).some(output => output.path === selectedPath)) || null;
}

/** The specific output record for the selection, else the newest one. */
function outputForSelection(group, selectedPath) {
  const outputs = group?.outputs || [];
  return outputs.find(output => output.path === selectedPath) || outputs[outputs.length - 1] || null;
}

/**
 * Judge one prompt group against the current asset library.
 * `sentPaths` is what actually went to the model (for the no-meta fallback).
 */
function groupDirtiness(group, selectedPath, assetLibrary) {
  const reasons = [];
  const missingTags = [];
  if (!group) return { dirty: false, reasons, missingTags };

  const rawPrompt = group.rawPrompt ?? '';
  const tags = extractTags(rawPrompt);
  if (tags.length === 0) return { dirty: false, reasons, missingTags };

  const output = outputForSelection(group, selectedPath);
  const reference = output?.createdAt || group.meta?.createdAt || null;
  const stamps = group.meta?.assetStamps || null;
  const attached = group.attachTaggedImages !== false;
  const sentPaths = Array.isArray(group.inputImagePaths)
    ? group.inputImagePaths
    : (group.imageInput ? [group.imageInput] : []);

  for (const tag of tags) {
    const asset = findAssetByTag(assetLibrary, tag);
    if (!asset) {
      missingTags.push(tag);
      continue;
    }

    // Text drift.
    if (asset.updatedAt && reference) {
      // Forward path: both sides stamped.
      if (asset.updatedAt > reference) {
        reasons.push(`<${asset.tag}> edited since this was generated`);
        continue;
      }
    } else {
      // Fallback: recompose — the composed prompt must still contain the
      // asset's current substitution text.
      const substitution = assetPromptText(asset);
      if (substitution && group.prompt && !group.prompt.includes(substitution)) {
        reasons.push(`<${asset.tag}>'s description no longer matches this prompt`);
        continue;
      }
    }

    // Primary-image drift, both eras. Generated files are immutable and
    // timestamp-named, so path comparison IS content comparison.
    if (attached) {
      const currentPrimary = assetPrimaryImage(asset);
      const stamp = stamps?.[asset.id];
      if (stamp !== undefined && stamp !== null) {
        if ((stamp.primaryImage || null) !== (currentPrimary || null)) {
          reasons.push(`<${asset.tag}>'s primary image changed`);
        }
      } else if (currentPrimary && sentPaths.length > 0 && !sentPaths.includes(currentPrimary)) {
        reasons.push(`<${asset.tag}>'s primary image was not the one sent`);
      }
    }
  }

  return { dirty: reasons.length > 0, reasons, missingTags };
}

/** Is this shot's selected image stale? */
export function imageDirtiness(shot, assetLibrary) {
  if (!shot?.selectedImage) return { dirty: false, reasons: [], missingTags: [] };
  const group = groupForSelection(shot.imagePrompts, shot.selectedImage);
  return groupDirtiness(group, shot.selectedImage, assetLibrary);
}

/**
 * Is this shot's selected video stale? The union of:
 *  (a) source-image drift — the still that was animated is no longer the
 *      shot's selected image;
 *  (b) the shot's image is itself dirty (regenerating it will then trip (a));
 *  (c) the video group's own tagged assets drifted.
 */
export function videoDirtiness(shot, assetLibrary) {
  if (!shot?.selectedVideo) return { dirty: false, reasons: [], missingTags: [] };
  const group = groupForSelection(shot.videoPrompts, shot.selectedVideo);
  if (!group) return { dirty: false, reasons: [], missingTags: [] };

  const own = groupDirtiness(group, shot.selectedVideo, assetLibrary);
  const reasons = [...own.reasons];

  const animated = group.imageInput
    || (Array.isArray(group.inputImagePaths) ? group.inputImagePaths[0] : null)
    || null;
  if (animated && shot.selectedImage && animated !== shot.selectedImage) {
    reasons.push('animates a different still than the one now selected');
  }

  const image = imageDirtiness(shot, assetLibrary);
  if (image.dirty) {
    reasons.push('its source image is itself stale');
  }

  return { dirty: reasons.length > 0, reasons, missingTags: own.missingTags };
}

/** Map of shotId -> { image, video } for memoised UI reads. */
export function buildDirtyMap(scenes = [], assetLibrary = []) {
  const map = new Map();
  for (const scene of scenes) {
    for (const shot of scene.shots || []) {
      map.set(shot.id, {
        image: imageDirtiness(shot, assetLibrary),
        video: videoDirtiness(shot, assetLibrary)
      });
    }
  }
  return map;
}

// Candidate helpers in the { shot, sceneName } shape the batch runners use —
// and exactly the "re-derive work from project state between stages" shape
// the pipeline orchestrator wants.

export function dirtyImageCandidates(scenes = [], assetLibrary = []) {
  const out = [];
  for (const scene of scenes) {
    for (const shot of scene.shots || []) {
      const state = imageDirtiness(shot, assetLibrary);
      if (state.dirty) out.push({ shot, sceneName: scene.name, dirtiness: state });
    }
  }
  return out;
}

export function dirtyVideoCandidates(scenes = [], assetLibrary = []) {
  const out = [];
  for (const scene of scenes) {
    for (const shot of scene.shots || []) {
      const state = videoDirtiness(shot, assetLibrary);
      if (state.dirty) out.push({ shot, sceneName: scene.name, dirtiness: state });
    }
  }
  return out;
}
