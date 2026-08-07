// node --test frontend/src/modelSettings.test.js
//
// The property worth pinning down is the inherit rule: empty string, null and
// undefined all fall through to the next level, on every level — the old
// `shot.imageModel || imageModel` idiom got that right only by accident of JS
// truthiness, and a resolver that broke it would silently repoint shots at
// nothing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveModelSettings } from './modelSettings.js';

const project = {
  imageModel: 'fal-ai/flux/schnell',
  imageResolution: '16:9',
  videoModel: 'fal-ai/kling-video',
  videoResolution: '1280x720',
  videoDuration: '5',
  assetTypeModels: { character: 'higgsfield-ai/soul-id' }
};

test('with nothing else set, project defaults win and say so', () => {
  const r = resolveModelSettings({ type: 'image', project });
  assert.equal(r.model, 'fal-ai/flux/schnell');
  assert.equal(r.source, 'project');
});

test('a shot override wins over everything', () => {
  const r = resolveModelSettings({
    type: 'image', project,
    scene: { imageModel: 'fal-ai/flux/dev' },
    shot: { imageModel: 'google-gemini-image' }
  });
  assert.equal(r.model, 'google-gemini-image');
  assert.equal(r.source, 'shot');
});

test('a scene default beats the project default', () => {
  const r = resolveModelSettings({ type: 'video', project, scene: { videoModel: 'fal-ai/veo3.1' }, shot: {} });
  assert.equal(r.model, 'fal-ai/veo3.1');
  assert.equal(r.source, 'scene');
});

test('empty string means inherit, not override', () => {
  const r = resolveModelSettings({
    type: 'image', project,
    scene: { imageModel: '' },
    shot: { imageModel: null }
  });
  assert.equal(r.model, 'fal-ai/flux/schnell');
  assert.equal(r.source, 'project');
});

test('each field resolves independently', () => {
  const r = resolveModelSettings({
    type: 'video', project,
    scene: { videoDuration: '10' },
    shot: { videoModel: 'fal-ai/veo2' }
  });
  assert.equal(r.model, 'fal-ai/veo2');
  assert.equal(r.duration, '10');
  assert.deepEqual(r.sources, { model: 'shot', resolution: 'project', duration: 'scene' });
});

test('asset-type defaults apply to asset image generation only', () => {
  const character = { type: 'character' };
  const r = resolveModelSettings({ type: 'image', project, asset: character });
  assert.equal(r.model, 'higgsfield-ai/soul-id');
  assert.equal(r.source, 'assetType');

  // An asset's own explicit model still wins.
  const explicit = resolveModelSettings({ type: 'image', project, asset: { type: 'character', imageModel: 'fal-ai/flux/dev' } });
  assert.equal(explicit.model, 'fal-ai/flux/dev');
  assert.equal(explicit.source, 'asset');

  // A type with no default falls through to the project.
  const env = resolveModelSettings({ type: 'image', project, asset: { type: 'environment' } });
  assert.equal(env.model, 'fal-ai/flux/schnell');
  assert.equal(env.source, 'project');
});

test('image resolution never reads a duration', () => {
  const r = resolveModelSettings({ type: 'image', project, shot: { videoDuration: '8' } });
  assert.equal(r.duration, null);
  assert.equal(r.sources.duration, null);
});
