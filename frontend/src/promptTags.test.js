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

import {
  assetInputImages,
  buildAutoPromptContext,
  composeGenerationPrompt,
  droppedTags,
  tagPreservationRule
} from './promptTags.js';

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

// --- tag survival ----------------------------------------------------------
//
// A shot description is written with tags in it and the prompt writer's job is
// to rewrite that description — which it will do by replacing "<Sara>" with its
// own words unless told otherwise. The rewrite reads fine and silently costs
// the shot its reference artwork, so both halves matter: the instruction that
// asks for the tags back, and the check that they arrived.

test('the rule names the actual tags rather than stating a general principle', () => {
  const rule = tagPreservationRule('<Sara> runs through <Valley> with <Rudy>');
  assert.match(rule, /<Sara>, <Valley>, <Rudy>/);
  assert.match(rule, /exactly as written/);
});

test('the rule is empty for a shot with no tags, so its template line drops', () => {
  assert.equal(tagPreservationRule('a wide shot of an empty road'), '');
  assert.equal(tagPreservationRule(''), '');
  assert.equal(tagPreservationRule(undefined), '');
});

test('the rule is singular for one tag', () => {
  assert.match(tagPreservationRule('<Sara> alone'), /keep this tag/);
  assert.match(tagPreservationRule('<Sara> and <Rudy>'), /keep these tags/);
});

test('a tag that survived the rewrite is not reported as dropped', () => {
  assert.deepEqual(droppedTags('<Sara> in <Valley>', 'wide shot of <Sara> standing in <Valley>, golden hour'), []);
});

test('a paraphrased tag is caught', () => {
  const lost = droppedTags('<Sara> in <Valley>', 'wide shot of a young girl standing in <Valley>');
  assert.deepEqual(lost, ['Sara']);
});

test('tag matching ignores case and spacing, as tag resolution does', () => {
  // <Monster Truck> and <monstertruck> resolve to the same asset at generation
  // time, so the survival check has to agree or it cries wolf.
  assert.deepEqual(droppedTags('<Monster Truck> arrives', 'the <monstertruck> arrives'), []);
});

test('an empty rewrite loses everything', () => {
  assert.deepEqual(droppedTags('<Sara> and <Rudy>', ''), ['Sara', 'Rudy']);
});

test('tags the writer invented are not counted as survivors of anything', () => {
  assert.deepEqual(droppedTags('<Sara>', '<Rudy> walks by'), ['Sara']);
});

// --- reference pointers ----------------------------------------------------
//
// Seedance 2.0 numbers the images it is given and the prompt has to point at
// them by that number. The number is a position in the array the server sends,
// which means the prompt and the upload order are one artefact pretending to be
// two — and a mismatch between them is invisible: the generation succeeds, it
// just puts the wrong character in the shot. Everything below is there to keep
// the two halves nailed together.

const SEEDANCE = 'atlas:bytedance/seedance-2.0/reference-to-video';

test('a tag becomes a pointer at its own image, not a description', () => {
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> works on the car',
    assetLibrary: [ralph, garage],
    type: 'video',
    modelId: SEEDANCE
  });
  assert.equal(composed.prompt, '@image1 works on the car');
  assert.deepEqual(composed.inputImagePaths, ['assets/ralph_1.png']);
  assert.equal(composed.usesRefTags, true);
});

test('the pointer counts from the images actually sent, shot still included', () => {
  // The shot's own frame takes slot 1, so the character is @image2 — off-by-one
  // here would hand the model its own establishing frame as the character.
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> steps out of <Garage>',
    assetLibrary: [ralph, garage],
    primaryImagePaths: ['assets/shot_still.png'],
    type: 'video',
    modelId: SEEDANCE
  });
  assert.equal(composed.prompt, '@image2 steps out of @image3');
  assert.deepEqual(composed.inputImagePaths, [
    'assets/shot_still.png', 'assets/ralph_1.png', 'assets/garage_1.png'
  ]);
});

test('every mention of one asset points at the single slot it occupies', () => {
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> looks up. <Ralph> wipes his hands.',
    assetLibrary: [ralph],
    type: 'video',
    modelId: SEEDANCE
  });
  assert.equal(composed.prompt, '@image1 looks up. @image1 wipes his hands.');
  assert.equal(composed.inputImagePaths.length, 1);
});

// A pointer to a slot that was never filled is worse than a wordy prompt: the
// model resolves it against whatever *is* in that slot, silently.
test('a tag trimmed off the end falls back to prose rather than dangling', () => {
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> in <Garage>',
    assetLibrary: [ralph, garage],
    primaryImagePaths: paths(9), // fills every slot this model has
    type: 'video',
    modelId: SEEDANCE
  });
  assert.equal(composed.prompt, 'Ralph (grizzled mechanic) in The Garage (oil-stained bay)');
  assert.match(composed.prompt, /^(?!.*@image)/);
});

test('an image picked by hand that is also a tagged asset is sent once and still addressable', () => {
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> waits',
    assetLibrary: [ralph],
    primaryImagePaths: ['assets/ralph_1.png'],
    type: 'video',
    modelId: SEEDANCE
  });
  assert.deepEqual(composed.inputImagePaths, ['assets/ralph_1.png']);
  assert.equal(composed.prompt, '@image1 waits');
});

test('turning off tagged images turns off the pointers that would have named them', () => {
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> waits',
    assetLibrary: [ralph],
    attachTaggedImages: false,
    type: 'video',
    modelId: SEEDANCE
  });
  assert.deepEqual(composed.inputImagePaths, []);
  assert.equal(composed.prompt, 'Ralph (grizzled mechanic) waits');
});

test('the reference endpoint takes nine images where image-to-video takes one', () => {
  const nine = { prompt: 'x', assetLibrary: [], primaryImagePaths: paths(9), type: 'video' };
  assert.equal(composeGenerationPrompt({ ...nine, modelId: SEEDANCE }).inputImagePaths.length, 9);
  assert.equal(
    composeGenerationPrompt({ ...nine, modelId: 'atlas:bytedance/seedance-2.0/image-to-video' }).inputImagePaths.length,
    1
  );
});

test('a model with no pointer convention still gets descriptions', () => {
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> waits',
    assetLibrary: [ralph],
    type: 'video',
    modelId: 'kling-video/v2.6/pro/image-to-video'
  });
  assert.equal(composed.prompt, 'Ralph (grizzled mechanic) waits');
  assert.equal(composed.usesRefTags, false);
});

test('an unknown tag stays literal on a pointer model too', () => {
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> meets <Nobody>',
    assetLibrary: [ralph],
    type: 'video',
    modelId: SEEDANCE
  });
  assert.equal(composed.prompt, '@image1 meets <Nobody>');
  assert.deepEqual(composed.missingTags, ['Nobody']);
});

test('the pre/post prompt still wraps a pointer prompt', () => {
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> waits',
    prePrompt: 'cinematic,',
    postPrompt: ', 35mm',
    assetLibrary: [ralph],
    type: 'video',
    modelId: SEEDANCE
  });
  assert.equal(composed.prompt, 'cinematic, @image1 waits, 35mm');
});

// --- auto prompt context ---------------------------------------------------

test('the context names every tag with its description, so the writer can use them', () => {
  const context = buildAutoPromptContext({ assetLibrary: [ralph, garage] });
  assert.match(context, /<Ralph> \(character\): "Ralph" — grizzled mechanic/);
  assert.match(context, /<Garage> \(environment\)/);
});

test('the neighbouring shots go in so the writer can stay continuous', () => {
  const context = buildAutoPromptContext({
    assetLibrary: [],
    previousShot: { name: 'S1', description: 'the car pulls in' },
    nextShot: { name: 'S3', description: 'the door slams' }
  });
  assert.match(context, /PREVIOUS SHOT \(S1\)[\s\S]*the car pulls in/);
  assert.match(context, /NEXT SHOT \(S3\)[\s\S]*the door slams/);
});

test('a shot at the top of the film has no previous block rather than an empty one', () => {
  const context = buildAutoPromptContext({
    assetLibrary: [],
    previousShot: null,
    nextShot: { name: 'S2', description: 'the door slams' }
  });
  assert.doesNotMatch(context, /PREVIOUS SHOT/);
});

test('nothing to say produces nothing, not a heading', () => {
  assert.equal(buildAutoPromptContext({}), '');
  assert.equal(buildAutoPromptContext({ assetLibrary: [], previousShot: { name: 'S1' } }), '');
});
