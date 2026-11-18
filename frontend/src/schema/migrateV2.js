// v1 → v2 project migration (SCHEMA_V2.md §5).
//
// One pure function. It takes the blob `buildStatePayload` wrote and returns
// the v2 document plus a report of what it did and what it could not know.
// Nothing moves on disk; every path the v1 file mentions becomes one `Media`
// record, every prompt-group output becomes a `Take`, and selections point at
// takes instead of paths.
//
// It never mutates its input (the caller may be holding it as an undo
// snapshot) and it is idempotent: a document stamped `schemaVersion: 2` is
// returned as it is. The existing v1 normalizers run first — imported, not
// copied — so this sees the one shape `applyLoadedState` sees.
//
// What it does not know, it marks (§5.2): provider fields are null, video
// takes are `inputsComplete: false`, confidence is `group-latest` or `none`
// where the group's asset snapshot was overwritten, and the selection log is
// stamped with the migration time because v1 kept no selection history.

import { migrateReferenceState } from '../references.js';
import { migrateEdit } from '../edit/model.js';
import { migratePromptSettings } from '../prompts.js';
import { assetInputImages } from '../promptTags.js';
import { basename, extensionOf, mediaKindOf } from '../shared/assetPaths.js';
import { createIdMinter } from './ids.js';
import { groupSignature } from './groupKey.js';
import { isExternalPath, normalizePath, pathKey } from './paths.js';
import { SCHEMA_VERSION, validateProject } from './validate.js';

export { SCHEMA_VERSION };

// `mediaKindOf` answers 'image' for anything it does not know, so the image
// extensions are listed here too to tell "the table says image" from "the
// table has no idea" — the latter falls back to where the path was found.
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

const PROJECT_KEYS_REMOVED = [
  'shots', 'imageGallery', 'videoGallery', 'referenceImages', 'refAssignments',
  'referenceSchemaVersion', 'batchJobs', 'pipelineRun'
];
const SHOT_KEYS_REMOVED = ['selectedImage', 'selectedVideo', 'imagePrompts', 'videoPrompts', 'referenceImages'];
const ASSET_KEYS_REMOVED = ['imagePrompt', 'shotDescription', 'images', 'primaryImage', 'inputImages', 'useExistingAsReference'];

// v1 job `type` → v2 Job.kind. Anything else is recorded under `legacy.type`.
const JOB_KIND_BY_V1_TYPE = {
  image: 'image', video: 'video', lipsync: 'lipsync', llm: 'llm',
  compile: 'concat', concat: 'concat', watermark: 'render', render: 'render', export: 'export'
};
const JOB_STATUSES = ['queued', 'running', 'waiting-provider', 'completed', 'failed', 'cancelled', 'uncertain'];
const SELECTION_LOG_NOTE = 'v1 recorded no selection history; every migrated selectionLog entry is stamped with the migration time.';

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isIso = (value) => typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
const list = (value) => (Array.isArray(value) ? value : []);

const unknownOrigin = () => ({ type: 'unknown', takeId: null, sourceMediaId: null, atSec: null, note: null });
const nullProvider = () => ({ requestId: null, seed: null, modelVersion: null, endpoint: null });

function kindFromExtension(path) {
  const clean = String(path).split(/[?#]/)[0];
  const extension = extensionOf(clean);
  if (!extension) return null;
  const kind = mediaKindOf(clean);
  if (kind !== 'image') return kind;
  return IMAGE_EXTENSIONS.has(extension) ? 'image' : null;
}

function streamKind(stream) {
  if (stream === 'audio') return 'audio';
  if (stream === 'image') return 'image';
  return 'video';
}

/**
 * Migrate a v1 project document to v2.
 *
 * `now` (milliseconds) and `random` ([0, 1)) feed id minting and the
 * migration timestamp, so a test can pin both. Returns `{ state, report }`;
 * for a document already at v2 the input comes back untouched with a null
 * report.
 */
export function migrateProjectV2(input, { now = () => Date.now(), random = Math.random } = {}) {
  if (isObject(input) && Number(input.schemaVersion) >= SCHEMA_VERSION) {
    return { state: input, report: null };
  }

  const raw = structuredClone(isObject(input) ? input : {});
  const at = new Date(now()).toISOString();
  const ids = createIdMinter({ now, random });

  const report = {
    schemaVersion: SCHEMA_VERSION,
    at,
    media: { created: 0, external: { count: 0, ids: [] }, unknownOrigin: { count: 0, ids: [] }, merged: [] },
    takes: {
      created: 0,
      byPurpose: { 'shot-image': 0, 'shot-video': 0, lipsync: 0, continuation: 0, imported: 0 },
      importedForSelections: { count: 0, ids: [] },
      inputsIncomplete: { count: 0, ids: [] },
      byConfidence: { exact: 0, 'group-latest': 0, none: 0 },
      outputsSharingMedia: []
    },
    groups: { emptyDropped: { count: 0, ids: [] } },
    bindings: {
      created: 0,
      byScope: { project: 0, scene: 0, shot: 0, 'asset-look': 0 },
      danglingSkipped: { count: 0, ids: [], reasons: { reference: 0, target: 0, asset: 0 } }
    },
    ids: { remapped: [] },
    selectionLog: { stampedAt: at, note: SELECTION_LOG_NOTE },
    skipped: { referencesWithoutPath: [], outputsWithoutPath: [], duplicateReferences: [] },
    problems: []
  };

  // --- ids: keep every v1 id, suffix a collision (§4.8) -----------------------

  const used = {};
  const claimId = (collection, wanted, prefix) => {
    if (!used[collection]) used[collection] = new Set();
    const set = used[collection];
    let id = typeof wanted === 'string' && wanted ? wanted : ids.mint(prefix);
    if (set.has(id)) {
      let n = 2;
      while (set.has(`${id}_${n}`)) n += 1;
      const to = `${id}_${n}`;
      report.ids.remapped.push({ collection, from: id, to });
      id = to;
    }
    set.add(id);
    ids.reserve(id);
    return id;
  };

  // --- 2. normalize v1 exactly as applyLoadedState does -----------------------

  let scenes = list(raw.scenes);
  if (scenes.length === 0 && list(raw.shots).length > 0) {
    scenes = [{
      id: 'scene_default_' + now(),
      name: 'Scene 1',
      number: 1,
      shots: raw.shots,
      sceneConcatenatedVideo: raw.sceneConcatenatedVideo || null
    }];
  }
  const migratedRefs = migrateReferenceState({ ...raw, scenes });
  scenes = migratedRefs.scenes.map(scene => ({
    ...scene,
    id: claimId('scenes', scene?.id, 'scene'),
    shots: list(scene?.shots).map(shot => ({ ...shot, id: claimId('shots', shot?.id, 'shot') }))
  }));
  const references = migratedRefs.references;
  const assignments = migratedRefs.assignments;
  const v1Edit = migrateEdit(raw.edit);
  const promptSettings = migratePromptSettings(raw);
  const batchJobs = list(raw.batchJobs).map(job => (
    job?.status === 'running' ? { ...job, status: 'failed', error: 'interrupted by reload' } : job
  ));
  const v1Assets = list(raw.assetLibrary)
    .filter(isObject)
    .map(asset => ({ ...asset, id: claimId('assetLibrary', asset.id, 'asset') }));

  const sceneIds = new Set(scenes.map(scene => scene.id));
  const shotIds = new Set(scenes.flatMap(scene => scene.shots.map(shot => shot.id)));
  const assetById = new Map(v1Assets.map(asset => [asset.id, asset]));
  // Look ids are minted before anything refers to them: asset revisions on
  // takes (step 5) and asset-look bindings (step 8) both name a look.
  const lookIdByAsset = new Map(v1Assets.map(asset => [asset.id, ids.mint('look')]));

  // --- 3. index media: one record per distinct path ---------------------------

  const media = {};
  const idByKey = new Map();
  const spellings = new Map();     // mediaId -> Set of raw spellings seen
  const namePriority = new Map();  // mediaId -> priority of the name chosen so far
  const kindSource = new Map();    // mediaId -> 'extension' | 'location' | 'default'

  /**
   * Record a sighting of a path and return its media id.
   * `kind` says where it was found when the extension is no help; `name` and
   * `namePriority` (lower wins) pick the display name; `createdAt` keeps the
   * earliest time seen.
   */
  const indexPath = (value, { kind = null, name = null, priority = 9, createdAt = null } = {}) => {
    const normalized = normalizePath(value);
    if (!normalized) return null;
    const key = pathKey(normalized);
    let id = idByKey.get(key);
    const fromExtension = kindFromExtension(normalized);

    if (!id) {
      id = ids.mint('med');
      const external = isExternalPath(normalized);
      media[id] = {
        id,
        path: normalized,
        external,
        kind: fromExtension || kind || 'image',
        name: basename(normalized.split(/[?#]/)[0]) || normalized,
        createdAt: null,
        hash: null,
        bytes: null,
        width: null,
        height: null,
        durationSec: null,
        origin: unknownOrigin(),
        reference: null,
        tags: [],
        notes: '',
        rating: null,
        favorite: false,
        archived: false
      };
      idByKey.set(key, id);
      spellings.set(id, new Set());
      namePriority.set(id, 9);
      kindSource.set(id, fromExtension ? 'extension' : kind ? 'location' : 'default');
      if (external) report.media.external.ids.push(id);
    } else if (!fromExtension && kind && kindSource.get(id) === 'default') {
      media[id].kind = kind;
      kindSource.set(id, 'location');
    }

    spellings.get(id).add(String(value).trim());
    if (typeof name === 'string' && name.trim() && priority < namePriority.get(id)) {
      media[id].name = name.trim();
      namePriority.set(id, priority);
    }
    if (isIso(createdAt) && (!media[id].createdAt || createdAt < media[id].createdAt)) {
      media[id].createdAt = createdAt;
    }
    return id;
  };

  /** Set an origin only where nothing better is known yet. */
  const setOrigin = (mediaId, origin) => {
    if (!mediaId || media[mediaId].origin.type !== 'unknown') return false;
    media[mediaId].origin = { ...unknownOrigin(), ...origin };
    return true;
  };

  const walkGroup = (group, kind) => {
    if (!isObject(group)) return;
    list(group.outputs).forEach(output => {
      indexPath(output?.path, { kind, name: output?.name, priority: 3, createdAt: output?.createdAt });
    });
    ['primaryImagePaths', 'excludedImagePaths', 'inputImagePaths'].forEach(field => {
      list(group[field]).forEach(path => indexPath(path, { kind: 'image' }));
    });
    indexPath(group.imageInput, { kind: 'image' });
    Object.values(isObject(group.meta?.assetStamps) ? group.meta.assetStamps : {}).forEach(stamp => {
      indexPath(stamp?.primaryImage, { kind: 'image' });
    });
  };

  scenes.forEach(scene => {
    indexPath(scene.sceneConcatenatedVideo, { kind: 'video' });
    scene.shots.forEach(shot => {
      list(shot.imagePrompts).forEach(group => walkGroup(group, 'image'));
      list(shot.videoPrompts).forEach(group => walkGroup(group, 'video'));
      indexPath(shot.selectedImage, { kind: 'image' });
      indexPath(shot.selectedVideo, { kind: 'video' });
      indexPath(shot.lipSyncAudio, { kind: 'audio' });
      list(shot.audioRefs).forEach(ref => indexPath(ref, { kind: 'audio' }));
      list(shot.videoRefs).forEach(ref => indexPath(ref, { kind: 'video' }));
    });
  });
  list(raw.imageGallery).forEach(entry => indexPath(entry?.path, { kind: 'image', name: entry?.name, priority: 2, createdAt: entry?.createdAt }));
  list(raw.videoGallery).forEach(entry => indexPath(entry?.path, { kind: 'video', name: entry?.name, priority: 2, createdAt: entry?.createdAt }));
  references.forEach(ref => indexPath(ref.path, { kind: 'image', name: ref.name, priority: 1, createdAt: ref.createdAt }));
  v1Assets.forEach(asset => {
    list(asset.images).forEach(path => indexPath(path, { kind: 'image' }));
    indexPath(asset.primaryImage, { kind: 'image' });
    list(asset.inputImages).forEach(path => indexPath(path, { kind: 'image' }));
  });
  v1Edit.bin.forEach(item => indexPath(item.path, { kind: item.type, name: item.name, priority: 4, createdAt: item.addedAt }));
  Object.keys(v1Edit.durations).forEach(path => indexPath(path));
  v1Edit.video.forEach(clip => {
    if (clip.source?.kind === 'asset') indexPath(clip.source.path, { kind: streamKind(clip.source.stream), name: clip.source.name, priority: 4 });
    if (typeof clip.boundTo === 'string') indexPath(clip.boundTo);
  });
  v1Edit.audio.forEach(track => track.clips.forEach(clip => {
    if (clip.source?.kind === 'asset') indexPath(clip.source.path, { kind: streamKind(clip.source.stream || 'audio'), name: clip.source.name, priority: 4 });
    if (typeof clip.boundTo === 'string') indexPath(clip.boundTo);
  }));
  indexPath(raw.watermarkImage, { kind: 'image' });
  indexPath(raw.concatenatedVideo, { kind: 'video' });

  // --- 4 + 5. takes from outputs, asset revisions from group meta ------------

  const takes = {};
  const takeOrder = new Map();       // takeId -> creation index, for stable "newest" ties
  const takesByShot = new Map();     // shotId -> [takeId]
  const generatedBy = new Map();     // mediaId -> [takeId], in creation order

  const addTake = (take) => {
    takes[take.id] = take;
    takeOrder.set(take.id, takeOrder.size);
    if (take.owner?.shotId) {
      if (!takesByShot.has(take.owner.shotId)) takesByShot.set(take.owner.shotId, []);
      takesByShot.get(take.owner.shotId).push(take.id);
    }
    return take;
  };
  const newestOf = (takeIds) => takeIds.reduce((best, id) => {
    if (!best) return id;
    const a = takes[id].createdAt || '';
    const b = takes[best].createdAt || '';
    if (a > b) return id;
    if (a === b && takeOrder.get(id) > takeOrder.get(best)) return id;
    return best;
  }, null);

  const liftRecipe = (group) => ({
    rawPrompt: group.rawPrompt ?? group.prompt ?? '',
    prompt: group.prompt ?? '',
    promptOverride: group.promptOverride ?? null,
    model: group.model || '',
    providerFamily: null,
    resolution: group.resolution || '',
    duration: group.duration ?? null,
    primaryInputs: list(group.primaryImagePaths).map(path => indexPath(path, { kind: 'image' })).filter(Boolean),
    excludedInputs: list(group.excludedImagePaths).map(path => indexPath(path, { kind: 'image' })).filter(Boolean),
    attachTaggedImages: group.attachTaggedImages !== false,
    usePrePrompt: group.usePrePrompt !== false,
    usePostPrompt: group.usePostPrompt !== false,
    extra: {}
  });

  const liftInputs = (group) => {
    const paths = Array.isArray(group.inputImagePaths)
      ? group.inputImagePaths
      : (group.imageInput ? [group.imageInput] : []);
    return paths
      .map(path => ({ path, mediaId: indexPath(path, { kind: 'image' }) }))
      .filter(entry => entry.mediaId)
      .map((entry, index) => ({
        role: 'image',
        slot: index + 1,
        mediaId: entry.mediaId,
        url: isExternalPath(entry.path) ? normalizePath(entry.path) : null,
        via: null
      }));
  };

  const liftRevisions = (meta) => {
    const revisions = {};
    Object.entries(isObject(meta.assetStamps) ? meta.assetStamps : {}).forEach(([assetId, stamp]) => {
      revisions[assetId] = {
        lookId: lookIdByAsset.get(assetId) ?? null,
        revision: 1,
        updatedAt: stamp?.updatedAt ?? null,
        primaryMediaId: indexPath(stamp?.primaryImage, { kind: 'image' })
      };
    });
    return revisions;
  };

  scenes.forEach(scene => scene.shots.forEach(shot => {
    const groups = [
      ...list(shot.imagePrompts).map(group => ({ group, kind: 'image' })),
      ...list(shot.videoPrompts).map(group => ({ group, kind: 'video' }))
    ];
    groups.forEach(({ group, kind }) => {
      if (!isObject(group)) return;
      const outputs = list(group.outputs).filter(isObject);
      if (outputs.length === 0) {
        report.groups.emptyDropped.ids.push(group.id ?? null);
        return;
      }
      const lipsync = typeof group.id === 'string' && group.id.startsWith('prompt_sync_');
      const purpose = lipsync ? 'lipsync' : (kind === 'image' ? 'shot-image' : 'shot-video');
      const groupKey = groupSignature(kind, group);
      const recipe = lipsync ? { prompt: group.prompt ?? '' } : liftRecipe(group);
      const inputs = lipsync ? [] : liftInputs(group);
      const inputsComplete = kind === 'image' && !lipsync && Array.isArray(group.inputImagePaths);

      const created = [];
      outputs.forEach(output => {
        const mediaId = indexPath(output.path, { kind, name: output.name, priority: 3, createdAt: output.createdAt });
        if (!mediaId) {
          report.skipped.outputsWithoutPath.push({ groupId: group.id ?? null, outputId: output.id ?? null });
          return;
        }
        const take = addTake({
          id: claimId('takes', output.id, 'take'),
          kind,
          purpose,
          owner: { shotId: shot.id },
          mediaId,
          createdAt: isIso(output.createdAt) ? output.createdAt : (isIso(group.meta?.createdAt) ? group.meta.createdAt : at),
          recipe,
          inputs,
          inputsComplete,
          assetRevisions: null,
          assetRevisionsConfidence: 'none',
          provider: nullProvider(),
          jobId: null,
          parentTakeId: null,
          groupKey,
          legacy: { groupId: group.id ?? null, outputId: output.id ?? null },
          annotations: { name: output.name || '', rating: null, rejected: false, favorite: false, notes: '' }
        });
        if (!generatedBy.has(mediaId)) generatedBy.set(mediaId, []);
        generatedBy.get(mediaId).push(take.id);
        created.push(take.id);
      });

      // 5. The group's meta was overwritten by every rerun, so only the newest
      // output can claim it exactly.
      if (isObject(group.meta) && created.length > 0) {
        const newest = newestOf(created);
        created.forEach(takeId => {
          takes[takeId].assetRevisions = liftRevisions(group.meta);
          takes[takeId].assetRevisionsConfidence = takeId === newest ? 'exact' : 'group-latest';
        });
      }
    });
  }));

  // The output's media is generated by its take; where two outputs name one
  // path the earliest take is the origin and the report lists the rest.
  generatedBy.forEach((takeIds, mediaId) => {
    const ordered = [...takeIds].sort((a, b) => (
      (takes[a].createdAt || '').localeCompare(takes[b].createdAt || '') || takeOrder.get(a) - takeOrder.get(b)
    ));
    setOrigin(mediaId, { type: 'generated', takeId: ordered[0] });
    if (ordered.length > 1) {
      report.takes.outputsSharingMedia.push({ mediaId, originTakeId: ordered[0], otherTakeIds: ordered.slice(1) });
    }
  });

  // --- 6. selections --------------------------------------------------------

  const selectionFor = (shot, kind, path) => {
    const mediaId = indexPath(path, { kind });
    if (!mediaId) return null;
    const owned = (takesByShot.get(shot.id) || []).filter(id => takes[id].kind === kind && takes[id].mediaId === mediaId);
    if (owned.length > 0) return newestOf(owned);
    const take = addTake({
      id: ids.mint('take'),
      kind,
      purpose: 'imported',
      owner: { shotId: shot.id },
      mediaId,
      createdAt: media[mediaId].createdAt || at,
      recipe: null,
      inputs: [],
      inputsComplete: true,
      assetRevisions: null,
      assetRevisionsConfidence: 'none',
      provider: nullProvider(),
      jobId: null,
      parentTakeId: null,
      groupKey: '',
      legacy: null,
      annotations: { name: media[mediaId].name || '', rating: null, rejected: false, favorite: false, notes: '' }
    });
    report.takes.importedForSelections.ids.push(take.id);
    return take.id;
  };

  const selections = new Map(); // shotId -> { selection, selectionLog }
  scenes.forEach(scene => scene.shots.forEach(shot => {
    const selection = {
      image: selectionFor(shot, 'image', shot.selectedImage),
      video: selectionFor(shot, 'video', shot.selectedVideo)
    };
    const selectionLog = [];
    if (selection.image) selectionLog.push({ kind: 'image', takeId: selection.image, at });
    if (selection.video) selectionLog.push({ kind: 'video', takeId: selection.video, at });
    selections.set(shot.id, { selection, selectionLog });
  }));

  // --- 7. looks ---------------------------------------------------------------

  const assetLibrary = v1Assets.map(asset => {
    const lookId = lookIdByAsset.get(asset.id);
    const primaryKey = pathKey(asset.primaryImage);
    const ticked = new Set(assetInputImages(asset).map(pathKey));
    const images = list(asset.images).filter(path => typeof path === 'string' && path.trim());
    const ordered = (primaryKey && !images.some(path => pathKey(path) === primaryKey))
      ? [asset.primaryImage, ...images]
      : images;
    const seen = new Set();
    const lookImages = [];
    ordered.forEach(path => {
      const key = pathKey(path);
      if (!key || seen.has(key)) return;
      seen.add(key);
      const mediaId = indexPath(path, { kind: 'image' });
      lookImages.push({ mediaId, primary: key === primaryKey, enabled: ticked.has(key), view: null });
    });

    const look = {
      id: lookId,
      name: 'Default',
      shotDescription: typeof asset.shotDescription === 'string' ? asset.shotDescription : '',
      prompt: typeof asset.imagePrompt === 'string' ? asset.imagePrompt : '',
      images: lookImages,
      revision: 1,
      updatedAt: asset.updatedAt || null
    };

    const rest = { ...asset };
    ASSET_KEYS_REMOVED.forEach(key => { delete rest[key]; });
    return {
      ...rest,
      notes: typeof asset.notes === 'string' ? asset.notes : '',
      defaultLookId: lookId,
      looks: [look]
    };
  });
  const lookById = new Map(assetLibrary.flatMap(asset => asset.looks.map(look => [look.id, look])));

  // --- 8. board and bindings ----------------------------------------------------

  const mediaByRef = new Map();
  references.forEach(ref => {
    const mediaId = indexPath(ref.path, { kind: 'image', name: ref.name, priority: 1, createdAt: ref.createdAt });
    if (!mediaId) {
      report.skipped.referencesWithoutPath.push(ref.id);
      return;
    }
    mediaByRef.set(ref.id, mediaId);
    if (media[mediaId].reference) {
      report.skipped.duplicateReferences.push(ref.id);
      return;
    }
    media[mediaId].reference = { category: ref.kind, tags: [...ref.tags], notes: ref.notes };
    // `source` is the one piece of history a v1 reference record kept: an
    // upload came from outside; 'generated' is asset artwork that registered
    // itself on the board (the same fact the `img_asset_` gallery id records).
    if (ref.source === 'upload') setOrigin(mediaId, { type: 'imported' });
    if (ref.source === 'generated') setOrigin(mediaId, { type: 'generated', takeId: null, note: 'asset artwork; v1 recorded no recipe' });
  });

  const bindings = [];
  const addBinding = (binding) => {
    bindings.push(binding);
    report.bindings.byScope[binding.scope] += 1;
    return binding;
  };
  const dangling = (edge, reason) => {
    report.bindings.danglingSkipped.ids.push(edge.id);
    report.bindings.danglingSkipped.reasons[reason] += 1;
  };

  assignments.forEach(edge => {
    const mediaId = mediaByRef.get(edge.refId);
    if (!mediaId) return dangling(edge, 'reference');
    const targetExists = edge.scope === 'project'
      || (edge.scope === 'scene' && sceneIds.has(edge.targetId))
      || (edge.scope === 'shot' && shotIds.has(edge.targetId));
    if (!targetExists) return dangling(edge, 'target');
    return addBinding({
      id: claimId('bindings', edge.id, 'bind'),
      mediaId,
      scope: edge.scope,
      targetId: edge.scope === 'project' ? null : edge.targetId,
      role: edge.role,
      enabled: edge.enabled !== false,
      order: Number.isFinite(edge.order) ? edge.order : 0,
      operations: null
    });
  });

  references.forEach(ref => {
    if (!ref.assetId) return;
    const mediaId = mediaByRef.get(ref.id);
    if (!mediaId) return;
    const lookId = lookIdByAsset.get(ref.assetId);
    const look = lookId ? lookById.get(lookId) : null;
    if (!look) {
      report.bindings.danglingSkipped.ids.push(ref.id);
      report.bindings.danglingSkipped.reasons.asset += 1;
      return;
    }
    if (look.images.some(image => image.mediaId === mediaId)) return;
    const existing = bindings.filter(binding => binding.scope === 'asset-look' && binding.targetId === lookId);
    if (existing.some(binding => binding.mediaId === mediaId)) return;
    addBinding({
      id: claimId('bindings', null, 'bind'),
      mediaId,
      scope: 'asset-look',
      targetId: lookId,
      role: 'subject',
      enabled: true,
      order: existing.length ? Math.max(...existing.map(binding => binding.order)) + 1 : 0,
      operations: null
    });
  });

  // --- 9. gallery leftovers -----------------------------------------------------

  const mediaNamed = (name) => Object.values(media).filter(record => record.name === name);
  const classifyGalleryEntry = (entry, kind) => {
    if (!isObject(entry)) return;
    const mediaId = indexPath(entry.path, { kind, name: entry.name, priority: 2, createdAt: entry.createdAt });
    if (!mediaId) return;
    const record = media[mediaId];
    const id = typeof entry.id === 'string' ? entry.id : '';
    const prompt = typeof entry.prompt === 'string' ? entry.prompt : '';

    if (record.origin.type === 'unknown') {
      if (id.startsWith('img_asset_')) {
        setOrigin(mediaId, { type: 'generated', takeId: null, note: 'asset artwork; v1 recorded no recipe' });
      } else if (id.startsWith('img_dream_')) {
        setOrigin(mediaId, { type: 'captured', sourceMediaId: null });
      } else if (prompt.startsWith('Crop of ')) {
        const sourceName = prompt.slice('Crop of '.length).trim();
        const sources = mediaNamed(sourceName).filter(source => source.id !== mediaId);
        setOrigin(mediaId, sources.length === 1
          ? { type: 'derived', sourceMediaId: sources[0].id }
          : { type: 'derived', sourceMediaId: null, note: prompt });
      }
    }
    // The prompt text is kept where no take carries it.
    if (prompt && !record.origin.takeId && !record.notes) record.notes = prompt;
  };
  list(raw.imageGallery).forEach(entry => classifyGalleryEntry(entry, 'image'));
  list(raw.videoGallery).forEach(entry => classifyGalleryEntry(entry, 'video'));

  // --- 10. edit -----------------------------------------------------------------

  const mapSource = (source, defaultStream) => {
    if (!isObject(source)) return source ?? null;
    if (source.kind !== 'asset') return source;
    const stream = source.stream || defaultStream;
    return {
      kind: 'media',
      mediaId: indexPath(source.path, { kind: streamKind(stream), name: source.name, priority: 4 }),
      stream
    };
  };
  const mapBoundTo = (value) => {
    if (typeof value === 'string') {
      const mediaId = indexPath(value);
      return mediaId ? { mediaId } : null;
    }
    return isObject(value) ? value : null;
  };

  const edit = {
    version: 2,
    settings: v1Edit.settings,
    smart: v1Edit.smart,
    video: v1Edit.video.map(clip => ({
      ...clip,
      id: claimId('edit', clip.id, 'vc'),
      source: mapSource(clip.source, 'video'),
      boundTo: mapBoundTo(clip.boundTo)
    })),
    audio: v1Edit.audio.map(track => ({
      ...track,
      clips: track.clips.map(clip => ({
        ...clip,
        id: claimId('edit', clip.id, 'ac'),
        source: mapSource(clip.source, 'audio'),
        boundTo: mapBoundTo(clip.boundTo)
      }))
    })),
    bin: v1Edit.bin.map(item => ({
      id: claimId('edit', item.id, 'bin'),
      mediaId: indexPath(item.path, { kind: item.type, name: item.name, priority: 4, createdAt: item.addedAt }),
      addedAt: item.addedAt
    })),
    durations: {}
  };
  Object.entries(v1Edit.durations).forEach(([path, value]) => {
    const mediaId = indexPath(path);
    if (mediaId && !(mediaId in edit.durations)) edit.durations[mediaId] = value;
  });
  edit.bin.forEach(item => setOrigin(item.mediaId, { type: 'imported' }));

  // --- 11. jobs and runs ------------------------------------------------------

  const jobs = {};
  batchJobs.filter(isObject).forEach(job => {
    const id = claimId('jobs', job.id, 'job');
    const kind = JOB_KIND_BY_V1_TYPE[job.type] || 'render';
    const outputKind = kind === 'image' ? 'image' : (['video', 'lipsync', 'concat', 'render'].includes(kind) ? 'video' : null);
    const resultMediaId = indexPath(job.outputPath, { kind: outputKind });
    if (resultMediaId && ['concat', 'render', 'export'].includes(kind)) setOrigin(resultMediaId, { type: 'render' });
    const resultTakeId = resultMediaId ? (media[resultMediaId].origin.takeId || null) : null;
    if (resultTakeId && takes[resultTakeId].jobId === null) takes[resultTakeId].jobId = id;

    jobs[id] = {
      id,
      kind,
      status: JOB_STATUSES.includes(job.status) ? job.status : 'uncertain',
      target: job.shotId
        ? { shotId: job.shotId }
        : (job.assetId ? { assetId: job.assetId, lookId: lookIdByAsset.get(job.assetId) ?? null } : null),
      runId: null,
      request: { model: job.model ?? null, providerFamily: null, prompt: typeof job.prompt === 'string' ? job.prompt : '', inputs: [], settings: {} },
      provider: null,
      submittedAt: isIso(job.createdAt) ? job.createdAt : null,
      startedAt: null,
      finishedAt: null,
      error: job.error ? { class: 'unknown', message: String(job.error) } : null,
      resultTakeId,
      resultMediaId,
      cost: { estimated: null, reported: null, currency: null },
      legacy: { type: job.type ?? null, shotName: job.shotName ?? null, taggedAssets: list(job.taggedAssets) }
    };
  });

  const runs = [];
  if (isObject(raw.pipelineRun)) {
    const run = raw.pipelineRun;
    runs.push({
      id: claimId('runs', run.id, 'run'),
      kind: 'pipeline',
      status: run.status ?? null,
      startedAt: run.startedAt ?? null,
      finishedAt: run.finishedAt ?? null,
      options: isObject(run.options) ? run.options : {},
      stageStates: isObject(run.stageStates) ? run.stageStates : {},
      jobIds: []
    });
  }

  // --- 12. render outputs -------------------------------------------------------

  const concatenatedVideo = indexPath(raw.concatenatedVideo, { kind: 'video' });
  setOrigin(concatenatedVideo, { type: 'render' });
  const watermarkMediaId = indexPath(raw.watermarkImage, { kind: 'image' });
  setOrigin(watermarkMediaId, { type: 'imported' });

  // --- 13. shot and project cleanup ----------------------------------------------

  // Lip-sync audio and the audio/video reference slots are filled by upload or
  // by a URL the user typed, so their history is known: brought in from outside.
  const uploadedRef = (value, kind) => {
    const mediaId = indexPath(value, { kind });
    setOrigin(mediaId, { type: 'imported' });
    return mediaId;
  };

  const v2Scenes = scenes.map(scene => {
    const sceneConcatenatedVideo = indexPath(scene.sceneConcatenatedVideo, { kind: 'video' });
    setOrigin(sceneConcatenatedVideo, { type: 'render' });
    return {
      ...scene,
      sceneConcatenatedVideo,
      shots: scene.shots.map(shot => {
        const rest = { ...shot };
        SHOT_KEYS_REMOVED.forEach(key => { delete rest[key]; });
        const { selection, selectionLog } = selections.get(shot.id);
        return {
          ...rest,
          selection,
          selectionLog,
          lipSyncAudio: uploadedRef(shot.lipSyncAudio, 'audio'),
          audioRefs: list(shot.audioRefs).map(ref => uploadedRef(ref, 'audio')).filter(Boolean),
          videoRefs: list(shot.videoRefs).map(ref => uploadedRef(ref, 'video')).filter(Boolean),
          assetLooks: {}
        };
      })
    };
  });

  const carried = { ...raw };
  PROJECT_KEYS_REMOVED.forEach(key => { delete carried[key]; });

  Object.values(media).forEach(record => {
    if (!record.createdAt) record.createdAt = at;
  });

  // --- 15. stamp and validate ------------------------------------------------------

  const state = {
    ...carried,
    schemaVersion: SCHEMA_VERSION,
    migratedFrom: { schemaVersion: 1, at },
    scenes: v2Scenes,
    assetLibrary,
    media,
    takes,
    bindings,
    jobs,
    runs,
    edit,
    promptSettings,
    concatenatedVideo
  };

  // --- the report ---------------------------------------------------------------

  spellings.forEach((seen, mediaId) => {
    if (seen.size > 1) report.media.merged.push({ mediaId, path: media[mediaId].path, variants: [...seen] });
  });
  report.media.created = Object.keys(media).length;
  report.media.unknownOrigin.ids = Object.values(media).filter(record => record.origin.type === 'unknown').map(record => record.id);
  report.takes.created = Object.keys(takes).length;
  Object.values(takes).forEach(take => {
    report.takes.byPurpose[take.purpose] += 1;
    report.takes.byConfidence[take.assetRevisionsConfidence] += 1;
    if (!take.inputsComplete) report.takes.inputsIncomplete.ids.push(take.id);
  });
  report.bindings.created = bindings.length;
  for (const bucket of [
    report.media.external, report.media.unknownOrigin, report.takes.importedForSelections,
    report.takes.inputsIncomplete, report.groups.emptyDropped, report.bindings.danglingSkipped
  ]) {
    bucket.count = bucket.ids.length;
  }
  report.problems = validateProject(state);

  return { state, report };
}
