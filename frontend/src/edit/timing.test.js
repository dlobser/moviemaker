// node --test frontend/src/edit/
//
// Covers the arithmetic that is easy to get wrong and hard to eyeball in the
// UI: ripple reflow, trim clamping against the real source length, dissolve
// overlaps, and the parity behaviour that makes an untrimmed clip adopt a new
// take's duration on its own.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEmptyEdit,
  deriveVideoClips,
  pickDefaultSettings,
  resolveClipSource
} from './model.js';
import {
  makeContext,
  normalize,
  buildTimeline,
  clipsAtTime,
  clipLength,
  setClipTrim,
  clearClipTrim,
  setTransition,
  setSmart,
  moveClipToTime,
  moveClipToIndex,
  removeVideoClip,
  splitClipAtTime,
  MIN_CLIP_SECONDS
} from './timing.js';

// --- fixture ----------------------------------------------------------------

const scenes = [{
  id: 'scene_1',
  name: 'Act 1',
  shots: [
    { id: 'sh1', name: 'A', selectedVideo: 'assets/a.mp4' },
    { id: 'sh2', name: 'B', selectedVideo: 'assets/b.mp4' },
    // Image only: holds for its own videoDuration, the way the existing
    // concatenate endpoint already treats a shot with no take yet.
    { id: 'sh3', name: 'C', selectedImage: 'assets/c.png', videoDuration: 3 }
  ]
}];

const durations = {
  'assets/a.mp4': { duration: 5, width: 1920, height: 1080, fps: 24, hasAudio: true },
  'assets/b.mp4': { duration: 4, width: 1280, height: 720, fps: 24, hasAudio: true },
  'assets/d.mp4': { duration: 6, width: 1280, height: 720, fps: 24, hasAudio: true },
  'assets/c.png': { isImage: true, width: 1920, height: 1080, duration: null, hasAudio: false }
};

const ctx = makeContext(scenes, durations);

function freshEdit(overrides = {}) {
  return normalize({ ...createEmptyEdit(), video: deriveVideoClips(scenes), ...overrides }, ctx);
}

const starts = (edit) => edit.video.map(clip => round(clip.start));
const lengths = (edit, context = ctx) => edit.video.map(clip => round(clipLength(clip, context)));
const round = (n) => Math.round(n * 1000) / 1000;

// --- layout -----------------------------------------------------------------

test('a fresh assembly lays every shot end to end in story order', () => {
  const edit = freshEdit();
  assert.equal(edit.video.length, 3);
  assert.deepEqual(lengths(edit), [5, 4, 3]);
  assert.deepEqual(starts(edit), [0, 5, 9]);
  assert.equal(round(buildTimeline(edit, ctx).duration), 12);
});

test('shots with neither a take nor a still are left out of the assembly', () => {
  const sparse = [{ id: 's', shots: [{ id: 'x' }, { id: 'y', selectedVideo: 'assets/a.mp4' }] }];
  assert.equal(deriveVideoClips(sparse).length, 1);
});

// --- parity -----------------------------------------------------------------

test('an untrimmed clip adopts the length of whatever take is selected', () => {
  const edit = freshEdit();

  // A new take lands: same shot, longer file.
  const longer = makeContext(scenes, {
    ...durations,
    'assets/a.mp4': { ...durations['assets/a.mp4'], duration: 7 }
  });
  const after = normalize(edit, longer);

  assert.deepEqual(lengths(after, longer), [7, 4, 3]);
  assert.deepEqual(starts(after), [0, 7, 11]);
});

test('a clip follows its shot to a different asset without being touched', () => {
  const edit = freshEdit();
  const reselected = [{
    ...scenes[0],
    shots: [{ ...scenes[0].shots[0], selectedVideo: 'assets/d.mp4' }, ...scenes[0].shots.slice(1)]
  }];
  const next = makeContext(reselected, durations);

  assert.equal(resolveClipSource(edit.video[0], reselected).path, 'assets/d.mp4');
  assert.deepEqual(lengths(normalize(edit, next), next), [6, 4, 3]);
});

test('a trim measured against an old take is flagged stale, not silently applied', () => {
  const base = freshEdit();
  const trimmed = setClipTrim(base, 'PLACEHOLDER', 'out', 3, ctx);
  const edit = setClipTrim(base, base.video[0].id, 'out', 3, ctx);
  assert.equal(edit.video[0].boundTo, 'assets/a.mp4');
  assert.equal(buildTimeline(edit, ctx).video[0].stale, false);

  const reselected = [{
    ...scenes[0],
    shots: [{ ...scenes[0].shots[0], selectedVideo: 'assets/d.mp4' }, ...scenes[0].shots.slice(1)]
  }];
  const next = makeContext(reselected, durations);
  assert.equal(buildTimeline(normalize(edit, next), next).video[0].stale, true);

  // An unknown clip id is a no-op rather than a throw.
  assert.deepEqual(starts(trimmed), [0, 5, 9]);
});

// --- smart mode -------------------------------------------------------------

test('trimming a clip shorter pulls everything after it back', () => {
  const edit = freshEdit();
  const after = setClipTrim(edit, edit.video[0].id, 'out', 3, ctx);
  assert.deepEqual(lengths(after), [3, 4, 3]);
  assert.deepEqual(starts(after), [0, 3, 7]);
});

test('trimming the in point ripples too, and cannot cross the out point', () => {
  const edit = freshEdit();
  const after = setClipTrim(edit, edit.video[0].id, 'in', 2, ctx);
  assert.deepEqual(lengths(after), [3, 4, 3]);
  assert.deepEqual(starts(after), [0, 3, 7]);

  const crossed = setClipTrim(after, after.video[0].id, 'in', 99, ctx);
  assert.equal(round(clipLength(crossed.video[0], ctx)), MIN_CLIP_SECONDS);
});

test('stretching a clip stops at the end of its source and pushes the rest back', () => {
  const base = freshEdit();
  const edit = setClipTrim(base, base.video[1].id, 'out', 2, ctx);
  assert.deepEqual(lengths(edit), [5, 2, 3]);

  // Ask for far more than the file has; it stops at four seconds.
  const stretched = setClipTrim(edit, edit.video[1].id, 'out', 99, ctx);
  assert.deepEqual(lengths(stretched), [5, 4, 3]);
  assert.deepEqual(starts(stretched), [0, 5, 9]);
});

test('a still has no source limit, so it stretches as far as asked', () => {
  const edit = freshEdit();
  const stretched = setClipTrim(edit, edit.video[2].id, 'out', 30, ctx);
  assert.deepEqual(lengths(stretched), [5, 4, 30]);
});

test('clearing a trim returns the clip to following its source', () => {
  const edit = freshEdit();
  const trimmed = setClipTrim(edit, edit.video[0].id, 'out', 2, ctx);
  const cleared = clearClipTrim(trimmed, trimmed.video[0].id, ctx);
  assert.equal(cleared.video[0].out, null);
  assert.deepEqual(lengths(cleared), [5, 4, 3]);
});

test('dropping a clip at a time reorders the sequence and closes the gap', () => {
  const edit = freshEdit();
  // Drag C (the 3s still, sitting at 9s) to the head of the timeline.
  const after = moveClipToTime(edit, edit.video[2].id, 0, ctx);
  assert.deepEqual(after.video.map(clip => clip.source.shotId), ['sh3', 'sh1', 'sh2']);
  assert.deepEqual(starts(after), [0, 3, 8]);
});

test('a clip dropped past the end lands last', () => {
  const edit = freshEdit();
  const after = moveClipToTime(edit, edit.video[0].id, 99, ctx);
  assert.deepEqual(after.video.map(clip => clip.source.shotId), ['sh2', 'sh3', 'sh1']);
  assert.deepEqual(starts(after), [0, 4, 7]);
});

test('removing a clip closes the hole it leaves', () => {
  const edit = freshEdit();
  const after = removeVideoClip(edit, edit.video[1].id, ctx);
  assert.deepEqual(after.video.map(clip => clip.source.shotId), ['sh1', 'sh3']);
  assert.deepEqual(starts(after), [0, 5]);
});

test('moveClipToIndex reorders without consulting times', () => {
  const edit = freshEdit();
  const after = moveClipToIndex(edit, edit.video[0].id, 2, ctx);
  assert.deepEqual(after.video.map(clip => clip.source.shotId), ['sh2', 'sh3', 'sh1']);
});

test('splitting a clip yields two clips that still add up', () => {
  const edit = freshEdit();
  const after = splitClipAtTime(edit, edit.video[0].id, 2, ctx);
  assert.equal(after.video.length, 4);
  assert.deepEqual(lengths(after), [2, 3, 4, 3]);
  assert.deepEqual(starts(after), [0, 2, 5, 9]);

  // A cut at the very edge is refused rather than making a zero-length clip.
  assert.equal(splitClipAtTime(edit, edit.video[0].id, 0, ctx).video.length, 3);
});

// --- transitions ------------------------------------------------------------

test('a dissolve overlaps its neighbour and shortens the timeline', () => {
  const edit = freshEdit();
  const after = setTransition(edit, edit.video[1].id, { type: 'dissolve', duration: 1 }, ctx);
  assert.deepEqual(starts(after), [0, 4, 8]);
  assert.equal(round(buildTimeline(after, ctx).duration), 11);
});

test('a dip to black does not overlap', () => {
  const edit = freshEdit();
  const after = setTransition(edit, edit.video[1].id, { type: 'dip', duration: 1 }, ctx);
  assert.deepEqual(starts(after), [0, 5, 9]);
});

test('a dissolve is capped by the shorter of the two clips', () => {
  const edit = freshEdit();
  const after = setTransition(edit, edit.video[1].id, { type: 'dissolve', duration: 10 }, ctx);
  // B is four seconds, so the overlap cannot exceed that minus a frame.
  assert.equal(round(after.video[1].transition.duration), round(4 - MIN_CLIP_SECONDS));
});

test('the first clip cannot have an incoming transition', () => {
  const edit = freshEdit();
  const after = setTransition(edit, edit.video[0].id, { type: 'dissolve', duration: 1 }, ctx);
  assert.equal(after.video[0].transition, null);
});

test('clipsAtTime reports the mix through a dissolve', () => {
  const base = freshEdit();
  const edit = setTransition(base, base.video[1].id, { type: 'dissolve', duration: 1 }, ctx);
  const timeline = buildTimeline(edit, ctx);

  assert.equal(clipsAtTime(timeline, 2).incoming, null);

  const mid = clipsAtTime(timeline, 4.5);
  assert.equal(mid.current.clip.source.shotId, 'sh1');
  assert.equal(mid.incoming.clip.source.shotId, 'sh2');
  assert.equal(round(mid.mix), 0.5);
});

// --- free mode --------------------------------------------------------------

test('free mode leaves a clip where it is dropped and allows a gap', () => {
  const edit = setSmart(freshEdit(), false, ctx);
  const after = moveClipToTime(edit, edit.video[2].id, 20, ctx);
  assert.deepEqual(starts(after), [0, 5, 20]);
  assert.equal(round(buildTimeline(after, ctx).duration), 23);
});

test('dragging clips into each other in free mode writes a dissolve', () => {
  const edit = setSmart(freshEdit(), false, ctx);
  const after = moveClipToTime(edit, edit.video[1].id, 4, ctx);
  assert.deepEqual(after.video[1].transition, { type: 'dissolve', duration: 1 });
});

test('pulling clips back apart clears the dissolve again', () => {
  const free = setSmart(freshEdit(), false, ctx);
  const overlapped = moveClipToTime(free, free.video[1].id, 4, ctx);
  const separated = moveClipToTime(overlapped, overlapped.video[1].id, 6, ctx);
  assert.equal(separated.video[1].transition, null);
});

test('turning smart mode back on closes every gap at once', () => {
  const free = setSmart(freshEdit(), false, ctx);
  const scattered = moveClipToTime(free, free.video[2].id, 40, ctx);
  const tidy = setSmart(scattered, true, ctx);
  assert.deepEqual(starts(tidy), [0, 5, 9]);
});

// --- project settings -------------------------------------------------------

test('resolution defaults to whatever most of the footage is', () => {
  const settings = pickDefaultSettings(
    ['assets/b.mp4', 'assets/d.mp4', 'assets/a.mp4', 'assets/c.png'],
    durations
  );
  assert.equal(settings.width, 1280);
  assert.equal(settings.height, 720);
  assert.equal(settings.fps, 24);
});

test('a tie breaks towards the larger frame rather than throwing away detail', () => {
  const settings = pickDefaultSettings(['assets/a.mp4', 'assets/b.mp4'], durations);
  assert.equal(settings.width, 1920);
  assert.equal(settings.height, 1080);
});

test('with nothing measured yet the current settings stand', () => {
  const settings = pickDefaultSettings(['assets/unknown.mp4'], durations, { width: 720, height: 480, fps: 30 });
  assert.deepEqual(settings, { width: 720, height: 480, fps: 30 });
});
