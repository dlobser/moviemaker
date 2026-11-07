import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bindingsFor,
  boardMedia,
  findShot,
  groupKeyOf,
  groupsForShot,
  lookEnabledPaths,
  lookFor,
  lookImages,
  lookPrimaryPath,
  mediaByPath,
  mediaPath,
  selectedPath,
  selectedTake,
  takeById,
  takesForShot
} from './selectors.js';
import { migrateProjectV2 } from '../schema/migrateV2.js';
import { seededRandom } from '../schema/ids.js';
import { normalizePath } from '../schema/paths.js';
import { FIXED_NOW, PATHS, studioProject } from '../schema/fixtures/v1-studio.js';
import { assetInputImages, assetPrimaryImage } from '../promptTags.js';

const migrated = (project = studioProject()) => migrateProjectV2(project, { now: () => FIXED_NOW, random: seededRandom(7) }).state;
const v1Shots = (project) => project.scenes.flatMap(scene => scene.shots);

// --- selections ------------------------------------------------------------------

test('selectedPath returns what shot.selectedImage / shot.selectedVideo returned for every shot in the fixture', () => {
  const project = studioProject();
  const state = migrated(project);
  for (const shot of v1Shots(project)) {
    assert.equal(selectedPath(state, shot.id, 'image'), shot.selectedImage, `${shot.id} image`);
    assert.equal(selectedPath(state, shot.id, 'video'), shot.selectedVideo, `${shot.id} video`);
  }
  assert.equal(selectedPath(state, 'sh_nope', 'image'), null);
});

test('selectedTake is the take the selection names', () => {
  const state = migrated();
  assert.equal(selectedTake(state, 'sh_1', 'image').id, 'out_img_1002');
  assert.equal(selectedTake(state, 'sh_1', 'video').purpose, 'lipsync');
  assert.equal(selectedTake(state, 'sh_2', 'video'), null);
  assert.equal(selectedTake(state, 'sh_3', 'image').purpose, 'imported');
});

test('takesForShot lists a shot’s takes oldest first, narrowed by kind', () => {
  const state = migrated();
  assert.deepEqual(takesForShot(state, 'sh_1').map(t => t.id), ['out_img_1001', 'out_img_1002', 'out_img_1003', 'out_vid_2001', 'out_vid_2002']);
  assert.deepEqual(takesForShot(state, 'sh_1', 'video').map(t => t.id), ['out_vid_2001', 'out_vid_2002']);
  assert.deepEqual(takesForShot(state, 'sh_3', 'image').map(t => t.purpose), ['imported']);
  assert.deepEqual(takesForShot(state, 'sh_nope'), []);
});

// --- the prompt-group view -----------------------------------------------------------

test('groupsForShot reproduces the v1 group list and order for a migrated fixture', () => {
  const project = studioProject();
  const state = migrated(project);

  for (const shot of v1Shots(project)) {
    for (const kind of ['image', 'video']) {
      const v1Groups = shot[kind === 'image' ? 'imagePrompts' : 'videoPrompts'].filter(g => (g.outputs || []).length > 0);
      const view = groupsForShot(state, shot.id, kind);

      assert.deepEqual(view.map(g => g.id), v1Groups.map(g => g.id), `${shot.id} ${kind} group order`);
      view.forEach((group, index) => {
        const v1 = v1Groups[index];
        assert.deepEqual(group.outputs.map(o => o.id), v1.outputs.map(o => o.id), `${v1.id} output ids`);
        assert.deepEqual(group.outputs.map(o => o.path), v1.outputs.map(o => o.path), `${v1.id} output paths`);
        assert.deepEqual(group.outputs.map(o => o.name), v1.outputs.map(o => o.name));
        assert.deepEqual(group.outputs.map(o => o.createdAt), v1.outputs.map(o => o.createdAt));
        assert.equal(group.prompt, v1.prompt);
        assert.equal(group.groupKey, groupKeyOf(kind, v1), `${v1.id} key`);
        assert.equal(groupKeyOf(kind, group), groupKeyOf(kind, v1), `${v1.id} rebuilt key`);
        if (!v1.id.startsWith('prompt_sync_')) {
          const sentPaths = Array.isArray(v1.inputImagePaths) ? v1.inputImagePaths : (v1.imageInput ? [v1.imageInput] : []);
          assert.deepEqual(group.inputImagePaths, sentPaths.map(normalizePath), `${v1.id} inputs`);
          assert.equal(group.rawPrompt, v1.rawPrompt ?? v1.prompt);
          assert.equal(group.model, v1.model);
          if (kind === 'video') assert.equal(group.imageInput, v1.imageInput || '');
          if (v1.meta) {
            assert.deepEqual(group.meta.taggedAssetIds, v1.meta.taggedAssetIds);
            assert.deepEqual(group.meta.assetStamps, v1.meta.assetStamps);
          } else {
            assert.equal(group.meta, undefined);
          }
        }
      });
    }
  }
});

test('the group view keeps the lip-sync group’s v1 shape and leaves imported takes out', () => {
  const state = migrated();
  const sync = groupsForShot(state, 'sh_1', 'video').find(g => g.purpose === 'lipsync');
  assert.equal(sync.id, 'prompt_sync_2002');
  assert.equal(sync.prompt, 'Lipsync synced with: voice.wav');
  assert.deepEqual(sync.outputs.map(o => o.takeId), ['out_vid_2002']);
  assert.ok(!('rawPrompt' in sync));
  assert.deepEqual(groupsForShot(state, 'sh_3', 'image'), [], 'a gallery pick never was a group');
});

test('a remapped output id shows as its v1 id in the group view and its take id beside it', () => {
  const state = migrated();
  const [group] = groupsForShot(state, 'sh_2', 'image');
  assert.deepEqual(group.outputs, [{ id: 'out_img_1001', takeId: 'out_img_1001_2', path: PATHS.shot2Image1, name: 'Iteration 1001', createdAt: '2026-10-21T09:00:00.000Z' }]);
});

test('a take’s recipe is not changed by selecting, renaming, rating or rejecting it', () => {
  const state = migrated();
  const before = structuredClone(state.takes.out_img_1001.recipe);
  const edited = structuredClone(state);
  const take = edited.takes.out_img_1001;
  take.annotations = { name: 'Keeper', rating: 5, rejected: true, favorite: true, notes: 'the one' };
  findShot(edited, 'sh_1').selection.image = 'out_img_1001';

  assert.deepEqual(take.recipe, before);
  assert.equal(take.groupKey, state.takes.out_img_1001.groupKey);
  const [group] = groupsForShot(edited, 'sh_1', 'image');
  assert.deepEqual(group.outputs.map(o => o.id), ['out_img_1001', 'out_img_1002'], 'still in the same group, same order');
  assert.equal(group.outputs[0].name, 'Keeper');
  assert.equal(selectedPath(edited, 'sh_1', 'image'), PATHS.shot1Image1);
});

// --- assets and looks ------------------------------------------------------------------

test('lookPrimaryPath and lookEnabledPaths reproduce assetPrimaryImage and assetInputImages for every asset', () => {
  const project = studioProject();
  const state = migrated(project);
  for (const asset of project.assetLibrary) {
    const primary = assetPrimaryImage(asset);
    assert.equal(lookPrimaryPath(state, asset.id), primary ? normalizePath(primary) : null, `${asset.id} primary`);
    assert.deepEqual(lookEnabledPaths(state, asset.id), assetInputImages(asset).map(normalizePath), `${asset.id} ticked`);
  }
});

test('lookFor honours a shot’s look binding and falls back to the default', () => {
  const state = migrated();
  const ralph = state.assetLibrary.find(a => a.id === 'asset_ralph');
  assert.equal(lookFor(state, 'asset_ralph').id, ralph.defaultLookId);
  assert.equal(lookFor(state, 'asset_ralph', 'sh_1').id, ralph.defaultLookId);

  const second = { ...ralph.looks[0], id: 'look_second', name: 'Wet', images: [] };
  const withLooks = structuredClone(state);
  withLooks.assetLibrary[0].looks.push(second);
  findShot(withLooks, 'sh_1').assetLooks = { asset_ralph: 'look_second' };
  assert.equal(lookFor(withLooks, 'asset_ralph', 'sh_1').name, 'Wet');
  assert.equal(lookFor(withLooks, 'asset_ralph', 'sh_2').name, 'Default');
  assert.equal(lookFor(withLooks, 'asset_nope'), null);
});

test('lookImages resolves each pool entry to its media', () => {
  const state = migrated();
  const images = lookImages(state, 'asset_ralph');
  assert.deepEqual(images.map(i => [i.path, i.primary, i.enabled]), [[PATHS.ralph1, true, false], [PATHS.ralph2, false, true]]);
  assert.equal(images[1].media.name, 'Ralph 2');
  assert.deepEqual(lookImages(state, 'asset_car'), []);
});

// --- the board, paths and bindings ----------------------------------------------------------

test('boardMedia is every media with a reference, oldest first', () => {
  const state = migrated();
  assert.deepEqual(boardMedia(state).map(m => m.name), ['Ralph turnaround', 'Rain style', 'Ralph 2']);
  boardMedia(state).forEach(m => assert.ok(m.reference));
});

test('mediaByPath joins on the migration’s identity rule and tolerates misses', () => {
  const state = migrated();
  const alley = mediaByPath(state, PATHS.alley);
  assert.equal(mediaByPath(state, PATHS.alleyBackslash), alley);
  assert.equal(mediaByPath(state, 'ASSETS/Alley_1.PNG'), alley);
  assert.equal(mediaByPath(state, PATHS.vocalUrl).external, true);
  assert.equal(mediaByPath(state, 'assets/nowhere.png'), null);
  assert.equal(mediaByPath(state, ''), null);
  assert.equal(mediaPath(state, alley.id), PATHS.alley);
  assert.equal(takeById(state, 'out_img_1002').mediaId, mediaByPath(state, PATHS.shot1Image2).id);
});

test('bindingsFor returns one target’s bindings by order; project scope ignores the target', () => {
  const state = migrated();
  const rain = mediaByPath(state, PATHS.rainStyle).id;
  assert.deepEqual(bindingsFor(state, 'project').map(b => b.mediaId), [rain]);
  assert.deepEqual(bindingsFor(state, 'project', 'ignored').map(b => b.id), ['edge_1']);
  assert.deepEqual(bindingsFor(state, 'scene', 'sc_1').map(b => b.enabled), [false]);
  assert.deepEqual(bindingsFor(state, 'shot', 'sh_1').map(b => b.id), ['edge_2']);
  const ralphLook = state.assetLibrary[0].defaultLookId;
  assert.deepEqual(bindingsFor(state, 'asset-look', ralphLook).map(b => b.mediaId), [mediaByPath(state, PATHS.ralphTurnaround).id]);

  const reordered = structuredClone(state);
  reordered.bindings.push({ ...reordered.bindings[1], id: 'edge_late', order: -1 });
  assert.deepEqual(bindingsFor(reordered, 'shot', 'sh_1').map(b => b.id), ['edge_late', 'edge_2']);
});
