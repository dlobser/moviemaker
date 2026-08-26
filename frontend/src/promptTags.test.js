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
  assetShotDescription,
  buildAutoPromptContext,
  composeGenerationPrompt,
  defaultAssetPrompt,
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

test('a 9-reference model keeps all nine', () => {
  const composed = compose({ modelId: 'atlas:bytedance/seedance-2.0/reference-to-video', type: 'video', primaryImagePaths: paths(9) });
  assert.equal(composed.capacity, 9);
  assert.equal(composed.inputImagePaths.length, 9);
  assert.deepEqual(composed.droppedImagePaths, []);
});

test('the tenth is dropped rather than sent to a model that will reject it', () => {
  const composed = compose({ modelId: 'atlas:bytedance/seedance-2.0/reference-to-video', type: 'video', primaryImagePaths: paths(10) });
  assert.equal(composed.inputImagePaths.length, 9);
  assert.deepEqual(composed.droppedImagePaths, ['assets/ref_9.png']);
});

test('the same model served by a stricter host keeps that host\'s smaller ceiling', () => {
  // Seedance 2.0's reference endpoint takes 9; the same family's first-frame
  // endpoint takes 1, and Gemini direct takes 3.
  assert.equal(compose({ modelId: 'atlas:bytedance/seedance-2.0/reference-to-video', type: 'video', primaryImagePaths: paths(9) }).inputImagePaths.length, 9);
  assert.equal(compose({ modelId: 'atlas:bytedance/seedance-2.0/image-to-video', type: 'video', primaryImagePaths: paths(9) }).inputImagePaths.length, 1);
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

// Gemini numbers its references too, but has no @-token to do it with: the
// prompt says "image 2" in plain English and the Google adapter numbers the
// parts to match. Sending Seedance's syntax here would put a literal at-sign in
// front of a word Gemini then reads as prose.
// Gemini keeps the description and follows it with bare tokens. Three formats
// were tried on real generations: ordinals from ai.google.dev's own examples
// ("the first and second images") lost the character, and so did dropping the
// pointer entirely on an asset with several references. This one holds her.
// No @ — that is Seedance's marker, and Gemini reads it as punctuation.
test('a Gemini tag keeps its description and follows it with bare tokens', () => {
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> steps out of <Garage>',
    assetLibrary: [ralph, garage],
    type: 'image',
    modelId: 'google-gemini-image'
  });
  assert.equal(
    composed.prompt,
    'Ralph (grizzled mechanic) image1 steps out of The Garage (oil-stained bay) image2'
  );
  assert.equal(composed.usesRefTags, true);
  assert.equal(composed.refTagSample, 'imageN');
  assert.equal(composed.prompt.includes('@'), false);
});

test('every reference an asset holds is named, juxtaposed', () => {
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> waits',
    assetLibrary: [{ ...ralph, inputImages: ['assets/ralph_1.png', 'assets/ralph_2.png'] }],
    type: 'image',
    modelId: 'google-gemini-image-pro'
  });
  assert.equal(composed.prompt, 'Ralph (grizzled mechanic) image1 image2 waits');
  assert.equal(composed.inputImagePaths.length, 2);
});

test('four ticked references are named as four tokens', () => {
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> waits',
    assetLibrary: [ticked],
    type: 'image',
    modelId: 'google-gemini-image-pro'
  });
  assert.equal(composed.prompt, 'Ralph (grizzled mechanic) image1 image2 image3 image4 waits');
});

test('Seedance still drops the description, because it indexes on the token', () => {
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> works on the car',
    assetLibrary: [ralph, garage],
    type: 'video',
    modelId: SEEDANCE
  });
  assert.equal(composed.prompt, '@image1 works on the car');
});

test('Seedance still replaces, because the token is what it indexes on', () => {
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> works on the car',
    assetLibrary: [ralph, garage],
    type: 'video',
    modelId: SEEDANCE
  });
  assert.equal(composed.prompt, '@image1 works on the car');
});

// --- ticked images travel ---------------------------------------------------
//
// Ticking is the user answering "which of my images represent me" directly.
// It used to be consulted only on the board's auto-attach path, so with the
// board unwired or auto-attach off, four ticked images arrived as one.

const ticked = {
  ...ralph,
  inputImages: ['assets/ralph_1.png', 'assets/ralph_2.png', 'assets/ralph_3.png', 'assets/ralph_4.png']
};

test('every ticked image travels with the tag, not just the primary', () => {
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> waits',
    assetLibrary: [ticked],
    type: 'image',
    modelId: 'google-gemini-image-pro' // 14 slots, so nothing is trimmed
  });
  assert.deepEqual(composed.inputImagePaths, [
    'assets/ralph_1.png', 'assets/ralph_2.png', 'assets/ralph_3.png', 'assets/ralph_4.png'
  ]);
});

test('ticks travel with auto-attach off — that setting is about the board', () => {
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> waits',
    assetLibrary: [ticked],
    type: 'image',
    modelId: 'google-gemini-image-pro',
    shot: { id: 's1', refExclusions: [] },
    autoAttachRefs: false
  });
  assert.equal(composed.inputImagePaths.length, 4);
});

test('ticks travel with no reference board at all', () => {
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> waits',
    assetLibrary: [ticked],
    type: 'image',
    modelId: 'google-gemini-image-pro'
  });
  assert.equal(composed.inputImagePaths.length, 4);
});

test('an unticked asset with inference off still sends its primary alone', () => {
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> waits',
    assetLibrary: [ralph],
    type: 'image',
    modelId: 'google-gemini-image-pro',
    autoAttachRefs: false
  });
  assert.deepEqual(composed.inputImagePaths, ['assets/ralph_1.png']);
});

// Seedance is the model that does index on position, so a tag there addresses
// every slot its asset occupies. Four references sent and one addressed would
// be three paid for and ignored.
test('Seedance juxtaposes its tokens, because it has no list syntax', () => {
  const pair = { ...ralph, inputImages: ['assets/ralph_1.png', 'assets/ralph_2.png'] };
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> works on the car',
    assetLibrary: [pair],
    type: 'video',
    modelId: SEEDANCE
  });
  assert.equal(composed.prompt, '@image1 @image2 works on the car');
});

test('only the slots that survived the trim are addressed', () => {
  // Two ticked, one slot. Pointing at a second image that was never sent
  // resolves against whatever happens to be there.
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> works on the car',
    assetLibrary: [{ ...ralph, inputImages: ['assets/ralph_1.png', 'assets/ralph_2.png'] }],
    type: 'video',
    modelId: 'atlas:bytedance/seedance-2.0/image-to-video',
    shot: { id: 's1', refExclusions: [] }
  });
  assert.equal(composed.inputImagePaths.length, 1);
  assert.equal(composed.prompt, '@image1 works on the car');
});

test('the model still caps them — four ticks into three slots is three', () => {
  // Nano Banana takes 3; Nano Banana Pro takes 14. Ticking more than the model
  // reads is not an error, it is a trim, and the prompt only points at what
  // actually went.
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> waits',
    assetLibrary: [ticked],
    type: 'image',
    modelId: 'google-gemini-image'
  });
  assert.equal(composed.inputImagePaths.length, 3);
  assert.deepEqual(composed.droppedImagePaths, ['assets/ralph_4.png']);
});

// --- the two descriptions ---------------------------------------------------

test('a shot gets the short description when the asset has one', () => {
  const brief = { ...ralph, shotDescription: 'grey beard, overalls' };
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> waits',
    assetLibrary: [brief],
    type: 'image',
    modelId: 'fal-ai/flux/schnell'
  });
  assert.equal(composed.prompt, 'Ralph (grey beard, overalls) waits');
});

test('an asset written before the split reads exactly as it always did', () => {
  const composed = composeGenerationPrompt({
    prompt: '<Ralph> waits',
    assetLibrary: [ralph],
    type: 'image',
    modelId: 'fal-ai/flux/schnell'
  });
  assert.equal(composed.prompt, 'Ralph (grizzled mechanic) waits');
});

test('the full description still builds the asset art, short one or not', () => {
  // The whole point of the split: the long one keeps every detail for the
  // character sheet while the shot line stays a handful of words.
  const brief = { ...ralph, shotDescription: 'grey beard' };
  assert.equal(assetShotDescription(brief), 'grey beard');
  assert.ok(defaultAssetPrompt(brief).includes('grizzled mechanic'));
  assert.equal(defaultAssetPrompt(brief).includes('grey beard'), false);
});

test('an empty short description falls back rather than emptying the tag', () => {
  assert.equal(assetShotDescription({ ...ralph, shotDescription: '   ' }), 'grizzled mechanic');
  assert.equal(assetShotDescription({}), '');
});

test('Nano Banana Pro takes fourteen references where plain Nano Banana takes three', () => {
  assert.equal(compose({ modelId: 'google-gemini-image', primaryImagePaths: paths(20) }).inputImagePaths.length, 3);
  assert.equal(compose({ modelId: 'google-gemini-image-pro', primaryImagePaths: paths(20) }).inputImagePaths.length, 14);
});

test('a model that reads its references as a pile advertises no pointer syntax', () => {
  const composed = compose({ modelId: 'fal-ai/flux/dev/redux', primaryImagePaths: paths(1) });
  assert.equal(composed.usesRefTags, false);
  assert.equal(composed.refTagSample, '');
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
    modelId: 'fal-ai/kling-video'
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

// --- Phase 1: prompt overflow reporting ------------------------------------

test('a prompt over the documented limit is reported, never trimmed', () => {
  const long = 'x'.repeat(4200);
  const composed = composeGenerationPrompt({ prompt: long, assetLibrary: [], type: 'image', modelId: 'chatgpt' });
  assert.equal(composed.prompt.length, 4200, 'the prompt is sent whole');
  assert.deepEqual(composed.promptOverflow, { limit: 4000, length: 4200 });
});

test('no known limit means no overflow report however long the prompt', () => {
  const composed = composeGenerationPrompt({ prompt: 'y'.repeat(9000), assetLibrary: [], type: 'image', modelId: 'fal-ai/flux/schnell' });
  assert.equal(composed.promptOverflow, null);
});

test('a prompt within the limit reports nothing', () => {
  const composed = composeGenerationPrompt({ prompt: 'short', assetLibrary: [], type: 'image', modelId: 'chatgpt' });
  assert.equal(composed.promptOverflow, null);
});
