// node --test frontend/src/edit/reconcile.test.js
//
// Structure reconciliation is the destructive half of parity, so the property
// that matters most is what it does NOT touch: a trim, a transition or a link
// must survive a reorder or an insertion. Losing an afternoon's cutting because
// a shot was renumbered would be far worse than the convenience is worth.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createAudioClip, createAudioTrack, createEmptyEdit, deriveVideoClips } from './model.js';
import {
  makeContext, normalize, buildTimeline, setClipTrim, setTransition, addAudioClip, findAudioClip
} from './timing.js';
import {
  diffShots, insertNewShots, pruneOrphans, matchStoryOrder, reconcile, storyOrder
} from './reconcile.js';

const durations = {
  'assets/a.mp4': { duration: 5, width: 1920, height: 1080, fps: 24, hasAudio: true },
  'assets/b.mp4': { duration: 4, width: 1920, height: 1080, fps: 24, hasAudio: true },
  'assets/c.mp4': { duration: 3, width: 1920, height: 1080, fps: 24, hasAudio: true },
  'assets/d.mp4': { duration: 2, width: 1920, height: 1080, fps: 24, hasAudio: true }
};

const shot = (id, path) => ({ id, name: id.toUpperCase(), selectedVideo: path });

const baseScenes = [
  { id: 'sc1', shots: [shot('a', 'assets/a.mp4'), shot('b', 'assets/b.mp4')] },
  { id: 'sc2', shots: [shot('c', 'assets/c.mp4')] }
];

const ctxFor = (scenes) => makeContext(scenes, durations, 5);
const ctx = ctxFor(baseScenes);

function assembled(scenes = baseScenes) {
  return normalize({ ...createEmptyEdit(), video: deriveVideoClips(scenes) }, ctxFor(scenes));
}

const shotIds = (edit) => edit.video.map(clip => clip.source.shotId);
const round = (n) => Math.round(n * 1000) / 1000;

// --- diffing ----------------------------------------------------------------

test('an edit that matches its shot list reports nothing to do', () => {
  const diff = diffShots(assembled(), baseScenes);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.orphaned, []);
  assert.equal(diff.reordered, false);
  assert.equal(diff.total, 0);
});

test('shots with no take and no still are not counted as missing', () => {
  const scenes = [{ id: 'sc', shots: [shot('a', 'assets/a.mp4'), { id: 'empty' }] }];
  assert.equal(storyOrder(scenes).length, 1);
  assert.equal(diffShots(assembled(scenes), scenes).total, 0);
});

test('a pending insertion is not also counted as a reorder', () => {
  const scenes = [{
    id: 'sc',
    shots: [shot('a', 'assets/a.mp4'), shot('new', 'assets/d.mp4'), shot('b', 'assets/b.mp4')]
  }];
  const diff = diffShots(assembled(baseScenes), scenes);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].id, 'new');
  assert.equal(diff.reordered, false, 'a and b are still in the same relative order');
});

// --- inserting --------------------------------------------------------------

test('a shot added in the middle lands in the middle, not at the end', () => {
  const scenes = [
    { id: 'sc1', shots: [shot('a', 'assets/a.mp4'), shot('new', 'assets/d.mp4'), shot('b', 'assets/b.mp4')] },
    { id: 'sc2', shots: [shot('c', 'assets/c.mp4')] }
  ];
  const after = insertNewShots(assembled(baseScenes), scenes, ctxFor(scenes));
  assert.deepEqual(shotIds(after), ['a', 'new', 'b', 'c']);
  // And the sequence closes up around it.
  assert.deepEqual(after.video.map(c => round(c.start)), [0, 5, 7, 11]);
});

test('a shot appended to the story is appended to the timeline', () => {
  const scenes = [...baseScenes, { id: 'sc3', shots: [shot('d', 'assets/d.mp4')] }];
  const after = insertNewShots(assembled(baseScenes), scenes, ctxFor(scenes));
  assert.deepEqual(shotIds(after), ['a', 'b', 'c', 'd']);
});

test('inserting leaves existing trims and transitions alone', () => {
  const base = assembled();
  const trimmed = setClipTrim(base, base.video[1].id, 'out', 2, ctx);
  const withDissolve = setTransition(trimmed, trimmed.video[2].id, { type: 'dissolve', duration: 0.5 }, ctx);

  const scenes = [
    { id: 'sc1', shots: [shot('a', 'assets/a.mp4'), shot('b', 'assets/b.mp4')] },
    { id: 'sc2', shots: [shot('new', 'assets/d.mp4'), shot('c', 'assets/c.mp4')] }
  ];
  const after = insertNewShots(withDissolve, scenes, ctxFor(scenes));

  assert.deepEqual(shotIds(after), ['a', 'b', 'new', 'c']);
  const b = after.video.find(c => c.source.shotId === 'b');
  const c = after.video.find(c => c.source.shotId === 'c');
  assert.equal(round(b.out), 2, 'trim survived');
  assert.deepEqual(c.transition, { type: 'dissolve', duration: 0.5 }, 'transition survived');
});

// --- pruning ----------------------------------------------------------------

test('clips for deleted shots are removed, and the sequence closes up', () => {
  const scenes = [{ id: 'sc1', shots: [shot('a', 'assets/a.mp4'), shot('c', 'assets/c.mp4')] }];
  const after = pruneOrphans(assembled(baseScenes), scenes, ctxFor(scenes));
  assert.deepEqual(shotIds(after), ['a', 'c']);
  assert.deepEqual(after.video.map(c => round(c.start)), [0, 5]);
});

test('audio linked to a deleted shot goes with it', () => {
  const base = assembled();
  const track = createAudioTrack('VO');
  const clip = createAudioClip(
    { kind: 'asset', path: 'assets/a.mp4' },
    { link: { clipId: base.video[1].id, offset: 0 } }
  );
  const withAudio = addAudioClip({ ...base, audio: [track] }, track.id, clip);

  const scenes = [{ id: 'sc1', shots: [shot('a', 'assets/a.mp4'), shot('c', 'assets/c.mp4')] }];
  const after = pruneOrphans(withAudio, scenes, ctxFor(scenes));

  assert.deepEqual(shotIds(after), ['a', 'c']);
  assert.equal(findAudioClip(after, clip.id), null);
});

test('unlinked audio survives a prune', () => {
  const base = assembled();
  const track = createAudioTrack('Music');
  const clip = createAudioClip({ kind: 'asset', path: 'assets/a.mp4' }, { start: 1 });
  const withAudio = addAudioClip({ ...base, audio: [track] }, track.id, clip);

  const scenes = [{ id: 'sc1', shots: [shot('a', 'assets/a.mp4')] }];
  const after = pruneOrphans(withAudio, scenes, ctxFor(scenes));
  assert.ok(findAudioClip(after, clip.id), 'music is not tied to any shot');
});

// --- reordering -------------------------------------------------------------

test('matching story order rearranges without discarding any work', () => {
  const base = assembled();
  const trimmed = setClipTrim(base, base.video[0].id, 'out', 2, ctx);
  const withDissolve = setTransition(trimmed, trimmed.video[1].id, { type: 'dissolve', duration: 0.5 }, ctx);

  // The shot list is re-ordered: c now comes first.
  const scenes = [
    { id: 'sc1', shots: [shot('c', 'assets/c.mp4')] },
    { id: 'sc2', shots: [shot('a', 'assets/a.mp4'), shot('b', 'assets/b.mp4')] }
  ];
  assert.equal(diffShots(withDissolve, scenes).reordered, true);

  const after = matchStoryOrder(withDissolve, scenes, ctxFor(scenes));
  assert.deepEqual(shotIds(after), ['c', 'a', 'b']);

  const a = after.video.find(c => c.source.shotId === 'a');
  const b = after.video.find(c => c.source.shotId === 'b');
  assert.equal(round(a.out), 2, 'trim survived the reorder');
  assert.deepEqual(b.transition, { type: 'dissolve', duration: 0.5 }, 'transition survived');
});

test('a clip reordered to the front loses its incoming transition', () => {
  // There is nothing left for it to arrive from, so keeping the dissolve would
  // leave an overlap with no clip underneath it.
  const base = assembled();
  const withDissolve = setTransition(base, base.video[2].id, { type: 'dissolve', duration: 0.5 }, ctx);

  const scenes = [{
    id: 'sc',
    shots: [shot('c', 'assets/c.mp4'), shot('a', 'assets/a.mp4'), shot('b', 'assets/b.mp4')]
  }];
  const after = matchStoryOrder(withDissolve, scenes, ctxFor(scenes));

  assert.deepEqual(shotIds(after), ['c', 'a', 'b']);
  assert.equal(after.video[0].transition, null);
  assert.equal(round(after.video[0].start), 0);
});

test('a reorder is a no-op when the orders already agree', () => {
  const base = assembled();
  assert.deepEqual(shotIds(matchStoryOrder(base, baseScenes, ctx)), ['a', 'b', 'c']);
});

test('clips split off a shot travel with the part of the edit they sit in', () => {
  // Two clips share shot 'a'; both must stay together and stay before 'b'.
  const base = assembled();
  const duplicated = normalize({
    ...base,
    video: [base.video[0], { ...base.video[0], id: 'copy' }, base.video[1], base.video[2]]
  }, ctx);

  const after = matchStoryOrder(duplicated, baseScenes, ctx);
  assert.deepEqual(shotIds(after), ['a', 'a', 'b', 'c']);
});

// --- the whole thing --------------------------------------------------------

test('reconcile prunes before inserting so ranks are computed against reality', () => {
  const scenes = [
    { id: 'sc1', shots: [shot('a', 'assets/a.mp4'), shot('new', 'assets/d.mp4')] }
  ];
  // b and c are gone; new has appeared.
  const after = reconcile(assembled(baseScenes), scenes, ctxFor(scenes), {
    add: true, prune: true, reorder: true
  });
  assert.deepEqual(shotIds(after), ['a', 'new']);
  assert.deepEqual(after.video.map(c => round(c.start)), [0, 5]);
  assert.equal(diffShots(after, scenes).total, 0, 'nothing left to reconcile');
});

test('reconcile does nothing at all when asked for nothing', () => {
  const scenes = [{ id: 'sc', shots: [shot('a', 'assets/a.mp4')] }];
  const base = assembled(baseScenes);
  assert.equal(reconcile(base, scenes, ctxFor(scenes), {}), base);
});

test('a reconciled timeline still resolves and measures correctly', () => {
  const scenes = [
    { id: 'sc1', shots: [shot('c', 'assets/c.mp4'), shot('a', 'assets/a.mp4')] }
  ];
  const after = reconcile(assembled(baseScenes), scenes, ctxFor(scenes), {
    add: true, prune: true, reorder: true
  });
  const timeline = buildTimeline(after, ctxFor(scenes));
  assert.equal(round(timeline.duration), 8);
  assert.deepEqual(timeline.video.map(e => e.resolved.path), ['assets/c.mp4', 'assets/a.mp4']);
});
