import test from 'node:test';
import assert from 'node:assert/strict';

import { SCHEMA_VERSION, migrateProjectV2 } from './migrateV2.js';
import { validateProject } from './validate.js';
import { imagePromptSignature, videoPromptSignature } from './groupKey.js';
import { isMintedId, seededRandom } from './ids.js';
import { normalizePath } from './paths.js';
import { FIXED_NOW, PATHS, STUDIO_DISTINCT_PATHS, studioProject } from './fixtures/v1-studio.js';
import { legacyProject } from './fixtures/v1-legacy.js';
import { mediaByPath, takesForShot } from '../project/selectors.js';

const options = () => ({ now: () => FIXED_NOW, random: seededRandom(7) });
const migrate = (project = studioProject()) => migrateProjectV2(project, options());

const shotIn = (state, id) => state.scenes.flatMap(s => s.shots).find(s => s.id === id);
const assetIn = (state, id) => state.assetLibrary.find(a => a.id === id);
const mediaId = (state, path) => mediaByPath(state, path)?.id ?? null;
const v1Group = (project, shotId, kind, groupId) => project.scenes
  .flatMap(s => s.shots).find(s => s.id === shotId)[kind === 'image' ? 'imagePrompts' : 'videoPrompts']
  .find(g => g.id === groupId);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

// --- the whole document --------------------------------------------------------

test('a v1 project migrates to a document that passes validateProject', () => {
  for (const fixture of [studioProject, legacyProject]) {
    const { state, report } = migrate(fixture());
    assert.equal(state.schemaVersion, SCHEMA_VERSION);
    assert.deepEqual(state.migratedFrom, { schemaVersion: 1, at: report.at });
    assert.deepEqual(validateProject(state), []);
    assert.deepEqual(report.problems, []);
  }
});

test('migration does not run twice over an already-migrated project', () => {
  const first = migrate();
  const again = migrateProjectV2(first.state, options());
  assert.equal(again.state, first.state, 'the same object comes back');
  assert.equal(again.report, null);
});

test('the input is never mutated', () => {
  const project = studioProject();
  const before = JSON.stringify(project);
  deepFreeze(project);
  assert.doesNotThrow(() => migrate(project));
  assert.equal(JSON.stringify(project), before);
});

test('the same clock and random source give the same document', () => {
  assert.deepEqual(migrate().state, migrate().state);
});

test('v1 ids are kept; new records get <prefix>_<t36>_<4 random> ids', () => {
  const { state } = migrate();
  assert.ok(Object.keys(state.takes).includes('out_img_1002'));
  assert.ok(state.bindings.some(b => b.id === 'edge_1'));
  assert.ok(Object.keys(state.jobs).includes('job_2'));
  Object.keys(state.media).forEach(id => assert.ok(isMintedId(id, 'med'), id));
  state.assetLibrary.forEach(asset => assert.ok(isMintedId(asset.defaultLookId, 'look')));
});

// --- 3. media ----------------------------------------------------------------------

test('the same path recorded as output, gallery entry, reference and asset image becomes one media record', () => {
  const project = studioProject();
  project.referenceImages.push({ id: 'ref_still', path: PATHS.shot1Image2, name: 'Shot 1 still', kind: 'other', tags: [], notes: '', source: 'project', createdAt: '2026-10-21T09:30:00.000Z' });
  project.assetLibrary[0].images.push(PATHS.shot1Image2);
  const { state } = migrate(project);

  assert.equal(Object.keys(state.media).length, STUDIO_DISTINCT_PATHS, 'no extra record for the extra sightings');
  const media = mediaByPath(state, PATHS.shot1Image2);
  assert.equal(state.takes.out_img_1002.mediaId, media.id);
  assert.ok(assetIn(state, 'asset_ralph').looks[0].images.some(image => image.mediaId === media.id));
  assert.equal(media.reference.category, 'other');
  assert.equal(media.name, 'Shot 1 still', 'the reference name wins over the gallery and output names');
  assert.equal(media.createdAt, '2026-10-21T09:00:05.000Z', 'the earliest sighting dates the file');
});

test('backslash and forward-slash spellings of one path merge, and the report says so', () => {
  const { state, report } = migrate();
  const alley = mediaByPath(state, PATHS.alley);
  assert.equal(alley.path, PATHS.alley, 'stored with forward slashes');
  assert.equal(mediaByPath(state, PATHS.alleyBackslash), alley);
  assert.equal(assetIn(state, 'asset_alley').looks[0].images[0].mediaId, alley.id);
  assert.deepEqual(report.media.merged, [{ mediaId: alley.id, path: PATHS.alley, variants: [PATHS.alley, PATHS.alleyBackslash] }]);
});

test('an https:// video ref becomes external media and is never looked up on disk', () => {
  const { state, report } = migrate();
  const move = mediaByPath(state, PATHS.moveUrl);
  assert.equal(move.external, true);
  assert.equal(move.path, PATHS.moveUrl, 'kept byte for byte, query string included');
  assert.equal(move.kind, 'video');
  assert.equal(move.origin.type, 'imported');
  assert.equal(move.hash, null);
  assert.deepEqual(shotIn(state, 'sh_1').videoRefs, [mediaId(state, PATHS.moveClip), move.id]);
  assert.deepEqual(shotIn(state, 'sh_1').audioRefs, [mediaId(state, PATHS.vocalUrl)]);
  assert.equal(mediaByPath(state, PATHS.vocalUrl).kind, 'audio');
  assert.equal(report.media.external.count, 2);
});

test('kind comes from the extension, falling back to where the path was found', () => {
  const project = studioProject();
  project.scenes[0].shots[0].audioRefs.push('asset://atlas/abc123');
  const { state } = migrate(project);
  const atlas = mediaByPath(state, 'asset://atlas/abc123');
  assert.equal(atlas.kind, 'audio');
  assert.equal(atlas.external, true);
  assert.equal(mediaByPath(state, PATHS.shot1Voice).kind, 'audio');
  assert.equal(mediaByPath(state, PATHS.shot1Video1).kind, 'video');
});

// --- 4 + 5. takes ---------------------------------------------------------------------

test('every output becomes a take with the group’s recipe and the group’s signature as groupKey', () => {
  const project = studioProject();
  const { state } = migrate(project);
  const group = v1Group(project, 'sh_1', 'image', 'prompt_img_1');

  for (const output of group.outputs) {
    const take = state.takes[output.id];
    assert.ok(take, output.id);
    assert.equal(take.kind, 'image');
    assert.equal(take.purpose, 'shot-image');
    assert.deepEqual(take.owner, { shotId: 'sh_1' });
    assert.equal(take.mediaId, mediaId(state, output.path));
    assert.equal(take.createdAt, output.createdAt);
    assert.equal(take.groupKey, imagePromptSignature(group));
    assert.deepEqual(take.legacy, { groupId: 'prompt_img_1', outputId: output.id });
    assert.equal(take.recipe.rawPrompt, group.rawPrompt);
    assert.equal(take.recipe.prompt, group.prompt);
    assert.equal(take.recipe.model, group.model);
    assert.equal(take.recipe.resolution, group.resolution);
    assert.equal(take.recipe.duration, group.duration);
    assert.deepEqual(take.recipe.primaryInputs, [mediaId(state, PATHS.ralph1)]);
    assert.deepEqual(take.recipe.excludedInputs, []);
    assert.equal(take.recipe.attachTaggedImages, true);
    assert.equal(take.recipe.promptOverride, null);
    assert.deepEqual(take.inputs, [
      { role: 'image', slot: 1, mediaId: mediaId(state, PATHS.ralph1), url: null, via: null },
      { role: 'image', slot: 2, mediaId: mediaId(state, PATHS.alley), url: null, via: null }
    ]);
    assert.equal(take.inputsComplete, true);
    assert.equal(take.annotations.name, output.name);
    assert.equal(mediaByPath(state, output.path).origin.type, 'generated');
    assert.equal(mediaByPath(state, output.path).origin.takeId, output.id);
  }

  const video = state.takes.out_vid_2001;
  assert.equal(video.groupKey, videoPromptSignature(v1Group(project, 'sh_1', 'video', 'prompt_vid_1')));
  assert.equal(video.purpose, 'shot-video');
  assert.equal(video.inputsComplete, false, 'v1 never recorded the audio and video refs a video run sent');
});

test('only the newest output in a group gets exact asset revisions; the rest are group-latest', () => {
  const { state } = migrate();
  const newest = state.takes.out_img_1002;
  const older = state.takes.out_img_1001;
  assert.equal(newest.assetRevisionsConfidence, 'exact');
  assert.equal(older.assetRevisionsConfidence, 'group-latest');
  const ralphLook = assetIn(state, 'asset_ralph').defaultLookId;
  assert.deepEqual(newest.assetRevisions, {
    asset_ralph: { lookId: ralphLook, revision: 1, updatedAt: '2026-10-20T10:00:00.000Z', primaryMediaId: mediaId(state, PATHS.ralph1) },
    asset_alley: { lookId: assetIn(state, 'asset_alley').defaultLookId, revision: 1, updatedAt: '2026-10-19T08:00:00.000Z', primaryMediaId: mediaId(state, PATHS.alley) }
  });
  assert.deepEqual(older.assetRevisions, newest.assetRevisions, 'the copy is the same snapshot, with less confidence');
});

test('a group without meta gives takes with no asset revisions and confidence none', () => {
  const { state } = migrate();
  assert.equal(state.takes.out_img_1003.assetRevisions, null);
  assert.equal(state.takes.out_img_1003.assetRevisionsConfidence, 'none');
});

test('a group that only recorded imageInput is marked incomplete', () => {
  const { state } = migrate(legacyProject());
  const take = state.takes.out_img_old;
  assert.equal(take.inputsComplete, false);
  assert.deepEqual(take.inputs.map(i => i.mediaId), [mediaId(state, 'assets/ref_1.png')]);
  assert.equal(take.recipe.rawPrompt, 'A hover-car crosses the skyline.', 'a group without rawPrompt keys on its prompt');
});

test('an empty prompt group is dropped and counted', () => {
  const { state, report } = migrate();
  assert.ok(!Object.values(state.takes).some(t => t.legacy?.groupId === 'prompt_img_3'));
  assert.deepEqual(report.groups.emptyDropped, { count: 1, ids: ['prompt_img_3'] });
});

test('a lip-sync group becomes a lipsync take with no parent', () => {
  const project = studioProject();
  const { state } = migrate(project);
  const take = state.takes.out_vid_2002;
  assert.equal(take.kind, 'video');
  assert.equal(take.purpose, 'lipsync');
  assert.deepEqual(take.recipe, { prompt: 'Lipsync synced with: voice.wav' });
  assert.equal(take.parentTakeId, null);
  assert.deepEqual(take.inputs, []);
  assert.equal(take.inputsComplete, false);
  assert.equal(take.groupKey, videoPromptSignature(v1Group(project, 'sh_1', 'video', 'prompt_sync_2002')));
});

test('provider fields are null on every migrated take, and the report counts the partial ones', () => {
  const { state, report } = migrate();
  Object.values(state.takes).forEach(take => {
    assert.deepEqual(take.provider, { requestId: null, seed: null, modelVersion: null, endpoint: null });
  });
  assert.deepEqual([...report.takes.inputsIncomplete.ids].sort(), ['out_img_1001_2', 'out_vid_2001', 'out_vid_2002']);
});

// --- 6. selections ---------------------------------------------------------------------

test('a selected path that matches no output becomes an imported take owned by the shot', () => {
  const { state, report } = migrate();
  const shot = shotIn(state, 'sh_3');
  const take = state.takes[shot.selection.image];
  assert.ok(take);
  assert.equal(take.purpose, 'imported');
  assert.equal(take.kind, 'image');
  assert.deepEqual(take.owner, { shotId: 'sh_3' });
  assert.equal(take.mediaId, mediaId(state, PATHS.crop1));
  assert.equal(take.recipe, null);
  assert.equal(take.groupKey, '');
  assert.equal(take.legacy, null);
  assert.deepEqual(report.takes.importedForSelections, { count: 1, ids: [take.id] });
});

test('a selected path that matches an output selects that take, preferring the newest', () => {
  const { state } = migrate();
  assert.deepEqual(shotIn(state, 'sh_1').selection, { image: 'out_img_1002', video: 'out_vid_2002' });
  assert.deepEqual(shotIn(state, 'sh_2').selection, { image: 'out_img_1001_2', video: null });

  // Two outputs in different groups name the same file: the newest take is
  // selected, the earliest is the file's origin, and the report lists the rest.
  const project = studioProject();
  v1Group(project, 'sh_1', 'image', 'prompt_img_2').outputs.push({
    id: 'out_img_1005', path: PATHS.shot1Image2, name: 'Iteration 1005', createdAt: '2026-10-21T09:20:00.000Z'
  });
  const twice = migrate(project);
  assert.equal(shotIn(twice.state, 'sh_1').selection.image, 'out_img_1005');
  const media = mediaByPath(twice.state, PATHS.shot1Image2);
  assert.equal(media.origin.takeId, 'out_img_1002');
  assert.deepEqual(twice.report.takes.outputsSharingMedia, [{ mediaId: media.id, originTakeId: 'out_img_1002', otherTakeIds: ['out_img_1005'] }]);
  assert.deepEqual(validateProject(twice.state), []);
});

test('the selection log has one entry per selection, stamped with the migration time', () => {
  const { state, report } = migrate();
  assert.deepEqual(shotIn(state, 'sh_1').selectionLog, [
    { kind: 'image', takeId: 'out_img_1002', at: report.at },
    { kind: 'video', takeId: 'out_vid_2002', at: report.at }
  ]);
  assert.deepEqual(shotIn(state, 'sh_2').selectionLog, [{ kind: 'image', takeId: 'out_img_1001_2', at: report.at }]);
  assert.equal(report.selectionLog.stampedAt, report.at);
  assert.equal(report.at, new Date(FIXED_NOW).toISOString());
});

// --- 7. looks ----------------------------------------------------------------------------

test('an asset becomes one Default look with primary and enabled flags preserved', () => {
  const { state } = migrate();
  const ralph = assetIn(state, 'asset_ralph');
  assert.equal(ralph.looks.length, 1);
  const look = ralph.looks[0];
  assert.equal(look.id, ralph.defaultLookId);
  assert.equal(look.name, 'Default');
  assert.equal(look.shotDescription, 'rusty robot');
  assert.equal(look.prompt, 'character sheet of a rusty maintenance robot');
  assert.equal(look.revision, 1);
  assert.equal(look.updatedAt, '2026-10-20T10:00:00.000Z');
  assert.deepEqual(look.images, [
    { mediaId: mediaId(state, PATHS.ralph1), primary: true, enabled: false, view: null },
    { mediaId: mediaId(state, PATHS.ralph2), primary: false, enabled: true, view: null }
  ]);
  for (const key of ['imagePrompt', 'shotDescription', 'images', 'primaryImage', 'inputImages', 'useExistingAsReference']) {
    assert.ok(!(key in ralph), `${key} moved onto the look`);
  }
  assert.equal(ralph.description, 'A tired maintenance robot with one cracked eye.');
  assert.equal(ralph.notes, '');
  assert.equal(ralph.imageModel, 'fal-ai/flux/dev');
});

test('an asset still carrying useExistingAsReference ticks only its primary', () => {
  const { state } = migrate();
  const look = assetIn(state, 'asset_alley').looks[0];
  assert.deepEqual(look.images, [{ mediaId: mediaId(state, PATHS.alley), primary: true, enabled: true, view: null }]);

  const project = studioProject();
  project.assetLibrary[1].useExistingAsReference = false;
  assert.equal(migrate(project).state.assetLibrary[1].looks[0].images[0].enabled, false);
});

test('a primary that is missing from the image list is added first; an asset with no images gets an empty look', () => {
  const project = studioProject();
  project.assetLibrary[0].images = [PATHS.ralph2];
  const { state } = migrate(project);
  assert.deepEqual(assetIn(state, 'asset_ralph').looks[0].images.map(i => [mediaByPath(state, i.mediaId === mediaId(state, PATHS.ralph1) ? PATHS.ralph1 : PATHS.ralph2).path, i.primary]), [
    [PATHS.ralph1, true], [PATHS.ralph2, false]
  ]);
  assert.deepEqual(assetIn(state, 'asset_car').looks[0].images, []);
});

// --- 8. board and bindings ------------------------------------------------------------------

test('a reference record puts its media on the board', () => {
  const { state } = migrate();
  const rain = mediaByPath(state, PATHS.rainStyle);
  assert.deepEqual(rain.reference, { category: 'style', tags: ['rain'], notes: 'moody' });
  assert.equal(rain.name, 'Rain style');
  assert.equal(rain.origin.type, 'imported', 'an uploaded reference came from outside');
  assert.equal(mediaByPath(state, PATHS.ralph2).origin.type, 'generated');
  assert.equal(mediaByPath(state, PATHS.ralph2).origin.takeId, null);
  assert.equal(mediaByPath(state, PATHS.ralph2).origin.note, 'asset artwork; v1 recorded no recipe');
});

test('a reference linked to an asset but absent from its pool becomes an asset-look binding', () => {
  const { state } = migrate();
  const ralph = assetIn(state, 'asset_ralph');
  const link = state.bindings.filter(b => b.scope === 'asset-look');
  assert.equal(link.length, 1);
  assert.deepEqual({ ...link[0], id: undefined }, {
    id: undefined,
    mediaId: mediaId(state, PATHS.ralphTurnaround),
    scope: 'asset-look',
    targetId: ralph.defaultLookId,
    role: 'subject',
    enabled: true,
    order: 0,
    operations: null
  });
  assert.ok(isMintedId(link[0].id, 'bind'));
});

test('a reference already in the pool does not also get a binding', () => {
  const { state } = migrate();
  const ralph2 = mediaId(state, PATHS.ralph2);
  assert.ok(assetIn(state, 'asset_ralph').looks[0].images.some(i => i.mediaId === ralph2));
  assert.ok(!state.bindings.some(b => b.mediaId === ralph2));
});

test('assignments become bindings keyed by media id, in their scope and order', () => {
  const { state } = migrate();
  const edges = state.bindings.filter(b => b.id.startsWith('edge_'));
  assert.deepEqual(edges, [
    { id: 'edge_1', mediaId: mediaId(state, PATHS.rainStyle), scope: 'project', targetId: null, role: 'style', enabled: true, order: 0, operations: null },
    { id: 'edge_2', mediaId: mediaId(state, PATHS.ralphTurnaround), scope: 'shot', targetId: 'sh_1', role: 'subject', enabled: true, order: 0, operations: null },
    { id: 'edge_3', mediaId: mediaId(state, PATHS.rainStyle), scope: 'scene', targetId: 'sc_1', role: 'style', enabled: false, order: 0, operations: null }
  ]);
});

test('a dangling assignment is skipped and counted', () => {
  const { state, report } = migrate();
  assert.ok(!state.bindings.some(b => b.id === 'edge_4' || b.id === 'edge_5'));
  assert.deepEqual(report.bindings.danglingSkipped, { count: 2, ids: ['edge_4', 'edge_5'], reasons: { reference: 1, target: 1, asset: 0 } });
});

test('legacy per-shot reference arrays become shot bindings through the v1 normalizer', () => {
  const { state } = migrate(legacyProject());
  assert.equal(state.bindings.length, 1);
  assert.equal(state.bindings[0].scope, 'shot');
  assert.equal(state.bindings[0].targetId, 'shot_1');
  assert.equal(state.bindings[0].mediaId, mediaId(state, 'assets/ref_1.png'));
  assert.ok(!('referenceImages' in state.scenes[0].shots[0]));
});

// --- 9. gallery leftovers ----------------------------------------------------------------------

test('gallery entries with no take are classified by what the document says about them', () => {
  const { state, report } = migrate();
  const alley = mediaByPath(state, PATHS.alley);
  assert.deepEqual(alley.origin, { type: 'generated', takeId: null, sourceMediaId: null, atSec: null, note: 'asset artwork; v1 recorded no recipe' });
  assert.equal(alley.notes, 'reference art of a rain-slick alley', 'the gallery prompt is kept where no take holds it');

  assert.deepEqual(mediaByPath(state, PATHS.dreamFrame).origin, { type: 'captured', takeId: null, sourceMediaId: null, atSec: null, note: null });

  const crop = mediaByPath(state, PATHS.crop1);
  assert.equal(crop.origin.type, 'derived');
  assert.equal(crop.origin.sourceMediaId, mediaId(state, PATHS.shot1Image2), 'exactly one media is named Iteration 1002');

  const orphanCrop = mediaByPath(state, PATHS.crop2);
  assert.deepEqual(orphanCrop.origin, { type: 'derived', takeId: null, sourceMediaId: null, atSec: null, note: 'Crop of Nowhere' });

  const moodboard = mediaByPath(state, PATHS.moodboard);
  assert.equal(moodboard.origin.type, 'unknown');
  assert.equal(moodboard.notes, 'uploaded moodboard');

  assert.equal(mediaByPath(state, PATHS.shot1Image2).notes, '', 'a prompt already on a take is not copied');
  assert.deepEqual([...report.media.unknownOrigin.ids].sort(), [mediaId(state, PATHS.ralph1), moodboard.id].sort());
});

// --- 10. edit -----------------------------------------------------------------------------------------

test('shot clips stay follow-mode and asset clips become media clips', () => {
  const { state } = migrate();
  assert.equal(state.edit.version, 2);
  const [follow, titles] = state.edit.video;
  assert.deepEqual(follow.source, { kind: 'shot', shotId: 'sh_1' });
  assert.deepEqual(follow.boundTo, { mediaId: mediaId(state, PATHS.shot1Video2) });
  assert.equal(follow.out, 4);
  assert.deepEqual(titles.source, { kind: 'media', mediaId: mediaId(state, PATHS.titles), stream: 'video' });
  assert.equal(titles.boundTo, null);
  assert.deepEqual(titles.transition, { type: 'dissolve', duration: 0.5 });

  const music = state.edit.audio[0].clips[0];
  assert.deepEqual(music.source, { kind: 'media', mediaId: mediaId(state, PATHS.music), stream: 'audio' });
  assert.deepEqual(music.boundTo, { mediaId: mediaId(state, PATHS.music) });
  assert.equal(music.fadeOut, 1);
  assert.equal(mediaByPath(state, PATHS.music).kind, 'audio');
});

test('durations and bin items are re-keyed by media id', () => {
  const { state } = migrate();
  assert.deepEqual(state.edit.bin, [
    { id: 'bin_1', mediaId: mediaId(state, PATHS.titles), addedAt: '2026-10-23T09:00:00.000Z' },
    { id: 'bin_2', mediaId: mediaId(state, PATHS.music), addedAt: '2026-10-23T09:01:00.000Z' }
  ]);
  assert.deepEqual(Object.keys(state.edit.durations).sort(), [mediaId(state, PATHS.shot1Video2), mediaId(state, PATHS.titles)].sort());
  assert.deepEqual(state.edit.durations[mediaId(state, PATHS.titles)], { duration: 3, width: 1920, height: 1080, fps: 25, hasAudio: false, isImage: false });
  assert.equal(mediaByPath(state, PATHS.titles).origin.type, 'imported');
  assert.equal(mediaByPath(state, PATHS.titles).name, 'Titles');
});

test('a project saved before the editor existed gets an empty version 2 edit', () => {
  const { state } = migrate(legacyProject());
  assert.deepEqual(state.edit, {
    version: 2,
    settings: { width: 1920, height: 1080, fps: 24, resolutionAuto: true },
    smart: true,
    video: [],
    audio: [],
    bin: [],
    durations: {}
  });
});

// --- 11. jobs and runs ----------------------------------------------------------------------------------

test('running jobs are not resurrected and costs are null, not zero', () => {
  const { state } = migrate();
  assert.equal(state.jobs.job_1.status, 'failed');
  assert.deepEqual(state.jobs.job_1.error, { class: 'unknown', message: 'interrupted by reload' });
  Object.values(state.jobs).forEach(job => {
    assert.deepEqual(job.cost, { estimated: null, reported: null, currency: null });
    assert.equal(job.provider, null);
    assert.equal(job.runId, null);
  });
  assert.deepEqual(Object.keys(state.jobs), ['job_3', 'job_1', 'job_2'], 'newest first, as the v1 log was');
});

test('a completed job links to the take and media its output became', () => {
  const { state } = migrate();
  const job = state.jobs.job_2;
  assert.equal(job.kind, 'image');
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.target, { shotId: 'sh_1' });
  assert.equal(job.resultMediaId, mediaId(state, PATHS.shot1Image2));
  assert.equal(job.resultTakeId, 'out_img_1002');
  assert.equal(state.takes.out_img_1002.jobId, 'job_2');
  assert.deepEqual(job.request, { model: 'fal-ai/flux/dev', providerFamily: null, prompt: state.takes.out_img_1002.recipe.prompt, inputs: [], settings: {} });
  assert.equal(job.submittedAt, '2026-10-21T09:00:04.000Z');
  assert.deepEqual(job.legacy, { type: 'image', shotName: 'Shot 1', taggedAssets: ['Ralph', 'Alley'] });

  const assetJob = state.jobs.job_3;
  assert.deepEqual(assetJob.target, { assetId: 'asset_alley', lookId: assetIn(state, 'asset_alley').defaultLookId });
  assert.deepEqual(assetJob.error, { class: 'unknown', message: 'provider timeout' });
});

test('a pipeline run becomes runs[0]', () => {
  const { state } = migrate();
  assert.deepEqual(state.runs, [{
    id: 'run_1',
    kind: 'pipeline',
    status: 'done',
    startedAt: '2026-10-21T08:00:00.000Z',
    finishedAt: '2026-10-21T08:30:00.000Z',
    options: { skip: [], dryRun: false },
    stageStates: { prompts: { status: 'done', total: 2, done: 2, failed: [] } },
    jobIds: []
  }]);
  assert.deepEqual(migrate(legacyProject()).state.runs, []);
});

// --- 12 + 13. render outputs and cleanup -------------------------------------------------------------------

test('render outputs become render media and the fields store media ids', () => {
  const { state } = migrate();
  assert.equal(state.concatenatedVideo, mediaId(state, PATHS.finalCut));
  assert.equal(mediaByPath(state, PATHS.finalCut).origin.type, 'render');
  assert.equal(state.scenes[0].sceneConcatenatedVideo, mediaId(state, PATHS.scene1Cut));
  assert.equal(mediaByPath(state, PATHS.scene1Cut).origin.type, 'render');
  assert.equal(state.scenes[1].sceneConcatenatedVideo, null);
  assert.equal(state.watermarkImage, PATHS.watermark, 'the watermark stays a path; the render pipeline resolves it by path');
  assert.equal(mediaByPath(state, PATHS.watermark).origin.type, 'imported');
});

test('v1-only keys are gone from the project, its shots and its assets', () => {
  const { state } = migrate();
  for (const key of ['shots', 'imageGallery', 'videoGallery', 'referenceImages', 'refAssignments', 'referenceSchemaVersion', 'batchJobs', 'pipelineRun']) {
    assert.ok(!(key in state), key);
  }
  state.scenes.flatMap(s => s.shots).forEach(shot => {
    for (const key of ['selectedImage', 'selectedVideo', 'imagePrompts', 'videoPrompts', 'referenceImages']) {
      assert.ok(!(key in shot), `${shot.id}.${key}`);
    }
    assert.deepEqual(shot.assetLooks, {});
    assert.ok(Array.isArray(shot.selectionLog));
  });
  const shot = shotIn(state, 'sh_1');
  assert.equal(shot.lipSyncAudio, mediaId(state, PATHS.shot1Voice));
  assert.equal(shot.description, '<Ralph> walks down the <Alley>');
  assert.equal(shotIn(state, 'sh_2').lipSyncAudio, null);
});

test('settings travel through unchanged, and the prompt bag is folded from the flat fields', () => {
  const { state } = migrate();
  assert.equal(state.imageModel, 'fal-ai/flux/schnell');
  assert.equal(state.videoDuration, '5');
  assert.equal(state.activeShotId, 'sh_1');
  assert.equal(state.prePrompt, 'cinematic.');
  assert.deepEqual(state.promptSettings, { prePrompt: 'cinematic.', postPrompt: 'film grain', videoPrePrompt: '', videoPostPrompt: '', imageSystemPrompt: '', videoSystemPrompt: '' });

  const legacy = migrate(legacyProject()).state;
  assert.deepEqual(legacy.promptSettings, { imageSystemPrompt: 'You write prompts.', prePrompt: 'cinematic', postPrompt: 'grain' });
});

test('flat shots without scenes are wrapped in a default scene, as the loader does', () => {
  const { state } = migrate(legacyProject());
  assert.equal(state.scenes.length, 1);
  assert.ok(state.scenes[0].id.startsWith('scene_default_'));
  assert.equal(state.scenes[0].name, 'Scene 1');
  assert.deepEqual(state.scenes[0].shots.map(s => s.id), ['shot_1']);
  assert.equal(state.scenes[0].shots[0].selection.image, 'out_img_old');
});

// --- 14. ids ------------------------------------------------------------------------------------------------

test('colliding output ids are remapped and every reference follows', () => {
  const { state, report } = migrate();
  assert.deepEqual(report.ids.remapped, [{ collection: 'takes', from: 'out_img_1001', to: 'out_img_1001_2' }]);
  assert.equal(state.takes.out_img_1001.owner.shotId, 'sh_1');
  assert.equal(state.takes.out_img_1001_2.owner.shotId, 'sh_2');
  assert.deepEqual(state.takes.out_img_1001_2.legacy, { groupId: 'prompt_img_4', outputId: 'out_img_1001' });
  assert.equal(shotIn(state, 'sh_2').selection.image, 'out_img_1001_2');
  assert.equal(mediaByPath(state, PATHS.shot2Image1).origin.takeId, 'out_img_1001_2');
  assert.equal(mediaByPath(state, PATHS.shot1Image1).origin.takeId, 'out_img_1001');
  assert.deepEqual(takesForShot(state, 'sh_2').map(t => t.id), ['out_img_1001_2']);
});

test('colliding shot ids are suffixed and the second shot keeps its own takes', () => {
  const project = studioProject();
  project.scenes[1].shots[0].id = 'sh_2';
  const { state, report } = migrate(project);
  assert.deepEqual(report.ids.remapped.filter(r => r.collection === 'shots'), [{ collection: 'shots', from: 'sh_2', to: 'sh_2_2' }]);
  assert.equal(state.scenes[1].shots[0].id, 'sh_2_2');
  assert.equal(state.takes[state.scenes[1].shots[0].selection.image].owner.shotId, 'sh_2_2');
  assert.deepEqual(validateProject(state), []);
});

// --- 5.4 the report ---------------------------------------------------------------------------------------

test('the report counts match the fixture', () => {
  const { report } = migrate();
  assert.equal(report.media.created, STUDIO_DISTINCT_PATHS);
  assert.equal(report.media.external.count, 2);
  assert.equal(report.media.unknownOrigin.count, 2);
  assert.equal(report.media.merged.length, 1);
  assert.equal(report.takes.created, 7);
  assert.deepEqual(report.takes.byPurpose, { 'shot-image': 4, 'shot-video': 1, lipsync: 1, continuation: 0, imported: 1 });
  assert.equal(report.takes.importedForSelections.count, 1);
  assert.equal(report.takes.inputsIncomplete.count, 3);
  assert.deepEqual(report.takes.byConfidence, { exact: 2, 'group-latest': 1, none: 4 });
  assert.deepEqual(report.takes.outputsSharingMedia, []);
  assert.equal(report.groups.emptyDropped.count, 1);
  assert.equal(report.bindings.created, 4);
  assert.deepEqual(report.bindings.byScope, { project: 1, scene: 1, shot: 1, 'asset-look': 1 });
  assert.equal(report.bindings.danglingSkipped.count, 2);
  assert.equal(report.ids.remapped.length, 1);
  assert.deepEqual(report.skipped, { referencesWithoutPath: [], outputsWithoutPath: [], duplicateReferences: [] });
  assert.deepEqual(report.problems, []);
  for (const bucket of [report.media.external, report.media.unknownOrigin, report.takes.importedForSelections, report.takes.inputsIncomplete, report.groups.emptyDropped, report.bindings.danglingSkipped]) {
    assert.equal(bucket.count, bucket.ids.length);
  }
});

test('paths are stored with forward slashes everywhere', () => {
  const { state } = migrate();
  Object.values(state.media).forEach(media => {
    assert.equal(media.path, normalizePath(media.path));
    assert.ok(!media.path.includes('\\'), media.path);
  });
});
