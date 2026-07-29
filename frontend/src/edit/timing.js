// Timeline arithmetic. Pure functions, no React and no I/O, so the fiddly parts
// can be tested directly with `node --test`.
//
// Two ideas carry most of the weight here.
//
// `transition` is authoritative and geometry derives from it. A dissolve is
// stored as a duration on the arriving clip; the overlap you see on the
// timeline is computed from it. Dragging a clip into its neighbour in free mode
// writes the transition rather than becoming a second, competing source of
// truth about how long the dissolve is.
//
// Smart mode is an invariant, not a mode with its own code path. Every mutation
// ends in `normalize`, which either reflows the sequence so it has no holes
// (smart) or sorts it by start time and reads the overlaps back (free).

import { resolveClipSource, findShot, FALLBACK_CLIP_SECONDS } from './model.js';

/** No clip may be trimmed shorter than this. Roughly one frame at 24fps. */
export const MIN_CLIP_SECONDS = 0.05;

/** Slop for comparing float seconds. Well under a frame at any sane rate. */
const EPSILON = 1e-4;

/**
 * @typedef {object} TimingContext
 * @property {Array} scenes    the shot list, for resolving shot-backed clips
 * @property {object} durations probe cache keyed by asset path
 * @property {number} [fallbackSeconds] how long to hold a still with no explicit out
 */

export function makeContext(scenes, durations, fallbackSeconds = FALLBACK_CLIP_SECONDS) {
  return { scenes: scenes || [], durations: durations || {}, fallbackSeconds };
}

// --- clip measurement -------------------------------------------------------

/**
 * How much material the source has, in seconds.
 *
 * Stills return Infinity: an image can be held for as long as you like, so
 * "stretch until the source runs out" correctly never stops you.
 * Unprobed video also returns Infinity rather than guessing — clamping a trim
 * against a number we made up would silently destroy the user's edit.
 */
export function sourceDuration(clip, ctx) {
  const resolved = resolveClipSource(clip, ctx.scenes);
  if (resolved.kind === 'image') return Infinity;
  if (!resolved.path) return Infinity;
  const probe = ctx.durations[resolved.path];
  const duration = Number(probe?.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : Infinity;
}

/** The furthest `out` a clip may be trimmed to. */
export function maxOut(clip, ctx) {
  return sourceDuration(clip, ctx);
}

/**
 * How long a clip runs on the timeline.
 *
 * `out: null` means "to the end of the source", which is how an untrimmed clip
 * inherits the length of whatever take is selected right now. When the source
 * has no measurable length — a still, or a video we have not probed — a still
 * falls back to the shot's own videoDuration, matching what the existing
 * concatenate endpoint already does for image-only shots.
 */
export function clipLength(clip, ctx) {
  const inPoint = Math.max(0, Number(clip.in) || 0);

  if (clip.out !== null && clip.out !== undefined) {
    return Math.max(MIN_CLIP_SECONDS, Number(clip.out) - inPoint);
  }

  const natural = sourceDuration(clip, ctx);
  if (Number.isFinite(natural)) {
    return Math.max(MIN_CLIP_SECONDS, natural - inPoint);
  }
  return Math.max(MIN_CLIP_SECONDS, stillSeconds(clip, ctx) - inPoint);
}

/** How long to hold a shot that only has a still image. */
function stillSeconds(clip, ctx) {
  if (clip.source?.kind === 'shot') {
    const shot = findShot(ctx.scenes, clip.source.shotId);
    const perShot = Number(shot?.videoDuration);
    if (Number.isFinite(perShot) && perShot > 0) return perShot;
  }
  return ctx.fallbackSeconds;
}

export function clipEnd(clip, ctx) {
  return (Number(clip.start) || 0) + clipLength(clip, ctx);
}

/** The concrete out point, resolving `null` against the current source. */
export function effectiveOut(clip, ctx) {
  return (Number(clip.in) || 0) + clipLength(clip, ctx);
}

/**
 * How far this clip overlaps the one before it. Only dissolves overlap — a dip
 * to black is a straight cut with a fade either side of it.
 */
export function overlapOf(clip) {
  if (clip?.transition?.type !== 'dissolve') return 0;
  return Math.max(0, Number(clip.transition.duration) || 0);
}

// --- the invariant ----------------------------------------------------------

/**
 * Lay the sequence out end to end with no holes, honouring dissolve overlaps.
 * Array order is the edit order; start times are entirely derived.
 */
function reflow(clips, ctx) {
  let cursor = 0;
  return clips.map((clip, index) => {
    const overlap = index === 0 ? 0 : Math.min(overlapOf(clip), cursor);
    const start = Math.max(0, cursor - overlap);
    cursor = start + clipLength(clip, ctx);
    return clip.start === start ? clip : { ...clip, start };
  });
}

/**
 * Sort by start time and read each overlap back out as a dissolve.
 *
 * This is the free-mode half: the user dragged clips to wherever they wanted
 * them, so geometry is what they meant, and any overlap they created is a
 * dissolve of exactly that length. A dip survives a non-overlapping boundary
 * because it never implied an overlap in the first place.
 */
function readBackOverlaps(clips, ctx) {
  const sorted = [...clips].sort((a, b) => (a.start - b.start) || 0);
  let previousEnd = null;

  return sorted.map((clip, index) => {
    if (index === 0) {
      previousEnd = clipEnd(clip, ctx);
      return clip.transition ? { ...clip, transition: null } : clip;
    }

    const overlap = previousEnd - clip.start;
    let transition = null;
    if (overlap > EPSILON) {
      const type = clip.transition?.type === 'dip' ? 'dissolve' : (clip.transition?.type || 'dissolve');
      transition = { type: type === 'dip' ? 'dissolve' : type, duration: overlap };
    } else if (clip.transition?.type === 'dip') {
      transition = { ...clip.transition };
    }

    previousEnd = clipEnd(clip, ctx);
    return sameTransition(clip.transition, transition) ? clip : { ...clip, transition };
  });
}

function sameTransition(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.type === b.type && Math.abs(a.duration - b.duration) < EPSILON;
}

/**
 * Clamp every dissolve so it cannot be longer than the material either side of
 * it has to give. An overlap longer than its shorter neighbour would make
 * xfade's offset go negative at render time.
 */
function clampTransitions(clips, ctx) {
  return clips.map((clip, index) => {
    if (index === 0) return clip.transition ? { ...clip, transition: null } : clip;
    if (!clip.transition) return clip;

    const budget = Math.min(clipLength(clips[index - 1], ctx), clipLength(clip, ctx));
    const capped = Math.max(0, Math.min(clip.transition.duration, budget - MIN_CLIP_SECONDS));
    if (capped <= EPSILON) return { ...clip, transition: null };
    if (Math.abs(capped - clip.transition.duration) < EPSILON) return clip;
    return { ...clip, transition: { ...clip.transition, duration: capped } };
  });
}

/** Re-establish the document's invariants after any mutation. */
export function normalize(edit, ctx) {
  const ordered = edit.smart
    ? [...edit.video]
    : [...edit.video].sort((a, b) => (a.start - b.start) || 0);

  const clamped = clampTransitions(ordered, ctx);
  const video = edit.smart ? reflow(clamped, ctx) : readBackOverlaps(clamped, ctx);

  return { ...edit, video };
}

// --- video track operations -------------------------------------------------

function withVideo(edit, video, ctx) {
  return normalize({ ...edit, video }, ctx);
}

function indexOfClip(edit, clipId) {
  return edit.video.findIndex(clip => clip.id === clipId);
}

/**
 * Trim one edge of a clip.
 *
 * `out` is clamped to however much material the source actually has, which is
 * the "it will only stretch as far as the max length of the clip" rule; in
 * smart mode the reflow in `normalize` then pushes or pulls everything after it.
 */
export function setClipTrim(edit, clipId, edge, value, ctx) {
  const index = indexOfClip(edit, clipId);
  if (index < 0) return edit;

  const clip = edit.video[index];
  const resolved = resolveClipSource(clip, ctx.scenes);
  const limit = maxOut(clip, ctx);
  const currentOut = effectiveOut(clip, ctx);

  let nextIn = Number(clip.in) || 0;
  let nextOut = currentOut;

  if (edge === 'in') {
    nextIn = clamp(value, 0, currentOut - MIN_CLIP_SECONDS);
  } else {
    const ceiling = Number.isFinite(limit) ? limit : Infinity;
    nextOut = clamp(value, nextIn + MIN_CLIP_SECONDS, ceiling);
  }

  const next = {
    ...clip,
    in: nextIn,
    out: nextOut,
    manual: true,
    boundTo: resolved.path || clip.boundTo
  };

  const video = [...edit.video];
  video[index] = next;
  return withVideo(edit, video, ctx);
}

/** Drop a trim so the clip goes back to following its source's full length. */
export function clearClipTrim(edit, clipId, ctx) {
  const index = indexOfClip(edit, clipId);
  if (index < 0) return edit;
  const video = [...edit.video];
  video[index] = { ...video[index], in: 0, out: null, boundTo: null };
  return withVideo(edit, video, ctx);
}

/**
 * Where a clip dropped at `targetStart` belongs in the running order.
 * Compares centres rather than edges so a clip dragged halfway over its
 * neighbour lands on the side the user is actually aiming at.
 */
export function insertionIndexForTime(others, targetStart, length, ctx) {
  const centre = targetStart + length / 2;
  let index = 0;
  for (const clip of others) {
    const otherCentre = clip.start + clipLength(clip, ctx) / 2;
    if (otherCentre >= centre) break;
    index += 1;
  }
  return index;
}

/**
 * Move a clip to a time. In smart mode this becomes a reorder — the drop time
 * picks an insertion point and the sequence closes back up around it. In free
 * mode the clip simply lands where it was dropped.
 */
export function moveClipToTime(edit, clipId, targetStart, ctx) {
  const index = indexOfClip(edit, clipId);
  if (index < 0) return edit;

  const clip = edit.video[index];
  const start = Math.max(0, targetStart);

  if (!edit.smart) {
    const video = [...edit.video];
    video[index] = { ...clip, start, manual: true };
    return withVideo(edit, video, ctx);
  }

  const others = edit.video.filter(other => other.id !== clipId);
  const target = insertionIndexForTime(others, start, clipLength(clip, ctx), ctx);
  others.splice(target, 0, { ...clip, manual: true });
  return withVideo(edit, others, ctx);
}

/** Move a clip to an explicit position in the running order. */
export function moveClipToIndex(edit, clipId, targetIndex, ctx) {
  const index = indexOfClip(edit, clipId);
  if (index < 0) return edit;
  const video = [...edit.video];
  const [clip] = video.splice(index, 1);
  const bounded = clamp(targetIndex, 0, video.length);
  video.splice(bounded, 0, clip);
  return withVideo(edit, video, ctx);
}

export function removeVideoClip(edit, clipId, ctx) {
  const video = edit.video.filter(clip => clip.id !== clipId);
  if (video.length === edit.video.length) return edit;
  // Anything linked to the clip goes with it.
  const audio = (edit.audio || []).map(track => ({
    ...track,
    clips: (track.clips || []).filter(clip => clip.link?.clipId !== clipId)
  }));
  return normalize({ ...edit, video, audio }, ctx);
}

/** Cut a clip in two at an absolute timeline position. */
export function splitClipAtTime(edit, clipId, time, ctx) {
  const index = indexOfClip(edit, clipId);
  if (index < 0) return edit;

  const clip = edit.video[index];
  const offset = time - clip.start;
  const length = clipLength(clip, ctx);
  if (offset <= MIN_CLIP_SECONDS || offset >= length - MIN_CLIP_SECONDS) return edit;

  const inPoint = Number(clip.in) || 0;
  const cut = inPoint + offset;
  const resolved = resolveClipSource(clip, ctx.scenes);

  const left = { ...clip, out: cut, manual: true, boundTo: resolved.path || clip.boundTo };
  const right = {
    ...clip,
    id: `${clip.id}_b${Math.random().toString(36).slice(2, 6)}`,
    in: cut,
    out: effectiveOut(clip, ctx),
    start: clip.start + offset,
    transition: null,
    manual: true,
    boundTo: resolved.path || clip.boundTo
  };

  const video = [...edit.video];
  video.splice(index, 1, left, right);
  return withVideo(edit, video, ctx);
}

export function setTransition(edit, clipId, transition, ctx) {
  const index = indexOfClip(edit, clipId);
  if (index <= 0) return edit; // the first clip has nothing to arrive from
  const video = [...edit.video];
  video[index] = { ...video[index], transition: transition || null };
  return withVideo(edit, video, ctx);
}

/**
 * Toggle ripple editing. Turning it on closes any holes immediately, which is
 * the point of the mode — you should not have to hunt for gaps afterwards.
 */
export function setSmart(edit, smart, ctx) {
  const ordered = [...edit.video].sort((a, b) => (a.start - b.start) || 0);
  return normalize({ ...edit, smart: Boolean(smart), video: ordered }, ctx);
}

// --- the resolved timeline --------------------------------------------------

/**
 * The absolute-time view of the document that both the preview engine and the
 * ffmpeg graph builder consume. Deriving them from one function is what keeps
 * what you watch and what you render in agreement.
 */
export function buildTimeline(edit, ctx) {
  const video = edit.video.map((clip, index) => {
    const length = clipLength(clip, ctx);
    return {
      clip,
      index,
      resolved: resolveClipSource(clip, ctx.scenes),
      start: clip.start,
      end: clip.start + length,
      length,
      in: Number(clip.in) || 0,
      out: effectiveOut(clip, ctx),
      transition: clip.transition || null,
      // Flagged when a trim was measured against a take that is no longer the
      // select, so the UI can badge it instead of silently mangling the edit.
      stale: Boolean(clip.boundTo && resolveClipSource(clip, ctx.scenes).path
        && clip.boundTo !== resolveClipSource(clip, ctx.scenes).path)
    };
  });

  const byId = new Map(video.map(entry => [entry.clip.id, entry]));

  const audio = (edit.audio || []).map(track => ({
    track,
    clips: (track.clips || []).map(clip => {
      const anchor = clip.link ? byId.get(clip.link.clipId) : null;
      const start = anchor ? anchor.start + (clip.link.offset || 0) : clip.start;
      const length = clipLength(clip, ctx);
      return {
        clip,
        resolved: resolveClipSource(clip, ctx.scenes),
        start,
        end: start + length,
        length,
        in: Number(clip.in) || 0,
        out: effectiveOut(clip, ctx),
        gain: Number(clip.gain) || 0,
        fadeIn: Number(clip.fadeIn) || 0,
        fadeOut: Number(clip.fadeOut) || 0
      };
    })
  }));

  const ends = [
    ...video.map(entry => entry.end),
    ...audio.flatMap(entry => entry.clips.map(clip => clip.end))
  ];

  return {
    settings: edit.settings,
    smart: edit.smart,
    video,
    audio,
    duration: ends.length ? Math.max(...ends) : 0
  };
}

/** The clip under the playhead, plus the one dissolving in over it. */
export function clipsAtTime(timeline, time) {
  const active = timeline.video.filter(entry => time >= entry.start - EPSILON && time < entry.end - EPSILON);
  if (active.length === 0) return { current: null, incoming: null, mix: 0 };
  if (active.length === 1) return { current: active[0], incoming: null, mix: 0 };

  // Overlapping means a dissolve: the earlier clip is on its way out.
  const [current, incoming] = active.sort((a, b) => a.start - b.start);
  const span = current.end - incoming.start;
  const mix = span > EPSILON ? clamp((time - incoming.start) / span, 0, 1) : 1;
  return { current, incoming, mix };
}

function clamp(value, low, high) {
  const n = Number(value);
  if (!Number.isFinite(n)) return low;
  return Math.min(Math.max(n, low), high);
}
