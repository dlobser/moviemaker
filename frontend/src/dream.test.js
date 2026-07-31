import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DREAM_SYSTEM_PROMPT,
  buildDreamUserMessage,
  compactDreamSettings,
  createDreamSettings,
  describeAssetLibrary,
  parseDreamReply
} from './dream.js';

test('createDreamSettings leaves models unset so the project decides', () => {
  const settings = createDreamSettings();
  assert.equal(settings.videoModel, null);
  assert.equal(settings.imageModel, null);
  assert.equal(settings.systemPrompt, DEFAULT_DREAM_SYSTEM_PROMPT);
});

test('createDreamSettings keeps a saved dream intact', () => {
  const settings = createDreamSettings({ instructions: 'stay underwater', iterations: 12 });
  assert.equal(settings.instructions, 'stay underwater');
  assert.equal(settings.iterations, 12);
  assert.equal(settings.historyDepth, 3);
});

test('compactDreamSettings writes only what differs from the defaults', () => {
  const saved = compactDreamSettings(createDreamSettings({ instructions: 'drift', videoModel: 'fal-ai/veo2' }));
  assert.deepEqual(saved, { instructions: 'drift', videoModel: 'fal-ai/veo2' });
});

test('compactDreamSettings drops an edited-then-reset system prompt', () => {
  const saved = compactDreamSettings(createDreamSettings({ systemPrompt: DEFAULT_DREAM_SYSTEM_PROMPT }));
  assert.equal(saved.systemPrompt, undefined);
});

test('describeAssetLibrary lists tags, types and descriptions', () => {
  const text = describeAssetLibrary([
    { tag: 'Ralph', type: 'character', name: 'Ralph the Mechanic', description: 'grizzled, oil-stained' },
    { tag: 'Yard', type: 'environment', name: 'The Scrapyard' }
  ]);
  assert.equal(text, '- <Ralph> character: Ralph the Mechanic — grizzled, oil-stained\n- <Yard> environment: The Scrapyard');
});

test('describeAssetLibrary skips entries with neither tag nor name', () => {
  assert.equal(describeAssetLibrary([{ description: 'orphan' }, null]), '');
  assert.equal(describeAssetLibrary(), '');
});

test('buildDreamUserMessage carries the instructions, the cast and the recent clips', () => {
  const message = buildDreamUserMessage({
    instructions: 'never leave the water',
    assetLibrary: [{ tag: 'Ralph', type: 'character', name: 'Ralph' }],
    history: ['a', 'b', 'c', 'd'],
    historyDepth: 2,
    clipNumber: 5,
    totalClips: 8
  });

  assert.match(message, /clip 5 of 8/);
  assert.match(message, /final frame of clip 4/);
  assert.match(message, /never leave the water/);
  assert.match(message, /<Ralph>/);
  // Only the tail, numbered so it lines up with the clip it describes.
  assert.match(message, /3\. c/);
  assert.match(message, /4\. d/);
  assert.doesNotMatch(message, /1\. a/);
});

test('buildDreamUserMessage omits the frame line for the opening clip', () => {
  const message = buildDreamUserMessage({ clipNumber: 1, totalClips: 4, hasFrame: false });
  assert.doesNotMatch(message, /final frame/);
  assert.match(message, /none given/);
});

test('the opening clip is told the frame is a beginning, not a continuation', () => {
  // Filling in a start shot that has a still but nothing written: the model is
  // shown the shot's own image, and must not be told to continue from "clip 0".
  const message = buildDreamUserMessage({ clipNumber: 1, totalClips: 6, opening: true });
  assert.match(message, /where the dream begins/);
  assert.match(message, /nothing has happened yet/);
  assert.doesNotMatch(message, /final frame of clip 0/);
});

test('createDreamSettings defaults to inventing rather than chaining', () => {
  assert.equal(createDreamSettings().mode, 'invent');
  assert.equal(createDreamSettings({ mode: 'chain' }).mode, 'chain');
});

test('compactDreamSettings stores a chain run but not the default mode', () => {
  assert.equal(compactDreamSettings(createDreamSettings()).mode, undefined);
  assert.equal(compactDreamSettings(createDreamSettings({ mode: 'chain' })).mode, 'chain');
});

test('parseDreamReply reads the JSON object', () => {
  const reply = parseDreamReply('{"description":"the wall opens","videoPrompt":"slow dolly through a widening crack"}');
  assert.deepEqual(reply, { description: 'the wall opens', videoPrompt: 'slow dolly through a widening crack' });
});

test('parseDreamReply survives a markdown fence and surrounding chatter', () => {
  const reply = parseDreamReply('Sure!\n```json\n{"description":"d","videoPrompt":"v"}\n```\n');
  assert.deepEqual(reply, { description: 'd', videoPrompt: 'v' });
});

test('parseDreamReply takes a plain-text reply as the prompt', () => {
  const reply = parseDreamReply('the camera sinks past a whale');
  assert.deepEqual(reply, { description: '', videoPrompt: 'the camera sinks past a whale' });
});

test('parseDreamReply falls back when the JSON has no usable prompt', () => {
  const reply = parseDreamReply('{"description":"only a description"}');
  assert.equal(reply.videoPrompt, '{"description":"only a description"}');
});

test('parseDreamReply rejects an empty reply', () => {
  assert.throws(() => parseDreamReply('   '), /returned nothing/);
});
