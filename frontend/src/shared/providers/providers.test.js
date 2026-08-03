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
import { buildFalImageRequest, buildFalVideoRequest, resolveFalVideoModel, falImageSize } from './fal.js';
import { buildHiggsfieldImageRequest, buildHiggsfieldVideoRequest } from './higgsfield.js';
import { buildAtlasImageBodies, buildAtlasVideoBodies, atlasImageSize } from './atlas.js';
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
    prompt: 'x', resolution: '16:9', imageDataUrls: ['data:a', 'data:b']
  });
  assert.equal(input.image_url, 'data:a');
  assert.deepEqual(input.reference_images, ['data:a', 'data:b']);
  assert.deepEqual(input.image_references, ['data:a', 'data:b']);
});

test('Higgsfield aspect vs resolution field choice', () => {
  assert.equal(buildHiggsfieldImageRequest('higgsfield', { prompt: 'x', resolution: '16:9' }).input.aspect_ratio, '16:9');
  assert.equal(buildHiggsfieldImageRequest('higgsfield', { prompt: 'x', resolution: '1080p' }).input.resolution, '1080p');
});

test('bare higgsfield ids resolve to the flagship endpoints', () => {
  assert.equal(buildHiggsfieldImageRequest('higgsfield', { prompt: 'x' }).modelId, 'higgsfield-ai/soul/standard');
  assert.equal(buildHiggsfieldVideoRequest('higgsfield', { prompt: 'x' }).modelId, 'higgsfield-ai/dop/preview');
});

test('Higgsfield video carries both image aliases and numeric duration', () => {
  const { input } = buildHiggsfieldVideoRequest('kling-video/o1/image-to-video', {
    prompt: 'x', resolution: '720x1280', duration: '5', imageDataUrls: ['data:a']
  });
  assert.equal(input.aspect_ratio, '9:16');
  assert.equal(input.duration, 5);
  assert.equal(input.image_url, 'data:a');
  assert.deepEqual(input.input_images, ['data:a']);
});

// --- Atlas -----------------------------------------------------------------

test('Atlas pixel map translates studio ratios', () => {
  assert.equal(atlasImageSize('16:9'), '1344*768');
  assert.equal(atlasImageSize('9:16'), '768*1344');
  assert.equal(atlasImageSize('1280x720'), '1280*720');
  assert.equal(atlasImageSize(undefined), '1344*768');
});

test('Atlas image body ladder: rich body first, minimal fallback second', () => {
  const bodies = buildAtlasImageBodies('z-image/turbo', {
    prompt: 'x', resolution: '16:9', imageDataUrl: 'data:a', safetyChecker: false
  });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].enable_safety_checker, false);
  assert.equal(bodies[0].size, '1344*768');
  assert.deepEqual(bodies[1], { model: 'z-image/turbo', prompt: 'x', image: 'data:a' });
});

test('the safety checker flag only appears when turned off', () => {
  const bodies = buildAtlasImageBodies('z-image/turbo', { prompt: 'x', resolution: '16:9', safetyChecker: true });
  assert.equal('enable_safety_checker' in bodies[0], false);
});

test('Atlas i2v body ladder: single first frame, three shapes', () => {
  const bodies = buildAtlasVideoBodies('bytedance/seedance-2.0/image-to-video', {
    prompt: 'x', resolution: '1280x720', duration: '5', imageDataUrls: ['data:a', 'data:b']
  });
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].image, 'data:a');
  assert.equal(bodies[0].ratio, '16:9');
  assert.equal(bodies[0].resolution, '720p');
  assert.equal(bodies[1].aspect_ratio, '16:9');
  assert.equal(bodies[2].image, 'data:a');
  assert.equal('ratio' in bodies[2], false);
});

test('Atlas ref2v never falls back to a body without the reference array', () => {
  const refs = ['data:a', 'data:b', 'data:c'];
  const bodies = buildAtlasVideoBodies('bytedance/seedance-2.0/reference-to-video', {
    prompt: 'x', resolution: '1280x720', duration: '5', imageDataUrls: refs
  });
  bodies.forEach(body => assert.deepEqual(body.reference_images, refs));
  bodies.forEach(body => assert.equal('image' in body, false));
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
