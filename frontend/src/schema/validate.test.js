import test from 'node:test';
import assert from 'node:assert/strict';

import { describeProblems, validateProject } from './validate.js';
import { migrateProjectV2 } from './migrateV2.js';
import { seededRandom } from './ids.js';
import { FIXED_NOW, PATHS, studioProject } from './fixtures/v1-studio.js';
import { mediaByPath } from '../project/selectors.js';

/** A fresh, sound v2 document to break one invariant at a time. */
function doc() {
  return migrateProjectV2(studioProject(), { now: () => FIXED_NOW, random: seededRandom(7) }).state;
}

const codes = (state) => validateProject(state).map(p => p.code);
const shot = (state, id) => state.scenes.flatMap(s => s.shots).find(s => s.id === id);
const asset = (state, id) => state.assetLibrary.find(a => a.id === id);

test('a migrated project has no problems', () => {
  assert.deepEqual(validateProject(doc()), []);
  assert.equal(describeProblems([]), 'no problems');
});

test('anything that is not a v2 document is reported, never thrown on', () => {
  assert.deepEqual(codes(null), ['not-a-document']);
  const empty = codes({});
  assert.ok(empty.includes('schema-version'));
  assert.ok(empty.includes('missing-collection'));
  assert.equal(describeProblems(validateProject({})).includes('missing-collection×'), true);
});

test('1. every media id must exist', () => {
  const state = doc();
  asset(state, 'asset_ralph').looks[0].images[0].mediaId = 'med_nope';
  shot(state, 'sh_1').lipSyncAudio = 'med_gone';
  state.bindings[0].mediaId = 'med_missing';
  state.edit.durations.med_unknown = { duration: 1 };
  const found = validateProject(state).filter(p => p.code === 'missing-media');
  assert.equal(found.length, 4);
  assert.ok(found.some(p => p.at.startsWith('assetLibrary.asset_ralph.looks')));
  assert.ok(found.some(p => p.at === 'shots.sh_1.lipSyncAudio'));
  assert.ok(found.some(p => p.at === 'edit.durations.med_unknown'));
});

test('2. every take id must exist', () => {
  const state = doc();
  shot(state, 'sh_1').selection.image = 'take_nope';
  shot(state, 'sh_1').selectionLog.push({ kind: 'image', takeId: 'take_gone', at: state.migratedFrom.at });
  state.edit.video[0].source = { kind: 'take', takeId: 'take_missing' };
  state.edit.video[1].boundTo = { takeId: 'take_lost' };
  state.jobs.job_2.resultTakeId = 'take_vanished';
  state.takes.out_vid_2002.parentTakeId = 'take_parentless';
  assert.equal(codes(state).filter(c => c === 'missing-take').length, 6);
});

test('3. a path appears once, ignoring separators and case; a duplicate hash is reported', () => {
  const state = doc();
  const twin = { ...structuredClone(mediaByPath(state, PATHS.alley)), id: 'med_twin', path: 'ASSETS\\Alley_1.PNG' };
  state.media.med_twin = twin;
  assert.ok(codes(state).includes('duplicate-path'));

  const hashed = doc();
  Object.values(hashed.media).slice(0, 2).forEach(m => { m.hash = 'sha256:same'; });
  assert.ok(codes(hashed).includes('duplicate-hash'));
});

test('4. a take and its media agree on kind, and a generated media points back at its take', () => {
  const state = doc();
  state.takes.out_img_1001.mediaId = mediaByPath(state, PATHS.shot1Voice).id;
  assert.ok(codes(state).includes('kind-mismatch'));

  const crossed = doc();
  mediaByPath(crossed, PATHS.shot1Image1).origin.takeId = 'out_img_1002';
  assert.ok(codes(crossed).includes('origin-mismatch'));
});

test('5. a selection names a take of the right kind owned by that shot', () => {
  const state = doc();
  shot(state, 'sh_1').selection.image = 'out_vid_2001';
  assert.ok(codes(state).includes('selection-kind'));

  const foreign = doc();
  shot(foreign, 'sh_2').selection.image = 'out_img_1002';
  assert.ok(codes(foreign).includes('selection-owner'));
});

test('6. one primary per look, a default look of its own asset, and shot look bindings that match', () => {
  const state = doc();
  const ralph = asset(state, 'asset_ralph');
  ralph.looks[0].images.forEach(image => { image.primary = true; });
  assert.ok(codes(state).includes('many-primaries'));

  const wrongDefault = doc();
  asset(wrongDefault, 'asset_ralph').defaultLookId = asset(wrongDefault, 'asset_alley').defaultLookId;
  assert.ok(codes(wrongDefault).includes('missing-look'));

  const wrongBinding = doc();
  shot(wrongBinding, 'sh_1').assetLooks = { asset_ralph: asset(wrongBinding, 'asset_alley').defaultLookId };
  assert.ok(codes(wrongBinding).includes('missing-look'));

  const unknownAsset = doc();
  shot(unknownAsset, 'sh_1').assetLooks = { asset_nope: 'look_x' };
  assert.ok(codes(unknownAsset).includes('missing-asset'));
});

test('7. binding targets exist for their scope', () => {
  const state = doc();
  state.bindings.find(b => b.scope === 'shot').targetId = 'sh_gone';
  state.bindings.find(b => b.scope === 'asset-look').targetId = 'look_nope';
  state.bindings.find(b => b.scope === 'scene').targetId = 'sc_nope';
  assert.equal(codes(state).filter(c => c === 'missing-target').length, 3);

  const badScope = doc();
  badScope.bindings[0].scope = 'asset';
  assert.ok(codes(badScope).includes('bad-binding'));
});

test('8. the edit is version 2 and every clip source resolves', () => {
  const state = doc();
  state.edit.version = 1;
  state.edit.video[1].source = { kind: 'media', mediaId: 'med_nope', stream: 'video' };
  state.edit.audio[0].clips[0].source = { kind: 'asset', path: 'assets/x.mp3' };
  state.edit.bin[0].mediaId = 'med_nope';
  const found = codes(state);
  assert.ok(found.includes('edit-version'));
  assert.ok(found.includes('bad-clip-source'));
  assert.equal(found.filter(c => c === 'missing-media').length, 2);

  const follows = doc();
  follows.edit.video[0].source = { kind: 'shot', shotId: 'sh_gone' };
  assert.ok(codes(follows).includes('missing-shot'));
});

test('9. no two records in one collection share an id', () => {
  const state = doc();
  state.scenes.push({ ...state.scenes[1], shots: [] });
  state.bindings.push({ ...state.bindings[0] });
  state.edit.video.push({ ...state.edit.video[0] });
  assert.equal(codes(state).filter(c => c === 'duplicate-id').length, 3);

  const mismatched = doc();
  mismatched.media.med_alias = mismatched.media[Object.keys(mismatched.media)[0]];
  assert.ok(codes(mismatched).includes('id-mismatch'));
});

test('a cost of zero is a lie; unknown is null', () => {
  const state = doc();
  state.jobs.job_2.cost.reported = 0;
  assert.ok(codes(state).includes('zero-cost'));
});

test('malformed records are reported rather than crashing the validator', () => {
  const state = doc();
  state.takes.out_img_1001.assetRevisionsConfidence = 'maybe';
  state.takes.out_img_1002.recipe = 'not a recipe';
  state.media[Object.keys(state.media)[0]].origin = null;
  state.jobs.job_1.kind = 'teleport';
  const found = codes(state);
  assert.ok(found.includes('bad-take'));
  assert.ok(found.includes('bad-origin'));
  assert.ok(found.includes('bad-job'));
});
