// node --test frontend/src/prompts.test.js
//
// The prompt slots are project settings with shipped defaults. What these pin
// down is the one place "the user cleared it" must not mean "send nothing": a
// template. An emptied asset template used to be honoured, so every prop and
// environment without a hand-written prompt was generated from an empty string
// — description, tags and all silently unused — while the editor's placeholder
// showed the shipped template as if it were in effect.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assetTemplateText,
  compactPromptSettings,
  isPromptOverridden,
  promptDefault,
  promptText
} from './prompts.js';
import { defaultAssetPrompt } from './promptTags.js';

test('an emptied asset template falls back to the shipped default', () => {
  const settings = { 'assetTemplate.prop': '', 'assetTemplate.environment': '   ' };
  assert.equal(promptText(settings, 'assetTemplate.prop'), promptDefault('assetTemplate.prop'));
  assert.equal(assetTemplateText(settings, 'environment'), promptDefault('assetTemplate.environment'));
  // Nothing to show an "edited" badge or a Reset button for.
  assert.equal(isPromptOverridden(settings, 'assetTemplate.prop'), false);
});

test('a prop described with a tag generates from that description again', () => {
  const settings = { 'assetTemplate.prop': '' };
  const prompt = defaultAssetPrompt({
    tag: 'CRANK', type: 'prop', name: 'The Crank', description: 'a rusted crank, in the style of <LOOK>'
  }, settings);
  assert.match(prompt, /product photograph of The Crank, a rusted crank, in the style of <LOOK>/);
});

test('a real template override is still honoured, and so is a blank prose slot', () => {
  const settings = {
    'assetTemplate.prop': 'catalogue shot of {name}: {description}',
    imageUserTemplate: 'Shot: {description}',
    prePrompt: ''
  };
  assert.equal(promptText(settings, 'assetTemplate.prop'), 'catalogue shot of {name}: {description}');
  assert.equal(isPromptOverridden(settings, 'assetTemplate.prop'), true);
  assert.equal(promptText(settings, 'imageUserTemplate'), 'Shot: {description}');
  // Clearing the pre-prompt means no pre-prompt, not the default one.
  assert.equal(promptText(settings, 'prePrompt'), '');
});

test('compacting drops emptied templates along with untouched defaults', () => {
  const compact = compactPromptSettings({
    'assetTemplate.prop': '',
    imageSystemPrompt: promptDefault('imageSystemPrompt'),
    'assetTemplate.style': 'mood board: {description}'
  });
  assert.deepEqual(compact, { 'assetTemplate.style': 'mood board: {description}' });
});
