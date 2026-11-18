// The v2 document's invariants (SCHEMA_V2.md §4.9), as a list of problems.
//
// Pure and total: it never throws on a malformed document, it reports. The
// test suite runs it over every fixture and every migrated project, and the
// app runs it after migration and after each undo step in development. An
// empty list is the only acceptable answer from the migration.
//
// Each problem is `{ code, message, at }`: a stable code for tests and
// filtering, a sentence for people, and where in the document it was found.

import { isExternalPath, pathKey } from './paths.js';

export const SCHEMA_VERSION = 2;

const MEDIA_KINDS = ['image', 'video', 'audio'];
const ORIGIN_TYPES = ['generated', 'imported', 'captured', 'derived', 'render', 'unknown'];
const TAKE_PURPOSES = ['shot-image', 'shot-video', 'lipsync', 'continuation', 'imported'];
const CONFIDENCES = ['exact', 'group-latest', 'none'];
const BINDING_SCOPES = ['project', 'scene', 'shot', 'asset-look'];
const BINDING_ROLES = ['style', 'subject', 'composition'];
const JOB_KINDS = ['image', 'video', 'lipsync', 'llm', 'render', 'concat', 'export'];
const JOB_STATUSES = ['queued', 'running', 'waiting-provider', 'completed', 'failed', 'cancelled', 'uncertain'];

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/** Every invariant violation in `state`, or [] when it is a sound v2 document. */
export function validateProject(state) {
  const problems = [];
  const problem = (code, message, at = null) => { problems.push({ code, message, at }); };

  if (!isObject(state)) {
    problem('not-a-document', 'the project is not an object');
    return problems;
  }
  if (Number(state.schemaVersion) !== SCHEMA_VERSION) {
    problem('schema-version', `schemaVersion is ${state.schemaVersion}, expected ${SCHEMA_VERSION}`, 'schemaVersion');
  }

  const media = isObject(state.media) ? state.media : {};
  const takes = isObject(state.takes) ? state.takes : {};
  const jobs = isObject(state.jobs) ? state.jobs : {};
  const scenes = Array.isArray(state.scenes) ? state.scenes : [];
  const assets = Array.isArray(state.assetLibrary) ? state.assetLibrary : [];
  const bindings = Array.isArray(state.bindings) ? state.bindings : [];
  const runs = Array.isArray(state.runs) ? state.runs : [];
  const edit = isObject(state.edit) ? state.edit : {};

  for (const [name, value] of [['media', state.media], ['takes', state.takes], ['jobs', state.jobs]]) {
    if (!isObject(value)) problem('missing-collection', `${name} is not a map`, name);
  }
  for (const [name, value] of [['scenes', state.scenes], ['assetLibrary', state.assetLibrary], ['bindings', state.bindings], ['runs', state.runs]]) {
    if (!Array.isArray(value)) problem('missing-collection', `${name} is not a list`, name);
  }

  // --- 9. ids: maps key by id, lists carry unique ids ------------------------

  for (const [name, map] of [['media', media], ['takes', takes], ['jobs', jobs]]) {
    for (const [key, record] of Object.entries(map)) {
      if (!isObject(record)) {
        problem('bad-record', `${name}.${key} is not a record`, `${name}.${key}`);
      } else if (record.id !== key) {
        problem('id-mismatch', `${name}.${key} carries id ${record.id}`, `${name}.${key}`);
      }
    }
  }

  const uniqueIds = (name, records, at = name) => {
    const seen = new Set();
    records.forEach((record, index) => {
      const id = record?.id;
      if (typeof id !== 'string' || !id) {
        problem('missing-id', `${name}[${index}] has no id`, `${at}[${index}]`);
        return;
      }
      if (seen.has(id)) problem('duplicate-id', `${name} holds id ${id} twice`, `${at}.${id}`);
      seen.add(id);
    });
  };

  uniqueIds('scenes', scenes);
  uniqueIds('assetLibrary', assets);
  uniqueIds('bindings', bindings);
  uniqueIds('runs', runs);

  const shots = [];
  const shotIds = new Set();
  const sceneIds = new Set(scenes.map(scene => scene?.id));
  scenes.forEach(scene => (Array.isArray(scene?.shots) ? scene.shots : []).forEach(shot => {
    if (shot?.id && shotIds.has(shot.id)) problem('duplicate-id', `shots hold id ${shot.id} twice`, `shots.${shot.id}`);
    if (shot?.id) shotIds.add(shot.id);
    shots.push({ shot, scene });
  }));

  const looks = new Map();          // lookId -> assetId
  assets.forEach(asset => {
    (Array.isArray(asset?.looks) ? asset.looks : []).forEach(look => {
      if (!look?.id) {
        problem('missing-id', `a look of asset ${asset?.id} has no id`, `assetLibrary.${asset?.id}.looks`);
        return;
      }
      if (looks.has(look.id)) problem('duplicate-id', `looks hold id ${look.id} twice`, `looks.${look.id}`);
      looks.set(look.id, asset.id);
    });
  });

  // --- reference checks shared below ----------------------------------------

  const hasMedia = (id) => typeof id === 'string' && own(media, id) && isObject(media[id]);
  const hasTake = (id) => typeof id === 'string' && own(takes, id) && isObject(takes[id]);

  const mediaRef = (id, at, { required = false } = {}) => {
    if (id === null || id === undefined) {
      if (required) problem('missing-media', `${at} has no media id`, at);
      return false;
    }
    if (!hasMedia(id)) {
      problem('missing-media', `${at} points at media ${id}, which does not exist`, at);
      return false;
    }
    return true;
  };
  const takeRef = (id, at, { required = false } = {}) => {
    if (id === null || id === undefined) {
      if (required) problem('missing-take', `${at} has no take id`, at);
      return false;
    }
    if (!hasTake(id)) {
      problem('missing-take', `${at} points at take ${id}, which does not exist`, at);
      return false;
    }
    return true;
  };

  // --- 1, 3, 4. media ---------------------------------------------------------

  const byPath = new Map();
  const byHash = new Map();
  for (const [id, record] of Object.entries(media)) {
    if (!isObject(record)) continue;
    const at = `media.${id}`;
    if (typeof record.path !== 'string' || !record.path) problem('bad-media', `${at} has no path`, at);
    if (!MEDIA_KINDS.includes(record.kind)) problem('bad-media', `${at} has kind ${record.kind}`, at);
    if (typeof record.path === 'string' && record.path) {
      const key = pathKey(record.path);
      if (byPath.has(key)) {
        problem('duplicate-path', `${at} and ${byPath.get(key)} both hold ${record.path}`, at);
      } else {
        byPath.set(key, at);
      }
      if (Boolean(record.external) !== isExternalPath(record.path)) {
        problem('bad-media', `${at} external flag does not match its path`, at);
      }
    }
    if (typeof record.hash === 'string' && record.hash) {
      if (byHash.has(record.hash)) problem('duplicate-hash', `${at} shares hash ${record.hash} with ${byHash.get(record.hash)}`, at);
      else byHash.set(record.hash, at);
    }
    const origin = record.origin;
    if (!isObject(origin) || !ORIGIN_TYPES.includes(origin.type)) {
      problem('bad-origin', `${at} has no usable origin`, `${at}.origin`);
      continue;
    }
    if (takeRef(origin.takeId, `${at}.origin.takeId`)) {
      if (origin.type === 'generated' && takes[origin.takeId].mediaId !== id) {
        problem('origin-mismatch', `${at} says take ${origin.takeId} generated it, but that take's media is ${takes[origin.takeId].mediaId}`, `${at}.origin.takeId`);
      }
    }
    mediaRef(origin.sourceMediaId, `${at}.origin.sourceMediaId`);
    if (record.reference !== null && record.reference !== undefined && !isObject(record.reference)) {
      problem('bad-media', `${at}.reference is neither null nor an object`, `${at}.reference`);
    }
  }

  // --- 2, 4. takes ------------------------------------------------------------

  for (const [id, take] of Object.entries(takes)) {
    if (!isObject(take)) continue;
    const at = `takes.${id}`;
    if (!MEDIA_KINDS.includes(take.kind)) problem('bad-take', `${at} has kind ${take.kind}`, at);
    if (!TAKE_PURPOSES.includes(take.purpose)) problem('bad-take', `${at} has purpose ${take.purpose}`, at);
    if (mediaRef(take.mediaId, `${at}.mediaId`, { required: true })) {
      const kind = media[take.mediaId].kind;
      if (kind !== take.kind) problem('kind-mismatch', `${at} is a ${take.kind} take over ${kind} media ${take.mediaId}`, `${at}.mediaId`);
    }
    if (take.owner !== null && take.owner !== undefined) {
      if (!isObject(take.owner) || !shotIds.has(take.owner.shotId)) {
        problem('missing-shot', `${at} is owned by shot ${take.owner?.shotId}, which does not exist`, `${at}.owner`);
      }
    }
    if (take.recipe !== null && take.recipe !== undefined) {
      if (!isObject(take.recipe)) {
        problem('bad-take', `${at}.recipe is neither null nor an object`, `${at}.recipe`);
      } else {
        (Array.isArray(take.recipe.primaryInputs) ? take.recipe.primaryInputs : [])
          .forEach((mediaId, index) => mediaRef(mediaId, `${at}.recipe.primaryInputs[${index}]`, { required: true }));
        (Array.isArray(take.recipe.excludedInputs) ? take.recipe.excludedInputs : [])
          .forEach((mediaId, index) => mediaRef(mediaId, `${at}.recipe.excludedInputs[${index}]`, { required: true }));
      }
    }
    (Array.isArray(take.inputs) ? take.inputs : []).forEach((input, index) => {
      if (!isObject(input)) {
        problem('bad-take', `${at}.inputs[${index}] is not an input`, `${at}.inputs[${index}]`);
        return;
      }
      mediaRef(input.mediaId, `${at}.inputs[${index}].mediaId`);
    });
    if (take.assetRevisions !== null && take.assetRevisions !== undefined) {
      if (!isObject(take.assetRevisions)) {
        problem('bad-take', `${at}.assetRevisions is neither null nor an object`, `${at}.assetRevisions`);
      } else {
        for (const [assetId, stamp] of Object.entries(take.assetRevisions)) {
          const where = `${at}.assetRevisions.${assetId}`;
          if (!isObject(stamp)) { problem('bad-take', `${where} is not a stamp`, where); continue; }
          mediaRef(stamp.primaryMediaId, `${where}.primaryMediaId`);
          if (stamp.lookId !== null && stamp.lookId !== undefined && !looks.has(stamp.lookId)) {
            problem('missing-look', `${where} names look ${stamp.lookId}, which does not exist`, `${where}.lookId`);
          }
        }
      }
    }
    if (!CONFIDENCES.includes(take.assetRevisionsConfidence)) {
      problem('bad-take', `${at} has assetRevisionsConfidence ${take.assetRevisionsConfidence}`, at);
    }
    takeRef(take.parentTakeId, `${at}.parentTakeId`);
    if (typeof take.groupKey !== 'string') problem('bad-take', `${at} has no groupKey`, `${at}.groupKey`);
    if (!isObject(take.annotations)) problem('bad-take', `${at} has no annotations`, `${at}.annotations`);
  }

  // --- 5. shots and selections ------------------------------------------------

  const assetById = new Map(assets.map(asset => [asset?.id, asset]));
  for (const { shot, scene } of shots) {
    if (!isObject(shot)) continue;
    const at = `shots.${shot.id}`;
    const selection = isObject(shot.selection) ? shot.selection : null;
    if (!selection) {
      problem('bad-shot', `${at} has no selection`, `${at}.selection`);
    } else {
      for (const kind of ['image', 'video']) {
        const takeId = selection[kind];
        if (takeId === null || takeId === undefined) continue;
        if (!takeRef(takeId, `${at}.selection.${kind}`)) continue;
        const take = takes[takeId];
        if (take.kind !== kind) problem('selection-kind', `${at} selects ${kind} take ${takeId}, which is a ${take.kind} take`, `${at}.selection.${kind}`);
        if (take.owner?.shotId !== shot.id) problem('selection-owner', `${at} selects take ${takeId}, which is owned by ${take.owner?.shotId ?? 'nobody'}`, `${at}.selection.${kind}`);
      }
    }
    (Array.isArray(shot.selectionLog) ? shot.selectionLog : []).forEach((entry, index) => {
      takeRef(entry?.takeId, `${at}.selectionLog[${index}]`, { required: true });
    });
    mediaRef(shot.lipSyncAudio, `${at}.lipSyncAudio`);
    for (const field of ['audioRefs', 'videoRefs']) {
      (Array.isArray(shot[field]) ? shot[field] : []).forEach((value, index) => {
        if (isExternalPath(value)) return;
        mediaRef(value, `${at}.${field}[${index}]`, { required: true });
      });
    }
    if (shot.assetLooks !== undefined && !isObject(shot.assetLooks)) {
      problem('bad-shot', `${at}.assetLooks is not an object`, `${at}.assetLooks`);
    } else {
      for (const [assetId, lookId] of Object.entries(shot.assetLooks || {})) {
        if (!assetById.has(assetId)) {
          problem('missing-asset', `${at}.assetLooks names asset ${assetId}, which does not exist`, `${at}.assetLooks.${assetId}`);
        } else if (looks.get(lookId) !== assetId) {
          problem('missing-look', `${at}.assetLooks binds ${assetId} to ${lookId}, which is not one of its looks`, `${at}.assetLooks.${assetId}`);
        }
      }
    }
    mediaRef(scene?.sceneConcatenatedVideo, `scenes.${scene?.id}.sceneConcatenatedVideo`);
  }
  mediaRef(state.concatenatedVideo, 'concatenatedVideo');

  // --- 6. assets and looks ----------------------------------------------------

  for (const asset of assets) {
    if (!isObject(asset)) continue;
    const at = `assetLibrary.${asset.id}`;
    const assetLooks = Array.isArray(asset.looks) ? asset.looks : [];
    if (!assetLooks.some(look => look?.id === asset.defaultLookId)) {
      problem('missing-look', `${at}.defaultLookId ${asset.defaultLookId} is not one of its looks`, `${at}.defaultLookId`);
    }
    for (const look of assetLooks) {
      if (!isObject(look)) continue;
      const where = `${at}.looks.${look.id}`;
      const images = Array.isArray(look.images) ? look.images : [];
      const primaries = images.filter(image => image?.primary === true);
      if (primaries.length > 1) problem('many-primaries', `${where} has ${primaries.length} primary images`, where);
      images.forEach((image, index) => {
        if (!isObject(image)) { problem('bad-look', `${where}.images[${index}] is not an image`, where); return; }
        mediaRef(image.mediaId, `${where}.images[${index}].mediaId`, { required: true });
      });
      if (!Number.isInteger(look.revision) || look.revision < 1) {
        problem('bad-look', `${where} has revision ${look.revision}`, `${where}.revision`);
      }
    }
  }

  // --- 7. bindings ------------------------------------------------------------

  bindings.forEach((binding, index) => {
    if (!isObject(binding)) { problem('bad-binding', `bindings[${index}] is not a binding`, `bindings[${index}]`); return; }
    const at = `bindings.${binding.id ?? index}`;
    mediaRef(binding.mediaId, `${at}.mediaId`, { required: true });
    if (!BINDING_SCOPES.includes(binding.scope)) {
      problem('bad-binding', `${at} has scope ${binding.scope}`, `${at}.scope`);
      return;
    }
    if (!BINDING_ROLES.includes(binding.role)) problem('bad-binding', `${at} has role ${binding.role}`, `${at}.role`);
    const target = binding.targetId;
    const exists = binding.scope === 'project' ? (target === null || target === undefined)
      : binding.scope === 'scene' ? sceneIds.has(target)
        : binding.scope === 'shot' ? shotIds.has(target)
          : looks.has(target);
    if (!exists) problem('missing-target', `${at} (${binding.scope}) targets ${target}, which does not exist`, `${at}.targetId`);
  });

  // --- jobs and runs ----------------------------------------------------------

  for (const [id, job] of Object.entries(jobs)) {
    if (!isObject(job)) continue;
    const at = `jobs.${id}`;
    if (!JOB_KINDS.includes(job.kind)) problem('bad-job', `${at} has kind ${job.kind}`, `${at}.kind`);
    if (!JOB_STATUSES.includes(job.status)) problem('bad-job', `${at} has status ${job.status}`, `${at}.status`);
    takeRef(job.resultTakeId, `${at}.resultTakeId`);
    mediaRef(job.resultMediaId, `${at}.resultMediaId`);
    if (isObject(job.cost)) {
      for (const field of ['estimated', 'reported']) {
        if (job.cost[field] === 0) problem('zero-cost', `${at}.cost.${field} is 0; unknown costs are null`, `${at}.cost.${field}`);
      }
    } else {
      problem('bad-job', `${at} has no cost record`, `${at}.cost`);
    }
  }

  // --- 8. edit ----------------------------------------------------------------

  if (Number(edit.version) !== 2) problem('edit-version', `edit.version is ${edit.version}, expected 2`, 'edit.version');

  const clipSource = (source, at) => {
    if (!isObject(source)) { problem('bad-clip-source', `${at} has no source`, at); return; }
    if (source.kind === 'take') takeRef(source.takeId, `${at}.takeId`, { required: true });
    else if (source.kind === 'media') mediaRef(source.mediaId, `${at}.mediaId`, { required: true });
    else if (source.kind === 'shot') {
      if (!shotIds.has(source.shotId)) problem('missing-shot', `${at} follows shot ${source.shotId}, which does not exist`, `${at}.shotId`);
    } else problem('bad-clip-source', `${at} has kind ${source.kind}`, at);
  };
  const boundTo = (value, at) => {
    if (value === null || value === undefined) return;
    if (!isObject(value)) { problem('bad-bound-to', `${at} is not { takeId } or { mediaId }`, at); return; }
    if (own(value, 'takeId')) takeRef(value.takeId, `${at}.takeId`, { required: true });
    else if (own(value, 'mediaId')) mediaRef(value.mediaId, `${at}.mediaId`, { required: true });
    else problem('bad-bound-to', `${at} names neither a take nor a media`, at);
  };

  const clipIds = new Set();
  const clipId = (clip, at) => {
    if (!clip?.id) { problem('missing-id', `${at} has no id`, at); return; }
    if (clipIds.has(clip.id)) problem('duplicate-id', `edit holds clip id ${clip.id} twice`, at);
    clipIds.add(clip.id);
  };

  (Array.isArray(edit.video) ? edit.video : []).forEach((clip, index) => {
    const at = `edit.video[${index}]`;
    clipId(clip, at);
    clipSource(clip?.source, `${at}.source`);
    boundTo(clip?.boundTo, `${at}.boundTo`);
  });
  (Array.isArray(edit.audio) ? edit.audio : []).forEach((track, trackIndex) => {
    (Array.isArray(track?.clips) ? track.clips : []).forEach((clip, index) => {
      const at = `edit.audio[${trackIndex}].clips[${index}]`;
      clipId(clip, at);
      clipSource(clip?.source, `${at}.source`);
      boundTo(clip?.boundTo, `${at}.boundTo`);
    });
  });
  (Array.isArray(edit.bin) ? edit.bin : []).forEach((item, index) => {
    const at = `edit.bin[${index}]`;
    clipId(item, at);
    mediaRef(item?.mediaId, `${at}.mediaId`, { required: true });
  });
  for (const key of Object.keys(isObject(edit.durations) ? edit.durations : {})) {
    mediaRef(key, `edit.durations.${key}`, { required: true });
  }

  return problems;
}

/** A one-line summary for logs and the migration report. */
export function describeProblems(problems = []) {
  if (problems.length === 0) return 'no problems';
  const counts = new Map();
  problems.forEach(p => counts.set(p.code, (counts.get(p.code) || 0) + 1));
  return [...counts].map(([code, n]) => `${code}×${n}`).join(', ');
}
