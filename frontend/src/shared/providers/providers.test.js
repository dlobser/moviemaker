// node --test frontend/src/shared/providers/providers.test.js
//
// The provider dispatch used to exist twice — once in server.js, once in
// static/providers.js — with ~14 per-model special cases duplicated verbatim.
// These tests pin down exactly those special cases on the now-single
// implementation: the request bodies each adapter builds, and the routing
// guards that keep an unknown id from silently billing the wrong host.

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveRouting, routesToHiggsfield, routesToFal } from './routing.js';
import { buildFalImageRequest, buildFalVideoRequest, resolveFalVideoModel, falImageSize, isFalReferenceEndpoint, falQueueBase, describeFalError } from './fal.js';
import { buildHiggsfieldImageRequest, buildHiggsfieldVideoRequest } from './higgsfield.js';
import {
  buildAtlasImageBodies, buildAtlasVideoBodies, atlasImageSize, resolveAudioReference,
  isAtlasGeminiImage, usesAtlasImageArray
} from './atlas.js';
import { buildGeminiImageBodies, geminiAspectRatio, geminiImageModel, referenceImageParts } from './google.js';
import { dalleSize } from './openai.js';
import { generateImage, generateVideo, generateText } from './index.js';

// --- routing ---------------------------------------------------------------

test('an explicit host wins over the prefix guess', () => {
  assert.deepEqual(resolveRouting('fal:bytedance/seedance-2.0/image-to-video', null),
    { family: 'fal-ai', path: 'bytedance/seedance-2.0/image-to-video' });
  assert.equal(routesToHiggsfield('fal-ai', 'bytedance/seedance-2.0/image-to-video'), false);
  assert.equal(routesToFal('fal-ai', 'bytedance/seedance-2.0/image-to-video'), true);
});

test('without a host the vendor prefix routes to Higgsfield', () => {
  assert.equal(routesToHiggsfield(null, 'bytedance/seedance/v1/pro/image-to-video'), true);
  assert.equal(routesToFal(null, 'some/unknown/path'), false);
});

test('an unknown image id is refused, not billed to Fal', async () => {
  const ctx = { credentials: {}, capabilities: { direct: true } };
  await assert.rejects(
    generateImage({ provider: 'brand/new/mystery', prompt: 'x' }, ctx),
    /Unsupported image provider: brand\/new\/mystery/
  );
  await assert.rejects(
    generateVideo({ provider: 'brand/new/mystery', prompt: 'x' }, ctx),
    /Unsupported video provider: brand\/new\/mystery/
  );
});

test('an unknown LLM provider is refused', async () => {
  await assert.rejects(generateText({ provider: 'mistral', prompt: 'x' }, { credentials: {} }),
    /Unsupported LLM provider/);
});

// --- Fal -------------------------------------------------------------------

test('the bare fal-ai image id means Flux Schnell', () => {
  assert.equal(buildFalImageRequest('fal-ai', { prompt: 'x', resolution: '16:9' }).modelId, 'fal-ai/flux/schnell');
});

test('Fal aspect enum ladder', () => {
  assert.equal(falImageSize('16:9'), 'landscape_16_9');
  assert.equal(falImageSize('9:16'), 'portrait_16_9');
  assert.equal(falImageSize('1:1'), 'square_hd');
  assert.equal(falImageSize('4:3'), 'landscape_4_3');
  assert.deepEqual(falImageSize('3:2'), { width: 1200, height: 800 });
  assert.deepEqual(falImageSize('21:9'), { width: 1536, height: 640 });
  assert.equal(falImageSize('1024x768'), '1024x768');
  assert.equal(falImageSize(undefined), 'landscape_16_9');
});

test('Kling and Luma swap endpoints on the presence of an input frame', () => {
  assert.equal(resolveFalVideoModel('fal-ai', true), 'fal-ai/kling-video/v2.1/standard/image-to-video');
  assert.equal(resolveFalVideoModel('fal-ai', false), 'fal-ai/kling-video/v3/standard/text-to-video');
  assert.equal(resolveFalVideoModel('fal-ai/luma-dream-machine', true), 'fal-ai/luma-dream-machine/image-to-video');
  assert.equal(resolveFalVideoModel('fal-ai/luma-dream-machine', false), 'fal-ai/luma-dream-machine/text-to-video');
  assert.equal(resolveFalVideoModel('fal-ai/veo3.1', true), 'fal-ai/veo3.1');
});

test('Veo duration coerces to 5s/8s, everything else passes through', () => {
  const veo = buildFalVideoRequest('fal-ai/veo3.1', { prompt: 'x', resolution: '1280x720', duration: '10', hasImage: false });
  assert.equal(veo.input.duration, '8s');
  const veoShort = buildFalVideoRequest('fal-ai/veo2', { prompt: 'x', resolution: '1280x720', duration: '5', hasImage: false });
  assert.equal(veoShort.input.duration, '5s');
  const kling = buildFalVideoRequest('fal-ai', { prompt: 'x', resolution: '720x1280', duration: '10', hasImage: false });
  assert.equal(kling.input.duration, '10');
  assert.equal(kling.input.aspect_ratio, '9:16');
});

// --- Higgsfield ------------------------------------------------------------

test('Higgsfield sends all three image field aliases', () => {
  const { input } = buildHiggsfieldImageRequest('google/nano-banana', {
    prompt: 'x', resolution: '16:9', imageUrls: ['https://fal.media/a.png', 'https://fal.media/b.png']
  });
  assert.equal(input.image_url, 'https://fal.media/a.png');
  assert.deepEqual(input.reference_images, ['https://fal.media/a.png', 'https://fal.media/b.png']);
  assert.deepEqual(input.image_references, ['https://fal.media/a.png', 'https://fal.media/b.png']);
});

test('Higgsfield aspect vs resolution field choice', () => {
  assert.equal(buildHiggsfieldImageRequest('higgsfield', { prompt: 'x', resolution: '16:9' }).input.aspect_ratio, '16:9');
  assert.equal(buildHiggsfieldImageRequest('higgsfield', { prompt: 'x', resolution: '1080p' }).input.resolution, '1080p');
});

test('bare higgsfield ids resolve to the flagship endpoints', () => {
  assert.equal(buildHiggsfieldImageRequest('higgsfield', { prompt: 'x' }).modelId, 'higgsfield-ai/soul/standard');
  assert.equal(buildHiggsfieldVideoRequest('higgsfield', { prompt: 'x' }).modelId, 'higgsfield-ai/dop/standard');
});

test('Higgsfield video carries both image aliases and numeric duration', () => {
  const { input } = buildHiggsfieldVideoRequest('kling-video/o1/image-to-video', {
    prompt: 'x', resolution: '720x1280', duration: '5', imageUrls: ['https://fal.media/a.png']
  });
  assert.equal(input.aspect_ratio, '9:16');
  assert.equal(input.duration, 5);
  assert.equal(input.image_url, 'https://fal.media/a.png');
  assert.deepEqual(input.input_images, ['https://fal.media/a.png']);
});

// --- Atlas -----------------------------------------------------------------

test('Atlas pixel map translates studio ratios', () => {
  assert.equal(atlasImageSize('16:9'), '1344*768');
  assert.equal(atlasImageSize('9:16'), '768*1344');
  assert.equal(atlasImageSize('1280x720'), '1280*720');
  assert.equal(atlasImageSize(undefined), '1344*768');
});

test('Atlas image body ladder: rich body first, minimal fallback second', () => {
  const bodies = buildAtlasImageBodies('black-forest-labs/flux-dev', {
    prompt: 'x', resolution: '16:9', imageDataUrls: ['data:a'], safetyChecker: false
  });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].enable_safety_checker, false);
  assert.equal(bodies[0].size, '1344*768');
  assert.deepEqual(bodies[1], { model: 'black-forest-labs/flux-dev', prompt: 'x', image: 'data:a' });
});

// --- Atlas: Gemini image endpoints ------------------------------------------
//
// Atlas documents `images` (1..10) and `aspect_ratio` for these, and neither
// `image` nor `size` nor `num_images`. Sending the open-weight shape here is
// not an error Atlas reports — it is a bill for a picture that ignored the
// references.

test('a Gemini edit endpoint takes its references as an array, not a lone image', () => {
  const bodies = buildAtlasImageBodies('google/nano-banana-pro/edit', {
    prompt: 'x', resolution: '16:9', imageDataUrls: ['data:a', 'data:b', 'data:c']
  });
  assert.deepEqual(bodies[0].images, ['data:a', 'data:b', 'data:c']);
  assert.equal('image' in bodies[0], false);
  assert.equal('size' in bodies[0], false);
  assert.equal('num_images' in bodies[0], false);
  assert.equal(bodies[0].aspect_ratio, '16:9');
});

test('the Gemini fallback gives up the ratio but never the references', () => {
  const bodies = buildAtlasImageBodies('google/nano-banana-pro/edit', {
    prompt: 'x', resolution: '16:9', imageDataUrls: ['data:a']
  });
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1], { model: 'google/nano-banana-pro/edit', prompt: 'x', images: ['data:a'] });
});

test('a shape Atlas has no ratio for constrains nothing rather than guessing', () => {
  const bodies = buildAtlasImageBodies('google/nano-banana-pro/edit', {
    prompt: 'x', resolution: '7:5', imageDataUrls: ['data:a']
  });
  assert.equal('aspect_ratio' in bodies[0], false);
});

test('the Gemini text-to-image endpoint is sent no images at all', () => {
  // It documents none. Passing them anyway is the silent drop, one layer in.
  const bodies = buildAtlasImageBodies('google/nano-banana-pro/text-to-image', {
    prompt: 'x', resolution: '16:9', imageDataUrls: ['data:a']
  });
  assert.equal(isAtlasGeminiImage('google/nano-banana-pro/text-to-image'), true);
  assert.equal(usesAtlasImageArray('google/nano-banana-pro/text-to-image'), false);
  bodies.forEach(body => {
    assert.equal('images' in body, false);
    assert.equal('image' in body, false);
  });
});

test('the open-weight models keep the shape they always had', () => {
  assert.equal(isAtlasGeminiImage('black-forest-labs/flux-dev'), false);
  assert.equal(isAtlasGeminiImage('z-image/turbo'), false);
  const bodies = buildAtlasImageBodies('black-forest-labs/flux-dev', {
    prompt: 'x', resolution: '16:9', imageDataUrls: ['data:a']
  });
  assert.equal(bodies[0].image, 'data:a');
  assert.equal(bodies[0].num_images, 1);
});

test('the safety checker flag only appears when turned off', () => {
  const bodies = buildAtlasImageBodies('black-forest-labs/flux-dev', { prompt: 'x', resolution: '16:9', safetyChecker: true });
  assert.equal('enable_safety_checker' in bodies[0], false);
});

test('Atlas i2v body ladder: single first frame, every documented shape', () => {
  const bodies = buildAtlasVideoBodies('bytedance/seedance-2.0/image-to-video', {
    prompt: 'x', resolution: '1280x720', duration: '5', imageDataUrls: ['data:a', 'data:b']
  });
  assert.equal(bodies.length, 4);
  // Only the first frame travels on an i2v endpoint, whatever was collected.
  bodies.forEach(body => assert.equal(body.image, 'data:a'));

  assert.equal(bodies[0].ratio, '16:9');          // Seedance 2.0
  assert.equal(bodies[0].resolution, '720p');
  // Seedance 1.5 documents aspect_ratio *and* resolution together. This rung
  // used to carry only the ratio, so a 1.5 request that reached it asked for
  // no size at all and took whatever the model defaulted to.
  assert.equal(bodies[1].aspect_ratio, '16:9');
  assert.equal(bodies[1].resolution, '720p');
  assert.equal(bodies[2].aspect_ratio, '16:9');
  assert.equal('resolution' in bodies[2], false);
  assert.equal('ratio' in bodies[3], false);
  assert.equal('aspect_ratio' in bodies[3], false);
});

test('Atlas ref2v never falls back to a body without the reference array', () => {
  const refs = ['data:a', 'data:b', 'data:c'];
  const bodies = buildAtlasVideoBodies('bytedance/seedance-2.0/reference-to-video', {
    prompt: 'x', resolution: '1280x720', duration: '5', imageDataUrls: refs
  });
  bodies.forEach(body => assert.deepEqual(body.reference_images, refs));
  bodies.forEach(body => assert.equal('image' in body, false));
});

// Reference audio is worth the same care as reference images: a body accepted
// without it produces a silent video at full price, looking like the model
// simply ignored the prompt.
test('every Atlas candidate carries the reference audio it was given', () => {
  const bodies = buildAtlasVideoBodies('bytedance/seedance-2.0/reference-to-video', {
    prompt: 'she sings @audio1', resolution: '1280x720', duration: '5',
    imageDataUrls: ['data:a'], audioAssetRefs: ['asset://1', 'asset://2']
  });
  assert.equal(bodies.length, 3);
  bodies.forEach(body => assert.deepEqual(body.reference_audio, ['asset://1', 'asset://2']));
});

// Atlas accepts a reference_audio it cannot use and only fails once the
// prediction runs, so reshaping until something submits would keep choosing the
// body that dies. Audio gets one shape; only the aspect fields ladder.
test('audio does not multiply the candidate ladder', () => {
  const bodies = buildAtlasVideoBodies('bytedance/seedance-2.0/image-to-video', {
    prompt: 'x', resolution: '1280x720', duration: '5',
    imageDataUrls: ['data:a'], audioAssetRefs: ['data:audio/mpeg;base64,AAA']
  });
  assert.equal(bodies.length, 4);
  bodies.forEach(body => assert.deepEqual(body.reference_audio, ['data:audio/mpeg;base64,AAA']));
});

// Atlas ingests an inline image into its own library and rewrites the field to
// asset://…, but forwards reference_audio verbatim to ByteDance, which wants a
// URL it can fetch. So audio travels as a link and everything else is refused
// locally with a reason, rather than as ByteDance's bare "invalid url".
test('a reachable audio URL passes through untouched', async () => {
  const ctx = {
    fetch: async () => ({ ok: true, headers: { get: () => 'audio/mpeg' } })
  };
  assert.equal(await resolveAudioReference('https://example.com/vo.mp3', ctx), 'https://example.com/vo.mp3');
});

test('a project file cannot be an audio reference, and says why', async () => {
  await assert.rejects(() => resolveAudioReference('assets/vo.wav', {}), /not a URL/);
});

// A clip already in Atlas's own library needs no check and admits none — the
// id resolves only inside Atlas — and it is the sturdiest form, since the file
// then sits on storage the model host is known to reach.
test('an Atlas asset id passes through without a fetch', async () => {
  const ctx = { fetch: () => { throw new Error('should not be fetched'); } };
  assert.equal(await resolveAudioReference('asset://atlas-asset-abc123', ctx), 'asset://atlas-asset-abc123');
});

test('an inlined clip is refused — ByteDance calls a data: URL invalid', async () => {
  await assert.rejects(() => resolveAudioReference('data:audio/mpeg;base64,AQID', {}), /not a URL/);
});

// The /blob/ page is the mistake everyone makes, and ByteDance's only word for
// it would be "invalid url" without naming which clip or why.
test('a URL serving a web page is refused', async () => {
  const ctx = {
    fetch: async () => ({ ok: true, headers: { get: () => 'text/html; charset=utf-8' } })
  };
  await assert.rejects(
    () => resolveAudioReference('https://github.com/u/r/blob/main/vo.mp3', ctx),
    /rather than audio/
  );
});

test('an unreachable clip names the URL that failed', async () => {
  const ctx = { fetch: async () => ({ ok: false, status: 404 }) };
  await assert.rejects(() => resolveAudioReference('https://example.com/gone.mp3', ctx), /404.*gone\.mp3/s);
});

test('no audio means the body ladder is untouched', () => {
  const bodies = buildAtlasVideoBodies('bytedance/seedance-2.0/image-to-video', {
    prompt: 'x', resolution: '1280x720', duration: '5', imageDataUrls: ['data:a']
  });
  assert.equal(bodies.length, 4);
  bodies.forEach(body => assert.equal('reference_audio' in body, false));
});

test('a model that cannot take audio refuses rather than dropping it', async () => {
  await assert.rejects(
    () => generateVideo(
      { provider: 'fal-ai/kling-video', prompt: 'x', audioUrls: ['assets/vo.mp3'] },
      { credentials: {} }
    ),
    /does not take reference audio/
  );
});

// --- moderation refusals ----------------------------------------------------
//
// A refusal aimed at the reference images used to be reported with "rewording
// the prompt is the only route through", which sends you to rewrite text that
// was never the problem while the offending picture stays attached.

test('a refusal about the references does not blame the prompt', () => {
  const body = JSON.stringify({
    detail: [{
      type: 'content_policy_violation',
      msg: 'The images or videos provided may contain likenesses of real people or other private information that cannot be processed.'
    }]
  });
  const described = describeFalError(body);
  assert.match(described, /refusing your reference images, not the prompt/);
  assert.doesNotMatch(described, /Rewording the prompt is the only route/);
});

test('a refusal about the prompt still says so', () => {
  const body = JSON.stringify({
    detail: [{ type: 'content_policy_violation', msg: 'The generated content was withheld.' }]
  });
  const described = describeFalError(body);
  assert.match(described, /Rewording the prompt is the only route/);
});

test('an ordinary error carries no moderation advice at all', () => {
  const body = JSON.stringify({ detail: [{ type: 'value_error', msg: 'duration must be a string' }] });
  assert.equal(describeFalError(body), 'duration must be a string');
});

// --- Fal's Seedance reference endpoint --------------------------------------
//
// Where Atlas forwards an audio string untouched and ByteDance refuses any host
// it does not trust, Fal uploads the clip to its own storage first. That is the
// whole reason a file on disk can be an audio reference here and not there.

test('the reference endpoint is recognised, the first-frame ones are not', () => {
  assert.equal(isFalReferenceEndpoint('bytedance/seedance-2.0/reference-to-video'), true);
  assert.equal(isFalReferenceEndpoint('bytedance/seedance-2.0/image-to-video'), false);
  assert.equal(isFalReferenceEndpoint('fal-ai/kling-video'), false);
});

// Fal's own id for Seedance carries no `fal-ai/` prefix. Adding one makes the
// queue base `fal-ai/bytedance`, and the result fetch then 404s on the
// remainder — after the video has been generated and billed.
test('Seedance on Fal is polled at its app, not at a fal-ai namespace', () => {
  assert.equal(falQueueBase('bytedance/seedance-2.0/reference-to-video'), 'bytedance/seedance-2.0');
  assert.equal(falQueueBase('bytedance/seedance-2.0/fast/reference-to-video'), 'bytedance/seedance-2.0');
  assert.equal(
    resolveRouting('fal:bytedance/seedance-2.0/reference-to-video', null).path,
    'bytedance/seedance-2.0/reference-to-video'
  );
  // Without the explicit host that same path would bill Higgsfield instead.
  assert.equal(routesToHiggsfield(null, 'bytedance/seedance-2.0/reference-to-video'), true);
  assert.equal(routesToFal('fal-ai', 'bytedance/seedance-2.0/reference-to-video'), true);
});

test('the reference endpoint asks for 720p, the others leave resolution alone', () => {
  const ref = buildFalVideoRequest('bytedance/seedance-2.0/reference-to-video', {
    prompt: 'x', resolution: '1280x720', duration: '8', hasImage: true
  });
  assert.equal(ref.input.resolution, '720p');
  assert.equal(ref.input.aspect_ratio, '16:9');
  assert.equal(ref.input.duration, '8');

  const kling = buildFalVideoRequest('fal-ai/kling-video', {
    prompt: 'x', resolution: '1280x720', duration: '5', hasImage: true
  });
  assert.equal('resolution' in kling.input, false);
});

test('every reference travels, as arrays rather than a single frame', async () => {
  const seen = {};
  const ctx = {
    credentials: { falKey: 'k' },
    uploadPublicUrl: async (path) => `https://fal.media/${path}`,
    // Refused at submission on purpose: the request body is what these pin
    // down, and letting it reach the queue would cost the suite a poll cycle.
    fetch: async (url, options) => {
      seen.input = JSON.parse(options.body);
      return { ok: false, status: 400, text: async () => 'inspected' };
    }
  };
  await assert.rejects(() => generateVideo({
    provider: 'fal:bytedance/seedance-2.0/reference-to-video',
    providerFamily: null,
    prompt: '@image1 sings @audio1',
    imageUrls: ['assets/a.png', 'assets/b.png'],
    audioUrls: ['assets/vo.mp3'],
    resolution: '1280x720',
    duration: '8'
  }, ctx));
  assert.deepEqual(seen.input.image_urls, ['https://fal.media/assets/a.png', 'https://fal.media/assets/b.png']);
  assert.deepEqual(seen.input.audio_urls, ['https://fal.media/assets/vo.mp3']);
  assert.equal('image_url' in seen.input, false);
});

test('an already-hosted clip is not re-uploaded', async () => {
  const seen = {};
  const ctx = {
    credentials: { falKey: 'k' },
    uploadPublicUrl: async (path) => `https://fal.media/${path}`,
    // Refused at submission on purpose: the request body is what these pin
    // down, and letting it reach the queue would cost the suite a poll cycle.
    fetch: async (url, options) => {
      seen.input = JSON.parse(options.body);
      return { ok: false, status: 400, text: async () => 'inspected' };
    }
  };
  await assert.rejects(() => generateVideo({
    provider: 'fal:bytedance/seedance-2.0/reference-to-video',
    providerFamily: null,
    prompt: 'x',
    imageUrls: ['assets/a.png'],
    audioUrls: ['https://example.com/vo.mp3'],
    resolution: '1280x720'
  }, ctx));
  assert.deepEqual(seen.input.audio_urls, ['https://example.com/vo.mp3']);
});

test('an Atlas asset id is refused on Fal, where it means nothing', async () => {
  const ctx = {
    credentials: { falKey: 'k' },
    uploadPublicUrl: async (path) => `https://fal.media/${path}`,
    fetch: async () => ({ ok: true, json: async () => ({ request_id: 'r', status: 'COMPLETED' }) })
  };
  await assert.rejects(() => generateVideo({
    provider: 'fal:bytedance/seedance-2.0/reference-to-video',
    providerFamily: null,
    prompt: 'x',
    imageUrls: ['assets/a.png'],
    audioUrls: ['asset://atlas-asset-abc'],
    resolution: '1280x720'
  }, ctx), /Atlas Asset Library id and means nothing to Fal/);
});

// --- Gemini Image ----------------------------------------------------------
//
// The adapter dropped `resolution` entirely, so every generation was made at
// whatever shape the model felt like. These pin down that a ratio is now asked
// for, and that an unrecognised one asks for nothing rather than inventing.

test('studio ratios pass through to Gemini unchanged', () => {
  assert.equal(geminiAspectRatio('16:9'), '16:9');
  assert.equal(geminiAspectRatio('9:16'), '9:16');
  assert.equal(geminiAspectRatio('1:1'), '1:1');
  assert.equal(geminiAspectRatio('21:9'), '21:9');
});

test('pixel dimensions reduce to the ratio they are closest to', () => {
  assert.equal(geminiAspectRatio('1344x768'), '16:9');
  assert.equal(geminiAspectRatio('768*1344'), '9:16');
  assert.equal(geminiAspectRatio('1024x1024'), '1:1');
});

test('a shape Gemini has no ratio for constrains nothing', () => {
  assert.equal(geminiAspectRatio('7:5'), null);
  assert.equal(geminiAspectRatio(''), null);
  assert.equal(geminiAspectRatio(undefined), null);
  assert.equal(geminiAspectRatio('1000x137'), null);
});

test('both documented ratio fields are offered, then a body without one', () => {
  const bodies = buildGeminiImageBodies([{ text: 'x' }], '16:9');
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].generationConfig.imageConfig.aspectRatio, '16:9');
  assert.equal(bodies[1].generationConfig.responseFormat.image.aspectRatio, '16:9');
  assert.equal('imageConfig' in bodies[2].generationConfig, false);
  assert.equal('responseFormat' in bodies[2].generationConfig, false);
  bodies.forEach(body => assert.deepEqual(body.generationConfig.responseModalities, ['IMAGE']));
});

test('no ratio means one body, exactly as before', () => {
  const bodies = buildGeminiImageBodies([{ text: 'x' }], null);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].generationConfig, { responseModalities: ['IMAGE'] });
});

test('the two Nano Bananas are different endpoints with different ceilings', () => {
  assert.deepEqual(geminiImageModel('google-gemini-image'),
    { model: 'gemini-2.5-flash-image', label: 'Nano Banana', maxImages: 3 });
  assert.deepEqual(geminiImageModel('google-gemini-image-pro'),
    { model: 'gemini-3-pro-image-preview', label: 'Nano Banana Pro', maxImages: 14 });
});

test('an unknown id falls back to the small model rather than overpromising', () => {
  // Guessing Pro would let 14 references through to an endpoint that takes 3.
  assert.equal(geminiImageModel(undefined).maxImages, 3);
  assert.equal(geminiImageModel('something-else').model, 'gemini-2.5-flash-image');
});

test('references travel as a plain run of images, with nothing interleaved', () => {
  // Labelling them ("The second image:") was tried and made character identity
  // worse: numbering four views of one person invites the model to reconcile
  // four people. Anything between the images is a claim about them.
  const parts = referenceImageParts([
    { mimeType: 'image/png', data: 'AAA' },
    { mimeType: 'image/jpeg', data: 'BBB' }
  ]);
  assert.deepEqual(parts.map(p => p.inlineData.data), ['AAA', 'BBB']);
  assert.equal(parts.every(p => p.text === undefined), true);
  assert.equal(parts[1].inlineData.mimeType, 'image/jpeg');
});

test('no references means no parts', () => {
  assert.deepEqual(referenceImageParts([]), []);
});

// --- DALL-E ----------------------------------------------------------------

test('DALL-E size mapping', () => {
  assert.equal(dalleSize('16:9'), '1792x1024');
  assert.equal(dalleSize('9:16'), '1024x1792');
  assert.equal(dalleSize('1:1'), '1024x1024');
  assert.equal(dalleSize(undefined), '1024x1024');
});

// --- CORS-gated adapters ---------------------------------------------------

test('Runway and Kling refuse to run without direct network access', async () => {
  const ctx = { credentials: { runwayKey: 'k', klingKey: 'k' }, capabilities: { direct: false } };
  await assert.rejects(generateVideo({ provider: 'runway', prompt: 'x' }, ctx), /no CORS support/);
  await assert.rejects(generateVideo({ provider: 'kling', prompt: 'x' }, ctx), /no CORS support/);
});
