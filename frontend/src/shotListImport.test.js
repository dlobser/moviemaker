// node --test frontend/src/shotListImport.test.js
//
// The paste box exists so a model's reply can go straight from the chat window
// into the studio, which means the thing worth pinning down is exactly how much
// surrounding mess it tolerates — a fence, a preamble, a sign-off — and that it
// still refuses text with no document in it rather than importing something
// half-read.

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractJsonDocument, normalizeImportedShotList } from './shotListImport.js';

const DOC = '{"scenes":[{"name":"Act 1","shots":[{"name":"1.1"}]}]}';

test('a bare JSON document parses', () => {
  assert.deepEqual(extractJsonDocument(DOC).scenes[0].name, 'Act 1');
});

test('a ```json fence is stripped', () => {
  assert.equal(extractJsonDocument('```json\n' + DOC + '\n```').scenes.length, 1);
});

test('a bare ``` fence is stripped', () => {
  assert.equal(extractJsonDocument('```\n' + DOC + '\n```').scenes.length, 1);
});

test('a chat preamble and sign-off are ignored', () => {
  const pasted = `Sure! Here's the shot list you asked for:\n\n${DOC}\n\nLet me know if you'd like changes.`;
  assert.equal(extractJsonDocument(pasted).scenes[0].shots.length, 1);
});

test('leading and trailing whitespace is fine', () => {
  assert.equal(extractJsonDocument(`\n\n   ${DOC}   \n`).scenes.length, 1);
});

test('an empty paste says so rather than throwing a parse error', () => {
  assert.throws(() => extractJsonDocument('   '), /paste a shot list first/);
});

test('prose with no document is refused', () => {
  assert.throws(() => extractJsonDocument('I could not produce that.'), /No JSON object found/);
});

test('malformed JSON still surfaces the parser message', () => {
  assert.throws(() => extractJsonDocument('{"scenes": [,]}'), SyntaxError);
});

test('exported ids map to the minted ones so assignments can follow', () => {
  const result = normalizeImportedShotList({
    scenes: [{ id: 'scene_old', name: 'Act 1', shots: [{ id: 'shot_old', name: '1.1' }] }]
  });
  assert.equal(result.idMap['scene_old'], result.scenes[0].id);
  assert.equal(result.idMap['shot_old'], result.scenes[0].shots[0].id);
});

test('legacy per-shot referenceImages surface as edges-to-be, not as the dead field', () => {
  const result = normalizeImportedShotList({
    scenes: [{ name: 'Act 1', shots: [{ name: '1.1', referenceImages: ['ref_a', 'ref_b'] }] }]
  });
  assert.equal(result.scenes[0].shots[0].referenceImages, undefined);
  assert.deepEqual(result.legacyShotRefs, [
    { shotId: result.scenes[0].shots[0].id, refIds: ['ref_a', 'ref_b'] }
  ]);
});

test('the extractor feeds the normaliser unchanged', () => {
  const pasted = '```json\n' + JSON.stringify({
    project: { prePrompt: 'cinematic film still,' },
    assets: [{ tag: 'Market', type: 'environment', name: 'Valu-Rite', description: 'damp' }],
    scenes: [{ name: 'Act 1 - The Doors', shots: [{ name: '1.1', imagePrompt: 'inside <Market>' }] }]
  }) + '\n```';

  const result = normalizeImportedShotList(extractJsonDocument(pasted));
  assert.equal(result.project.prePrompt, 'cinematic film still,');
  assert.equal(result.assets[0].tag, 'Market');
  assert.equal(result.scenes[0].shots[0].draftImagePrompt, 'inside <Market>');
  assert.deepEqual(result.warnings, []);
});
