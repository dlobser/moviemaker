// node --test frontend/src/history.test.js
//
// Undo restores whole-project snapshots, so the properties worth pinning down
// are the ones that would quietly corrupt a project rather than throw: that a
// new edit drops the redo branch instead of letting you redo onto a timeline
// that no longer exists, that the buffer's cap trims the oldest rather than the
// newest, and that the label the menu promises matches what actually changed.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HISTORY_LIMIT,
  canRedo,
  canUndo,
  createHistory,
  describeChange,
  pushHistory,
  redoHistory,
  redoLabel,
  undoHistory,
  undoLabel
} from './history.js';

const entry = (n) => ({ state: { scenes: [{ id: 's', shots: [] }], marker: n }, label: `step ${n}`, at: n });

test('a fresh history can do neither', () => {
  const history = createHistory();
  assert.equal(canUndo(history), false);
  assert.equal(canRedo(history), false);
  assert.equal(undoLabel(history), null);
  assert.equal(redoLabel(history), null);
});

test('undo walks back and redo walks forward again', () => {
  let history = pushHistory(createHistory(), entry(1));
  history = pushHistory(history, entry(2));

  const back = undoHistory(history, entry(3));
  assert.equal(back.entry.state.marker, 2);
  assert.equal(canRedo(back.history), true);

  const forward = redoHistory(back.history, back.entry);
  assert.equal(forward.entry.state.marker, 3);
  assert.equal(canRedo(forward.history), false);
});

test('undo at the bottom returns null rather than throwing', () => {
  assert.equal(undoHistory(createHistory(), entry(1)), null);
  assert.equal(redoHistory(createHistory(), entry(1)), null);
});

test('a new edit after an undo drops the redo branch', () => {
  // Otherwise redo would restore a project that never existed: the future was
  // recorded on a timeline the user has since edited away from.
  let history = pushHistory(createHistory(), entry(1));
  const back = undoHistory(history, entry(2));
  assert.equal(canRedo(back.history), true);

  const afterEdit = pushHistory(back.history, entry(9));
  assert.equal(canRedo(afterEdit), false);
});

test('the buffer keeps the newest entries when it overflows', () => {
  let history = createHistory();
  for (let i = 0; i < HISTORY_LIMIT + 10; i++) history = pushHistory(history, entry(i));
  assert.equal(history.past.length, HISTORY_LIMIT);
  assert.equal(history.past[history.past.length - 1].state.marker, HISTORY_LIMIT + 9);
  assert.equal(history.past[0].state.marker, 10);
});

test('the menu labels name the step either way', () => {
  let history = pushHistory(createHistory(), entry(1));
  assert.equal(undoLabel(history), 'step 1');
  const back = undoHistory(history, entry(2));
  assert.equal(redoLabel(back.history), 'step 2');
});

// --- labelling -------------------------------------------------------------

const project = (shots, extra = {}) => ({
  scenes: [{ id: 'sc1', name: 'Scene 1', shots }],
  assetLibrary: [],
  imageGallery: [],
  videoGallery: [],
  referenceImages: [],
  promptSnippets: [],
  ...extra
});

const shot = (id, over = {}) => ({
  id, name: `Shot ${id}`, setup: '', description: '', dialogue: '', notes: '',
  selectedImage: null, selectedVideo: null, imagePrompts: [], videoPrompts: [],
  draftImagePrompt: '', draftVideoPrompt: '', ...over
});

test('added and deleted shots are counted and pluralised', () => {
  assert.equal(describeChange(project([shot('a')]), project([shot('a'), shot('b')])), 'add 1 shot');
  assert.equal(describeChange(project([shot('a'), shot('b'), shot('c')]), project([shot('a')])), 'delete 2 shots');
});

test('gallery growth is named', () => {
  const before = project([shot('a')]);
  const after = project([shot('a')], { videoGallery: [{ id: 'v1' }] });
  assert.equal(describeChange(before, after), 'add 1 video');
});

test('an in-place text edit names the shot', () => {
  const before = project([shot('a')]);
  const after = project([shot('a', { description: 'a pig in a cart' })]);
  assert.equal(describeChange(before, after), 'edit to Shot a');
});

test('changing the selected still is distinguished from editing text', () => {
  const before = project([shot('a')]);
  const after = project([shot('a', { selectedImage: 'assets/x.png' })]);
  assert.equal(describeChange(before, after), 'image choice on Shot a');
});

test('a new generation output is named as a generation', () => {
  const before = project([shot('a')]);
  const after = project([shot('a', { videoPrompts: [{ id: 'p1', outputs: [{ id: 'o1' }] }] })]);
  assert.equal(describeChange(before, after), 'generation on Shot a');
});

test('reordering shots is recognised without any field changing', () => {
  const before = project([shot('a'), shot('b')]);
  const after = project([shot('b'), shot('a')]);
  assert.equal(describeChange(before, after), 'reorder');
});

test('settings changes outside the shots are still labelled', () => {
  const before = project([shot('a')], { promptSettings: {} });
  const after = project([shot('a')], { promptSettings: { prePrompt: 'cinematic,' } });
  assert.equal(describeChange(before, after), 'prompt settings');
});

test('renaming a scene names the new title', () => {
  const before = project([shot('a')]);
  const after = { ...project([shot('a')]) };
  after.scenes = [{ ...after.scenes[0], name: 'Act 2 - The Wet Aisle' }];
  assert.equal(describeChange(before, after), 'rename scene to Act 2 - The Wet Aisle');
});

test('an unrecognised difference still yields a usable label', () => {
  const before = project([shot('a')]);
  const after = project([shot('a')]);
  assert.equal(describeChange(before, after), 'change');
});
