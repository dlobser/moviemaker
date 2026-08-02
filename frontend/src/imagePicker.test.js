// node --test frontend/src/imagePicker.test.js
//
// The picker's job is to make every image in the project reachable exactly
// once. The properties worth pinning down are the ones that would make it
// untrustworthy rather than broken: that a file appearing in two places is
// offered once and under its most meaningful name, that the shot's own takes
// come first, and that an empty source never leaves a bare heading behind.

import test from 'node:test';
import assert from 'node:assert/strict';

import { collectShotMedia, countShotMedia, filterShotMedia } from './imagePicker.js';

const shot = {
  id: 'shot1',
  imagePrompts: [
    { id: 'p1', outputs: [{ id: 'o1', path: 'assets/take1.png', name: 'Iteration 1' }] },
    { id: 'p2', outputs: [{ id: 'o2', path: 'assets/take2.png', name: 'Iteration 2' }] }
  ],
  videoPrompts: [{ id: 'v1', outputs: [{ id: 'ov', path: 'assets/clip.mp4', name: 'Clip 1' }] }]
};

const fullProject = {
  kind: 'image',
  shot,
  imageGallery: [{ path: 'assets/gallery.png', name: 'A still' }],
  referenceImages: [{ path: 'assets/ref.png', name: 'Board ref' }],
  assetLibrary: [{ tag: 'Pig', name: 'The Vaseline Pig', images: ['assets/pig.png'] }],
  projectFiles: [
    { path: 'assets/loose.png', name: 'loose.png' },
    { path: 'assets/take1.png', name: 'take1.png' }
  ]
};

test('every source is represented, nearest to the shot first', () => {
  const groups = collectShotMedia(fullProject);
  assert.deepEqual(groups.map(g => g.label), [
    'This shot', 'Generated images', 'Reference board', 'Asset artwork', 'Elsewhere in the project'
  ]);
  assert.equal(countShotMedia(groups), 6);
});

test('reference board images are reachable — the whole point of the change', () => {
  const groups = collectShotMedia(fullProject);
  const board = groups.find(g => g.label === 'Reference board');
  assert.deepEqual(board.items.map(i => i.path), ['assets/ref.png']);
});

test('a file in two sources is offered once, under the closer name', () => {
  // take1.png is both a shot output and a loose file on disk. Offering it twice
  // would make the picker look duplicated and unreliable.
  const groups = collectShotMedia(fullProject);
  const all = groups.flatMap(g => g.items.map(i => i.path));
  assert.equal(all.filter(p => p === 'assets/take1.png').length, 1);
  assert.equal(groups[0].items.find(i => i.path === 'assets/take1.png').name, 'Iteration 1');
  const elsewhere = groups.find(g => g.label === 'Elsewhere in the project');
  assert.deepEqual(elsewhere.items.map(i => i.path), ['assets/loose.png']);
});

test('asset artwork carries its tag so a portrait is identifiable', () => {
  const groups = collectShotMedia(fullProject);
  assert.equal(groups.find(g => g.label === 'Asset artwork').items[0].note, '<Pig>');
});

test('an empty source contributes no heading', () => {
  const groups = collectShotMedia({ kind: 'image', shot, imageGallery: [], referenceImages: [] });
  assert.deepEqual(groups.map(g => g.label), ['This shot']);
});

test('a shot with nothing at all yields no groups rather than throwing', () => {
  assert.deepEqual(collectShotMedia(), []);
  assert.equal(countShotMedia([]), 0);
});

test('video draws on clips only, never the board or asset artwork', () => {
  const groups = collectShotMedia({
    ...fullProject,
    kind: 'video',
    videoGallery: [{ path: 'assets/other.mp4', name: 'Another clip' }]
  });
  assert.deepEqual(groups.map(g => g.label), ['This shot', 'Generated videos']);
  assert.deepEqual(groups[0].items.map(i => i.path), ['assets/clip.mp4']);
});

test('search matches name, tag and path, and hides emptied groups', () => {
  const groups = collectShotMedia(fullProject);
  assert.deepEqual(filterShotMedia(groups, 'pig').map(g => g.label), ['Asset artwork']);
  assert.deepEqual(filterShotMedia(groups, 'board').map(g => g.label), ['Reference board']);
  assert.deepEqual(filterShotMedia(groups, 'take2').map(g => g.label), ['This shot']);
  assert.equal(filterShotMedia(groups, 'nothing-matches').length, 0);
});

test('an empty search returns the list untouched', () => {
  const groups = collectShotMedia(fullProject);
  assert.equal(filterShotMedia(groups, '   '), groups);
});
