import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { groupSignature, imagePromptSignature, videoPromptSignature } from './groupKey.js';

/** The body of `const <name> = (group) => JSON.stringify([ … ]);` in a source file, whitespace-normalized. */
function signatureSource(source, name) {
  const pattern = new RegExp(`const ${name} = \\(group\\) => JSON\\.stringify\\(\\[[\\s\\S]*?\\]\\);`);
  const match = pattern.exec(source);
  assert.ok(match, `${name} not found`);
  return match[0].replace(/\r\n/g, '\n').replace(/^[ \t]+/gm, '');
}

test('the signature functions are the ones App.jsx uses, byte for byte', () => {
  const app = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
  const lifted = readFileSync(new URL('./groupKey.js', import.meta.url), 'utf8');
  for (const name of ['imagePromptSignature', 'videoPromptSignature']) {
    assert.equal(signatureSource(lifted, name).replace(/^export /, ''), signatureSource(app, name));
  }
});

test('the key is the raw recipe, with defaults for flags saved before they existed', () => {
  const group = { rawPrompt: 'a robot', model: 'fal-ai/flux/dev', resolution: '16:9', primaryImagePaths: ['assets/a.png'] };
  assert.equal(
    imagePromptSignature(group),
    JSON.stringify(['a robot', 'fal-ai/flux/dev', '16:9', ['assets/a.png'], true, [], true, true, null])
  );
  assert.equal(imagePromptSignature({ ...group, attachTaggedImages: false }) === imagePromptSignature(group), false);
});

test('a group without rawPrompt keys on its composed prompt', () => {
  assert.equal(
    imagePromptSignature({ prompt: 'composed', model: 'm' }),
    imagePromptSignature({ rawPrompt: 'composed', model: 'm' })
  );
});

test('video keys include the duration; image keys do not', () => {
  const group = { rawPrompt: 'walk', model: 'kling', resolution: '1280x720', duration: '5' };
  assert.equal(videoPromptSignature(group), JSON.stringify(['walk', 'kling', '1280x720', '5', [], true, [], true, true, null]));
  assert.equal(imagePromptSignature(group), imagePromptSignature({ ...group, duration: '10' }));
  assert.notEqual(videoPromptSignature(group), videoPromptSignature({ ...group, duration: '10' }));
});

test('groupSignature picks the function by kind', () => {
  const group = { rawPrompt: 'x', duration: '5' };
  assert.equal(groupSignature('image', group), imagePromptSignature(group));
  assert.equal(groupSignature('video', group), videoPromptSignature(group));
});
