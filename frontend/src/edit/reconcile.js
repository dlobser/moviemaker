// Keeping the edit in step with the shot list as the shot list changes.
//
// Content parity needs none of this: a clip resolves its media through its
// shot every time it is drawn, so re-generating a take is picked up for free.
// What this handles is *structure* — shots that appeared, shots that were
// deleted, shots that were reordered — where guessing would destroy work.
//
// So nothing here runs on its own. Each change is offered, counted, and applied
// only when asked, because "the running order changed underneath me while I was
// cutting" is a far worse outcome than "I had to click a button".
//
// The one rule throughout: reordering and inserting must preserve trims,
// transitions and links. Rebuilding from scratch is a separate, deliberate act.

import { createVideoClip } from './model.js';
import { normalize } from './timing.js';

/** Every shot in story order that has something to show. */
export function storyOrder(scenes) {
  const shots = [];
  for (const scene of scenes || []) {
    for (const shot of scene.shots || []) {
      if (!shot.selectedVideo && !shot.selectedImage) continue;
      shots.push(shot);
    }
  }
  return shots;
}

/**
 * What differs between the shot list and the timeline.
 *
 * `reordered` compares only the shots present in both, so a pending insertion
 * does not also register as a reorder and get counted twice.
 */
export function diffShots(edit, scenes) {
  const story = storyOrder(scenes);
  const storyIds = story.map(shot => shot.id);
  const storySet = new Set(storyIds);

  const placed = [];
  const orphaned = [];
  for (const clip of edit.video || []) {
    const shotId = clip.source?.kind === 'shot' ? clip.source.shotId : null;
    if (!shotId) continue;
    if (storySet.has(shotId)) placed.push(shotId);
    else orphaned.push(clip.id);
  }

  const placedSet = new Set(placed);
  const added = story.filter(shot => !placedSet.has(shot.id));

  // Compare the shared shots in each order, ignoring anything not in both.
  const timelineShared = placed.filter(id => storySet.has(id));
  const storyShared = storyIds.filter(id => placedSet.has(id));
  const reordered = timelineShared.join('|') !== storyShared.join('|');

  return { added, orphaned, reordered, total: added.length + orphaned.length + (reordered ? 1 : 0) };
}

/**
 * Put new shots where the story says they belong.
 *
 * A shot inserted between two others in the shot list lands between their clips
 * rather than at the end of the timeline, which is almost always what was meant
 * — you added a shot to a scene, not an epilogue.
 */
export function insertNewShots(edit, scenes, ctx) {
  const { added } = diffShots(edit, scenes);
  if (added.length === 0) return edit;

  const storyIds = storyOrder(scenes).map(shot => shot.id);
  const rank = new Map(storyIds.map((id, index) => [id, index]));
  const video = [...edit.video];

  for (const shot of added) {
    const clip = createVideoClip({ kind: 'shot', shotId: shot.id });
    const target = rank.get(shot.id);

    // Sit after the last clip whose shot comes earlier in the story. Clips for
    // shots no longer in the list are skipped rather than used as landmarks.
    let index = video.length;
    for (let position = 0; position < video.length; position += 1) {
      const otherId = video[position].source?.shotId;
      const otherRank = otherId != null ? rank.get(otherId) : undefined;
      if (otherRank === undefined) continue;
      if (otherRank > target) { index = position; break; }
    }
    video.splice(index, 0, clip);
    rank.set(shot.id, target);
  }

  return normalize({ ...edit, video }, ctx);
}

/** Drop clips whose shot has been deleted, and any audio linked to them. */
export function pruneOrphans(edit, scenes, ctx) {
  const { orphaned } = diffShots(edit, scenes);
  if (orphaned.length === 0) return edit;

  const gone = new Set(orphaned);
  const video = edit.video.filter(clip => !gone.has(clip.id));
  const audio = (edit.audio || []).map(track => ({
    ...track,
    clips: (track.clips || []).filter(clip => !gone.has(clip.link?.clipId))
  }));

  return normalize({ ...edit, video, audio }, ctx);
}

/**
 * Sort the timeline back into story order without losing any work.
 *
 * This is the difference between this and "Match story order", which throws the
 * edit away and reassembles: here every clip keeps its trim, its transition and
 * anything linked to it, and only the running order changes. Clips whose shot
 * has gone stay put relative to the clip they currently follow.
 */
export function matchStoryOrder(edit, scenes, ctx) {
  const rank = new Map(storyOrder(scenes).map((shot, index) => [shot.id, index]));

  // Decorate with the current position so the sort is stable, and so a clip
  // with no story rank keeps the neighbour it already had.
  const decorated = edit.video.map((clip, index) => {
    const shotId = clip.source?.kind === 'shot' ? clip.source.shotId : null;
    const order = shotId != null && rank.has(shotId) ? rank.get(shotId) : null;
    return { clip, index, order };
  });

  // Unranked clips inherit the rank of the nearest ranked clip before them, so
  // they travel with the part of the edit they were sitting in.
  let carried = -1;
  for (const entry of decorated) {
    if (entry.order === null) entry.order = carried + 0.5;
    else carried = entry.order;
  }

  decorated.sort((a, b) => (a.order - b.order) || (a.index - b.index));
  return normalize({ ...edit, video: decorated.map(entry => entry.clip) }, ctx);
}

/** Apply whichever reconciliations were asked for, in a safe order. */
export function reconcile(edit, scenes, ctx, { add = false, prune = false, reorder = false } = {}) {
  let next = edit;
  if (prune) next = pruneOrphans(next, scenes, ctx);
  if (add) next = insertNewShots(next, scenes, ctx);
  if (reorder) next = matchStoryOrder(next, scenes, ctx);
  return next;
}
