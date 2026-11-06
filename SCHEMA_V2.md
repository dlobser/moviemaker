# MovieMaker project schema v2 and migration plan

Drafted November 6, 2026. Companion to `REPLACEMENT_BRIEF.md` (the critique) and `PRODUCT_SPECIFICATION.md` (the target). This document is the first delivery step from both: change the data model before touching the interface, and keep every existing project loadable.

Everything below was checked against the working tree on the date above. Function names are given so the claims can be re-verified as the code moves.

## 1. What v1 cannot express

Four problems in the current document block most of the specification, and none of them can be fixed in the interface alone.

**A file has no identity.** The same generated image is written as an `outputs[]` entry on a prompt group, as an `imageGallery` entry, often as a `referenceImages` record, and as a bare path string in an asset's `images[]`. The path is the only join key. The server already needs a filename-fallback walk under `/assets` because paths recorded in checkpoints go stale when files are organized (`server.js`, the `app.use('/assets', …)` handler).

**A take has no recipe of its own.** The recipe (`rawPrompt`, `model`, `resolution`, `primaryImagePaths`, …) lives on the prompt group, and `group.meta` (the asset snapshot dirty-detection compares against) is overwritten by every rerun: "The latest output defines the group's currency" (`runAsyncImageJob`, `runAsyncVideoJob` in `App.jsx`). Earlier outputs in a group have lost the exact asset state they were generated with. Video groups also never record the audio and video references that were sent; only `inputImagePaths` is kept.

**A selection is a path, and the edit follows it.** `shot.selectedImage` and `shot.selectedVideo` are path strings. An edit clip is `{ kind: 'shot', shotId }` and resolves through the shot's current selection every time it is drawn (`resolveClipSource` in `edit/model.js`). There is no way to keep a take in the cut after the shot's selection changes, which the specification requires (§15, §20, acceptance item 9). Trims record `boundTo: <path>` so a changed selection can at least be flagged stale (`edit/timing.js`).

**An asset has one appearance.** An asset is `{ tag, type, name, description, shotDescription, images[], primaryImage, inputImages[], imagePrompt, … , updatedAt }`. There are no looks and no revisions; `updatedAt` is the only change marker, and it is a timestamp rather than a counter, so two edits in one second are indistinguishable.

Smaller issues the migration also has to handle: ids are `prefix_<Date.now()>` for scenes, shots, groups and outputs, so a batch can collide within one millisecond; provider request ids and seeds are known to the adapters (`fal.js` reads `request_id`) but the server returns only `{ filePath }`, so no take can record them today; captured frames in the gallery do not record which video they came from.

## 2. Scope

**In scope.** Media identity, takes, selections, asset looks and revisions, reference bindings, edit clip sources, jobs and runs. One pure migration function, idempotent, with a report.

**Unchanged on purpose.** Scene and shot text fields (`setup`, `description`, `dialogue`, `notes`, draft prompts), the flat project settings keys that `resolveModelSettings` already reads with provenance (`imageModel`, `assetTypeModels`, …), `promptSettings` and its slots, `promptSnippets`, `dreamSettings`, watermark settings, edit `settings` and timing math, the reference kinds, roles and scope precedence, and the folder layout under `assets/` that `shared/assetPaths.js` plans. The migration moves nothing on disk.

**Not this step.** Splitting `App.jsx`, the server-side in-flight job ledger, resolving prompt tags to asset ids instead of tag text (spec §12), prompting profiles, MCP. Each of those builds on these records and is listed in §6 in the order it should follow.

## 3. The v1 document, as the migration's input

The persisted blob is built by `buildStatePayload` and loaded by `applyLoadedState` in `App.jsx`. The server writes it to the active project file (`project_state.json` fallback); the static runtime writes `<folder>.mmproj.json`. Checkpoints wrap the same blob in `{ id, name, note, createdAt, summary, state }`.

| Key | Shape | Notes |
|---|---|---|
| `scenes[]` | `{ id, name, number, shots[], sceneConcatenatedVideo, imageModel?, … }` | Only `name` and `number` are read as scene text today. |
| `shots[]` | flat mirror of every shot | Derived; dropped in v2. |
| `shot` | `{ id, name, setup, description, dialogue, notes, selectedImage, selectedVideo, referenceImages[], lipSyncAudio, audioRefs[], videoRefs[], imagePrompts[], videoPrompts[], draftImagePrompt, draftVideoPrompt, imageModel?, … }` | `referenceImages` is the pre-v2 reference array, already cleared by `migrateReferenceState`. `audioRefs`/`videoRefs` hold `https://` or `asset://` strings or uploaded paths. |
| prompt group | `{ id, rawPrompt, model, resolution, duration, primaryImagePaths[], attachTaggedImages, excludedImagePaths[], usePrePrompt, usePostPrompt, promptOverride, prompt, inputImagePaths[], imageInput?, meta?, outputs[] }` | Keyed by `imagePromptSignature` / `videoPromptSignature`. `meta = { taggedAssetIds[], assetStamps{ assetId: { updatedAt, primaryImage } }, createdAt }`. Lip-sync groups are `{ id: 'prompt_sync_…', prompt, outputs }`. |
| output | `{ id, path, name, createdAt }` | The only per-output facts. |
| `imageGallery[]`, `videoGallery[]` | `{ id, path, prompt, name, createdAt }` | Newest first. Ids hint at origin: `img_asset_`, `img_dream_`, `img_`, `vid_`. |
| `referenceImages[]` | `{ id, path, name, kind, tags[], notes, assetId, source, createdAt }` | `normalizeReference` in `references.js`. |
| `refAssignments[]` | `{ id, refId, scope, targetId, role, enabled, order }` | `normalizeAssignment`; scopes `project`/`scene`/`shot`, roles `style`/`subject`/`composition`. |
| `assetLibrary[]` | `{ id, tag, type, name, description, shotDescription?, images[], primaryImage, inputImages[], useExistingAsReference?, imagePrompt, imageModel, imageResolution, applyGlobalPrompts, updatedAt }` | `images[]` and `inputImages[]` are path strings. |
| `edit` | `{ version: 1, settings, smart, video[], audio[], bin[], durations{ path: sec } }` | Clip `source` is `{ kind: 'shot', shotId, stream? }` or `{ kind: 'asset', path, name, stream }`; `boundTo` is a path. |
| `batchJobs[]` | `{ id, shotId, shotName, type, model, prompt, taggedAssets[], status, createdAt, error, outputPath? }` | Capped at 100 on save; `running` becomes `failed` on load. |
| `pipelineRun` | `{ id, status, startedAt, finishedAt, options, stageStates }` | Snapshot of `createPipelineRun` state. |
| settings | `activeLlm`, `llmModel`, `activeImageGenerator`, `imageModel`, `imageResolution`, `activeVideoGenerator`, `videoModel`, `videoResolution`, `videoDuration`, `batchConcurrency`, `attachTagsForImages`, `attachTagsForVideos`, `atlasSafetyChecker`, `customModelCaps`, `assetTypeModels`, `autoAttachRefs`, `promptSettings`, `promptSnippets`, `dreamSettings`, `watermarkImage`, `watermarkMotion`, `concatenatedVideo`, `activeSceneId`, `activeShotId`, plus the flat prompt mirrors (`prePrompt` … `videoSystemPrompt`) | Carried through unchanged. |

Existing migrations that already run on load and that v2 builds on: `migrateReferenceState` (shot arrays to edges, stamps `referenceSchemaVersion: 2`), `migrateEdit` (any shape to `EDIT_VERSION` 1), `migratePromptSettings` (flat prompt fields into the slot bag), and the scenes-from-flat-shots fallback at the top of `applyLoadedState`.

## 4. The v2 document

```
{
  schemaVersion: 2,
  migratedFrom: { schemaVersion: 1, at: ISO } | null,

  scenes:       [ Scene ],              // shots nested, as today
  assetLibrary: [ Asset ],              // with looks
  media:        { [mediaId]: Media },   // every file, once
  takes:        { [takeId]: Take },     // every candidate result, immutable recipe
  bindings:     [ Binding ],            // reference edges, now keyed by mediaId
  jobs:         { [jobId]: Job },
  runs:         [ Run ],                // newest first, capped
  edit:         Edit,                   // version 2

  // unchanged from v1 (see §2)
  promptSettings, promptSnippets, dreamSettings, watermarkImage, watermarkMotion,
  activeLlm, llmModel, activeImageGenerator, imageModel, imageResolution,
  activeVideoGenerator, videoModel, videoResolution, videoDuration,
  batchConcurrency, attachTagsForImages, attachTagsForVideos, atlasSafetyChecker,
  customModelCaps, assetTypeModels, autoAttachRefs,
  concatenatedVideo,                    // now a mediaId
  activeSceneId, activeShotId,
  prePrompt, postPrompt, videoPrePrompt, videoPostPrompt, imageSystemPrompt, videoSystemPrompt
}
```

Removed: `shots` (derived), `imageGallery`, `videoGallery`, `referenceImages`, `refAssignments`, `referenceSchemaVersion`, `batchJobs`, `pipelineRun`, and on each shot `selectedImage`, `selectedVideo`, `imagePrompts`, `videoPrompts`, `referenceImages`.

`media`, `takes` and `jobs` are maps rather than arrays because every access is by id and they have no inherent order; the gallery sorts by `createdAt`. `bindings` stays an array because `order` within a target matters. Whole-state undo (`history.js`) is unaffected: it snapshots object graphs, and maps share unchanged entries exactly as arrays do.

### 4.1 Media

One record per file. The path is an attribute, not the identity, so organizing or relinking changes one field.

```
Media {
  id:        'med_<t36>_<r>',
  path:      'assets/…',                    // relative to the project folder; '/' separators
  external:  false,                         // true for https:// and asset:// references that never lived in assets/
  kind:      'image' | 'video' | 'audio',
  name:      string,                        // editable display name
  createdAt: ISO,                           // earliest time the file is known to have existed
  hash:      'sha256:…' | null,             // null until the server probes it; stays null in static mode
  bytes, width, height, durationSec: number | null,   // probed lazily; null means not yet known
  origin: {
    type:          'generated' | 'imported' | 'captured' | 'derived' | 'render' | 'unknown',
    takeId:        string | null,           // generated: the take that produced it
    sourceMediaId: string | null,           // captured/derived: what it came from
    atSec:         number | null,           // captured: timestamp in the source
    note:          string | null            // migration or UI note, e.g. 'asset artwork; v1 recorded no recipe'
  },
  reference: null | {                       // non-null = on the reference board
    category: 'character' | 'style' | 'scenery' | 'prop' | 'wardrobe' | 'lighting' | 'other',
    tags:     string[],
    notes:    string
  },
  tags:     string[],                       // gallery-wide free tags
  notes:    string,
  rating:   0..5 | null,
  favorite: boolean,
  archived: boolean
}
```

Runtime facts that are not stored: whether the file is currently missing on disk, and proxy/cache status. Those live in memory beside the document, as the probe results do today.

### 4.2 Takes

A take is one candidate result. Its `recipe`, `inputs`, `assetRevisions` and `provider` fields are written once and never edited; a changed recipe is a new take. `annotations` is the only mutable part.

```
Take {
  id:        'take_<t36>_<r>',
  kind:      'image' | 'video' | 'audio',
  purpose:   'shot-image' | 'shot-video' | 'lipsync' | 'continuation' | 'imported',
  owner:     { shotId } | null,             // null only for takes not attached to a shot
  mediaId:   string,
  createdAt: ISO,

  recipe: null | {                          // null for purpose 'imported'
    rawPrompt, prompt, promptOverride,      // what the user wrote; what was sent; any manual override
    model, providerFamily, resolution, duration,
    primaryInputs:   mediaId[],             // v1 primaryImagePaths
    excludedInputs:  mediaId[],             // v1 excludedImagePaths
    attachTaggedImages, usePrePrompt, usePostPrompt,
    extra: {}                               // endpoint-specific settings (safety checker, …)
  },
  inputs: [ { role: 'image' | 'audio' | 'video', slot: 1.., mediaId: string | null, url: string | null,
              via: 'tag' | 'board' | 'explicit' | 'frame' | 'selection' | null } ],
  inputsComplete: boolean,                  // false when the record is known to be partial (see §5.2)

  assetRevisions: null | { [assetId]: { lookId, revision, updatedAt, primaryMediaId } },
  assetRevisionsConfidence: 'exact' | 'group-latest' | 'none',

  provider: { requestId: null, seed: null, modelVersion: null, endpoint: null },   // null = unknown
  jobId:        string | null,
  parentTakeId: string | null,              // lipsync: the synced video; continuation: the previous clip
  groupKey:     string,                     // the v1 signature; the shot gallery groups by it
  legacy:       { groupId, outputId } | null,

  annotations: { name: string, rating: 0..5 | null, rejected: boolean, favorite: boolean, notes: string }
}
```

The shot gallery keeps its prompt groups: they become a view, `takes grouped by groupKey, ordered by first createdAt`, computed by a selector rather than stored. `groupKey` is produced by the same signature functions as today, moved out of `App.jsx` into a pure module so the migration and the app agree byte for byte.

A take that no shot generated (a gallery image picked as a shot's still, a captured frame used as an opening frame) is `purpose: 'imported'` with `recipe: null`. This keeps one invariant simple: a selection always points at a take.

### 4.3 Shots and selections

```
Shot {
  id, name, setup, description, dialogue, notes,
  draftImagePrompt, draftVideoPrompt,
  imageModel?, imageResolution?, videoModel?, videoResolution?, videoDuration?,   // unchanged overrides

  selection:    { image: takeId | null, video: takeId | null },
  selectionLog: [ { kind: 'image' | 'video', takeId, at: ISO } ],   // newest first, capped at 20

  lipSyncAudio: mediaId | null,
  audioRefs:    (mediaId | url)[],
  videoRefs:    (mediaId | url)[],

  assetLooks:   { [assetId]: lookId }       // which look a <Tag> in this shot means; absent = the asset's default
}
```

`selectionLog` is what makes "restore an earlier selection" one click without relying on whole-project undo. `assetLooks` is the whole of asset-look binding at shot level for this step; tags in prompt text keep resolving by tag.

### 4.4 Assets, looks and revisions

Identity on the asset, appearance on the look.

```
Asset {
  id, tag, type, name,
  description:   string,                    // the long one, used by reference-art prompts
  notes:         string,
  defaultLookId: string,
  looks:         [ Look ],
  imageModel, imageResolution, applyGlobalPrompts,   // generation preferences, unchanged
  updatedAt:     ISO
}

Look {
  id:              'look_<t36>_<r>',
  name:            string,                  // 'Default' after migration
  shotDescription: string,                  // what a <Tag> expands to in shot prompts; '' falls back to Asset.description
  prompt:          string,                  // reference-art prompt for this look (v1 asset.imagePrompt)
  images: [ { mediaId, primary: boolean, enabled: boolean,
              view: null | 'front' | 'profile' | 'rear' | 'closeup' | 'expression' | 'costume' | 'material' | 'detail' } ],
  revision:  integer,                       // starts at 1; incremented on shot-visible edits
  updatedAt: ISO | null
}
```

**Revision rule.** `revision` increments when a field that can change a shot's result changes: `shotDescription`, the image set, which image is primary, or an image's `enabled` flag. Renaming the look, editing `prompt` (it only affects the asset's own artwork), or changing generation preferences does not. This is the same rule `updatedAt` follows today in `App.jsx`, made countable.

**Dirty detection.** `dirty.js` compares `take.assetRevisions[assetId].revision` against the current revision of the look the shot binds. Migrated takes whose confidence is not `exact` fall back to the present `updatedAt` and primary-image comparison, so no shot becomes dirty or clean purely because it was migrated.

`primary` is unique per look. `enabled` is the v1 "ticked to send" flag and keeps its meaning in `refResolver.js`: ticked images are the explicit list; with none ticked, the board ranking applies.

### 4.5 Reference bindings

```
Binding {
  id:         'bind_<t36>_<r>',
  mediaId:    string,
  scope:      'project' | 'scene' | 'shot' | 'asset-look',
  targetId:   string | null,                // null only for 'project'; a lookId for 'asset-look'
  role:       'style' | 'subject' | 'composition',
  enabled:    boolean,
  order:      integer,
  operations: null | ('image' | 'video')[]  // null = both; new, optional
}
```

This is `refAssignments` with `refId` replaced by `mediaId` and one new scope. The v1 `reference.assetId` link ("this board image belongs to that asset, but is not in its pool") becomes an `asset-look` binding on the asset's default look. `refResolver.js` then ranks: ticked pool images, then pool images, then asset-look bindings, then tag matches, which is its present order with one list fewer to consult.

### 4.6 Edit

```
Edit { version: 2, settings, smart, video: [ Clip ], audio: [ Track ], bin: [ { id, mediaId, addedAt } ], durations: { [mediaId]: sec } }

Clip.source:
  { kind: 'take',  takeId }                 // pinned to one take; the default for new clips
  { kind: 'shot',  shotId, stream? }        // follows the shot's selection; v1 behaviour, kept for migrated clips
  { kind: 'media', mediaId, stream }        // bin and imported files; v1 'asset'
Clip.boundTo: null | { takeId } | { mediaId }   // what the trim was measured against; replaces the path
```

`resolveClipSource` gains one branch (`take` resolves through `takes[id].mediaId`). The staleness check in `timing.js` compares ids instead of paths. `reconcile.js` is unchanged in logic; `storyOrder` reads `shot.selection` instead of two path fields.

Migrated shot clips keep `kind: 'shot'` so that nothing in an existing cut changes behaviour on load. "Pin every clip to its current take" is offered as an explicit action afterwards (one pure function, `pinClips(edit, scenes, takes)`); new clips created after migration are pinned. See §9.

### 4.7 Jobs and runs

```
Job {
  id:       'job_<t36>_<r>',
  kind:     'image' | 'video' | 'lipsync' | 'llm' | 'render' | 'concat' | 'export',
  status:   'queued' | 'running' | 'waiting-provider' | 'completed' | 'failed' | 'cancelled' | 'uncertain',
  target:   { shotId } | { assetId, lookId } | null,
  runId:    string | null,
  request:  null | { model, providerFamily, prompt, inputs: Take.inputs, settings: {} },   // frozen at submission
  provider: null | { requestId, statusUrl },
  submittedAt, startedAt, finishedAt: ISO | null,
  error:    null | { class: 'transient' | 'invalid-input' | 'account' | 'unknown', message },
  resultTakeId:  string | null,
  resultMediaId: string | null,
  cost: { estimated: number | null, reported: number | null, currency: string | null }   // null = unknown, never 0
}

Run { id, kind: 'pipeline' | 'dream', status, startedAt, finishedAt, options, stageStates, jobIds: [] }
```

The job record has every field the specification's §18 needs; the server-side in-flight ledger that makes recovery possible is a later step (§6) and only adds a file beside the project, not a schema change. Jobs are kept in the document so the static runtime has them too; completed jobs beyond a cap (500) are pruned oldest first on save, which is the present behaviour with a higher cap.

### 4.8 Ids

New ids are `<prefix>_<base36 time>_<4 random>` everywhere, which the asset, reference and job ids already do. The migration keeps every v1 id it meets so checkpoints, exports and the user's memory of "shot_1761…" stay valid. Where the same id appears twice in one collection (a `Date.now()` collision), the second is suffixed `_2`, `_3`, … and the remap is listed in the report.

### 4.9 Invariants

A pure `validateProject(state)` returns these as a list of problems; the test suite runs it over every fixture and every migrated project, and the app runs it after migration and after each undo step in development.

1. Every `mediaId` referenced from a take, look, binding, clip, bin item, duration key, shot field or project field exists in `media`.
2. Every `takeId` referenced from a selection, selection log, clip source, `boundTo`, `parentTakeId`, `origin.takeId` or `resultTakeId` exists in `takes`.
3. `media.path` is unique across `media` (ignoring separator and case differences on Windows). A duplicate `hash` is reported, never auto-merged.
4. `take.mediaId` points at media of the take's `kind`; a generated media's `origin.takeId` points back at a take whose `mediaId` is that media.
5. `shot.selection.image` is an image take and `shot.selection.video` is a video take; both are owned by that shot (an imported take is created when a shot adopts foreign media, so this always holds).
6. Each look has at most one `primary`, and `primary` implies membership; `defaultLookId` names a look of the same asset; `shot.assetLooks` values name looks of the named asset.
7. Binding targets exist for their scope; `asset-look` targets are look ids.
8. `edit.durations` keys are media ids; every clip source resolves to an existing id.
9. No two records in one collection share an id.

## 5. Migration

One pure function, `migrateProjectV2(state) → { state, report }`, in a new module `frontend/src/schema/migrateV2.js`, with the signature helpers it needs (`groupKey`, path normalization, id minting with an injectable clock and random source so tests are deterministic). It is called from `applyLoadedState` in both runtimes, after the existing v1 migrations and before any state is set, and from checkpoint restore and project import. It never mutates its input.

### 5.1 Algorithm

Steps run in this order because later steps look up what earlier ones created.

1. **Guard.** If `state.schemaVersion >= 2`, return `{ state, report: null }`.
2. **Normalize v1.** Run the scenes-from-flat-shots fallback, `migrateReferenceState`, `migrateEdit` and `migratePromptSettings` exactly as `applyLoadedState` does, so the rest of the algorithm sees one shape.
3. **Index media.** Walk every path in the document: group `outputs[].path`, group `primaryImagePaths`, `excludedImagePaths`, `inputImagePaths`, `imageInput`; `imageGallery` and `videoGallery`; `referenceImages`; asset `images`, `primaryImage`, `inputImages`; shot `selectedImage`, `selectedVideo`, `lipSyncAudio`, `audioRefs`, `videoRefs`; edit `bin[].path`, `durations` keys, `source.path` on clips and audio clips, `boundTo`; `watermarkImage`, `concatenatedVideo`, `sceneConcatenatedVideo`. Normalize separators to `/`. Strings matching `^(https?|asset)://` become `external: true` media keyed by the URL. One `Media` per distinct key. `kind` comes from the extension table in `assetPaths.js`, falling back to where the path was found (a video group output is a video). `name` prefers the reference record's name, then the gallery name, then the output name, then the basename. `createdAt` is the earliest timestamp seen for that path.
4. **Takes from outputs.** For each shot, each image and video group, each output: one `Take`. `recipe` is lifted from the group (paths mapped to media ids), `recipe.prompt` from `group.prompt`, `inputs` from `group.inputImagePaths` in slot order with `via: null`. `groupKey` is the group's signature; `legacy` records the group and output ids. Lip-sync groups (`id` starts with `prompt_sync_`) become `purpose: 'lipsync'` takes with `recipe: { prompt }` and `parentTakeId: null`. The output's media gets `origin: { type: 'generated', takeId }`; if two outputs name the same path, the earliest take wins and the report lists the rest. Groups with no outputs are dropped and counted.
5. **Asset revisions on takes.** Where the group has `meta`, every take in the group gets `assetRevisions` built from `meta.assetStamps` (`lookId` = that asset's default look, `revision: 1`, `updatedAt`, `primaryMediaId`). Confidence is `exact` for the newest output in the group and `group-latest` for the others, because the group's meta was overwritten by each rerun. Groups without `meta` give `assetRevisions: null`, confidence `none`.
6. **Selections.** For each shot and each of `selectedImage`/`selectedVideo`: find the newest take owned by this shot whose media path matches. If none matches (a gallery pick, a captured frame, a path from before groups existed), create an `imported` take owned by the shot for that media and count it. Write `selection` and a one-entry `selectionLog` stamped with the migration time, since the original selection time is unknown.
7. **Looks.** Each asset gets one look named `Default`: `shotDescription` from the asset, `prompt` from `asset.imagePrompt`, `images` from `asset.images` (adding `primaryImage` first if it is not in the list), `primary` where the path equals `primaryImage`, `enabled` where `inputImages` contains the path, or, for assets still carrying `useExistingAsReference`, on the primary only (the rule in `assetInputImages`). `revision: 1`, `updatedAt` from the asset. `defaultLookId` set. `asset.imagePrompt`, `shotDescription`, `images`, `primaryImage`, `inputImages` and `useExistingAsReference` are removed from the asset.
8. **Board and bindings.** Each `referenceImages` record sets `media.reference = { category: kind, tags, notes }` on its media. Each `refAssignments` edge becomes a `Binding` with the reference's media id. Each reference with `assetId` whose media is not already in that asset's default look becomes an `asset-look` binding (`role: 'subject'`, `enabled: true`, `order` after existing ones). Dangling `refId`s are counted and skipped.
9. **Gallery leftovers.** Gallery entries whose media got no origin in step 4 are classified by id prefix: `img_asset_` → `generated` with `takeId: null` and the note "asset artwork; v1 recorded no recipe"; `img_dream_` → `captured` with `sourceMediaId: null`; entries whose `prompt` reads `Crop of <name>` → `derived`, with `sourceMediaId` set only when exactly one media has that name and otherwise `null` with the name kept in the note (v1 recorded the source's display name, not its path); everything else `unknown`. The gallery `prompt` text, where present and not already on a take, is kept in `media.notes`.
10. **Edit.** `version: 2`. Clip sources `{ kind: 'asset', path }` become `{ kind: 'media', mediaId, stream }`; `{ kind: 'shot' }` is unchanged; `boundTo` paths become `{ mediaId }`; `bin` items and `durations` keys map to media ids. Audio clips the same way.
11. **Jobs and runs.** `batchJobs` become `jobs` with the same status strings (`running` entries were already turned into `failed` by the v1 loader), `request: { model, prompt }`, `provider: null`, `cost` all null, `resultMediaId` from `outputPath`. `pipelineRun`, if present, becomes `runs[0]` with `kind: 'pipeline'`.
12. **Render outputs.** `concatenatedVideo` and each `sceneConcatenatedVideo` become `render` media and the fields store media ids.
13. **Shot and project cleanup.** Remove `selectedImage`, `selectedVideo`, `imagePrompts`, `videoPrompts`, `referenceImages` from shots; remove `shots`, `imageGallery`, `videoGallery`, `referenceImages`, `refAssignments`, `referenceSchemaVersion`, `batchJobs`, `pipelineRun` from the project. Add `assetLooks: {}` to each shot.
14. **Ids.** Detect duplicates per collection and remap as §4.8 describes, rewriting every reference to the remapped id.
15. **Stamp and validate.** Set `schemaVersion: 2` and `migratedFrom`. Run `validateProject`; any problem is a migration bug, so in tests it fails the test and in the app it is logged and shown in the report rather than silently saved.

### 5.2 Marking unknowns honestly

The specification is explicit that unavailable metadata is marked unknown rather than invented (§15, acceptance item 8). The migration follows these rules.

- `provider.*` is `null` on every migrated take: v1 never received request ids, seeds or model versions from the server.
- Video takes get `inputsComplete: false` because v1 groups did not record the audio and video references that were sent. Image takes get `true` only when the group has `inputImagePaths`; older groups with only `imageInput` get `false`.
- `assetRevisionsConfidence` is `group-latest` for every output that is not the newest in its group, and `none` where the group predates `meta`.
- `selectionLog[0].at` is the migration time, and the report says so.
- `origin.type: 'unknown'` is used wherever a path's history cannot be read from the document; it is not guessed from folder names.
- Costs are `null`, never `0`.

### 5.3 Idempotency, backups, both runtimes, checkpoints

- The guard in step 1 makes a second pass a no-op, the same pattern `migrateReferenceState` uses with its version stamp.
- Before the first v2 write of a project that was loaded as v1, the server takes a backup: `POST /api/state` receives `X-MM-Migrated: 2` on that save and calls the existing `backupBeforeOverwrite('schema-v2')`, which lands in `checkpoints/auto-backups`. The static runtime writes `<folder>.v1-backup.mmproj.json` once, beside the project file.
- Checkpoints keep their v1 blobs on disk. Restoring one runs the migration in memory. Saving a new checkpoint writes v2. The checkpoint list endpoint does not care which version a file holds.
- Imports (`/api/project/import-assets`, JSON backup import, shot-list import) migrate the incoming document before merging.
- Older builds of the app cannot read a v2 file. The backup is the way back, and the project header should say so once, on the first v2 save.

### 5.4 The report

`report` is returned, shown once in the app after migration, and written to `checkpoints/auto-backups/<project>.v2-migration.json` by the server. It lists, with counts and ids:

media created; paths merged into one media (separator or case variants); external media; takes created by purpose; imported takes created for selections; empty groups dropped; bindings created by scope and dangling edges skipped; media with origin `unknown`; takes with `inputsComplete: false`; takes by `assetRevisionsConfidence`; id collisions remapped; validator problems (expected: none).

## 6. Landing it without the big split first

The migration can land and ship before `App.jsx` is broken up, provided reads and writes go through two small pure modules and the component is converted site by site.

**Order.**

1. `schema/ids.js`, `schema/groupKey.js`, `schema/validate.js`, `schema/migrateV2.js`, with tests (§7). No app change yet.
2. `project/selectors.js`: `selectedTake(state, shotId, kind)`, `selectedPath(…)` (returns what `shot.selectedImage` returned, for the transition), `takesForShot(state, shotId, kind)`, `groupsForShot(…)` (the v1 group view), `lookFor(state, assetId, shotId)`, `lookImages(…)`, `boardMedia(state)`, `mediaByPath(state, path)`, `bindingsFor(state, scope, targetId)`. Each reproduces today's semantics over v2 records.
3. `project/commands.js`: pure updaters returning a new state: `recordTake`, `selectTake`, `deleteTake`, `adoptMediaAsSelection`, `addLookImage`, `setPrimary`, `setEnabled`, `bumpRevision`, `bindMedia`, `unbindMedia`, `addMedia`, `pinClips`. These are where the 44 `selectedImage`/`selectedVideo` sites and 33 `imagePrompts`/`videoPrompts` sites in `App.jsx` get redirected. `dirty.js`, `refResolver.js`, `reconcile.js`, `timing.js` and `edit/model.js` get their small signature changes here (§4.4 to §4.6).
4. Wire `migrateProjectV2` into `applyLoadedState`, `buildStatePayload` (which now emits the v2 keys), checkpoint restore and imports. Convert `App.jsx` write sites to `commands.js`, then read sites to `selectors.js`, in that order, so partially converted builds still write a valid document. Each conversion is covered by the existing tests of the pure modules plus the validator.
5. Server: `/api/image/generate` and `/api/video/generate` return `{ filePath, provider: { requestId, seed, modelVersion } }` where the adapter knows them (Fal exposes `request_id` today), so new takes stop recording `null` there. `providers/index.js` does the same for the static runtime.
6. Only then: the server-side in-flight job ledger, the App split into workspaces, looks in the asset editor, the impact preview. Each of those reads the records above and adds no schema change.

The `selectedPath` selector exists purely so the transition can be done in slices; it is deleted when the last read site is converted.

## 7. Tests

All in `node --test`, pure, added to the `test` script in `package.json`. Fixtures are small hand-written v1 documents plus one anonymized real project (paths only, no media) checked in under `fixtures/`.

Migration:

- a v1 project migrates to a document that passes `validateProject`
- migration does not run twice over an already-migrated project
- the same path recorded as output, gallery entry, reference and asset image becomes one media record
- backslash and forward-slash spellings of one path merge, and the report says so
- an https:// video ref becomes external media and is never looked up on disk
- every output becomes a take with the group's recipe and the group's signature as groupKey
- only the newest output in a group gets exact asset revisions; the rest are group-latest
- a group without meta gives takes with no asset revisions and confidence none
- a selected path that matches no output becomes an imported take owned by the shot
- a selected path that matches an output selects that take, preferring the newest
- an empty prompt group is dropped and counted
- a lip-sync group becomes a lipsync take with no parent
- an asset becomes one Default look with primary and enabled flags preserved
- an asset still carrying useExistingAsReference ticks only its primary
- a reference linked to an asset but absent from its pool becomes an asset-look binding
- a reference already in the pool does not also get a binding
- a dangling assignment is skipped and counted
- shot clips stay follow-mode and asset clips become media clips
- durations and bin items are re-keyed by media id
- running jobs are not resurrected and costs are null, not zero
- colliding output ids are remapped and every reference follows
- the report counts match the fixture

Records and selectors:

- a take's recipe is not changed by selecting, renaming, rating or rejecting it
- groupsForShot reproduces the v1 group list and order for a migrated fixture
- selectedPath returns what shot.selectedImage returned for every shot in the fixture
- a look's revision increments on shot-visible edits and not on a rename or prompt edit
- dirty detection flags a take generated at revision 1 once the look is at revision 2
- a migrated group-latest take falls back to the updatedAt comparison
- refResolver ranks ticked pool images, then pool, then asset-look bindings, then tag matches
- a pinned clip keeps its take after the shot's selection changes; a follow clip does not
- pinClips converts every follow clip to the take currently selected and leaves media clips alone
- a stale trim is detected by take id, not by path

## 8. Acceptance

The step is done when, on a migrated copy of a real project:

1. Every file appears once in `media`, and from any image the inspector can list its takes (via `origin.takeId` and `inputs`), its looks (via `looks[].images`), its bindings, and the clips that resolve to it. (Spec §8, §26.5)
2. For any shot, the selected take can be older than the newest take, and after selecting a newer one the previous take, its recipe and its media are all still present. (§26.9)
3. Pinning a clip and then changing the shot's selection leaves the cut unchanged; a follow clip updates. (§26.9)
4. Editing a character's description bumps its look revision, and the shots whose takes recorded revision 1 are the ones flagged, with the reason naming the asset and the field. (§26.7, §26.10)
5. Every migrated take shows `unknown` for provider fields and the report lists how many takes are partial. Nothing shows a cost of zero. (§26.8, §26.13)
6. The project opens in the server runtime and the static runtime, a v1 backup exists beside it, and restoring a v1 checkpoint works. (§26.16)
7. `npm test` passes with the new suites and the whole-project undo still steps across migration-era edits.

## 9. Decisions to confirm

1. **Migrated edit clips stay in follow mode.** This preserves what every existing cut does today, at the cost of not matching the specification's "pin by default" until the user runs "Pin all". The alternative, pinning on migration, is one line and changes the behaviour of existing cuts without the user asking. I recommend follow-on-migrate, pin-for-new.
2. **Hashing is lazy and server-only.** Hashing a few thousand files on first open is slow, and the static runtime cannot do it cheaply. Media identity does not depend on it; it only powers duplicate detection and relinking.
3. **`shotDescription` and the reference-art prompt move onto the look;** the long `description` and generation preferences stay on the asset. If you would rather keep `shotDescription` on the asset until looks are actually editable in the UI, the migration simply copies instead of moving.
4. **Jobs live in the project document,** capped at 500, so the static runtime has a job history. The server-side in-flight ledger is additive.
5. **Prompt tags keep resolving by tag text.** Renaming a tag still breaks references, as it does today. Fixing that (spec §12) is a prompt-layer change that would add a `tagMap` to shots and is better done once looks are in the editor.
6. **The flat prompt mirrors (`prePrompt`, …) are still written** because shot-list export reads them. They cost nothing and can go in v3.
