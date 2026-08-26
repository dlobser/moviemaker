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

import {
  resolveClipSource, findShot, createAudioTrack, createAudioClip, FALLBACK_CLIP_SECONDS
} from './model.js';

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
 * Whether the source has a soundtrack at all.
 *
 * Generated clips very often have no audio stream, and offering level and fade
 * controls for silence is just misleading. Unknown counts as yes: the hosted
 * build cannot inspect streams, and wrongly silencing real audio is the worse
 * mistake of the two.
 */
export function sourceHasAudio(clip, ctx) {
  const resolved = resolveClipSource(clip, ctx.scenes);
  if (resolved.kind === 'image' || !resolved.path) return false;
  const probe = ctx.durations[resolved.path];
  return probe?.hasAudio !== false;
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

/** How long to hold a still: the clip's own setting, then the shot's, then the default. */
function stillSeconds(clip, ctx) {
  const perClip = Number(clip.stillSeconds);
  if (Number.isFinite(perClip) && perClip > 0) return perClip;
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

  return syncCompanions({ ...edit, video }, ctx);
}

// --- linked sound -----------------------------------------------------------
//
// A picture clip with a soundtrack gets that soundtrack as its own clip on an
// audio track, pinned to it. Two clips, one gesture: trim, move, split or delete
// the picture and the sound goes with it, exactly like an A/V pair in Premiere.
// Unlinking is what breaks the pair, and after that the sound is an ordinary
// clip sitting at an absolute time.
//
// The pairing is written down twice on purpose. `detachedFrom` says which
// picture clip this sound came off — permanent, and what makes "restore the
// audio" possible. `link` says whether it is still following that clip — the
// thing unlinking clears. A companion is a clip where both agree.

/** Is this the sound of that picture clip, still following it? */
export function isCompanion(audioClip) {
  return Boolean(audioClip?.detachedFrom)
    && Boolean(audioClip?.link)
    && audioClip.link.clipId === audioClip.detachedFrom;
}

/** The sound clip belonging to a picture clip, linked or not. */
export function companionOf(edit, videoClipId) {
  for (const track of edit.audio || []) {
    for (const clip of track.clips || []) {
      if (clip.detachedFrom === videoClipId) return { track, clip };
    }
  }
  return null;
}

/**
 * Make every companion's trim agree with the picture it follows.
 *
 * The picture clip is the single source of truth for the pair's in and out
 * points, so there is nothing to keep in step by hand — trimming picture, or
 * splitting it, or dropping a longer take underneath it, all land here. Only
 * placement stays the companion's own business, via `link.offset`, which is how
 * a sync nudge survives.
 */
function syncCompanions(edit, ctx) {
  if (!(edit.audio || []).length) return edit;
  const byId = new Map(edit.video.map(clip => [clip.id, clip]));
  let changed = false;

  const audio = (edit.audio || []).map(track => {
    const clips = (track.clips || []).map(clip => {
      if (!isCompanion(clip)) return clip;
      const anchor = byId.get(clip.detachedFrom);
      if (!anchor) return clip;

      const inPoint = Math.max(0, Number(anchor.in) || 0);
      const outPoint = effectiveOut(anchor, ctx);
      if (Math.abs((Number(clip.in) || 0) - inPoint) < EPSILON
        && clip.out !== null && clip.out !== undefined
        && Math.abs(clip.out - outPoint) < EPSILON) {
        return clip;
      }
      changed = true;
      return { ...clip, in: inPoint, out: outPoint };
    });
    return changed ? { ...track, clips } : track;
  });

  return changed ? { ...edit, audio } : edit;
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
  let nextStart = clip.start;

  if (edge === 'in') {
    nextIn = clamp(value, 0, currentOut - MIN_CLIP_SECONDS);
    // Free mode has no reflow to close the hole a shortened head would leave,
    // so the clip's start follows the trim and the picture stays put. In smart
    // mode the start is derived anyway and the ripple does the same job.
    if (!edit.smart) nextStart = Math.max(0, clip.start + (nextIn - (Number(clip.in) || 0)));
  } else {
    const ceiling = Number.isFinite(limit) ? limit : Infinity;
    nextOut = clamp(value, nextIn + MIN_CLIP_SECONDS, ceiling);
  }

  const next = {
    ...clip,
    in: nextIn,
    out: nextOut,
    start: nextStart,
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
  // The sound is cut at the same frame and the tail handed to the new clip, so
  // one keystroke cuts the pair rather than leaving the audio running under both
  // halves and re-syncing itself the moment either is moved.
  const audio = splitCompanions(edit, clip.id, right.id, cut);
  return withVideo({ ...edit, audio }, video, ctx);
}

/** Cut every companion of `clipId` at `cut` and give the tail to `rightId`. */
function splitCompanions(edit, clipId, rightId, cut) {
  return (edit.audio || []).map(track => ({
    ...track,
    clips: (track.clips || []).flatMap(clip => {
      if (clip.detachedFrom !== clipId) return [clip];
      // An unlinked clip is nobody's other half any more; splitting the picture
      // is not a reason to cut it.
      if (!isCompanion(clip)) return [clip];

      const inPoint = Math.max(0, Number(clip.in) || 0);
      const outPoint = clip.out === null || clip.out === undefined ? null : Number(clip.out);
      if (cut <= inPoint + MIN_CLIP_SECONDS) return [clip];
      if (outPoint !== null && cut >= outPoint - MIN_CLIP_SECONDS) return [clip];

      return [
        { ...clip, out: cut },
        {
          ...clip,
          id: `${clip.id}_b${Math.random().toString(36).slice(2, 6)}`,
          in: cut,
          out: outPoint,
          detachedFrom: rightId,
          link: { clipId: rightId, offset: clip.link.offset || 0 }
        }
      ];
    })
  }));
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

// --- audio tracks -----------------------------------------------------------

export function addAudioTrack(edit, name) {
  const audio = [...(edit.audio || [])];
  audio.push(createAudioTrack(name || `Audio ${audio.length + 1}`));
  return { ...edit, audio };
}

export function removeAudioTrack(edit, trackId) {
  return { ...edit, audio: (edit.audio || []).filter(track => track.id !== trackId) };
}

/** Patch a track's mixer settings: gain, muted, solo, name. */
export function setTrackField(edit, trackId, patch) {
  return {
    ...edit,
    audio: (edit.audio || []).map(track => (
      track.id === trackId ? { ...track, ...patch } : track
    ))
  };
}

export function addAudioClip(edit, trackId, clip) {
  const audio = (edit.audio || []).map(track => (
    track.id === trackId ? { ...track, clips: [...(track.clips || []), clip] } : track
  ));
  return { ...edit, audio };
}

export function removeAudioClip(edit, clipId) {
  return {
    ...edit,
    audio: (edit.audio || []).map(track => ({
      ...track,
      clips: (track.clips || []).filter(clip => clip.id !== clipId)
    }))
  };
}

export function findAudioClip(edit, clipId) {
  for (const track of edit.audio || []) {
    const clip = (track.clips || []).find(candidate => candidate.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

/** Patch one audio clip's own settings: gain, fades, trim. */
export function setAudioClipField(edit, clipId, patch) {
  return {
    ...edit,
    audio: (edit.audio || []).map(track => ({
      ...track,
      clips: (track.clips || []).map(clip => (
        clip.id === clipId ? { ...clip, ...patch } : clip
      ))
    }))
  };
}

/**
 * Trim an audio clip, clamped to the material the source actually has.
 *
 * Unlike picture there is no ripple: audio sits at an absolute time (or hangs
 * off a video clip), so trimming the head moves the clip to keep the sound
 * where it was rather than shuffling anything else along.
 */
export function setAudioClipTrim(edit, clipId, edge, value, ctx) {
  const found = findAudioClip(edit, clipId);
  if (!found) return edit;

  const { clip } = found;

  // Half of a linked pair. The picture clip owns the trim, so the gesture is
  // forwarded there and `syncCompanions` brings the sound along — otherwise the
  // two would disagree until the next time anything touched the picture.
  if (isCompanion(clip)) {
    const anchor = edit.video.find(entry => entry.id === clip.detachedFrom);
    if (anchor) {
      const offset = clip.link.offset || 0;
      return setClipTrim(edit, anchor.id, edge, value - offset, ctx);
    }
  }
  const limit = sourceDuration(clip, ctx);
  const currentIn = Number(clip.in) || 0;
  const currentOut = effectiveOut(clip, ctx);

  if (edge === 'in') {
    const nextIn = clamp(value, 0, currentOut - MIN_CLIP_SECONDS);
    const shift = nextIn - currentIn;
    const patch = { in: nextIn, out: currentOut };
    if (clip.link) patch.link = { ...clip.link, offset: (clip.link.offset || 0) + shift };
    else patch.start = Math.max(0, clip.start + shift);
    return setAudioClipField(edit, clipId, patch);
  }

  const ceiling = Number.isFinite(limit) ? limit : Infinity;
  return setAudioClipField(edit, clipId, {
    out: clamp(value, currentIn + MIN_CLIP_SECONDS, ceiling)
  });
}

/**
 * Move an audio clip.
 *
 * A linked clip keeps its link and slips its offset instead of breaking away —
 * that is how you nudge a lip-sync a few frames without losing the fact that it
 * belongs to that shot. A free clip just takes the new absolute time.
 */
export function moveAudioClip(edit, clipId, start, ctx) {
  const found = findAudioClip(edit, clipId);
  if (!found) return edit;

  // Dragging either half of a linked pair drags both. Slipping sync against
  // the picture is a deliberate act, so it lives on the offset field in the
  // inspector rather than one pixel away from an ordinary move.
  if (ctx && isCompanion(found.clip)) {
    const anchor = edit.video.find(entry => entry.id === found.clip.detachedFrom);
    if (anchor) return moveClipToTime(edit, anchor.id, start - (found.clip.link.offset || 0), ctx);
  }

  if (found.clip.link) {
    const anchor = edit.video.find(clip => clip.id === found.clip.link.clipId);
    if (anchor) {
      const offset = start - anchor.start;
      return setAudioClipField(edit, clipId, { link: { ...found.clip.link, offset } });
    }
  }
  return setAudioClipField(edit, clipId, { start: Math.max(0, start), link: null });
}

/** Pin an audio clip to a video clip so the two travel together from now on. */
export function linkAudioClip(edit, clipId, videoClipId, ctx) {
  const found = findAudioClip(edit, clipId);
  const anchor = buildTimeline(edit, ctx).video.find(entry => entry.clip.id === videoClipId);
  if (!found || !anchor) return edit;
  const currentStart = found.clip.link ? anchor.start + found.clip.link.offset : found.clip.start;
  return setAudioClipField(edit, clipId, {
    link: { clipId: videoClipId, offset: currentStart - anchor.start }
  });
}

/** Cut an audio clip loose, freezing it wherever it currently sits. */
export function unlinkAudioClip(edit, clipId, ctx) {
  const timeline = buildTimeline(edit, ctx);
  for (const track of timeline.audio) {
    const entry = track.clips.find(candidate => candidate.clip.id === clipId);
    if (entry) return setAudioClipField(edit, clipId, { link: null, start: entry.start });
  }
  return edit;
}

/**
 * Lift a video clip's own soundtrack onto an audio track.
 *
 * Until this happens the audio is part of the picture clip and moves with it,
 * which is what you want almost always. Detaching leaves the sound where it is
 * so the picture can be cut against it.
 */
export function detachClipAudio(edit, videoClipId, ctx) {
  const index = edit.video.findIndex(clip => clip.id === videoClipId);
  if (index < 0) return edit;

  const clip = edit.video[index];
  // Already done. A clip whose companion was deleted keeps `detached` — that is
  // what stops the auto-link pass quietly putting it back — so the check is for
  // the clip, not the flag.
  if (companionOf(edit, videoClipId)) return edit;

  const entry = buildTimeline(edit, ctx).video[index];
  // A still has no soundtrack to lift, and neither does a silent take — which
  // most generated clips are.
  if (entry.resolved.kind !== 'video' || !sourceHasAudio(clip, ctx)) return edit;

  const companion = createAudioClip(
    { ...clip.source, stream: 'audio' },
    {
      start: entry.start,
      in: entry.in,
      out: entry.out,
      gain: clip.audio?.gain ?? 1,
      fadeIn: clip.audio?.fadeIn ?? 0,
      fadeOut: clip.audio?.fadeOut ?? 0,
      detachedFrom: videoClipId,
      link: { clipId: videoClipId, offset: 0 }
    }
  );

  const placed = claimPictureTrack(edit, entry.start, entry.end, ctx);
  const video = [...placed.edit.video];
  video[index] = { ...clip, audio: { ...clip.audio, detached: true } };
  return normalize(addAudioClip({ ...placed.edit, video }, placed.trackId, companion), ctx);
}

/**
 * An audio track this stretch of time is free on, making one if need be.
 *
 * Picture tracks are kept apart from imported music and voiceover: dropping a
 * clip's dialogue into the middle of somebody's score would be a rude surprise,
 * and the mute and solo buttons are per track, so the separation is what makes
 * them useful. Overlapping picture — a dissolve, or free mode — spills onto the
 * next one down, which is what A1/A2/A3 are for.
 */
function claimPictureTrack(edit, start, end, ctx) {
  const timeline = buildTimeline(edit, ctx);
  for (const trackEntry of timeline.audio) {
    if (!trackEntry.track.forPicture) continue;
    const clash = trackEntry.clips.some(entry => (
      entry.start < end - EPSILON && entry.end > start + EPSILON
    ));
    if (!clash) return { edit, trackId: trackEntry.track.id };
  }

  const count = (edit.audio || []).filter(track => track.forPicture).length;
  const next = addAudioTrack(edit, `Picture ${count + 1}`);
  const track = next.audio[next.audio.length - 1];
  return {
    edit: { ...next, audio: next.audio.map(entry => (
      entry.id === track.id ? { ...entry, forPicture: true } : entry
    )) },
    trackId: track.id
  };
}

/**
 * Give every picture clip that has sound its sound.
 *
 * Run whenever the timeline or the measurements change, which is how a clip
 * dropped from the bin, a take that finished generating, and a project opened
 * from before any of this existed all end up with the same layout.
 *
 * `sourceHasAudio` treats unknown as yes so the render never silences real
 * sound by accident; here the opposite is right, so the check is strict. An
 * unprobed clip is left alone and picked up on the pass after its probe lands.
 */
export function autoLinkClipAudio(edit, ctx) {
  let next = edit;
  for (const clip of edit.video) {
    if (clip.audio?.detached) continue;
    const resolved = resolveClipSource(clip, ctx.scenes);
    if (resolved.kind !== 'video' || !resolved.path) continue;
    if (ctx.durations?.[resolved.path]?.hasAudio !== true) continue;
    next = detachClipAudio(next, clip.id, ctx);
  }
  return next;
}

/** Put a detached soundtrack back into its picture clip. */
export function reattachClipAudio(edit, videoClipId, ctx) {
  const index = edit.video.findIndex(clip => clip.id === videoClipId);
  if (index < 0) return edit;

  const audio = (edit.audio || []).map(track => ({
    ...track,
    clips: (track.clips || []).filter(clip => clip.detachedFrom !== videoClipId)
  }));

  const video = [...edit.video];
  video[index] = { ...video[index], audio: { ...video[index].audio, detached: false } };
  return normalize({ ...edit, video, audio }, ctx);
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
      hasAudio: sourceHasAudio(clip, ctx),
      transition: clip.transition || null,
      // Flagged when a trim was measured against a take that is no longer the
      // select, so the UI can badge it instead of silently mangling the edit.
      stale: Boolean(clip.boundTo && resolveClipSource(clip, ctx.scenes).path
        && clip.boundTo !== resolveClipSource(clip, ctx.scenes).path)
    };
  });

  const byId = new Map(video.map(entry => [entry.clip.id, entry]));

  // Which picture clips have their sound on a track below them. Read once here
  // rather than searched per clip while drawing, and it belongs in the resolved
  // timeline anyway: the strip and the inspector should agree about what is
  // half of a pair without either of them working it out for itself.
  const companions = new Map();
  for (const track of edit.audio || []) {
    for (const clip of track.clips || []) {
      if (clip.detachedFrom) companions.set(clip.detachedFrom, clip);
    }
  }
  for (const entry of video) {
    const companion = companions.get(entry.clip.id);
    entry.companionId = companion ? companion.id : null;
    entry.paired = Boolean(companion && companion.link && companion.link.clipId === entry.clip.id);
  }

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
        hasAudio: sourceHasAudio(clip, ctx),
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

  // Solo is global: the moment any track is soloed, every track without it goes
  // quiet, which is the only reading of solo that is useful while mixing.
  const anySolo = audio.some(entry => entry.track.solo);

  return {
    settings: edit.settings,
    smart: edit.smart,
    video,
    audio,
    anySolo,
    duration: ends.length ? Math.max(...ends) : 0
  };
}

/** Whether a track should be heard, taking mute and the solo state together. */
export function trackAudible(track, anySolo) {
  if (anySolo) return Boolean(track.solo);
  return !track.muted;
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
