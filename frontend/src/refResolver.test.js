// node --test frontend/src/refResolver.test.js
//
// The properties worth pinning down: the asset primary always outranks board
// material, capacity fairness round-robins across tagged assets (every asset
// lands its primary before any asset spends a second slot), pinned edges beat
// automatic picks, and exclusions actually remove things.

import test from 'node:test';
import assert from 'node:assert/strict';

import { collectAssetReferences, orderEntriesByRole } from './refResolver.js';
import { composeGenerationPrompt } from './promptTags.js';

const ralph = {
  id: 'a1', tag: 'Ralph', type: 'character', name: 'Ralph', description: 'grizzled mechanic',
  images: ['assets/ralph_1.png'], primaryImage: 'assets/ralph_1.png'
};
const garage = {
  id: 'a2', tag: 'Garage', type: 'environment', name: 'The Garage', description: 'oil-stained bay',
  images: ['assets/garage_1.png'], primaryImage: 'assets/garage_1.png'
};

const refs = [
  { id: 'r1', path: 'assets/ralph_closeup.png', name: 'Ralph closeup', kind: 'character', assetId: 'a1', tags: [] },
  { id: 'r2', path: 'assets/ralph_style.png', name: 'Ralph grade', kind: 'style', assetId: 'a1', tags: [] },
  { id: 'r3', path: 'assets/tagged_ralph.png', name: 'Old photo', kind: 'other', assetId: null, tags: ['Ralph'] },
  { id: 'r4', path: 'assets/garage_wide.png', name: 'Garage wide', kind: 'scenery', assetId: 'a2', tags: [] }
];

// --- collectAssetReferences -------------------------------------------------

test('primary first, then linked, then tag-matched; deduped by path', () => {
  const out = collectAssetReferences({ asset: ralph, references: refs });
  assert.deepEqual(out.map(e => e.path), [
    'assets/ralph_1.png', 'assets/ralph_closeup.png', 'assets/ralph_style.png', 'assets/tagged_ralph.png'
  ]);
  assert.deepEqual(out.map(e => e.reason), ['primary', 'linked', 'linked', 'tag-match']);
});

test('refKinds ranks matching kinds first without dropping the rest', () => {
  const out = collectAssetReferences({ asset: ralph, references: refs, refKinds: ['style'] });
  const linked = out.filter(e => e.reason === 'linked');
  assert.equal(linked[0].kind, 'style');
});

test('capacityHint caps the list', () => {
  assert.equal(collectAssetReferences({ asset: ralph, references: refs, capacityHint: 2 }).length, 2);
});

test('role ordering puts subject first, or style first for style-only models', () => {
  const entries = [
    { role: 'composition', ref: { id: 'x1' } },
    { role: 'style', ref: { id: 'x2' } },
    { role: 'subject', ref: { id: 'x3' } }
  ];
  assert.deepEqual(orderEntriesByRole(entries).map(e => e.role), ['subject', 'style', 'composition']);
  assert.deepEqual(orderEntriesByRole(entries, ['style']).map(e => e.role), ['style', 'subject', 'composition']);
});

// --- composeGenerationPrompt with the board wired ---------------------------

const shotFor = (over = {}) => ({ id: 'shot1', refExclusions: [], ...over });

const composeWired = (over = {}) => composeGenerationPrompt({
  prompt: '<Ralph> in <Garage>',
  assetLibrary: [ralph, garage],
  type: 'video',
  modelId: 'atlas:bytedance/seedance-2.0/reference-to-video', // 9 slots
  references: refs,
  assignments: [],
  shot: shotFor(),
  ...over
});

test('auto-attach: every tagged asset lands its primary before any second image', () => {
  // 3-slot Gemini with two tagged assets: both primaries in, remaining slot
  // goes to the first asset's rank-1 candidate.
  const composed = composeWired({ type: 'image', modelId: 'google-gemini-image' });
  assert.deepEqual(composed.inputImagePaths, [
    'assets/ralph_1.png', 'assets/garage_1.png', 'assets/ralph_closeup.png'
  ]);
});

test('spare capacity on an 8-slot model fills with linked board refs', () => {
  const composed = composeWired();
  assert.deepEqual(composed.inputImagePaths, [
    'assets/ralph_1.png', 'assets/garage_1.png',
    'assets/ralph_closeup.png', 'assets/garage_wide.png',
    'assets/ralph_style.png', 'assets/tagged_ralph.png'
  ]);
  assert.ok(composed.imageSources.every(e => e.origin === 'auto-tag'));
});

test('a pinned shot edge outranks every automatic pick', () => {
  const composed = composeWired({
    assignments: [{ id: 'e1', refId: 'r3', scope: 'shot', targetId: 'shot1', role: 'style', enabled: true, order: 0 }]
  });
  assert.equal(composed.inputImagePaths[0], 'assets/tagged_ralph.png');
  assert.equal(composed.imageSources[0].origin, 'pinned');
});

test('shot.refExclusions removes an auto-attached board ref', () => {
  const composed = composeWired({ shot: shotFor({ refExclusions: ['r1'] }) });
  assert.ok(!composed.inputImagePaths.includes('assets/ralph_closeup.png'));
});

test('autoAttachRefs: false keeps the one-primary-per-tag behaviour', () => {
  const composed = composeWired({ autoAttachRefs: false });
  assert.deepEqual(composed.inputImagePaths, ['assets/ralph_1.png', 'assets/garage_1.png']);
});

test('primary paths always outrank board material', () => {
  const composed = composeWired({ primaryImagePaths: ['assets/hand_picked.png'] });
  assert.equal(composed.inputImagePaths[0], 'assets/hand_picked.png');
  assert.equal(composed.imageSources[0].origin, 'primary');
});

test('an inherited scene edge arrives with origin inherited', () => {
  const composed = composeWired({
    scene: { id: 'scene1' },
    assignments: [{ id: 'e2', refId: 'r4', scope: 'scene', targetId: 'scene1', role: 'subject', enabled: true, order: 0 }]
  });
  const entry = composed.imageSources.find(e => e.path === 'assets/garage_wide.png');
  assert.equal(entry.origin, 'inherited');
});
