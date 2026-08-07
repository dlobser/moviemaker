// The edit document — MovieMaker's EDL.
//
// Parity with the shot list is structural rather than synced. A video clip
// stores a `shotId`, never a file path, and resolves its media through
// `shot.selectedVideo` every time it is drawn or rendered. Pick a new take as
// the select and the edit already points at it; there is nothing to reconcile
// and nothing to go stale.
//
// An untrimmed clip stores `out: null`, meaning "however long the source runs".
// A six second replacement for a five second take simply makes the clip longer.
// Trimming writes concrete in/out seconds plus `boundTo` — the asset those
// numbers were measured against — which is what lets us notice later that a
// trim no longer fits the take underneath it.
//
// Timeline arithmetic lives in ./timing.js. This module is only the shape of
// the document, how to build one from a shot list, and how to read a clip's
// source back out of the scenes.

export const EDIT_VERSION = 1;

/** Used when a clip's source has no measurable duration yet. */
export const FALLBACK_CLIP_SECONDS = 5;

export const DEFAULT_SETTINGS = {
  width: 1920,
  height: 1080,
  fps: 24,
  // Stays true until the user sets a resolution by hand, so the project keeps
  // adopting whatever most of the generated clips actually are.
  resolutionAuto: true
};

export const TRANSITION_TYPES = ['dissolve', 'dip'];

let idCounter = 0;

/** Unique enough for a document that only ever lives in one tab at a time. */
export function newId(prefix = 'ec') {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function createEmptyEdit() {
  return {
    version: EDIT_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    // Ripple editing. On, trimming and moving reflow every later clip so the
    // sequence never has a hole in it; off, clips sit wherever they are put.
    smart: true,
    video: [],
    audio: [],
    // The media bin: a curated list of external files brought into the edit,
    // not a folder scan — assets/ holds hundreds of generated iterations that
    // would drown one. Durations flow through `durations` like everything else.
    bin: [],
    durations: {}
  };
}

/** One bin entry. Type decides which track kinds it can land on. */
export function createBinItem({ path, name, type }) {
  return {
    id: newId('bin'),
    path,
    name: name || basename(path),
    type: ['video', 'audio', 'image'].includes(type) ? type : 'video',
    addedAt: new Date().toISOString()
  };
}

export function createVideoClip(source, overrides = {}) {
  return {
    id: newId('vc'),
    source,
    start: 0,
    in: 0,
    // null means "run to the end of the source", which is how a clip inherits
    // the length of whatever take is currently selected.
    out: null,
    boundTo: null,
    // The incoming transition, i.e. how this clip arrives from the one before
    // it. null is a straight cut.
    transition: null,
    audio: { gain: 1, fadeIn: 0, fadeOut: 0, detached: false },
    manual: false,
    ...overrides
  };
}

export function createAudioTrack(name, overrides = {}) {
  return {
    id: newId('at'),
    name,
    gain: 1,
    muted: false,
    solo: false,
    clips: [],
    ...overrides
  };
}

export function createAudioClip(source, overrides = {}) {
  return {
    id: newId('ac'),
    source,
    start: 0,
    in: 0,
    out: null,
    boundTo: null,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    // When set, this clip rides along with a video clip instead of sitting at
    // an absolute time. Unlinking clears it and freezes `start` where it was.
    link: null,
    // Set when this clip was pulled off a video clip, so it can be put back.
    detachedFrom: null,
    ...overrides
  };
}

/**
 * Lip-sync audio belongs to its shot, so it is placed automatically and linked
 * to that shot's picture — slipping the clip slips the sync with it.
 */
export function deriveAudioClipsForShots(scenes, videoClips) {
  const clips = [];
  for (const clip of videoClips || []) {
    if (clip.source?.kind !== 'shot') continue;
    const shot = findShot(scenes, clip.source.shotId);
    if (!shot?.lipSyncAudio) continue;
    clips.push(createAudioClip(
      { kind: 'shot', shotId: shot.id, stream: 'audio' },
      { link: { clipId: clip.id, offset: 0 } }
    ));
  }
  return clips;
}

// --- reading a clip's source back out of the shot list ----------------------

export function findShot(scenes, shotId) {
  for (const scene of scenes || []) {
    for (const shot of scene.shots || []) {
      if (shot.id === shotId) return shot;
    }
  }
  return null;
}

export function findSceneForShot(scenes, shotId) {
  return (scenes || []).find(scene =>
    (scene.shots || []).some(shot => shot.id === shotId)
  ) || null;
}

/**
 * What a clip actually points at right now.
 *
 * A shot-backed clip prefers its selected video and falls back to its selected
 * image, so a partly generated edit still plays end to end as an animatic and
 * silently upgrades itself to real footage as takes land.
 *
 * Returns `kind: 'missing'` rather than throwing — a shot can lose its select,
 * or be deleted out from under the edit, and the timeline still has to draw.
 */
export function resolveClipSource(clip, scenes) {
  const source = clip?.source;
  if (!source) return { kind: 'missing', path: null, name: 'Empty clip' };

  if (source.kind === 'asset') {
    return {
      kind: source.stream === 'audio' ? 'audio' : source.stream === 'image' ? 'image' : 'video',
      path: source.path || null,
      name: source.name || basename(source.path),
      shotId: null
    };
  }

  if (source.kind === 'shot') {
    const shot = findShot(scenes, source.shotId);
    if (!shot) {
      return { kind: 'missing', path: null, name: 'Deleted shot', shotId: source.shotId };
    }
    // An audio-stream clip reads the same video file, so a new take carries the
    // detached audio along with the picture.
    if (source.stream === 'audio') {
      const path = shot.lipSyncAudio || shot.selectedVideo || null;
      return {
        kind: path ? 'audio' : 'missing',
        path,
        name: shot.name || source.shotId,
        shotId: shot.id
      };
    }
    if (shot.selectedVideo) {
      return { kind: 'video', path: shot.selectedVideo, name: shot.name || shot.id, shotId: shot.id };
    }
    if (shot.selectedImage) {
      return { kind: 'image', path: shot.selectedImage, name: shot.name || shot.id, shotId: shot.id };
    }
    return { kind: 'missing', path: null, name: shot.name || shot.id, shotId: shot.id };
  }

  return { kind: 'missing', path: null, name: 'Unknown source' };
}

function basename(assetPath) {
  if (!assetPath) return 'Untitled';
  const parts = String(assetPath).split(/[\\/]/);
  return parts[parts.length - 1] || 'Untitled';
}

// --- building an edit from the shot list ------------------------------------

/**
 * A straight assembly of every shot that has something to show, in story order.
 * This is what a brand new edit starts as, and what "match story order" resets
 * the running order to.
 */
export function deriveVideoClips(scenes) {
  const clips = [];
  for (const scene of scenes || []) {
    for (const shot of scene.shots || []) {
      if (!shot.selectedVideo && !shot.selectedImage) continue;
      clips.push(createVideoClip({ kind: 'shot', shotId: shot.id }));
    }
  }
  return clips;
}

/** Every asset path the edit currently depends on, for probing. */
export function collectSourcePaths(edit, scenes) {
  const paths = new Set();
  for (const clip of edit?.video || []) {
    const resolved = resolveClipSource(clip, scenes);
    if (resolved.path) paths.add(resolved.path);
  }
  for (const track of edit?.audio || []) {
    for (const clip of track.clips || []) {
      const resolved = resolveClipSource(clip, scenes);
      if (resolved.path) paths.add(resolved.path);
    }
  }
  // Bin items measure through the same probe cache, so the panel can show a
  // duration before the file ever lands on a track.
  for (const item of edit?.bin || []) {
    if (item?.path) paths.add(item.path);
  }
  return [...paths];
}

// --- project settings -------------------------------------------------------

/**
 * The resolution most of the footage is already in.
 *
 * Ties break towards the larger frame, so a project split evenly between 720p
 * and 1080p masters at 1080p rather than throwing away detail. Stills are
 * ignored: an image's dimensions say nothing about what the edit should be.
 */
export function pickDefaultSettings(paths, durations, current = DEFAULT_SETTINGS) {
  const tally = new Map();
  let fpsTally = new Map();

  for (const path of paths || []) {
    const probe = durations?.[path];
    if (!probe || !probe.width || !probe.height) continue;
    if (probe.isImage) continue;

    const key = `${probe.width}x${probe.height}`;
    tally.set(key, (tally.get(key) || 0) + 1);
    if (probe.fps) fpsTally.set(probe.fps, (fpsTally.get(probe.fps) || 0) + 1);
  }

  if (tally.size === 0) return { ...current };

  let best = null;
  for (const [key, count] of tally) {
    const [width, height] = key.split('x').map(Number);
    if (!best
      || count > best.count
      || (count === best.count && width * height > best.width * best.height)) {
      best = { width, height, count };
    }
  }

  let bestFps = current.fps;
  let bestFpsCount = 0;
  for (const [fps, count] of fpsTally) {
    if (count > bestFpsCount) {
      bestFps = fps;
      bestFpsCount = count;
    }
  }

  return {
    ...current,
    width: best.width,
    height: best.height,
    fps: Math.round(bestFps) || current.fps
  };
}

// --- persistence ------------------------------------------------------------

/**
 * Coerce whatever came back from the project file into a usable document.
 *
 * Projects saved before the editor existed simply have no `edit` key, and older
 * ones may be missing fields added since. Everything is defaulted rather than
 * rejected — losing an edit because one field was absent would be a bad trade.
 */
export function migrateEdit(raw) {
  const base = createEmptyEdit();
  if (!raw || typeof raw !== 'object') return base;

  const settings = { ...base.settings, ...(raw.settings || {}) };
  settings.width = positiveInt(settings.width, base.settings.width);
  settings.height = positiveInt(settings.height, base.settings.height);
  settings.fps = positiveInt(settings.fps, base.settings.fps);
  settings.resolutionAuto = settings.resolutionAuto !== false;

  return {
    version: EDIT_VERSION,
    settings,
    smart: raw.smart !== false,
    video: (Array.isArray(raw.video) ? raw.video : []).map(normalizeVideoClip),
    audio: (Array.isArray(raw.audio) ? raw.audio : []).map(normalizeAudioTrack),
    bin: (Array.isArray(raw.bin) ? raw.bin : []).map(normalizeBinItem).filter(Boolean),
    durations: (raw.durations && typeof raw.durations === 'object') ? raw.durations : {}
  };
}

function normalizeBinItem(raw) {
  if (!raw || typeof raw !== 'object' || !raw.path) return null; // pathless items are junk
  return {
    id: raw.id || newId('bin'),
    path: raw.path,
    name: raw.name || basename(raw.path),
    type: ['video', 'audio', 'image'].includes(raw.type) ? raw.type : 'video',
    addedAt: raw.addedAt || new Date().toISOString()
  };
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeVideoClip(raw) {
  const clip = createVideoClip(raw?.source || { kind: 'shot', shotId: null });
  return {
    ...clip,
    ...raw,
    id: raw?.id || clip.id,
    start: Math.max(0, finiteOr(raw?.start, 0)),
    in: Math.max(0, finiteOr(raw?.in, 0)),
    out: raw?.out === null || raw?.out === undefined ? null : Math.max(0, finiteOr(raw.out, 0)),
    // Per-clip hold for stills; null = shot duration / project default.
    stillSeconds: Number(raw?.stillSeconds) > 0 ? Number(raw.stillSeconds) : null,
    transition: normalizeTransition(raw?.transition),
    audio: {
      gain: finiteOr(raw?.audio?.gain, 1),
      fadeIn: Math.max(0, finiteOr(raw?.audio?.fadeIn, 0)),
      fadeOut: Math.max(0, finiteOr(raw?.audio?.fadeOut, 0)),
      detached: Boolean(raw?.audio?.detached)
    },
    manual: Boolean(raw?.manual)
  };
}

function normalizeTransition(raw) {
  if (!raw || !TRANSITION_TYPES.includes(raw.type)) return null;
  const duration = Math.max(0, finiteOr(raw.duration, 0));
  if (duration <= 0) return null;
  return { type: raw.type, duration };
}

function normalizeAudioTrack(raw) {
  const track = createAudioTrack(raw?.name || 'Audio');
  return {
    ...track,
    ...raw,
    id: raw?.id || track.id,
    gain: finiteOr(raw?.gain, 1),
    muted: Boolean(raw?.muted),
    solo: Boolean(raw?.solo),
    clips: (Array.isArray(raw?.clips) ? raw.clips : []).map(normalizeAudioClip)
  };
}

function normalizeAudioClip(raw) {
  const clip = createAudioClip(raw?.source || { kind: 'asset', path: null });
  return {
    ...clip,
    ...raw,
    id: raw?.id || clip.id,
    start: Math.max(0, finiteOr(raw?.start, 0)),
    in: Math.max(0, finiteOr(raw?.in, 0)),
    out: raw?.out === null || raw?.out === undefined ? null : Math.max(0, finiteOr(raw.out, 0)),
    gain: finiteOr(raw?.gain, 1),
    fadeIn: Math.max(0, finiteOr(raw?.fadeIn, 0)),
    fadeOut: Math.max(0, finiteOr(raw?.fadeOut, 0)),
    link: raw?.link && raw.link.clipId
      ? { clipId: raw.link.clipId, offset: finiteOr(raw.link.offset, 0) }
      : null,
    detachedFrom: raw?.detachedFrom || null
  };
}
