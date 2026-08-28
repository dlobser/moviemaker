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
import {
  buildVeniceImageBody, buildVeniceEditBody, buildVeniceVideoBody,
  veniceAspectRatio, veniceResolutionTier, veniceDuration,
  isVeniceEditModel, isVeniceReferenceVideo, describeVeniceError
} from './venice.js';
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

// --- Venice ----------------------------------------------------------------
//
// Venice's split of every image model into a generator and an editor is the
// thing these tests exist to hold. The generator has no image field at all, so
// a reference handed to it does not fail — it vanishes, and a picture that
// ignored it is billed and saved. The adapter has to refuse instead.

test('Venice tells its generators and its editors apart from the id alone', () => {
  assert.equal(isVeniceEditModel('qwen-image-3-pro'), false);
  assert.equal(isVeniceEditModel('seedream-v5-pro'), false);
  assert.equal(isVeniceEditModel('qwen-image-3-pro-edit'), true);
  // The infix spelling, which is the one that would be missed by a suffix test.
  assert.equal(isVeniceEditModel('qwen-edit-uncensored'), true);
  assert.equal(isVeniceEditModel('firered-image-edit'), true);
});

test('the venice host routes nowhere else', () => {
  assert.deepEqual(resolveRouting('venice:qwen-image-3-pro', null),
    { family: 'venice', path: 'qwen-image-3-pro' });
  assert.equal(routesToFal('venice', 'qwen-image-3-pro'), false);
  assert.equal(routesToHiggsfield('venice', 'qwen-image-3-pro'), false);
});

test('a Venice generator refuses references rather than dropping them', async () => {
  const ctx = {
    credentials: { veniceKey: 'k' },
    readAssetDataUrl: async () => 'data:image/png;base64,AAA',
    capabilities: { direct: true },
    fetch: async () => { throw new Error('should never be sent'); }
  };
  await assert.rejects(
    generateImage({ provider: 'venice:seedream-v5-pro', prompt: 'x', inputImagePaths: ['assets/a.png'] }, ctx),
    /takes no reference images.*seedream-v5-pro-edit/s
  );
});

test('a Venice editor refuses to run with nothing to edit', async () => {
  const ctx = {
    credentials: { veniceKey: 'k' },
    readAssetDataUrl: async () => 'data:image/png;base64,AAA',
    capabilities: { direct: true },
    fetch: async () => { throw new Error('should never be sent'); }
  };
  await assert.rejects(
    generateImage({ provider: 'venice:qwen-edit-uncensored', prompt: 'x' }, ctx),
    /needs at least one input image/
  );
});

test('a missing Venice key is named before anything is sent', async () => {
  const ctx = { credentials: {}, capabilities: { direct: true }, readAssetDataUrl: async () => 'data:' };
  await assert.rejects(
    generateImage({ provider: 'venice:qwen-image-3-pro', prompt: 'x' }, ctx),
    /Venice.ai API key is not configured/
  );
});

// Every Venice model publishes its own aspect list and the siblings differ.
// A ratio the model does not list has to send nothing rather than be passed
// through, which is a 400 after the request has already gone out.
test('a ratio the model does not list constrains nothing', () => {
  assert.equal(veniceAspectRatio('qwen-image-3-pro', '21:9'), '21:9');
  assert.equal(veniceAspectRatio('seedream-v5-pro', '21:9'), null);
  assert.equal(veniceAspectRatio('seedream-v5-pro', '16:9'), '16:9');
  // Pixel forms reduce to the ratio they are nearest.
  assert.equal(veniceAspectRatio('qwen-image-3-pro', '1344x768'), '16:9');
  assert.equal(veniceAspectRatio('qwen-image-3-pro', 'nonsense'), null);
});

test('the text-to-image body asks for PNG and carries the safety flag', () => {
  const body = buildVeniceImageBody('qwen-image-3-pro', { prompt: 'x', resolution: '16:9', safetyChecker: false });
  assert.equal(body.model, 'qwen-image-3-pro');
  assert.equal(body.format, 'png');
  assert.equal(body.aspect_ratio, '16:9');
  // safe_mode blurs rather than refuses, so it has to follow the studio switch
  // exactly — a default of "on" would quietly return unusable frames.
  assert.equal(body.safe_mode, false);
  assert.equal(buildVeniceImageBody('qwen-image-3-pro', { prompt: 'x' }).safe_mode, true);
  assert.equal('images' in body, false);
});

test('the edit body keeps every reference and falls back to auto shape', () => {
  const images = ['data:a', 'data:b', 'data:c'];
  const body = buildVeniceEditBody('seedream-v5-pro-edit', { prompt: 'x', resolution: '16:9', imageDataUrls: images });
  assert.equal(body.modelId, 'seedream-v5-pro-edit');
  assert.deepEqual(body.images, images);
  assert.equal(body.aspect_ratio, '16:9');
  // A shape this model does not list means "keep the input's", not "guess".
  assert.equal(buildVeniceEditBody('seedream-v5-pro-edit', { prompt: 'x', resolution: '21:9', imageDataUrls: images }).aspect_ratio, 'auto');
});

test('Venice i2v takes one first frame, ref2v takes the whole array', () => {
  const images = ['data:a', 'data:b', 'data:c'];
  const i2v = buildVeniceVideoBody('wan-2-7-image-to-video', {
    prompt: 'x', resolution: '1280x720', duration: '10', imageDataUrls: images
  });
  assert.equal(i2v.image_url, 'data:a');
  assert.equal('reference_image_urls' in i2v, false);
  assert.equal(i2v.duration, '10s');

  const r2v = buildVeniceVideoBody('minimax-h3-enhanced-reference-to-video', {
    prompt: '@Image1 walks', resolution: '1280x720', duration: '8', imageDataUrls: images
  });
  assert.deepEqual(r2v.reference_image_urls, images);
  assert.equal('image_url' in r2v, false);
  assert.equal(isVeniceReferenceVideo('minimax-h3-enhanced-reference-to-video'), true);
});

// Wan publishes an empty aspect list because it takes the shape from the input
// frame; MiniMax publishes a real one. Sending Wan a ratio is a field it has no
// use for, and sending MiniMax none takes whatever it defaults to.
test('the shape fields follow what the model publishes', () => {
  const wan = buildVeniceVideoBody('wan-2-7-image-to-video', {
    prompt: 'x', resolution: '1920x1080', duration: '5', imageDataUrls: ['data:a']
  });
  assert.equal('aspect_ratio' in wan, false);
  assert.equal(wan.resolution, '1080p');

  const minimax = buildVeniceVideoBody('minimax-h3-enhanced-reference-to-video', {
    prompt: 'x', resolution: '1440x2560', duration: '5', imageDataUrls: ['data:a']
  });
  assert.equal(minimax.aspect_ratio, '9:16');
  assert.equal(minimax.resolution, '2K');
});

// The two vocabularies do not line up: there is no '720p' on MiniMax, and the
// truthful answer is the tier 48 pixels away rather than no tier at all.
// A first frame already states the shape. Sending a ratio beside it asks the
// model to reconcile "16:9" with a 1376x768 still that is not quite 16:9.
test('an image-to-video request states no ratio beside its first frame', () => {
  // Wan 3.0 publishes `adaptive` for this, which says it explicitly.
  const wan3 = buildVeniceVideoBody('wan-3-0-image-to-video', {
    prompt: 'x', resolution: '1280x720', duration: '5', imageDataUrls: ['https://host/a.jpg']
  });
  assert.equal(wan3.aspect_ratio, 'adaptive');

  // Wan 2.7 has no such token, so it is sent nothing rather than a guess.
  const wan27 = buildVeniceVideoBody('wan-2-7-image-to-video', {
    prompt: 'x', resolution: '1280x720', duration: '5', imageDataUrls: ['https://host/a.jpg']
  });
  assert.equal('aspect_ratio' in wan27, false);

  // With no frame there is nothing to take the shape from, so it is stated.
  const t2v = buildVeniceVideoBody('wan-3-0-image-to-video', {
    prompt: 'x', resolution: '1280x720', duration: '5', imageDataUrls: []
  });
  assert.equal(t2v.aspect_ratio, '16:9');
});

// Reference images are subjects, not a canvas — the output shape still has to
// be stated or the model chooses one on its own.
test('reference-to-video still states its shape', () => {
  const r2v = buildVeniceVideoBody('minimax-h3-enhanced-reference-to-video', {
    prompt: '@Image1 walks', resolution: '1440x2560', duration: '8',
    imageDataUrls: ['https://host/a.jpg', 'https://host/b.jpg']
  });
  assert.equal(r2v.aspect_ratio, '9:16');
  assert.equal(r2v.reference_image_urls.length, 2);
});

test('resolution tiers are named per model, nearest wins', () => {
  assert.equal(veniceResolutionTier('minimax-h3-enhanced-reference-to-video', '1280x720'), '768P');
  assert.equal(veniceResolutionTier('minimax-h3-enhanced-reference-to-video', '2560x1440'), '2K');
  assert.equal(veniceResolutionTier('wan-2-7-image-to-video', '720x1280'), '720p');
  assert.equal(veniceResolutionTier('wan-2-7-enhanced-image-to-video', '1080x1920'), '1080p');
  // No size to match: the model's own cheapest tier, never its largest.
  assert.equal(veniceResolutionTier('wan-2-7-image-to-video', undefined), '720p');
  // An id with no published tiers asks for none.
  assert.equal(veniceResolutionTier('some-unlisted-model', '1280x720'), null);
});

test('durations become Venice seconds strings', () => {
  assert.equal(veniceDuration('10'), '10s');
  assert.equal(veniceDuration(15), '15s');
  assert.equal(veniceDuration(undefined), '5s');
  assert.equal(veniceDuration('nonsense'), '5s');
});

test('a Venice error reads out its issues, not just its status', () => {
  assert.match(
    describeVeniceError('{"error":"Invalid request parameters","issues":[{"message":"aspect_ratio not supported"}]}'),
    /Invalid request parameters — aspect_ratio not supported/
  );
  assert.equal(describeVeniceError('not json at all'), 'not json at all');
});

// Venice answers its two image endpoints in two different shapes — base64
// inside JSON from /image/generate, raw bytes from /image/multi-edit — and the
// host contract only knows how to save a URL. These two cover that bridge,
// which is the part of the adapter no amount of reading the spec can check.

/** A Response stand-in with just the surface the adapter touches. */
function fakeResponse({ status = 200, contentType, json, bytes, text = '' }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => json,
    text: async () => text,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
}

test('a generated image arrives as base64 in JSON and is saved as a PNG', async () => {
  const sent = [];
  const ctx = {
    credentials: { veniceKey: 'k' },
    capabilities: { direct: true },
    readAssetDataUrl: async () => 'data:image/png;base64,AAA',
    fetch: async (url, options) => {
      sent.push({ url, body: JSON.parse(options.body) });
      return fakeResponse({ contentType: 'application/json', json: { id: '1', images: ['QUJD'] } });
    },
    saveRemote: async (url, prefix, ext) => `assets/${prefix}${ext}:${url}`
  };

  const saved = await generateImage({
    provider: 'venice:qwen-image-3-pro', prompt: 'a cat', resolution: '16:9', safetyChecker: false
  }, ctx);

  assert.equal(sent[0].url, 'https://api.venice.ai/api/v1/image/generate');
  assert.equal(sent[0].body.model, 'qwen-image-3-pro');
  assert.equal(saved, 'assets/img.png:data:image/png;base64,QUJD');
});

test('an edited image arrives as raw bytes and is wrapped into a data URL', async () => {
  const ctx = {
    credentials: { veniceKey: 'k' },
    capabilities: { direct: true },
    readAssetDataUrl: async (path) => `data:image/png;base64,${path}`,
    fetch: async (url, options) => {
      assert.equal(url, 'https://api.venice.ai/api/v1/image/multi-edit');
      // Both references travel, in order, as the base image and its layer.
      assert.deepEqual(JSON.parse(options.body).images,
        ['data:image/png;base64,a.png', 'data:image/png;base64,b.png']);
      return fakeResponse({ contentType: 'image/png', bytes: new Uint8Array([65, 66, 67]) });
    },
    saveRemote: async (url, prefix, ext) => `assets/${prefix}${ext}:${url}`
  };

  const saved = await generateImage({
    provider: 'venice:seedream-v5-pro-edit', prompt: 'x', resolution: '16:9',
    inputImagePaths: ['a.png', 'b.png']
  }, ctx);

  // "ABC" base64-encoded, under the content type Venice actually sent.
  assert.equal(saved, 'assets/img.png:data:image/png;base64,QUJD');
});

test('a Venice failure quotes the reason, not just the status', async () => {
  const ctx = {
    credentials: { veniceKey: 'k' },
    capabilities: { direct: true },
    readAssetDataUrl: async () => 'data:',
    fetch: async () => fakeResponse({
      status: 400, contentType: 'application/json',
      text: '{"error":"Invalid request parameters","issues":[{"message":"aspect_ratio not supported"}]}'
    })
  };
  await assert.rejects(
    generateImage({ provider: 'venice:qwen-image-3-pro', prompt: 'x' }, ctx),
    /400.*aspect_ratio not supported/s
  );
});

// Venice documents data: URLs for `image_url` and they are still the wrong
// choice at project scale: a 5MB still is ~6.5MB of base64 that has to reach
// Venice and then the backend actually running the model. These pin the fork.

test('Venice video frames are hosted when a Fal key can host them', async () => {
  const uploaded = [];
  const ctx = {
    credentials: { veniceKey: 'k', falKey: 'f' },
    capabilities: { direct: true },
    readAssetDataUrl: async () => { throw new Error('should not inline when a Fal key exists'); },
    uploadPublicUrl: async (path) => { uploaded.push(path); return `https://fal.media/${path}`; },
    fetch: async (url, options) => {
      if (url.endsWith('/video/quote')) return fakeResponse({ contentType: 'application/json', json: { quote: 0.55 } });
      if (url.endsWith('/video/queue')) {
        assert.equal(JSON.parse(options.body).image_url, 'https://fal.media/first.png');
        return fakeResponse({ contentType: 'application/json', json: {}, text: '{"queue_id":"q1"}' });
      }
      throw new Error('stop after queue');
    },
    saveRemote: async () => 'unused'
  };

  await assert.rejects(generateVideo({
    provider: 'venice:wan-2-7-image-to-video', prompt: 'x',
    imageUrls: ['first.png'], resolution: '1280x720', duration: '5'
  }, ctx), /stop after queue/);
  assert.deepEqual(uploaded, ['first.png']);
});

test('without a Fal key the frame still goes, inline, rather than being refused', async () => {
  const ctx = {
    credentials: { veniceKey: 'k' },
    capabilities: { direct: true },
    readAssetDataUrl: async (path) => `data:image/png;base64,${path}`,
    uploadPublicUrl: async () => { throw new Error('no Fal key'); },
    fetch: async (url, options) => {
      if (url.endsWith('/video/quote')) return fakeResponse({ contentType: 'application/json', json: { quote: 0.55 } });
      assert.equal(JSON.parse(options.body).image_url, 'data:image/png;base64,first.png');
      throw new Error('stop after queue');
    },
    saveRemote: async () => 'unused'
  };
  await assert.rejects(generateVideo({
    provider: 'venice:wan-2-7-image-to-video', prompt: 'x',
    imageUrls: ['first.png'], resolution: '1280x720', duration: '5'
  }, ctx), /stop after queue/);
});

// A 500 on /video/retrieve is Venice's "inference processing failed" — the job
// died, the poll was fine. Reporting it as a failed status check sends you
// looking at the network instead of at the request.
test('a failed generation is not reported as a failed status check', async () => {
  let polls = 0;
  const ctx = {
    credentials: { veniceKey: 'k' },
    capabilities: { direct: true },
    pollIntervalMs: 0,
    readAssetDataUrl: async () => 'data:image/png;base64,AAA',
    uploadPublicUrl: async () => { throw new Error('no Fal key'); },
    fetch: async (url) => {
      if (url.endsWith('/video/quote')) return fakeResponse({ contentType: 'application/json', json: { quote: 0.55 } });
      if (url.endsWith('/video/queue')) {
        return fakeResponse({ contentType: 'application/json', text: '{"queue_id":"q1"}' });
      }
      polls++;
      return fakeResponse({ status: 500, contentType: 'application/json', text: '{"error":"An unknown error occurred"}' });
    },
    saveRemote: async () => 'unused'
  };
  await assert.rejects(generateVideo({
    provider: 'venice:wan-2-7-image-to-video', prompt: 'x',
    imageUrls: ['first.png'], resolution: '1280x720', duration: '5'
  }, ctx), (error) => {
    assert.match(error.message, /could not generate this video/);
    assert.doesNotMatch(error.message, /status check failed/);
    // It names the frame form, which is the lead worth following first.
    assert.match(error.message, /inline data URLs/);
    assert.match(error.message, /Fal.ai key/);
    return true;
  });
  // A 500 is not taken at face value the first time: Venice answers one for a
  // queue id that has not finished registering as well as for a dead job, and
  // giving up on the first would abandon a generation already paid for.
  assert.equal(polls, 4);
});

// The other half of that rule: a 500 that resolves was the job being early, and
// the video still has to come back.
test('an early 500 does not abandon a job that then runs', async () => {
  let polls = 0;
  const ctx = {
    credentials: { veniceKey: 'k', falKey: 'f' },
    capabilities: { direct: true },
    pollIntervalMs: 0,
    uploadPublicUrl: async (path) => `https://fal.media/${path}`,
    fetch: async (url) => {
      if (url.endsWith('/video/quote')) return fakeResponse({ contentType: 'application/json', json: { quote: 0.09 } });
      if (url.endsWith('/video/queue')) {
        return fakeResponse({ contentType: 'application/json', text: '{"queue_id":"q1"}' });
      }
      polls++;
      if (polls === 1) return fakeResponse({ status: 500, contentType: 'application/json', text: '{"error":"nope"}' });
      if (polls === 2) return fakeResponse({ contentType: 'application/json', json: { status: 'PROCESSING' } });
      return fakeResponse({ contentType: 'video/mp4', bytes: new Uint8Array([1, 2, 3]) });
    },
    saveRemote: async (url, prefix, ext) => `assets/${prefix}${ext}`
  };

  const saved = await generateVideo({
    provider: 'venice:wan-2-7-image-to-video', prompt: 'x',
    imageUrls: ['first.png'], resolution: '1280x720', duration: '5'
  }, ctx);
  assert.equal(saved, 'assets/vid.mp4');
  assert.equal(polls, 3);
});

// The bug this pre-flight exists for, in full. A shot that carried 4s from a
// previous model is accepted by /video/queue — whose duration enum spans every
// model on the host, 1s to 30s — then billed, then killed in inference with a
// bare "An unknown error occurred". /video/quote checks the same field against
// the model actually being asked for, and costs nothing.
test('settings this model cannot take are refused before anything is queued', async () => {
  const called = [];
  const ctx = {
    credentials: { veniceKey: 'k', falKey: 'f' },
    capabilities: { direct: true },
    uploadPublicUrl: async (path) => `https://fal.media/${path}`,
    fetch: async (url) => {
      called.push(url);
      if (url.endsWith('/video/quote')) {
        return fakeResponse({
          status: 400, contentType: 'application/json',
          text: '{"error":"Invalid request parameters","issues":[{"message":"Invalid enum value. Expected \'5s\' | \'10s\' | \'15s\', received \'4s\'"}]}'
        });
      }
      throw new Error('nothing should be queued');
    }
  };

  await assert.rejects(generateVideo({
    provider: 'venice:wan-2-7-enhanced-image-to-video', prompt: 'x',
    imageUrls: ['first.png'], resolution: '1280x720', duration: '4'
  }, ctx), (error) => {
    assert.match(error.message, /will not accept these settings/);
    assert.match(error.message, /received '4s'/);
    assert.match(error.message, /Nothing was queued or billed/);
    return true;
  });
  // The point of the whole exercise: /video/queue was never reached.
  assert.deepEqual(called.filter(url => url.endsWith('/video/queue')), []);
});

// A quote that fails for any reason other than validation must not stand
// between a shot and a generation that would have worked.
test('a quote that is merely unavailable does not block the generation', async () => {
  const ctx = {
    credentials: { veniceKey: 'k', falKey: 'f' },
    capabilities: { direct: true },
    pollIntervalMs: 0,
    uploadPublicUrl: async (path) => `https://fal.media/${path}`,
    fetch: async (url) => {
      if (url.endsWith('/video/quote')) return fakeResponse({ status: 500, contentType: 'application/json', text: '{"error":"down"}' });
      if (url.endsWith('/video/queue')) return fakeResponse({ contentType: 'application/json', text: '{"queue_id":"q1"}' });
      return fakeResponse({ contentType: 'video/mp4', bytes: new Uint8Array([9]) });
    },
    saveRemote: async (url, prefix, ext) => `assets/${prefix}${ext}`
  };
  assert.equal(await generateVideo({
    provider: 'venice:wan-2-7-image-to-video', prompt: 'x',
    imageUrls: ['first.png'], resolution: '1280x720', duration: '5'
  }, ctx), 'assets/vid.mp4');
});
