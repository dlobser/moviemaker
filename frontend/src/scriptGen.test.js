// node --test frontend/src/scriptGen.test.js
//
// The retry path is the part that will silently rot if untested: a model
// replying with broken JSON must get exactly one correction round, shown its
// own reply, and a clean parse on either round must come back normalized.

import test from 'node:test';
import assert from 'node:assert/strict';

import { generateShotListFromIdea } from './scriptGen.js';

const GOOD_DOC = JSON.stringify({
  project: { name: 'Test' },
  assets: [{ tag: 'Hero', type: 'character', name: 'Hero', description: 'a hero' }],
  scenes: [{ name: 'Act 1', shots: [{ name: '1.1', imagePrompt: '<Hero> stands' }] }]
});

/** apiFetch fake returning queued LLM replies, recording every prompt sent. */
const fakeFetch = (replies) => {
  const calls = [];
  const fn = async (route, options) => {
    calls.push(JSON.parse(options.body));
    const text = replies.shift();
    return { ok: true, json: async () => ({ text }) };
  };
  fn.calls = calls;
  return fn;
};

test('a clean reply parses and normalizes in one round', async () => {
  const apiFetch = fakeFetch([GOOD_DOC]);
  const result = await generateShotListFromIdea({
    idea: 'a hero stands around', llm: { provider: 'claude', model: 'x' }, apiFetch
  });
  assert.equal(apiFetch.calls.length, 1);
  assert.equal(result.scenes.length, 1);
  assert.equal(result.assets[0].tag, 'Hero');
  // The request carried the JSON-only system prompt.
  assert.match(apiFetch.calls[0].systemPrompt, /single valid JSON document/);
});

test('a fenced, chatty reply is tolerated without a retry', async () => {
  const apiFetch = fakeFetch(['Sure! Here you go:\n```json\n' + GOOD_DOC + '\n```\nLet me know!']);
  const result = await generateShotListFromIdea({ idea: 'x', llm: {}, apiFetch });
  assert.equal(apiFetch.calls.length, 1);
  assert.equal(result.scenes[0].shots.length, 1);
});

test('corrupted JSON gets exactly one retry, shown its own reply', async () => {
  const broken = '{"scenes": [,]}';
  const apiFetch = fakeFetch([broken, GOOD_DOC]);
  const result = await generateShotListFromIdea({ idea: 'x', llm: {}, apiFetch });
  assert.equal(apiFetch.calls.length, 2);
  assert.match(apiFetch.calls[1].prompt, /could not be parsed/);
  assert.ok(apiFetch.calls[1].prompt.includes(broken), 'the retry shows the model its own reply');
  assert.equal(result.scenes.length, 1);
});

test('a second failure throws with both parser messages, no third round', async () => {
  const apiFetch = fakeFetch(['not json at all', 'still not json']);
  await assert.rejects(
    generateShotListFromIdea({ idea: 'x', llm: {}, apiFetch }),
    /after a retry/
  );
  assert.equal(apiFetch.calls.length, 2);
});

test('the JSON error escape hatch surfaces as a readable refusal', async () => {
  const apiFetch = fakeFetch([JSON.stringify({ error: 'the source material is empty' })]);
  await assert.rejects(generateShotListFromIdea({ idea: 'x', llm: {}, apiFetch }), /The model declined/);
});

test('an empty idea is refused before any request is made', async () => {
  const apiFetch = fakeFetch([]);
  await assert.rejects(generateShotListFromIdea({ idea: '   ', llm: {}, apiFetch }), /Write the idea first/);
  assert.equal(apiFetch.calls.length, 0);
});
