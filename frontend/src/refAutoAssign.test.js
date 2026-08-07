// node --test frontend/src/refAutoAssign.test.js
//
// Filename matching is all edge cases. The failure that matters is not "it
// missed one" — you can link that by hand — it is a confident wrong link,
// because nothing downstream ever questions an assetId and the bad reference
// rides along with every future generation of that character.

import test from 'node:test';
import assert from 'node:assert/strict';

import { autoAssignReferences, nameTokens, similarity, scoreAssetAgainstName } from './refAutoAssign.js';

const assets = [
  { id: 'a1', tag: 'Henry', name: 'Henry the mop man' },
  { id: 'a2', tag: 'Sara', name: 'Sara' },
  { id: 'a3', tag: 'Garage', name: 'The garage' }
];

const refs = (...names) => names.map((name, index) => ({ id: `r${index}`, name, path: `assets/${name}` }));

// --- tokenising -------------------------------------------------------------

test('take numbers, extensions and separators fall away', () => {
  assert.deepEqual(nameTokens('henry_closeup_02.png'), ['henry', 'closeup']);
  assert.deepEqual(nameTokens('Sara-wardrobe-final.jpg'), ['sara', 'wardrobe']);
  assert.deepEqual(nameTokens('garage wide 3.webp'), ['garage', 'wide']);
});

test('camelCase is split, so HenryCloseup reads like henry_closeup', () => {
  assert.deepEqual(nameTokens('HenryCloseup.png'), ['henry', 'closeup']);
});

// Without this, henry_ref.png and sara_ref.png both "match" on `ref`.
test('filename debris carries no meaning', () => {
  assert.deepEqual(nameTokens('IMG_2831.jpg'), []);
  assert.deepEqual(nameTokens('Screenshot 2024-01-02.png'), []);
  assert.deepEqual(nameTokens('untitled copy final v2.png'), []);
});

// --- matching ---------------------------------------------------------------

test('an exact name in the filename links', () => {
  const [proposal] = autoAssignReferences({ references: refs('henry_closeup_02.png'), assetLibrary: assets });
  assert.equal(proposal.assetId, 'a1');
  assert.equal(proposal.score, 1);
  assert.equal(proposal.ambiguous, false);
});

test('slop: a typo or an ending still lands', () => {
  const found = autoAssignReferences({ references: refs('henrry-wide.png', 'saras_hands.jpg'), assetLibrary: assets });
  assert.deepEqual(found.map(p => p.assetTag), ['Henry', 'Sara']);
});

test('a filename about nothing in the library proposes nothing', () => {
  assert.deepEqual(autoAssignReferences({ references: refs('rusty_pipe_texture.png'), assetLibrary: assets }), []);
});

test('a filename with no usable words is skipped rather than guessed at', () => {
  assert.deepEqual(autoAssignReferences({ references: refs('IMG_9921.jpg'), assetLibrary: assets }), []);
});

// A multi-word asset met on only one of its words is the classic false
// positive: `old lady` should not claim `lady_in_red`.
test('every word of a multi-word name has to be met', () => {
  const library = [{ id: 'a9', tag: 'OldLady', name: 'old lady' }];
  assert.deepEqual(autoAssignReferences({ references: refs('lady_in_red.png'), assetLibrary: library }), []);
  const [hit] = autoAssignReferences({ references: refs('old_lady_smiling.png'), assetLibrary: library });
  assert.equal(hit.assetTag, 'OldLady');
});

test('near-ties are flagged rather than silently resolved', () => {
  const library = [{ id: 'a1', tag: 'Sara', name: 'Sara' }, { id: 'a2', tag: 'Sarah', name: 'Sarah' }];
  const [proposal] = autoAssignReferences({ references: refs('sara_portrait.png'), assetLibrary: library });
  assert.equal(proposal.ambiguous, true);
  assert.ok(proposal.alternative);
});

test('references already linked are left alone unless asked for', () => {
  const linked = [{ id: 'r0', name: 'henry.png', path: 'assets/henry.png', assetId: 'someone-else' }];
  assert.deepEqual(autoAssignReferences({ references: linked, assetLibrary: assets }), []);
  assert.equal(autoAssignReferences({ references: linked, assetLibrary: assets, includeAssigned: true }).length, 1);
});

test('a reference with no name falls back to its path', () => {
  const captured = [{ id: 'r0', name: 'Untitled', path: 'assets/garage_wide_01.png' }];
  const [proposal] = autoAssignReferences({ references: captured, assetLibrary: assets });
  assert.equal(proposal.assetTag, 'Garage');
});

test('the asset name matches even when the tag does not', () => {
  // Tag is `Garage`, name is `The garage` — a file called `the_garage.png`
  // should land either way.
  const [proposal] = autoAssignReferences({ references: refs('the_garage_interior.png'), assetLibrary: assets });
  assert.equal(proposal.assetTag, 'Garage');
});

test('short words do not match everything', () => {
  // A two-letter tag against a long filename is exactly where fuzzy matching
  // goes wrong, so a prefix has to be at least four characters to count.
  assert.equal(scoreAssetAgainstName({ tag: 'Al', name: 'Al' }, nameTokens('alley_wide.png'), 0.7) < 0.9, true);
});

test('similarity is symmetric and bounded', () => {
  assert.equal(similarity('henry', 'henry'), 1);
  assert.equal(similarity('henry', 'sara') < 0.3, true);
  assert.equal(similarity('a', 'b'), 0);
  assert.ok(Math.abs(similarity('garage', 'garag') - similarity('garag', 'garage')) < 1e-9);
});
