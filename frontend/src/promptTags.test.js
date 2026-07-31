// node --test frontend/src/promptTags.test.js
//
// Reference images cost money and arrive silently truncated when a model is
// handed more than it reads, so the properties worth pinning down are the ones
// nobody would notice going wrong: that the model's own ceiling is what trims
// the list, that the images the user picked by hand outrank the ones a <Tag>
// dragged in, and that an asset saved before multi-select still sends what it
// used to.

import test from 'node:test';
import assert from 'node:assert/strict';

import { assetInputImages, composeGenerationPrompt } from './promptTags.js';

const ralph = {
  id: 'a1', tag: 'Ralph', type: 'character', name: 'Ralph', description: 'grizzled mechanic',
  images: ['assets/ralph_1.png', 'assets/ralph_2.png'], primaryImage: 'assets/ralph_1.png'
};
const garage = {
  id: 'a2', tag: 'Garage', type: 'environment', name: 'The Garage', description: 'oil-stained bay',
  images: ['assets/garage_1.png'], primaryImage: 'assets/garage_1.png'
};

const compose = (overrides) => composeGenerationPrompt({
  prompt: 'x', assetLibrary: [ralph, garage], type: 'image', ...overrides
});

const paths = (n) => Array.from({ length: n }, (_, i) => `assets/ref_${i}.png`);

test('a 14-reference model keeps all fourteen', () => {
  const composed = compose({ modelId: 'google/nano-banana-pro', primaryImagePaths: paths(14) });
  assert.equal(composed.capacity, 14);
  assert.equal(composed.inputImagePaths.length, 14);
  assert.deepEqual(composed.droppedImagePaths, []);
});

test('the fifteenth is dropped rather than sent to a model that will reject it', () => {
  const composed = compose({ modelId: 'google/nano-banana-pro', primaryImagePaths: paths(15) });
  assert.equal(composed.inputImagePaths.length, 14);
  assert.deepEqual(composed.droppedImagePaths, ['assets/ref_14.png']);
});

test('the same model served by a stricter host keeps that host\'s smaller ceiling', () => {
  // Gemini 2.5 Flash Image: 8 through Higgsfield, 3 direct from Google.
  assert.equal(compose({ modelId: 'google/nano-banana', primaryImagePaths: paths(9) }).inputImagePaths.length, 8);
  assert.equal(compose({ modelId: 'google-gemini-image', primaryImagePaths: paths(9) }).inputImagePaths.length, 3);
});

test('a text-to-image model sends no images however many were picked', () => {
  const composed = compose({ modelId: 'fal-ai/flux/schnell', primaryImagePaths: paths(3) });
  assert.equal(composed.capacity, 0);
  assert.deepEqual(composed.inputImagePaths, []);
});

test('hand-picked references survive the trim ahead of tagged ones', () => {
  const composed = composeGenerationPrompt({
    prompt: 'a portrait of <Ralph> in <Garage>',
    assetLibrary: [ralph, garage],
    primaryImagePaths: ['assets/picked.png'],
    type: 'image',
    modelId: 'fal-ai/flux/dev/redux' // one slot only
  });
  assert.deepEqual(composed.inputImagePaths, ['assets/picked.png']);
  assert.deepEqual(composed.unusedTaggedAssets.map(a => a.tag), ['Ralph', 'Garage']);
});

test('an unknown custom model path is assumed to take a single image', () => {
  const composed = compose({ modelId: 'someone/unreleased-model', primaryImagePaths: paths(4) });
  assert.equal(composed.inputImagePaths.length, 1);
});

test('assets saved before multi-select still send their primary', () => {
  assert.deepEqual(assetInputImages({ ...ralph, useExistingAsReference: true }), ['assets/ralph_1.png']);
  assert.deepEqual(assetInputImages({ ...ralph, useExistingAsReference: false }), []);
});

test('an explicit selection wins over the legacy flag, including an empty one', () => {
  const both = { ...ralph, useExistingAsReference: true, inputImages: ['assets/ralph_2.png'] };
  assert.deepEqual(assetInputImages(both), ['assets/ralph_2.png']);
  assert.deepEqual(assetInputImages({ ...both, inputImages: [] }), []);
});
