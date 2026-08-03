// node --test frontend/src/edit/
//
// Covers the arithmetic that is easy to get wrong and hard to eyeball in the
// UI: ripple reflow, trim clamping against the real source length, dissolve
// overlaps, and the parity behaviour that makes an untrimmed clip adopt a new
// take's duration on its own.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAudioClip,
  createAudioTrack,
  createEmptyEdit,
  deriveAudioClipsForShots,
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
  addAudioClip,
  findAudioClip,
  moveAudioClip,
  setAudioClipTrim,
  unlinkAudioClip,
  detachClipAudio,
  reattachClipAudio,
  trackAudible,
  sourceHasAudio,
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
  'assets/c.png': { isImage: true, width: 1920, height: 1080, duration: null, hasAudio: false },
  'assets/music.mp3': { duration: 30, width: null, height: null, fps: null, hasAudio: true, isImage: false },
  'assets/vo.mp3': { duration: 4, width: null, height: null, fps: null, hasAudio: true, isImage: false }
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

test('trimming the head in free mode moves the clip so the picture stays put', () => {
  const free = setSmart(freshEdit(), false, ctx);
  const after = setClipTrim(free, free.video[1].id, 'in', 1, ctx);

  // B ran 5–9 holding source 0–4. Dropping a second off its head leaves it
  // holding 1–4, and it starts a second later so that frame lands where it did.
  assert.equal(round(after.video[1].start), 6);
  assert.deepEqual(lengths(after), [5, 3, 3]);
  // The clip before it has not moved, and a gap is allowed here.
  assert.equal(round(after.video[0].start), 0);
});

test('trimming the head in smart mode ripples instead of moving the clip', () => {
  const base = freshEdit();
  const after = setClipTrim(base, base.video[1].id, 'in', 1, ctx);
  assert.deepEqual(starts(after), [0, 5, 8]);
  assert.deepEqual(lengths(after), [5, 3, 3]);
});

test('turning smart mode back on closes every gap at once', () => {
  const free = setSmart(freshEdit(), false, ctx);
  const scattered = moveClipToTime(free, free.video[2].id, 40, ctx);
  const tidy = setSmart(scattered, true, ctx);
  assert.deepEqual(starts(tidy), [0, 5, 9]);
});

// --- audio ------------------------------------------------------------------

const musicSource = { kind: 'asset', path: 'assets/music.mp3', name: 'Music' };

function withMusic(edit, overrides) {
  const track = createAudioTrack('Music');
  const clip = createAudioClip(musicSource, overrides);
  return { edit: addAudioClip({ ...edit, audio: [track] }, track.id, clip), clip };
}

test('audio linked to a picture clip moves when that clip moves', () => {
  const base = freshEdit();
  const { edit, clip } = withMusic(base, { link: { clipId: base.video[1].id, offset: 0 } });

  assert.equal(round(buildTimeline(edit, ctx).audio[0].clips[0].start), 5);

  // Shortening the clip before it pulls the picture back — and the sound with it.
  const trimmed = setClipTrim(edit, base.video[0].id, 'out', 3, ctx);
  assert.equal(round(buildTimeline(trimmed, ctx).audio[0].clips[0].start), 3);
  assert.equal(buildTimeline(trimmed, ctx).audio[0].clips[0].clip.id, clip.id);
});

test('unlinking freezes the sound where it currently sits', () => {
  const base = freshEdit();
  const { edit, clip } = withMusic(base, { link: { clipId: base.video[1].id, offset: 0 } });

  const freed = unlinkAudioClip(edit, clip.id, ctx);
  assert.equal(findAudioClip(freed, clip.id).clip.link, null);
  assert.equal(round(findAudioClip(freed, clip.id).clip.start), 5);

  // Now the picture can move without dragging the sound along.
  const trimmed = setClipTrim(freed, base.video[0].id, 'out', 3, ctx);
  assert.equal(round(buildTimeline(trimmed, ctx).audio[0].clips[0].start), 5);
});

test('dragging a linked clip slips the sync rather than breaking the link', () => {
  const base = freshEdit();
  const { edit, clip } = withMusic(base, { link: { clipId: base.video[1].id, offset: 0 } });

  const slipped = moveAudioClip(edit, clip.id, 5.5);
  const after = findAudioClip(slipped, clip.id).clip;
  assert.equal(after.link.clipId, base.video[1].id);
  assert.equal(round(after.link.offset), 0.5);
  assert.equal(round(buildTimeline(slipped, ctx).audio[0].clips[0].start), 5.5);
});

test('detaching a clip’s sound puts it on a track and silences the picture', () => {
  const base = freshEdit();
  const after = detachClipAudio(base, base.video[0].id, ctx);

  assert.equal(after.video[0].audio.detached, true);
  assert.equal(after.audio.length, 1);
  assert.equal(after.audio[0].clips.length, 1);

  const detached = after.audio[0].clips[0];
  assert.equal(detached.detachedFrom, base.video[0].id);
  // Detached means detached: it stays put when the picture is recut.
  assert.equal(detached.link, null);
  assert.equal(round(detached.start), 0);
});

test('a still has no soundtrack to detach', () => {
  const base = freshEdit();
  assert.equal(detachClipAudio(base, base.video[2].id, ctx), base);
});

test('a silent take has nothing to detach either', () => {
  // Generated clips very often carry no audio stream at all.
  const silent = makeContext(scenes, {
    ...durations,
    'assets/a.mp4': { ...durations['assets/a.mp4'], hasAudio: false }
  });
  const base = normalize({ ...createEmptyEdit(), video: deriveVideoClips(scenes) }, silent);

  assert.equal(sourceHasAudio(base.video[0], silent), false);
  assert.equal(sourceHasAudio(base.video[1], silent), true);
  assert.equal(detachClipAudio(base, base.video[0].id, silent), base);
  assert.equal(buildTimeline(base, silent).video[0].hasAudio, false);
});

test('an unmeasured source is assumed to have audio rather than silenced', () => {
  // The hosted build cannot inspect streams; wrongly muting is the worse error.
  const blind = makeContext(scenes, {});
  assert.equal(sourceHasAudio(freshEdit().video[0], blind), true);
});

test('relinking puts a detached soundtrack back into its clip', () => {
  const base = freshEdit();
  const detached = detachClipAudio(base, base.video[0].id, ctx);
  const restored = reattachClipAudio(detached, base.video[0].id, ctx);

  assert.equal(restored.video[0].audio.detached, false);
  assert.equal(restored.audio[0].clips.length, 0);
});

test('removing a picture clip takes its linked sound with it', () => {
  const base = freshEdit();
  const { edit, clip } = withMusic(base, { link: { clipId: base.video[1].id, offset: 0 } });
  const after = removeVideoClip(edit, base.video[1].id, ctx);
  assert.equal(findAudioClip(after, clip.id), null);
});

test('audio trim clamps to the source and keeps the sound in place', () => {
  const base = freshEdit();
  const { edit, clip } = withMusic(base, { start: 10 });

  const trimmed = setAudioClipTrim(edit, clip.id, 'in', 4, ctx);
  const after = findAudioClip(trimmed, clip.id).clip;
  assert.equal(round(after.in), 4);
  // Start moved by the same amount, so the music itself did not shift.
  assert.equal(round(after.start), 14);

  const stretched = setAudioClipTrim(trimmed, clip.id, 'out', 999, ctx);
  assert.equal(round(findAudioClip(stretched, clip.id).clip.out), 30);
});

test('solo silences every track without it; mute only silences its own', () => {
  const loud = createAudioTrack('Music');
  const quiet = createAudioTrack('Room', { muted: true });

  assert.equal(trackAudible(loud, false), true);
  assert.equal(trackAudible(quiet, false), false);

  const soloed = { ...quiet, solo: true, muted: false };
  assert.equal(trackAudible(loud, true), false);
  assert.equal(trackAudible(soloed, true), true);
});

test('lip-sync audio is placed automatically and linked to its shot', () => {
  const talking = [{
    id: 'sc',
    shots: [
      { id: 'sh1', name: 'A', selectedVideo: 'assets/a.mp4', lipSyncAudio: 'assets/vo.mp3' },
      { id: 'sh2', name: 'B', selectedVideo: 'assets/b.mp4' }
    ]
  }];
  const clips = deriveVideoClips(talking);
  const audio = deriveAudioClipsForShots(talking, clips);

  assert.equal(audio.length, 1);
  assert.equal(audio[0].link.clipId, clips[0].id);
  assert.equal(resolveClipSource(audio[0], talking).path, 'assets/vo.mp3');
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

// --- Phase B: the media bin --------------------------------------------------

test('a per-clip stillSeconds outranks the shot duration and the fallback', () => {
  const ctx = makeContext(scenes, durations, 5);
  const shotStill = { id: 'x1', source: { kind: 'shot', shotId: 'sh3' }, in: 0, out: null };
  assert.equal(clipLength(shotStill, ctx), 3, 'shot videoDuration still wins with no per-clip value');
  assert.equal(clipLength({ ...shotStill, stillSeconds: 7.5 }, ctx), 7.5);

  const binStill = { id: 'x2', source: { kind: 'asset', path: 'assets/pic.png', stream: 'image' }, in: 0, out: null };
  assert.equal(clipLength(binStill, ctx), 5, 'a bin still with nothing set holds the project default');
  assert.equal(clipLength({ ...binStill, stillSeconds: 2 }, ctx), 2);
});

test('an asset image source resolves as an image, not a video', () => {
  const resolved = resolveClipSource(
    { source: { kind: 'asset', path: 'assets/pic.png', name: 'pic', stream: 'image' } },
    scenes
  );
  assert.equal(resolved.kind, 'image');
  assert.equal(resolved.path, 'assets/pic.png');
});

test('the bin migrates: junk dropped, fields defaulted, and its paths get probed', async () => {
  const { migrateEdit, collectSourcePaths } = await import('./model.js');
  const edit = migrateEdit({
    bin: [
      { path: 'assets/music.mp3', type: 'audio' },
      { path: 'assets/clip.mp4' },          // no type: defaults to video
      { name: 'orphan with no path' },      // dropped
      null
    ]
  });
  assert.equal(edit.bin.length, 2);
  assert.equal(edit.bin[0].type, 'audio');
  assert.equal(edit.bin[1].type, 'video');
  assert.ok(edit.bin.every(item => item.id && item.addedAt));
  const paths = collectSourcePaths(edit, []);
  assert.ok(paths.includes('assets/music.mp3') && paths.includes('assets/clip.mp4'));
});
