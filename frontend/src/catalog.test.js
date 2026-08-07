// node --test frontend/src/catalog.test.js
//
// Custom model paths carry their host inline because the prefix guess stopped
// being decidable — `bytedance/…` is a real namespace on Fal *and* on
// Higgsfield. What matters here is that the new syntax never swallows an id
// that was already valid: everything saved before this existed must parse back
// out unchanged, or projects silently start generating on the wrong service.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_VIDEO_DURATIONS,
  durationOptions,
  formatModelId,
  isKnownImageModel,
  modelCapabilities,
  modelPath,
  normalizeFamily,
  parseModelId,
  refImageCapacity,
  sizeOptions
} from './catalog.js';

test('a plain path declares no host', () => {
  assert.deepEqual(parseModelId('fal-ai/flux/schnell'), { family: null, path: 'fal-ai/flux/schnell' });
  assert.deepEqual(parseModelId('bytedance/seedance-2.0/image-to-video'), {
    family: null, path: 'bytedance/seedance-2.0/image-to-video'
  });
});

test('an explicit host is split off', () => {
  assert.deepEqual(parseModelId('fal:bytedance/seedance-2.0/image-to-video'), {
    family: 'fal-ai', path: 'bytedance/seedance-2.0/image-to-video'
  });
  assert.deepEqual(parseModelId('higgsfield:bytedance/seedance/v1/pro/image-to-video'), {
    family: 'higgsfield', path: 'bytedance/seedance/v1/pro/image-to-video'
  });
});

test('host aliases all normalise', () => {
  ['fal', 'fal-ai', 'FALAI', 'Fal'].forEach(alias => {
    assert.equal(parseModelId(`${alias}:x/y`).family, 'fal-ai', alias);
  });
  ['higgsfield', 'HF', 'higgsfield-ai'].forEach(alias => {
    assert.equal(parseModelId(`${alias}:x/y`).family, 'higgsfield', alias);
  });
  assert.equal(normalizeFamily('nonsense'), null);
});

test('a colon after a slash is part of the path, not a host', () => {
  // Contrived, but the rule has to be positional or a path containing a colon
  // would be silently truncated.
  assert.deepEqual(parseModelId('vendor/model:v2'), { family: null, path: 'vendor/model:v2' });
});

test('an unknown host prefix is left in the path', () => {
  assert.deepEqual(parseModelId('replicate:owner/model'), { family: null, path: 'replicate:owner/model' });
});

test('formatModelId round-trips', () => {
  const id = formatModelId('fal-ai', 'bytedance/seedance-2.0/image-to-video');
  assert.equal(id, 'fal-ai:bytedance/seedance-2.0/image-to-video');
  assert.deepEqual(parseModelId(id), { family: 'fal-ai', path: 'bytedance/seedance-2.0/image-to-video' });
});

test('clearing the host gives the bare path back', () => {
  assert.equal(formatModelId(null, 'bytedance/seedance-2.0/image-to-video'), 'bytedance/seedance-2.0/image-to-video');
  assert.equal(formatModelId('fal-ai', ''), '');
});

test('modelPath strips the host for the provider call', () => {
  assert.equal(modelPath('fal:bytedance/seedance-2.0/image-to-video'), 'bytedance/seedance-2.0/image-to-video');
  assert.equal(modelPath('fal-ai/flux/schnell'), 'fal-ai/flux/schnell');
  assert.equal(modelPath(''), '');
  assert.equal(modelPath(undefined), '');
});

test('a host-tagged id is never mistaken for a catalog model', () => {
  // Otherwise the settings dropdown would show a catalog entry while the id
  // stored underneath carried a prefix the dropdown cannot represent.
  assert.equal(isKnownImageModel('fal-ai/flux/schnell'), true);
  assert.equal(isKnownImageModel('fal:fal-ai/flux/schnell'), false);
});

// --- capabilities ----------------------------------------------------------
//
// The studio used to offer every video model the same 5/10 seconds. That was
// wrong in both directions — Veo cannot make a 10 second clip and the request
// builder silently coerced it, while Seedance can make a 15 second one nobody
// could ask for. These pin the descriptor to what each host documents.

test('a model with recorded lengths offers exactly those', () => {
  assert.deepEqual(durationOptions('fal-ai/veo3.1', '5').map(o => o.value), ['5', '8']);
  assert.deepEqual(
    durationOptions('atlas:bytedance/seedance-2.0/image-to-video', '5').map(o => o.value),
    ['4', '5', '6', '8', '10', '12', '15']
  );
});

// Audio references default to none rather than to one, because a model that
// silently ignores an attached clip is indistinguishable from one that used it
// badly — and the shot would be billed either way.
test('only the models that document reference audio report any', () => {
  assert.equal(modelCapabilities('video', 'atlas:bytedance/seedance-2.0/reference-to-video').maxRefAudio, 3);
  assert.equal(modelCapabilities('video', 'atlas:bytedance/seedance-2.0-fast/reference-to-video').maxRefAudio, 3);
  assert.equal(modelCapabilities('video', 'fal-ai/kling-video').maxRefAudio, 0);
  assert.equal(modelCapabilities('video', 'atlas:bytedance/seedance-2.0/text-to-video').maxRefAudio, 0);
  assert.equal(modelCapabilities('video', 'atlas:something/brand/new').maxRefAudio, 0);
});

// Atlas refuses a first-frame image combined with reference media of any kind
// (error 1013032), and image-to-video exists to animate a first frame — so
// audio can never ride with it, however much the model family supports.
test('the image-to-video endpoints take no audio, first frame or nothing', () => {
  assert.equal(modelCapabilities('video', 'atlas:bytedance/seedance-2.0/image-to-video').maxRefAudio, 0);
  assert.equal(modelCapabilities('video', 'atlas:bytedance/seedance-2.0-fast/image-to-video').maxRefAudio, 0);
});

test('a model with nothing recorded keeps the studio defaults', () => {
  assert.deepEqual(durationOptions('fal-ai/kling-video', '5').map(o => o.value), DEFAULT_VIDEO_DURATIONS);
  assert.deepEqual(durationOptions('atlas:something/brand/new', '5').map(o => o.value), DEFAULT_VIDEO_DURATIONS);
});

test('a saved length the model does not offer stays selectable and is flagged', () => {
  // A shot saved at 10s and later pointed at Veo must not silently submit
  // whatever happens to be first in the list.
  const options = durationOptions('fal-ai/veo3.1', '10');
  assert.deepEqual(options.map(o => o.value), ['5', '8', '10']);
  assert.match(options[2].label, /as saved/);
});

test('a saved length the model does offer is not duplicated', () => {
  assert.deepEqual(durationOptions('fal-ai/veo3.1', '8').map(o => o.value), ['5', '8']);
});

test('per-model size lists override the studio-wide ones', () => {
  const flux = sizeOptions('image', 'atlas:black-forest-labs/flux-dev', '16:9').map(o => o.value);
  assert.ok(flux.includes('3:4'), 'FLUX offers 3:4, which the studio list never did');
  assert.ok(!flux.includes('21:9'), 'and does not offer 21:9, which it did');
  // Anything without its own list still gets the studio-wide set.
  assert.ok(sizeOptions('image', 'fal-ai/flux/schnell', '16:9').some(o => o.value === '21:9'));
});

test('video sizes fall back to the resolution list, not the aspect list', () => {
  assert.deepEqual(
    sizeOptions('video', 'fal-ai/kling-video', '1280x720').map(o => o.value),
    ['1280x720', '720x1280']
  );
});

test('capacity still reads through the descriptor', () => {
  assert.equal(refImageCapacity('video', 'atlas:bytedance/seedance-2.0/reference-to-video'), 9);
  assert.equal(refImageCapacity('image', 'fal-ai/flux/schnell'), 0);
  assert.equal(refImageCapacity('video', 'some/unknown/path'), 1);
});

test('an unknown model is marked as such rather than faking knowledge', () => {
  assert.equal(modelCapabilities('video', 'fal-ai/kling-video').known, true);
  assert.equal(modelCapabilities('video', 'atlas:brand/new/thing').known, false);
});

test('image models carry no duration axis at all', () => {
  assert.equal(modelCapabilities('image', 'fal-ai/flux/schnell').durations, null);
});

// --- Phase 1: capability profiles ------------------------------------------

test('refMode defaults from refImages when unset', () => {
  assert.equal(modelCapabilities('image', 'fal-ai/flux/schnell').refMode, 'none');
  assert.equal(modelCapabilities('image', 'higgsfield-ai/soul/character').refMode, 'optional');
  assert.equal(modelCapabilities('image', 'fal-ai/flux/dev/redux').refMode, 'required');
  assert.equal(modelCapabilities('video', 'higgsfield-ai/dop/turbo').refMode, 'required');
  // Unknown paths assume one optional input, as before.
  assert.equal(modelCapabilities('image', 'some/unknown/path').refMode, 'optional');
});

test('promptLimit is only reported where documented', () => {
  assert.equal(modelCapabilities('image', 'chatgpt').promptLimit, 4000);
  assert.equal(modelCapabilities('image', 'fal-ai/flux/schnell').promptLimit, null);
});

test('refKinds is null (all kinds) unless a model narrows it', () => {
  assert.equal(modelCapabilities('image', 'fal-ai/flux/dev').refKinds, null);
  assert.deepEqual(modelCapabilities('image', 'soul-id').refKinds, ['character']);
});

test('custom-path overrides lift the one-input assumption, catalog models ignore them', async () => {
  const { setCustomModelOverrides } = await import('./catalog.js');
  try {
    setCustomModelOverrides({ 'higgsfield:vendor/multi-ref': { refImages: 8 } });
    assert.equal(refImageCapacity('image', 'higgsfield:vendor/multi-ref'), 8);
    assert.equal(refImageCapacity('image', 'vendor/other-path'), 1);
    // A known catalog id never reads the override table.
    setCustomModelOverrides({ 'soul-id': { refImages: 99 } });
    assert.equal(refImageCapacity('image', 'soul-id'), 4);
  } finally {
    setCustomModelOverrides({});
  }
});
