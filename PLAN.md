# MovieMaker Improvement Plan

This is an execution-ready roadmap intended to be worked through phase by phase by a coding agent. It was produced from a deep analysis of the codebase (all file:line references verified at time of writing — line numbers will drift as phases land; treat them as anchors, re-locate by the quoted identifiers).

## How to execute this plan

- **Recommended execution order** (respects all dependencies):
  1. Phase 0 (bug fixes)
  2. Phase 1 (capability profiles)
  3. Phase C.1 only (dirty-tracking metadata persistence — land it early so the "clock" starts: every generation run before it lands is one more shot stuck on the fallback detection path forever)
  4. Phase 2 (shared provider module)
  5. Phase 3 (resolveModelSettings)
  6. Phase 4 (reference auto-attach)
  7. Phase 5 (in-app LLM stages)
  8. Phase A (scrubbing & preview overhaul — independent of 1–5, may be interleaved anywhere)
  9. Phase B (media bin — after A; both touch Timeline.jsx/EditView.jsx and sequencing avoids rebasing Timeline twice)
  10. Phase C.2–C.3 (dirty resolver + UI + batch — after Phase 4, because auto-attach changes what `composed.taggedAssets`/`inputImagePaths` contain; re-verify C's recompose-fallback containment check after Phase 4 lands)
  11. Phase 6 (orchestrator — must come after C so its stage predicates import `dirty.js` instead of growing a second dirtiness implementation)
  12. Phase 7 (backlog, as needed)
- Formal dependencies: 0, 1, 3, A are independent; 2 depends on 1; 4 depends lightly on 1; 5 depends on 0; B depends on A (shared files only); C.1 is independent (do early); C.2–C.3 depend on Phase 4; 6 depends on 3, 4, 5, C (benefits from 2 but does not require it).
- **Commit at least once per phase** with a message naming the phase. Run `npm test` before every commit; keep the app green after every phase — every phase is designed to be shippable alone.
- **Extend the test suites alongside each phase** (existing suites: `renderGraph.test.js`, `frontend/src/catalog.test.js`, `promptTags.test.js`, `references.test.js`, `shotListImport.test.js`, `dream.test.js`, `history.test.js`, `frontend/src/edit/timing.test.js`, `edit/reconcile.test.js`). New pure modules get their own `*.test.js` registered in the root `package.json` test script.
- **Both modes must keep working**: server mode (`node server.js` + Vite dev) and static mode (browser-only, File System Access API, `frontend/src/static/`). Any feature that needs a server endpoint must either have a static-mode client path or degrade gracefully with a clear message.
- **Do not change the HTTP request/response shapes** of `/api/image/generate`, `/api/video/generate`, `/api/llm/generate` unless a phase explicitly says so.
- **Fail loudly.** This is a personal power tool: prefer a visible warning/failed job over silent truncation, silent fallback, or silently spending money on a request a provider will reject.
- When a phase says "byte-identical behavior when new args are absent", existing tests must pass unchanged — that is the compat gate.

## Background: the three structural problems

1. **Per-model/provider quirks are scattered and duplicated.** Provider dispatch is implemented twice — `server.js:1093-1520` (server mode) and `frontend/src/static/providers.js:505-686` (static mode) — with ~14 per-model special cases duplicated verbatim (Higgsfield triple field-alias, Gemini 3-image cap, Flux Redux requires-image, Fal aspect enum ladder, Atlas pixel maps + multi-body retry, Veo duration coercion, Kling/Luma t2v↔i2v endpoint swaps…). `catalog.js` is a good data-driven catalog but has no prompt-length field, no reference-kind field, no requires-input-image flag. Image order is the only implicit link between prompt text and attachments.
2. **The reference system captures intent it never uses.** Reference `role` (style/subject/composition) and `kind` are collected and persisted but never affect generation; a `<Tag>` contributes exactly one image (the asset primary) regardless of model capacity; board `ref.tags[]` are search-only; generated images never reach the board automatically.
3. **All the pieces for one-button generation exist but nothing connects them.** `/api/llm/generate` exists (with image attachments) yet script generation is a clipboard round-trip; three separate batch runners share one cancel flag and can't compose; there's no "write all shot prompts" batch; no orchestrator, retry policy, or persisted run state.

Plus (added scope): the edit tool's scrubbing is broken for identified mechanical reasons, external media can't be brought onto the timeline (video), and there is no notion of a shot being stale ("dirty") after an asset it references changes.

---

## Phase 0 — Quick bug fixes

All verified in code, all localized, no data-shape changes.

1. **`server.js:569`** — `} else if (modelPath === 'chatgpt') {` inside `/api/llm/generate`. `modelPath` is not in scope in that handler (it exists only in the image/video handlers) → ReferenceError → caught → 500. **OpenAI prompt-writing is completely broken in server mode.** Fix: `provider === 'chatgpt'`, matching the `gemini` (:543) and `claude` (:604) siblings.
2. **`server.js:1253`** — image dispatch checks `provider === 'chatgpt'` while every sibling branch checks `modelPath`, so an id written `openai:chatgpt` misses the branch. Change to `modelPath === 'chatgpt'` (matches `static/providers.js:583`).
3. **`server.js:609` vs `static/providers.js:179`** — Claude default model disagrees (`claude-3-5-sonnet-latest` vs `claude-sonnet-5`). Align the server string to the static one. (Longer term the frontend should always send `model` explicitly so backend defaults never matter.)
4. **`server.js:616`** — remove the `'dangerously-allow-html': 'true'` header. It is not a real Anthropic header (the browser-only header is `anthropic-dangerous-direct-browser-access`, which a server never needs).
5. **`App.jsx:1956-1968`** — the asset-reference generation call site omits `safetyChecker`; add `safetyChecker: atlasSafetyChecker` to match `App.jsx:1212`.
6. **`static/providers.js:600-601`** — unknown image ids silently fall through to the Fal path (billed mis-routes). Add the guard the server has (`server.js:1288`): if family is null and the path is not a Fal-ish id, throw `Unsupported image provider: <id>`.
7. **Import path fixes** (`App.jsx:2739` area + `shotListImport.js`):
   - run imported `referenceImages` through `normalizeReference` (`references.js:77-89`) instead of restoring raw;
   - restore `refAssignments` on import — currently **silently dropped** (`normalizeImportedShotList` never parses it, `applyImportedDocument` never sets it), so re-importing a full export loses every assignment;
   - stop writing legacy `shot.referenceImages` from the importer (`shotListImport.js:270`) — it can never migrate because `migrateReferenceState` (`references.js:110-145`) only runs at load and the project is already stamped schema v2. Write shot-scope edges via `assignReferences` (`references.js:314-351`) instead.

**Verify:** `npm test`; exercise the OpenAI prompt writer in server mode; generate with an `openai`-prefixed id; export a project with board refs + assignments, re-import, confirm `refAssignments.length` survives.

## Phase 1 — Capability profiles in the catalog

**Goal:** one data record per model describing everything callers currently special-case: prompt limit, reference count and semantics, required-input flag.

Extend entries in `IMAGE_MODELS` / `VIDEO_MODELS` (`frontend/src/catalog.js`):

```js
{
  id, label, provider, price?, priceNote?,
  refImages: 8,                            // existing ceiling (keep the name)
  refMode: 'none'|'optional'|'required',   // 'required': Flux Redux, Soul image-to-image, i2v-only video models
  refKinds: ['character','style','scenery','prop'],  // which board kinds are worth sending; omit = all
  promptLimit: 4000,                       // chars; omit = no known limit. Only enter verified numbers
                                           // (DALL-E 3: 4000 documented). Do NOT guess limits.
  durations, sizes                         // existing
}
```

**Rule for what is data vs code:** counts, limits, enums, required-input flags, kinds → catalog data. Field-name aliasing (Higgsfield triple alias), endpoint swaps (Kling/Luma t2v↔i2v), payload retry ladders (Atlas), size-string translation tables, polling loops → code in provider adapters (Phase 2). Those are per-*provider* request shaping, not per-model facts.

Changes:
- Extend `modelCapabilities(type, id)` (`catalog.js:243-253`) to return `promptLimit: model?.promptLimit ?? null`, `refMode: model?.refMode ?? (model?.refImages > 0 ? 'optional' : 'none')`, `refKinds: model?.refKinds ?? null`. Keep `known: false` for custom paths, but add a user-settable `customRefImages` override (stored in project settings keyed by the custom path) so a custom multi-ref Higgsfield path stops silently dropping to 1 image.
- `composeGenerationPrompt` (`frontend/src/promptTags.js:176-232`): when `promptLimit` is known and the composed prompt exceeds it, include `promptOverflow: { limit, length }` in the return. **Warn, never silently truncate.** Surface as a warning chip in the generation modal (near the existing char count at `App.jsx:4939`) and as a logged warning on batch jobs.
- Preflight `refMode === 'required'` in `submitGenerationJob` (`App.jsx:1152`): if no input images survive composition/trim, fail the job locally with the same message the Redux branch throws today — this later removes that special case from both dispatchers.

**Files:** `frontend/src/catalog.js`, `frontend/src/promptTags.js`, `frontend/src/App.jsx`, `catalog.test.js`, `promptTags.test.js`.

**Verify:** unit tests for the new `modelCapabilities` defaults and for overflow reporting; modal shows the warning for an over-limit DALL-E prompt; Redux with no refs fails locally before any request.

## Phase 2 — Shared provider module

**Goal:** one implementation of provider dispatch consumed by both `server.js` (CommonJS) and the Vite frontend, replacing `server.js:1093-1520` and `static/providers.js:505-686`, and deleting the re-implemented catalog helpers at `server.js:916-935`.

**Placement: `frontend/src/shared/providers/` (ESM); server consumes via cached dynamic `import()`.**
- `frontend/package.json` already declares `"type": "module"`, and these files already run under plain `node --test` (the root test script proves it) — no new package, no dual-format build, no Vite `fs.allow` config.
- Server stays CommonJS. One lazy loader:
  ```js
  // server.js
  let providersPromise;
  const getProviders = () => (providersPromise ??= import('./frontend/src/shared/providers/index.js'));
  ```
  Every generation route is already `async`, so it's `const { generateImage } = await getProviders();` per route.
- Rejected alternatives: converting server.js to ESM (touches every `require` plus `renderGraph.js`, churn for no user value); a root-level `shared/` package (needs Vite `server.fs.allow` + alias, splits the test glob).

**Layout:**

```
frontend/src/shared/providers/
  index.js      // dispatch: generateImage(req, ctx), generateVideo(req, ctx), generateText(req, ctx)
  routing.js    // re-exports parseModelId/formatModelId/normalizeFamily/resolveRouting from ../../catalog.js
  fal.js  higgsfield.js  atlas.js  google.js  openai.js  runway.js  kling.js
```

**Adapter interface** (each provider file exports a subset):

```js
export const adapter = {
  id: 'fal-ai',
  uploadStrategy: 'public-url' | 'data-url' | 'inline-parts',
  async generateImage(req, profile, ctx) -> { remoteUrl } | { base64, mimeType },
  async generateVideo(req, profile, ctx) -> { remoteUrl },
};
```

`req = { modelPath, prompt, resolution, duration, inputImages, safetyChecker }` where `inputImages` are already prepared per `uploadStrategy` by the dispatcher — the Fal media upload and data-URL conversion happen once, in `index.js`, not in each adapter. `profile = modelCapabilities(...)` from Phase 1.

**Transport injection** — each host builds `ctx`:

```js
ctx = {
  fetch,                        // server: global fetch; static: callApi (CORS proxy + key headers)
  credentials,                  // server: config.json; static: keyStore
  readAssetDataUrl(path),       // server: fs + base64; static: fileSystem read
  uploadPublicUrl(path),        // server: uploadToFalMedia; static: its equivalent
  saveRemote(url, prefix, ext), // server: downloadFile; static: write into project dir
  capabilities: { directOnly }  // static ctx marks Runway/Kling unreachable (CORS) — adapter throws the existing message
}
```

Server builds `ctx` per request in the route handlers; `static/providers.js` shrinks to ctx construction + re-exports.

**Migration order (each step keeps the app green):**
1. Extract adapters from the *static* implementation (it's the more modern of the two), with pure `buildRequest`-style helpers inside each adapter so request bodies are unit-testable without network.
2. Point server routes at the shared module behind the dynamic import.
3. Diff behavior against the old server branches (the two implementations agree almost verbatim already; where they differ, the differences are catalogued in Phase 0 items 3, 6).
4. Delete the dead branches from both files.

HTTP shapes of `/api/image/generate` and `/api/video/generate` are unchanged; `App.jsx` is untouched.

**Verify:** new `frontend/src/shared/providers/*.test.js` asserting built request bodies per adapter (Higgsfield triple-alias, Atlas body ladder, Fal aspect mapping, Veo duration coercion, Kling/Luma endpoint choice); smoke one Fal image, one Higgsfield multi-ref image, one Atlas video in **both** modes.

## Phase 3 — `resolveModelSettings()` + granular model control

**Goal:** replace the five inline `shot.imageModel || imageModel` fallback chains with one resolver; add scene-level defaults and asset-type defaults; add the missing per-shot model override UI (today per-shot overrides can only be set via import — there is no UI; every `shot.imageModel` occurrence in App.jsx is a read).

New `frontend/src/modelSettings.js`:

```js
export function resolveModelSettings({ type /* 'image'|'video' */, project, scene, shot, asset }) {
  // precedence: shot/asset explicit override > scene default > asset-type default > project default
  // empty string or null on any level = inherit (fixes the `||` idiom where '' silently falls through)
  return { model, resolution, duration, source: 'shot'|'scene'|'assetType'|'project' };
}
```

- **Scene defaults:** optional `scene.imageModel / imageResolution / videoModel / videoResolution / videoDuration` (absent = inherit). The importer (`shotListImport.js` normalizer, `:169-281`) learns the same optional fields on scenes; schema stays v1-compatible; mention them as optional in `SCHEMA_EXAMPLE`.
- **Asset-type defaults:** optional `project.assetTypeModels = { character: 'higgsfield-ai/soul-id', environment: '...' }` so characters default to identity-preserving models and environments to cheap t2i. Editable in Settings → Models.
- **UI:** a small "Model" pill on shot cards, generation modal header, and scene headers showing the resolved value + its source; click → override or clear (clear = inherit). `withSelected` (`catalog.js:267`) already handles stale saved values in dropdowns.
- Replace the inline chains at the five call sites: modal open (~`App.jsx:944`), submit (~`:1161`), batch runner (~`:1484`), video path (~`:1782`), asset generation (~`:1956`).
- The returned `source` powers the pill and Phase 6's cost estimate breakdown.

**Verify:** precedence unit tests including the empty-string-means-inherit rule; scene default honored by a batch run; shot override wins and survives save → reload → export → import.

## Phase 4 — Tag-driven reference auto-attach

**Goal:** a `<Tag>` in a prompt automatically carries the *right* references for that asset — not just the single primary image — ranked by role/kind, allocated fairly under the model's capacity, with manual pins/exclusions always winning. And the reference board grows itself.

New `frontend/src/refResolver.js`:

```js
export function collectAssetReferences({ asset, references, capacityHint, refKinds }) {
  // Ranked candidates for one tagged asset:
  //  1. asset primary image (assetPrimaryImage — today's behavior, always rank 0)
  //  2. board refs with ref.assetId === asset.id  (kind matching model refKinds first; role 'subject' first)
  //  3. board refs whose tags[] match asset.tag (normalized compare)
  // Dedup by path. Returns [{ path, refId?, reason: 'primary'|'linked'|'tag-match', kind, role }]
}
```

`composeGenerationPrompt` (`promptTags.js:176`) gains optional params `references = []`, `assignments = []`, `shot = null`, `scene = null`, `autoAttachRefs = true`:

- **Allocation:** compute `capacity` first; reserve slots for `primaryImagePaths` and shot-resolved enabled edges (`resolveShotReferences`, `references.js:240-273` — which finally matters at generation time, not just in the board UI); distribute remaining capacity **round-robin across tagged assets** — every tagged asset gets its rank-0 image before any asset gets a rank-1 image. This preserves the existing fairness guarantee (the stated purpose of the one-image-per-asset rule at `promptTags.js:137-145`) while using spare capacity on 8/14/16-slot models.
- **Precedence (explicit beats automatic):** primary paths > shot-scope pinned edges > scene/project inherited enabled edges > auto tag refs. Resolve all three existing exclusion mechanisms (`edge.enabled`, `shot.refExclusions`, per-recipe `excludedImagePaths`) in this one place so every consumer agrees. `imageSources` entries carry `origin: 'primary'|'pinned'|'inherited'|'auto-tag'` plus a human `reason`.
- **Role-aware ordering** within a scope: subject before style before composition for character-capable models; style-first when the model's `refKinds` is `['style']`. This is the first real consumer of `edge.role` — no schema change needed (`references.js:38-42`).
- **Compat gate:** with the new args absent, output is byte-identical to today; existing `promptTags` tests pass unchanged. Project-level toggle for auto-attach mirroring `attachTagsForImages`.

**UI (generation modal preview strip, `App.jsx:4924-5040`):** thumbnails get an origin badge and two hover actions — *pin* (create/toggle a shot-scope edge via `assignReferences`) and *exclude* (write `shot.refExclusions` for auto/inherited entries, `excludedImagePaths` for recipe-only). Dropped entries (`droppedImageSources`) render greyed with "over capacity".

**Auto-register generated asset images on the board:** on asset generation success, create a reference via `normalizeReference`: `{ path, name: `${asset.name} ${n}`, kind: KIND_BY_ASSET_TYPE[asset.type], assetId: asset.id, tags: [asset.tag], source: 'generated' }`, dedup by path. Export `KIND_BY_ASSET_TYPE` from `references.js` (character→character, environment→scenery, prop/vehicle→prop, style→style). **Shot outputs are not auto-registered** (they'd flood the board with takes) — instead add a one-click "Add to ref board" action on gallery items.

**Scope limit — do not unify the four image stores.** The board becomes the searchable index (the resolver reads it); asset pools remain the asset-editor UX (the push model documented at `references.js:44-53` is sound); `genModalInputImages` stays a recipe snapshot (reproducibility is a feature); `/api/project-images` remains a fallback picker. Full unification is a large migration with little payoff once auto-registration makes the board complete.

**Files:** create `frontend/src/refResolver.js` + `refResolver.test.js`; modify `promptTags.js` (signature + allocation), `App.jsx` (`buildPrompt` at `:1094-1106` threads references/assignments/shot/scene; modal strip; auto-register), `references.js` (export `KIND_BY_ASSET_TYPE`).

**Verify:** allocation fairness (two tagged characters + 3-slot Gemini → both primaries in, remaining slot round-robins); pinned edge beats auto; exclusion removes an auto ref; existing tests unchanged; manual: `<Ralph>` on nano-banana (8 slots) shows primary + linked board refs with origin badges.

## Phase 5 — In-app LLM stages: script generation + prompt-writing batch

**(a) In-app script generation** — replace the clipboard round-trip with one call. Everything downstream exists: `buildLlmImportPrompt` (`shotListImport.js:75`), `/api/llm/generate` (with the Phase 0 fix; supports image attachments), `normalizeImportedShotList`, `applyImportedDocument`. New `frontend/src/scriptGen.js`:

```js
export async function generateShotListFromIdea({ idea, assetLibrary, llm: { provider, model }, apiFetch }) {
  const prompt = buildLlmImportPrompt({ assetLibrary, sourceMaterial: idea });
  // POST /api/llm/generate with a JSON_ONLY_SYSTEM system prompt
  // extractJsonBlock: strip ``` fences, tolerate surrounding prose
  // on parse failure: retry ONCE, feeding the parse error + original reply back to the LLM
  return normalizeImportedShotList(parsed);
}
```

UI: an "Idea → Script" panel — textarea for the idea/logline/script, LLM picker (via `resolveModelSettings`), and a **preview of the parsed document** (scene/shot/asset counts, new vs existing tags) before `applyImportedDocument` commits. Keep the copy-to-clipboard path as a fallback button.

**(b) "Write all prompts" batch** — extract the modal-trapped auto-prompt logic (`App.jsx:1015/1040`) into a reusable `writeShotPrompt({ shot, type, llm })`; add a batch entry mapping it over candidates (shots missing `draftImagePrompt` / `draftVideoPrompt`), small worker pool (LLM calls: pool of 1-2). Shape it as a stage function `(candidate, ctx) => result` with no UI coupling — Phase 6 consumes it directly. LLM-scripted projects that already carry draft prompts skip this stage naturally via the candidate predicate.

**Files:** create `frontend/src/scriptGen.js` + test (fence-strip/parse/retry logic is pure); modify `prompts.js` (JSON_ONLY_SYSTEM), `App.jsx`, `shotListImport.js` (export `extractJsonBlock` next to `extractJsonDocument`).

**Verify:** two-paragraph idea → valid parsed document previews and imports; unit test the retry path with corrupted JSON; "write all prompts" fills empty prompts across an imported project.

## Phase 6 — Pipeline orchestrator + one-button generate

**Goal:** one panel, one button: idea → script → assets → asset images → shot prompts → shot images → select → shot videos → timeline. Replaces the three batch runners' and dream mode's parallel cancel mechanisms with a single run controller.

New `frontend/src/pipeline.js` (pure logic) + `frontend/src/PipelinePanel.jsx` (UI). The stage list is a straight line with skippable nodes — no DAG machinery:

```js
const STAGES = [
  { id: 'script',      label: 'Generate script',        candidates: needsScript,              run: runScriptStage },      // Phase 5a
  { id: 'assetImages', label: 'Asset reference images', candidates: assetBatchCandidates,     run: runAssetImage },       // exists App.jsx:2113
  { id: 'shotPrompts', label: 'Write shot prompts',     candidates: shotsMissingPrompts,      run: writeShotPrompt },     // Phase 5b
  { id: 'shotImages',  label: 'Generate shot images',   candidates: batchCandidates('image'), run: submitGenerationJob }, // exists App.jsx:1152
  { id: 'select',      label: 'Select stills',          candidates: shotsWithoutSelection,    run: autoSelectNewest },    // exists App.jsx:1263
  { id: 'shotVideos',  label: 'Generate shot videos',   candidates: batchCandidates('video'), run: submitGenerationJob },
  { id: 'timeline',    label: 'Build timeline',         candidates: once,                     run: syncTimeline },        // edit/reconcile.js
];
// Plus, once Phase C has landed (it must, per the execution order): two optional stages
// { id: 'dirtyImages', candidates: dirtyImageCandidates, ... } and { id: 'dirtyVideos', ... }
// importing the predicates from dirty.js — never a second dirtiness implementation.

export function createPipelineRun({ stages, options, ctx }) {
  // options: { skip: Set<stageId>, concurrency, retry: { attempts: 2, backoffMs }, dryRun }
  // returns { start, pause, resume, cancel, subscribe } — ONE cancel token for everything
  // per-stage worker pool reusing the App.jsx:1443-1492 pattern
  // (pool 1-2 for LLM stages, batchConcurrency for images, min(2, batchConcurrency) for video)
}
```

Key behaviors:
- **Stages drain fully before the next starts** (simple, debuggable). Per-candidate failures retry up to `retry.attempts` with backoff, then are marked failed **without blocking siblings** — a failed shot image just makes that shot ineligible for the video stage via its candidate predicate; the run reports it rather than halting.
- **Candidate predicates are the source of truth, not a work queue.** Every stage re-derives its work from project state, so resume-after-reload = "run again with the same options"; completed work is naturally skipped. Persist `pipelineRun = { id, startedAt, stageStates: { [stageId]: { status, done, failed: [{id, error, attempts}] } }, options }` in project state — and start persisting `batchJobs` too (currently excluded from `buildStatePayload` at `App.jsx:525-568`, so the job log dies on reload).
- **Dry-run cost estimate:** per stage, count candidates × `resolveModelSettings(...)` → catalog `price`; sum known prices; list credit-priced models as "N runs, credit-priced". Shown in the panel before the Run button arms.
- **UI:** stage checklist with per-stage skip toggles, candidate counts, live progress (reuse the batch job feed), pause/resume/cancel, cost estimate, and the Phase 5 idea box + model pickers at the top. The one button is literally: paste idea → review estimate → Run.
- **Migration:** `handleRunBatch` (`App.jsx:1425`), `handleRunAssetBatch` (`App.jsx:2113`), and dream's loop (`App.jsx:1621`) become thin wrappers that create single-stage pipeline runs — three cancel mechanisms collapse into one (`cancelBatchRef` at `App.jsx:234` and `dreamCancelRef` at `:249-250` are retired). Remove the batch fallback to raw `shot.description` as a prompt (`App.jsx:1397-1400`): the shotPrompts stage supersedes it, and the candidate predicate skips promptless shots instead. Note: autosave is currently blocked while a batch runs (`App.jsx:639`) — the pipeline must checkpoint state between stages instead.

**Files:** create `frontend/src/pipeline.js` + `pipeline.test.js` (controller is pure given injected stage fns), `frontend/src/PipelinePanel.jsx`; modify `App.jsx` (extract stage fns, wire panel, persist run state), `dream.js` (adopt the shared cancel token).

**Verify:** controller unit tests with fake stages (retry, pause mid-stage, cancel, resume-from-state); end-to-end on a tiny 2-scene project with cheap models (Flux Schnell), videos skipped, then un-skip videos and rerun to confirm incremental resume; reload mid-run and resume.

## Phase A — Scrubbing & preview overhaul

**Why scrubbing is broken today (six verified root causes):**
1. **There is no playhead drag at all.** Only `onPointerDown` on the ruler (`Timeline.jsx:161`) and empty track background (`:180-182`) seek; the window `pointermove` handler (`:108-147`) serves only clip move/trim drags. The playhead itself is `pointer-events: none` (`edit.css:518-527`). "Scrubbing" today is a series of discrete clicks.
2. **A paused seek under 250ms never moves the picture.** `seek()` (`PreviewEngine.js:205-222`) only invalidates slots on the *playing* branch (`:215`); when paused, `syncSlot`'s drift logic (`:301-312`) skips any correction below `HARD_CORRECT = 0.25` (`:23`). The 1/24s arrow-key nudge (`EditView.jsx:337-338`) can never move the frame.
3. **Unthrottled `currentTime` assignment every rAF frame.** `drawAt` runs every rAF tick even paused (`:250`); `syncSlot` assigns `element.currentTime` (`:306`) with no seeking-guard and no `seeked` wait → up to 60 aborted seeks/sec during a scrub; the picture freezes then jumps.
4. **Clip switching races.** `syncSlot` calls `loadInto` without await/cancellation (`:291-294`); overlapping loads on the 2 fixed slots mark stale content ready (`seekElement`'s 4s timeout *resolves*, `:466`). No generation token — `AudioScheduler` already has the right pattern (`AudioScheduler.js:28,90,108,143`).
5. **No reverse preload.** `preload` only warms `index + 1` (`:399-409`); scrubbing backwards always hits a cold `src` assignment.
6. **React churn per seek.** `EditView.jsx:155-158` calls `setPlayhead` on every seek → full Timeline re-render; `snapTargets`/`snap` depend on `playhead` (`Timeline.jsx:58-82`), re-registering window listeners mid-drag (`:139-147`).

**Architecture decisions:** extend the existing Timeline drag state machine with a `scrub` mode (reuses window pointer plumbing + the `dragRef` guard); move continuous time out of React into a tiny subscription store with direct-DOM playhead writes; replace raw `currentTime` assignments with a per-slot coalesced seeker (latest-target-wins); grow the slot pool from 2 to 3 `<video>` elements so previous *and* next clips stay warm (audio wiring identical — `createMediaElementSource` once per element at construction). **Defer the frame cache** (A.7): with coalesced seeking, local short-GOP h.264 AI clips land seeks in 30–80ms and the canvas keeps painting the last decoded frame while a seek is in flight, so "freeze then jump" becomes "smooth follow".

### A.1 — Coalesced per-slot seeking (fixes root causes 2 and 3)

In `frontend/src/edit/PreviewEngine.js`, extend the slot shape in `createSlot()`: add `seekTarget: null` (latest requested media time), `seeking: false` (assignment in flight), `loadToken: 0` (for A.2). Attach **one persistent** `seeked` listener per element in `createSlot()`.

```js
/** Latest-target-wins. Never more than one in-flight seek per element. */
requestSeek(slot, mediaTime) {
  slot.seekTarget = mediaTime;
  if (slot.seeking) return;                    // seeked handler re-issues
  if (slot.element.readyState < 1) return;     // no metadata yet; loadInto path handles it
  slot.seeking = true;
  const target = slot.seekTarget;
  slot.seekTarget = null;
  slot.seekIssuedAt = performance.now();
  try { slot.element.currentTime = target; }
  catch { slot.seeking = false; }
}

onSlotSeeked(slot) {
  slot.seeking = false;
  if (slot.seekTarget !== null) {
    const next = slot.seekTarget;
    slot.seekTarget = null;
    this.requestSeek(slot, next);              // pointer moved on; chase it
  }
}
```

Rewrite the drift block in `syncSlot()` (`:301-313`):

```js
if (slot.ready) {
  const expected = entry.in + (time - entry.start);
  const drift = expected - slot.element.currentTime;
  if (!this.playing) {
    // Paused: land on the exact frame. Half a frame of tolerance stops re-seek churn.
    const frame = 1 / (this.timeline?.settings?.fps || 24);
    if (!slot.seeking && Math.abs(drift) > frame / 2) this.requestSeek(slot, expected);
    slot.element.playbackRate = 1;
  } else if (Math.abs(drift) > HARD_CORRECT) {
    this.requestSeek(slot, expected);
    slot.element.playbackRate = 1;
  } else if (Math.abs(drift) > SOFT_CORRECT) {
    slot.element.playbackRate = 1 + Math.max(-0.05, Math.min(0.05, drift));
  } else {
    slot.element.playbackRate = 1;
  }
}
```

Edge cases: `seeked` can wedge (seeking to exactly `duration` never fires it in most browsers — documented in `dreamFrame.js:22-25`); add a watchdog in `syncSlot`: if `slot.seeking && performance.now() - slot.seekIssuedAt > 1500`, clear `slot.seeking`, `console.warn`, retry. If `requestSeek` bailed on `readyState < 1`, the next rAF retries once metadata lands — no extra listener. The explicit `drawAt` call in `seek()`'s paused branch can be deleted (the always-on rAF loop covers it).

### A.2 — Generation tokens for `loadInto` (fixes root cause 4)

Copy the `AudioScheduler` token pattern into `loadInto(slot, entry)` (`:155-176`): bump `const token = ++slot.loadToken` on entry; reset `slot.ready/seekTarget/seeking`; after each `await` (`urlFor`, `seekElement`), bail if `token !== slot.loadToken` — a superseded load never marks the slot ready. Keep `seekElement`'s 4s resolving timeout; the token check makes a stale resolve harmless.

### A.3 — Three-slot pool + bidirectional preload (fixes root cause 5)

- `this.slots = [createSlot(), createSlot(), createSlot()]` (`:63`). Audio routing unchanged per slot.
- `claimSlot(entry, keep = [])` takes a list of clip ids to keep (current + incoming during dissolves; current + next + previous during preload) instead of the single-id parameter. Update both `syncSlot` call sites in `drawAt`.
- Rewrite `preload(current)` to warm **both** `timeline.video[current.index + 1]` and `[current.index - 1]` (next wins the slot tiebreak; images go through `imageFor`). With three slots it's now safe to preload during a dissolve — in the `incoming` branch of `drawAt`, call preload with `keep = [current.clip.id, incoming.clip.id, next?.clip.id]` (relaxing the comment at `:277-279`).

### A.4 — `timeStore`: playhead out of React (fixes root cause 6)

New file `frontend/src/edit/timeStore.js` (~25 lines): `createTimeStore(initial)` → `{ get, set, subscribe }` over a plain value + `Set` of subscribers.

- **EditView.jsx:** replace `useState(0)` playhead with a `timeStore` held in a ref. Engine `onTime` writes the store. `seek(time)` clamps and calls `engine.seek()` (whose `onTime` callback already fires). Keyboard handlers and `handleSplit` read `store.get()` — removing `playhead` from the keydown effect deps stops listener re-registration every frame during playback. The transport clock becomes a tiny component subscribing to the store and writing `el.textContent` directly, throttled to ~10Hz. `<Timeline>` receives `timeStore` instead of `playhead`.
- **Timeline.jsx:** new `<PlayheadMarker store={timeStore} pixelsPerSecond={pps} />` writing `transform: translateX()` directly in a subscribe effect, quantized to whole pixels (skip the write when the rounded px is unchanged). `snapTargets` reads `store.get()` inside instead of closing over `playhead` — the drag window-listener effect (`:139-147`) stops re-registering mid-drag. Wrap `Clip` in `React.memo` (its props are now stable during playback).

### A.5 — Scrub drag interaction (fixes root cause 1)

Extend the Timeline drag state machine with `mode: 'scrub'`:

- `startScrub(event)` on the ruler and empty-track pointerdown (replacing bare `seekFromEvent`): guard `dragRef.current`, set `dragRef.current = { mode: 'scrub' }`, arm the window listeners, seek immediately, `setPointerCapture`.
- In the window `onMove` handler, before the clip-drag branches: store the latest pointer time in a ref and schedule at most one `onSeek` per rAF (the rAF callback reads the ref, so coalescing is genuinely latest-wins). `onUp` clears drag state and cancels any pending rAF.
- The playhead stays `pointer-events: none` — ruler-drag is the standard NLE gesture; add `cursor: ew-resize` on `.edit-ruler` and a `mode-scrub` class for feedback.
- Scrubbing pauses playback: give Timeline an `onScrubStart` prop that calls `engine.pause()` once; arrow keys remain non-pausing. Audio during scrub stays silent (existing design — buffer sources are pinned to absolute context time; keep it).

### A.6 — OPTIONAL, defer: frame cache + `/api/thumbnail`

Only pursue if acceptance testing on real projects shows scrub latency > ~150ms (e.g. long-GOP screen recordings imported via the Phase B bin):
- Server: `GET /api/thumbnail?path=&t=&w=` next to `/api/probe`, via the existing `runFfmpeg` helper (`-ss <t> -i <abs> -frames:v 1 -vf scale=<w>:-2 -c:v mjpeg pipe:1`), `Cache-Control: immutable` (generated files are immutable timestamp-named), disk cache under `<project>/.cache/thumbs/`.
- Client: `Map<string, ImageBitmap>` keyed `${path}@${Math.round(t*4)/4}` (250ms quantization), LRU capped at 256 entries; populated opportunistically after each `seeked` via `createImageBitmap(slot.element)` and, in server mode, idle-prefetched around the playhead. `paintEntry` draws the cache hit while `slot.seeking`.
- The same endpoint powers clip filmstrips in `Timeline.jsx` — that is the real justification for building it. Server-mode-only nicety; static mode renders no filmstrip and scrubbing must not depend on it.

**Step order:** A.1 (engine only — arrow keys start working, testable in isolation) → A.2 → A.3 → A.4 (no behavior change, pure refactor) → A.5 → A.6 only if needed.

**Acceptance criteria ("good scrubbing"):**
- Dragging the ruler at any speed: the picture follows continuously; at every pointer stop the correct frame displays within ~100ms.
- Arrow keys: every 1/24s press visibly changes the frame (assert `|currentTime - expected| < 1/48` after settle); 10 rapid presses land on the final position's frame.
- During a 5s continuous scrub, each video element fires ~1 `seeking` per `seeked` (no aborted-seek pileup — verify with temporary listeners).
- Scrub backwards across a cut: previous clip's frame appears without a black flash once warm (instant on second crossing; ≤300ms cold).
- Rapid scrub across 3+ clips then stop: displayed frame belongs to the clip under the playhead (validates A.2).
- Playback, dissolves, dips, audio sync, clip drag/trim all behave exactly as before; React DevTools shows zero Timeline re-renders from time updates during playback.

## Phase B — Media bin (bring any video/audio/image into the edit)

**Key fact from analysis:** the clip model and render path are already source-agnostic. `resolveClipSource` (`model.js:152-191`) supports `{kind:'asset', path, name, stream}`; `renderPlan.js`/`renderGraph.js` are fully path-based; an arbitrary `assets/foo.mp4` clip **renders correctly today with zero render-path changes**. Audio import UI even exists (`EditView.jsx:242-269`). The gaps are: no UI to create asset-kind *video* clips, no media enumeration endpoint (`/api/project-images` filters to image extensions), `rebuildFromShots` (`EditView.jsx:229-236`) destroys non-shot clips, and bin stills fall back to the global 5s default.

### B.1 — Data model

Store the bin **in the edit document** (a curated list, not a folder scan — `assets/` holds hundreds of generated iterations that would drown a scan):

```js
// edit.bin — new array on the edit doc, defaulted in createEmptyEdit()
{ id, path, name, type: 'video'|'audio'|'image', addedAt }
```

Duration is *not* stored on bin items — it flows through the existing `edit.durations` probe cache: add bin paths to `collectSourcePaths(edit, scenes)` so `probeMissing` measures them automatically.

`model.js` changes (minimal): `createEmptyEdit()` gains `bin: []`; `migrateEdit()` normalizes `raw.bin` via a `normalizeBinItem` (drop pathless items); `resolveClipSource`'s asset branch supports stills — `stream: 'image'` → `kind: 'image'` (PreviewEngine `paintEntry` and the renderer already handle image clips generically).

### B.2 — Per-clip still duration

`timing.js` `stillSeconds(clip, ctx)` (`:100-107`): check `clip.stillSeconds` (finite, > 0) first, then the existing shot path, then `ctx.fallbackSeconds`. `normalizeVideoClip` passes `stillSeconds` through. `EditView` `VideoInspector`: when `entry.resolved.kind === 'image'`, render a "Hold for" number input (0.5–60s, step 0.5) writing `{ stillSeconds }` — applies to shot-stills too, a free win.

### B.3 — Enumeration + upload (both modes)

- **server.js:** new `GET /api/project-media` — same shape as `/api/project-images` (`:489-511`) but classifying by extension into image (`.png/.jpg/.jpeg/.webp/.gif`), video (`.mp4/.mov/.webm/.m4v`), audio (`.wav/.mp3/.m4a/.aac/.ogg/.flac`), with `mtime` for sorting. Leave `/api/project-images` untouched. Multer prefix (`:225-235`): add `video_` for video mimetypes (currently everything non-audio lands as `ref_`).
- **Static mode:** `static/fileSystem.js` gains `listAssetMedia()` (clone of `listAssetImages` `:330-342` with the three extension groups); `client.js` routes `/api/project-media` → it, and the `/api/upload` prefix logic (`:155`) becomes audio/video/ref by mimetype (`importFile(file, prefix)` already takes the prefix).

### B.4 — Bin panel UI

New `frontend/src/edit/MediaBin.jsx`, mounted in EditView as a collapsible left column of `.edit-body` (collapsed by default; toggled by a header "Bin" button; `edit-bin` styles in edit.css).

- Rows: type icon, name, duration from `edit.durations[path]` once probed, path in `title`.
- **Import:** hidden multi-file input `accept="video/*,audio/*,image/*"` + `onDrop` on the panel; both feed a sequential `importFiles(files)` loop — `POST /api/upload` per file, toast per failure (fail loudly, continue), append `{ id, path: data.filePath, name: file.name, type, addedAt }` to `edit.bin`. Probing happens automatically via B.1's `collectSourcePaths` change.
- **Add from project:** modal listing `/api/project-media` results not already in the bin; selecting adds entries (no copy — files are already in `assets/`).
- Removing a bin entry never deletes the file and never touches clips already on the timeline (clips hold their own path).

### B.5 — Drag from bin to timeline

Use native HTML5 drag-and-drop (the bin lives outside Timeline's pointer-event world; native DnD leaves the Timeline drag state machine untouched):

- Bin rows: `draggable`, `dragstart` sets `dataTransfer.setData('application/x-mm-bin-item', JSON.stringify(item))`, `effectAllowed = 'copy'`.
- **Timeline.jsx:** `onDragOver` (preventDefault + drop-position indicator line at `timeAt(event.clientX)`, drawn with the same direct-DOM technique as the playhead) and `onDrop` on the video track and each audio track. New prop `onDropAsset(item, time, target)` with `target = { kind: 'video' } | { kind: 'audio', trackId }`.
- **EditView.jsx** `handleDropAsset`: video/image items on the picture track → `createVideoClip({ kind: 'asset', path, name, stream: type === 'image' ? 'image' : 'video' }, smart ? {} : { start: time })`, inserted at `indexForTime(timeline, time)` in smart mode (first index whose `entry.start + length/2 > t`) or appended; audio items → `createAudioClip(...)` on the target track (creating a track first when dropped on empty space, reusing the `handleImportAudio` pattern `:254-263`). Audio items on the picture track → warning toast. **Video items dropped on an audio track are allowed** as `stream: 'audio'` — the model already supports pulling just a file's audio.
- Select the new clip after insert.

### B.6 — Guard `rebuildFromShots` (and `withDerivedAudio`)

`rebuildFromShots` keeps `asset`-kind clips (appended after the fresh shot-derived sequence) behind a confirm dialog naming how many imported clips are kept. **Also fix `withDerivedAudio` (`:753-758`) in the same commit** — it currently replaces `edit.audio` wholesale, which already destroys imported audio tracks today: preserve tracks containing ≥1 asset-kind clip, drop shot-derived dialogue tracks, append the fresh Dialogue track. `reconcile.js` needs no changes (verified: `diffShots:44-46` skips non-shot clips; `pruneOrphans` is shot-only; `matchStoryOrder:132-136` carries unranked clips with their neighbors).

**Step order:** B.1 model → B.2 stillSeconds → B.3 endpoints → B.4 panel → B.5 drop targets → B.6 guards.

**Verify:** server mode: import .mp4 via picker → bin shows duration after probe → drag mid-sequence onto picture track → plays, scrubs, dissolves, renders. Same for .mp3 → audio track, .png → still with editable hold. Static mode (`?static=1`): same flow via `importFile` + blob URLs. "Match story order" with imported clips → confirm dialog; imported picture clips and audio tracks survive. Reload: bin persists, clips resolve.

## Phase C — Dirty-shot tracking + batch regeneration

**Goal:** a shot whose generation used `<Tag>` assets is flagged stale ("dirty") when those assets have since changed (description, name, tag, or primary image), and dirty shots can be batch-regenerated — images first, then the videos that depended on them.

**What's already recorded per generation** (the foundation): every generation persists a prompt group on the shot (`App.jsx:1250-1256` image, `:1345-1351` video) containing `rawPrompt` (with literal `<Tag>` markers), `prompt` (composed), `model/resolution/duration`, `inputImagePaths` (image) / `imageInput` (video), and `outputs[{path, createdAt}]`. Missing: which assets were used by id, group-level timestamps, and any `updatedAt` on assets. `imagePromptSignature` (`App.jsx:1072-1079`) keys on an explicit field list, so **additive metadata never forks groups** — signature-safe.

### C.1 — Metadata persisted going forward (LAND THIS EARLY — see execution order)

- **Prompt groups:** in `submitGenerationJob` → `runAsyncImageJob`/`runAsyncVideoJob`, pass and store a `meta` object alongside the recipe (not inside it, keeping the signature input clean):

```js
const meta = {
  taggedAssetIds: composed.taggedAssets.map(a => a.id),
  // Snapshot of what each asset looked like at generation time.
  assetStamps: Object.fromEntries(composed.taggedAssets.map(a => [
    a.id, { updatedAt: a.updatedAt || null, primaryImage: assetPrimaryImage(a) }
  ])),
  createdAt: new Date().toISOString()
};
```

  When a generation appends to an existing group (`matchIndex >= 0`), refresh `taggedAssetIds`/`assetStamps`/`createdAt` on the group — the latest output defines currency.
- **Assets:** a `touchAsset(asset)` helper stamping `updatedAt`; applied **only where generation-relevant content changes** (avoids false positives):
  - `handleSaveAsset` (`:2209`): bump only if `tag`, `name`, `description`, or `primaryImage` differ from the previous record. (`inputImages`, `imageResolution`, `promptWrap`, `applyGlobalPrompts` affect the asset's own artwork generation, not shots — do not bump.)
  - `attachImageToAsset` (`:1908`): bump only if it changes the effective `assetPrimaryImage`.
  - Import/merge sites (`:2568`, `:2620`, `:2748`) and bulk-create (`:2835`): stamp new/overwritten records.
  - LLM description fill (`:2145`): bump.
  - Reference-pool append (`:3623`): no bump (doesn't change primaryImage).
- No migration: `updatedAt: undefined` on old assets routes evaluation to the fallback path.

### C.2 — The resolver: new file `frontend/src/dirty.js`

Pure functions, no React; later imported by the Phase 6 orchestrator. Exports `imageDirtiness(shot, assetLibrary)`, `videoDirtiness(shot, assetLibrary)` → `{ dirty, reasons[] }`, plus `groupForSelection(groups, selectedPath)` and candidate helpers `dirtyImageCandidates(scenes, assetLibrary)` / `dirtyVideoCandidates(...)`.

Core logic, per tag in `extractTags(group.rawPrompt)`:
- **Forward path** (both sides stamped): `asset.updatedAt > (output.createdAt || group.createdAt)` → dirty ("edited since").
- **Backward-compatible fallback** (old projects, no `updatedAt`): recompose — does the stored `group.prompt` still contain `assetPromptText(asset)` (the current `"name (description)"` substitution)? Description drift breaks containment. Misses renames and reverted edits — accepted and documented in the file header.
- **Primary-image drift, both eras** (only when `group.attachTaggedImages !== false`): the asset's current `assetPrimaryImage` is absent from what was actually sent (`assetStamps[id].primaryImage` when recorded, else `inputImagePaths`/`imageInput`). Generated files are immutable and timestamp-named, so path comparison *is* content comparison.

Video dirtiness = union of: **(a)** source-image drift — the still that was animated (`group.imageInput`) is no longer `shot.selectedImage`; **(b)** the shot's image is itself dirty (regenerating it will then trip (a)); **(c)** the video group's own tagged assets drifted.

**Scope decisions (explicit):**
- Dirties: asset description/name/tag changes, asset primary-image changes.
- Does NOT dirty: global pre/post prompt changes (would flag every shot at once and is usually intentional retuning; a project-wide "settings changed since last sweep" chip is deferred), reference-board changes not affecting an asset primary, asset generation-settings changes, prompt-snippet changes.
- Missing/renamed tag → not dirty; surface as a separate "missing asset" warning.

Performance: string ops over shots × tags; memoize as `dirtyMap = useMemo(() => buildDirtyMap(scenes, assetLibrary), [scenes, assetLibrary])` → `Map<shotId, {image, video}>`. Trivial at personal-project scale.

### C.3 — UI + batch regeneration

- **Shot card badge:** amber "stale" pill when image or video is dirty; `title` = joined reasons. A "Stale only" filter toggle in the shot-list toolbar.
- **Batch wiring:** `batchOnlyDirty` alongside `batchOnlyMissing`; extend `batchCandidates(type, scope, onlyMissing, onlyDirty)` (`App.jsx:1415-1423`) to filter through `dirtyMap`.
- **Regeneration reuses the original recipe, not the draft prompt:** when a candidate was selected by dirtiness, submit from the producing group — `rawPrompt`, `model`, `resolution`, `duration`, `attachTaggedImages`, `excludedImagePaths` from `groupForSelection(...)`; for video, animate the **current** `shot.selectedImage` (not the recorded one). Because tag attachment resolves at compose time, fresh asset images attach automatically; the signature match lands the new output in the same group and refreshes its `assetStamps` — **regenerating self-heals the dirty state**, and `shot.selectedImage/selectedVideo` re-resolution keeps the timeline current (the property to preserve, `model.js:1-17`).
- **"Regenerate stale" button:** extract the worker-pool body of `handleRunBatch` into `runBatchOver(candidates, type, submitFor)` so one button runs **images first → recompute dirtiness → then videos** — the order matters because a regenerated image flips its video to dirty via rule (a).
- **Orchestrator handoff:** `dirtyImageCandidates`/`dirtyVideoCandidates` are exactly the "re-derive candidates from project state between stages" shape Phase 6 wants; the orchestrator gains `regenerate-dirty-images` / `regenerate-dirty-videos` stages that import them. No orchestrator code in this phase.

**Step order:** C.1a `touchAsset` + bumps → C.1b group `meta` persistence → C.2 `dirty.js` + tests → C.3 badge/filter/batch/two-stage button.

**Verify:** edit an asset description → every shot whose selected image used that `<Tag>` shows the badge; shots without it don't; an old project file (no `updatedAt`) falls back correctly. Change only a primary image → dirty via image-drift on both new and old projects. Change the global pre-prompt → **zero** shots dirty. "Regenerate stale": images regenerate with original raw prompts + fresh references; their videos then flag dirty and regenerate; afterwards `dirtyMap` is empty and the timeline shows new takes with no edit-doc changes. Signature safety: "+ Add Iteration" on a pre-existing group still lands in the same group (no fork from the new metadata).



## Phase 7 — Parity & polish backlog (as needed)

- **Video ref parity:** send multiple `inputImagePaths` for video jobs per the Phase 1 capacity profile instead of hardcoding `[0]` (`App.jsx:1195`); revisit `attachTagsForVideos` defaulting off (`App.jsx:202`) while images default on.
- **Picker quality:** filter/group the "From project folder" list (`/api/project-images`, `server.js:489-511`) using board metadata once Phase 4's auto-registration lands.
- **Server-side generation queue:** `/api/image/generate` and `/api/video/generate` are held-open synchronous HTTP. Fine for personal use; if long video runs start timing out, move to the submit/poll pattern the ffmpeg renderer already uses (`renderJobs`, `server.js:1877+`). Deliberately deferred — the orchestrator's retry policy covers most failures.
- **`buildLlmImportPrompt` upgrade:** include Phase 1 profile facts (prompt limits, refMode) and Phase 3 scene-default fields so the LLM picks models intelligently when writing scripts.

---

## Overall verification

- `npm test` green after every phase; new pure modules get their own test files registered in the root test script.
- After Phase 6: two-paragraph idea → full pipeline on cheap models in server mode; repeat in static mode after Phase 2.
- After Phases 0/4: export → re-import round-trip preserves references, assignments, and overrides.
- After Phase A: the full acceptance list in Phase A holds — drag-scrub follows the pointer with ≤100ms settle, arrow keys step frames reliably, no stale-slot frames after fast scrubs.
- After Phase B: an imported .mp4/.mp3/.png plays, scrubs, and renders from the timeline in both modes; "Match story order" preserves imported clips and audio tracks.
- After Phase C: edit an asset description → its shots show dirty; "Regenerate stale" runs images then videos and clears the flags; a global pre-prompt change dirties nothing.
