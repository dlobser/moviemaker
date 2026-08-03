// node --test frontend/src/dirty.test.js
//
// Both eras get pinned down: the stamped forward path (updatedAt vs the
// output's createdAt) and the fallback for old projects (prompt containment
// + sent-path comparison). And the deliberate negatives — a global pre-prompt
// change or a missing tag must dirty NOTHING.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  imageDirtiness, videoDirtiness, groupForSelection,
  buildDirtyMap, dirtyImageCandidates, dirtyVideoCandidates
} from './dirty.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';
const T2 = '2026-03-01T00:00:00.000Z';

const ralph = (over = {}) => ({
  id: 'a1', tag: 'Ralph', name: 'Ralph', description: 'grizzled mechanic',
  images: ['assets/ralph.png'], primaryImage: 'assets/ralph.png', ...over
});

/** A stamped-era image group whose output is the shot's selection. */
const stampedGroup = (over = {}) => ({
  id: 'g1',
  rawPrompt: '<Ralph> at work',
  prompt: 'Ralph (grizzled mechanic) at work',
  attachTaggedImages: true,
  inputImagePaths: ['assets/ralph.png'],
  meta: {
    taggedAssetIds: ['a1'],
    assetStamps: { a1: { updatedAt: T0, primaryImage: 'assets/ralph.png' } },
    createdAt: T1
  },
  outputs: [{ id: 'o1', path: 'assets/img_1.png', createdAt: T1 }],
  ...over
});

const shotWith = (group, over = {}) => ({
  id: 'sh1', name: '1.1', selectedImage: 'assets/img_1.png', imagePrompts: [group], ...over
});

// --- forward path -----------------------------------------------------------

test('an asset edited after the generation dirties the shot', () => {
  const state = imageDirtiness(shotWith(stampedGroup()), [ralph({ updatedAt: T2 })]);
  assert.equal(state.dirty, true);
  assert.match(state.reasons[0], /edited since/);
});

test('an asset edited before the generation does not', () => {
  const state = imageDirtiness(shotWith(stampedGroup()), [ralph({ updatedAt: T0 })]);
  assert.equal(state.dirty, false);
});

test('a primary-image change dirties even when the text is untouched', () => {
  const library = [ralph({ updatedAt: T0, primaryImage: 'assets/ralph_v2.png' })];
  const state = imageDirtiness(shotWith(stampedGroup()), library);
  assert.equal(state.dirty, true);
  assert.match(state.reasons[0], /primary image changed/);
});

test('attachTaggedImages: false ignores primary-image drift', () => {
  const group = stampedGroup({ attachTaggedImages: false });
  const library = [ralph({ updatedAt: T0, primaryImage: 'assets/ralph_v2.png' })];
  assert.equal(imageDirtiness(shotWith(group), library).dirty, false);
});

// --- old-project fallback ---------------------------------------------------

/** No meta on the group, no updatedAt on the asset. */
const legacyGroup = (over = {}) => {
  const group = stampedGroup(over);
  delete group.meta;
  return group;
};

test('fallback: description drift breaks prompt containment', () => {
  const library = [ralph({ description: 'now a cyborg pirate' })];
  const state = imageDirtiness(shotWith(legacyGroup()), library);
  assert.equal(state.dirty, true);
  assert.match(state.reasons[0], /description no longer matches/);
});

test('fallback: unchanged description stays clean', () => {
  assert.equal(imageDirtiness(shotWith(legacyGroup()), [ralph()]).dirty, false);
});

test('fallback: a new primary image that was never sent dirties the shot', () => {
  const library = [ralph({ primaryImage: 'assets/ralph_v2.png' })];
  const state = imageDirtiness(shotWith(legacyGroup()), library);
  assert.equal(state.dirty, true);
  assert.match(state.reasons[0], /not the one sent/);
});

// --- deliberate negatives ---------------------------------------------------

test('a global pre-prompt change dirties nothing', () => {
  // The composed prompt got a new prefix but the substitution is intact.
  const group = legacyGroup({ prompt: 'NEW HOUSE STYLE, Ralph (grizzled mechanic) at work' });
  assert.equal(imageDirtiness(shotWith(group), [ralph()]).dirty, false);
});

test('a missing tag is a warning, never dirty', () => {
  const state = imageDirtiness(shotWith(stampedGroup()), []);
  assert.equal(state.dirty, false);
  assert.deepEqual(state.missingTags, ['Ralph']);
});

test('a selection that no group produced cannot be judged', () => {
  const state = imageDirtiness(shotWith(stampedGroup(), { selectedImage: 'assets/from_gallery.png' }), [ralph()]);
  assert.equal(state.dirty, false);
});

// --- video ------------------------------------------------------------------

const videoShot = (over = {}) => ({
  id: 'sh1', name: '1.1',
  selectedImage: 'assets/img_1.png',
  selectedVideo: 'assets/vid_1.mp4',
  imagePrompts: [stampedGroup()],
  videoPrompts: [{
    id: 'vg1',
    rawPrompt: 'slow push in',
    prompt: 'slow push in',
    imageInput: 'assets/img_1.png',
    inputImagePaths: ['assets/img_1.png'],
    outputs: [{ id: 'vo1', path: 'assets/vid_1.mp4', createdAt: T1 }]
  }],
  ...over
});

test('a video is stale when the shot now selects a different still', () => {
  const state = videoDirtiness(videoShot({ selectedImage: 'assets/img_2.png' }), [ralph({ updatedAt: T0 })]);
  assert.equal(state.dirty, true);
  assert.match(state.reasons.join(' '), /different still/);
});

test('a video is stale when its source image is itself stale', () => {
  const state = videoDirtiness(videoShot(), [ralph({ updatedAt: T2 })]);
  assert.equal(state.dirty, true);
  assert.match(state.reasons.join(' '), /source image is itself stale/);
});

test('a clean video stays clean', () => {
  assert.equal(videoDirtiness(videoShot(), [ralph({ updatedAt: T0 })]).dirty, false);
});

// --- helpers ----------------------------------------------------------------

test('groupForSelection finds the producing group by output path', () => {
  const group = stampedGroup();
  assert.equal(groupForSelection([group], 'assets/img_1.png'), group);
  assert.equal(groupForSelection([group], 'assets/other.png'), null);
});

test('candidates and the map agree', () => {
  const scenes = [{ name: 'Act 1', shots: [shotWith(stampedGroup())] }];
  const library = [ralph({ updatedAt: T2 })];
  assert.equal(dirtyImageCandidates(scenes, library).length, 1);
  assert.equal(dirtyVideoCandidates(scenes, library).length, 0);
  assert.equal(buildDirtyMap(scenes, library).get('sh1').image.dirty, true);
});
