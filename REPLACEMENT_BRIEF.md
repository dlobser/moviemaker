# MovieMaker: feature inventory, critique, and replacement brief

Reviewed October 25, 2026.

## Recommendation

Build around **shots, reusable assets, immutable takes, and visible relationships**. Your distinctive requirement is being able to change an ingredient, understand which outputs depend on it, generate alternatives, and decide exactly what enters the cut.

Before committing to a full rewrite, trial LTX Studio and FLORA against the acceptance exercise at the end. LTX is the closest filmmaking workspace found; FLORA is especially relevant to flexible generation chains and MCP. Neither has been verified here to satisfy your exact lineage, reference-gallery, and version-selection requirements.

If you build, make the shot board the everyday interface. Keep the dependency graph underneath it, with an optional visual graph for advanced work. Requiring everyone to manage nodes and wires would reproduce the complexity you want to remove.

## Scope and evidence

This inventory describes the current working-tree implementation, including existing uncommitted edits. It is a source review, not a hands-on usability test or verification of paid generation endpoints. “Implemented” means a code path or interface exists; it does not certify every provider integration works today. No API credentials or project content were needed for this review.

The older `PLAN.md` is not an accurate inventory of what remains missing: several proposed phases are now implemented. Application code is the primary evidence. Main anchors:

- `frontend/src/App.jsx`: project lifecycle, scenes/shots, asset editing, generation, output galleries, batches, pipeline, Dream, imports/exports.
- `catalog.js`, `modelSettings.js`, `shared/providers/`: model profiles, inherited settings, provider request adapters.
- `promptTags.js`, `prompts.js`, `PromptEditor.jsx`: prompt composition, reusable tags, prompt-writing instructions.
- `references.js`, `ReferencePanel.jsx`, `refResolver.js`, `refAutoAssign.js`: reference records, assignments, gallery organization, resolution.
- `dirty.js`, `history.js`, `pipeline.js`, `dream.js`: dependency warnings, undo, orchestration, clip chaining.
- `edit/`: timeline, preview, media bin, audio, reconciliation, render plan.
- `server.js`, `projectGuard.js`, `assetOrganizer.js`, `exportPlan.js`, `renderGraph.js`, `proxyCache.js`, `watermarkGraph.js`: persistence, files, media processing, rendering.
- `static/`, `client.js`, `DEPLOY.md`: browser-only implementation and its limitations.

## Current feature inventory and critique

### 1. Projects, storage, recovery, and portability

**Implemented:** Create/open local projects; recent projects; project folders and autosaved project state; save a copy in server mode; project-folder/reconnection status; save guards and revision checks; whole-project undo/redo with a 60-entry history limit; named checkpoints with load/delete operations; JSON backup/import; import assets from another project; readable folder export with scene/shot organization; file organization with a preview of proposed changes; local folder browsing/reveal.

The application has two execution modes: React/Vite plus a local Node/Express server, and a static browser application using the File System Access API. The static version stores credentials in browser storage and writes into a user-selected folder. Server-dependent operations, including FFmpeg processing and some project operations, are unavailable there; provider access also depends on CORS support.

**Critique:** Recovery and ownership of local files are worth preserving. Two runtime modes create different meanings of “supported,” which users have to discover while working. Whole-project undo, checkpoints, generation history, and selected outputs are useful but represent different kinds of history without one consistent version model.

**Replacement:** Pick one primary runtime initially, preferably a local application/service with a browser UI, reliable jobs, and FFmpeg. Keep a portable project format. Separate document undo, asset revisions, immutable generation takes, and saved edit versions in the interface. A checkpoint must preserve references to media; restoring a document cannot recover a file that was physically deleted.

### 2. Story development, scenes, and shots

**Implemented:** Scenes and shot records; names/order; shot description, camera/setup, dialogue, notes, and duration; scene and shot model settings; selected image/video previews; expandable shot details; storyboard overview; scene and whole-film previews/compilations; JSON shot-list import from files or pasted LLM output, including replace and append workflows; export of an LLM prompt containing the import schema and model catalog; in-app idea-to-shot-list generation.

**Critique:** A shot contains creative intent, model configuration, prompts, references, output history, and selection state. All are necessary, but exposing them together makes a routine shot feel like a configuration form. “Description,” “image prompt,” “video prompt,” and global wrappers compete as places to express intent.

**Replacement:** Default shot cards show a thumbnail, short action description, duration, asset chips, chosen take, and status. The inspector exposes technical details on selection. Keep creative intent separate from the compiled model prompt. Provide board and table views of the same shot records; table view should support fast bulk edits.

### 3. Reusable assets and consistency

**Implemented:** Character, environment, prop, style, and vehicle assets; names and reusable angle-bracket tags; descriptions and shorter shot-facing descriptions; generated/uploaded image collections; primary reference selection; per-image send toggles; reference prompts and model overrides; default reference-art templates by asset type; LLM-assisted asset descriptions/reference prompts; individual and batch asset-image generation; adding gallery images to asset image pools; creating assets from references; generated asset images registered in the reference board.

**Critique:** The underlying idea is right: define recurring subjects once. But asset identity, current appearance, reference collection, and latest edits are conflated. A character changing coats for scene 4 should not make scene 1 appear wrong. A primary image is also too coarse to represent front, profile, costume, prop detail, and expression references.

**Replacement:** An asset has a stable identity and named versions/looks: “Mara / travel coat,” “Mara / injured,” “Observatory / night.” A shot binds a specific asset version. References carry purpose and viewpoint. Updating an asset offers an impact preview and an explicit choice to update dependent shots; historical takes remain tied to the versions they used. Reference consistency improves results but cannot guarantee a model will preserve identity.

### 4. Reference gallery and relationship browsing

**Implemented:** Docked or fullscreen reference board; image upload and project-image import; names, kinds, tags, and notes; search; kind/tag filters; unused toggle; grouping by type, scene, shot, tag, or linked asset; sorting by recently added, name, type, or most used; multiselection and bulk tagging/assignment/removal; inspector with usage; project/scene/shot assignments; subject/style/composition roles; enabled/disabled assignments; scope inheritance; reference strips on scenes/shots; filename-based asset-link suggestions with review; push images into asset image pools.

References assigned directly to shots take precedence over scene and project references. Model capacity and reference ordering influence what is actually sent. Current code uses role ordering, so the older plan's statement that roles are entirely unused is outdated. A role label nevertheless does not establish native semantic control in every provider.

**Critique:** The gallery already covers much of your request. The weak point is that it has several relationship mechanisms: assignments, asset linkage, membership in asset image pools, tags, and actual generation inputs. They answer different questions. For example, the unused filter and usage sort operate on assignment records; they do not comprehensively answer whether a file was used through an asset or by a historical generation.

**Replacement:** Make relationships first-class and expose three separate facts: **assigned**, **will be sent**, and **was sent**. Every image should show linked asset versions, assigned shots, actual generation uses, and downstream clips in edits. Provide filters for exact asset/version, scene/shot, role, direct/inherited use, historical/current use, selected/unselected, and truly unused. Add saved views, intersection queries, usage counts with clear definitions, and sorting by last use, rating, date, and downstream impact. Preserve a single media record when the same file serves several purposes.

### 5. Models and provider support

**Implemented:** Central image/video catalogs; model labels, provider routing, prices/price notes, reference counts, required inputs, reference kinds, positional reference tokens, prompt limits, supported sizes and durations; custom model paths; custom reference-capacity settings; inherited project/scene/shot settings and asset-type defaults; shared provider adapters used by server and static modes; image, video, and text generation; reference audio/video on supported paths; upload/download handling and asynchronous provider polling.

Adapters exist for Fal, Higgsfield, Atlas, Venice, Google, OpenAI, Anthropic, Runway, and Kling, with different generation modalities supported by different adapters. These are implementation entries, not a claim of universal current endpoint availability. The catalog distinguishes model family from hosting provider, which matters because different hosts expose different inputs and limits.

**Critique:** This is already a useful capability layer, but custom model paths do not make the application compatible with an arbitrary API. Request schemas, authentication, uploads, polling, errors, and output formats still need adapters. A hard-coded catalog can also confuse a recommended reference count with a hard ceiling. Model support and model-specific prompting knowledge are separate problems.

**Replacement:** Use provider plugins plus versioned endpoint profiles. Distinguish hard limits, recommended practices, unknown capabilities, and user overrides. Validate the final request before spending credits. Show why a model is incompatible with the requested operation and offer explicit alternatives. Never silently remove required references, replace the selected model, or change a meaningful duration.

### 6. Prompt writing and composition

**Implemented:** Manual draft prompts; LLM Auto Prompt for images/videos; optional asset and neighboring-shot context; editable project prompt instructions/templates; image/video pre/post wrappers; reusable snippet tags; asset tag expansion into descriptions and images; reference-token mapping for relevant models; raw/composed prompt visibility; missing-tag and overflow warnings; attached-media previews; configurable attachment of tagged assets; reusable asset-reference templates.

**Critique:** Editable prompt settings are valuable, but there are too many overlapping sources of text. Current default prompt writers are broadly cinematic rather than a complete model/version-specific prompting knowledge system. Technical adaptation of image tokens is not equivalent to knowing how a model handles camera movement, complex actions, audio, negative wording, or image-to-video instructions.

**Replacement:** Compile a structured shot specification into a model-specific prompt. Preserve an editable final-prompt override and show a readable breakdown of what contributed text and media. A model change should produce a visible prompt/settings diff, never silently rewrite the creative brief.

### 7. Takes, output history, and stale results

**Implemented:** Image/video prompt groups containing multiple generated outputs; selected image/video per shot; prompt inspection; output galleries; regeneration; captured video frames reusable as references or shot inputs; asset stamps and generation input metadata; stale-image/video warnings; batch regeneration of stale results; source-image changes propagating into video staleness.

**Critique:** This is useful generation history, but not a complete version graph. The stale resolver deliberately excludes some changes, including global wrappers, snippets, and board changes that do not affect an asset's effective primary image. Older outputs rely on less reliable fallback detection. File paths and timestamps are carrying some responsibilities better served by immutable IDs and content hashes.

**Replacement:** Every generation is an immutable take with its exact input manifest, prompt, settings, provider/model version, prompt-profile version, parent takes, timestamps, and job identity. Separate “outdated relative to current inputs” from “unapproved,” “failed,” and “missing.” Allow favorite/reject/rate, named versions, branches, side-by-side comparison, and pinning a take. Distinguish reproducing the same request from guaranteeing an identical output.

### 8. Automation, batches, and one-pass creation

**Implemented:** Individual generation; batch asset references; batch image/video prompt writing; batch shot images/videos; missing/stale work selection; configurable concurrency; background job manager; pipeline stage selection, estimates, retries, pause/resume/cancel. The main pipeline runs script → asset images → shot prompts → shot images → still selection → stale images → videos → stale videos → timeline. Candidate lists are recomputed from project state. Still selection can choose the newest output automatically.

**Critique:** Much of the requested one-pass workflow exists, but completion is based heavily on whether outputs exist. The newest image is not necessarily an acceptable image. Re-running candidate checks after reload is not the same as recovering an in-flight provider job. Canceling local scheduling is not necessarily canceling an already-billed remote generation. Estimates made before an LLM creates the shot list cannot know all later work.

**Replacement:** One execution engine should power “do this step,” “continue to this stage,” and “make a rough cut.” Persist jobs and provider request IDs. Model dependencies per item, so one failed shot does not stop unrelated shots. Offer review gates or automatic draft selection according to the chosen run policy. Re-estimate after planning, constrain maximum spend and take count, classify retryable failures, and avoid duplicate paid submissions after uncertain network responses.

### 9. Continuous-shot generation: Dream

**Implemented:** Invent mode with LLM-written successive clips; chain mode over existing shots; starting-shot selection; configurable clip count, model, duration, resolution, instructions, and prompt history depth; opening-image generation settings; tag-attachment options; frame extraction to seed continuation; progress/cost presentation.

**Critique:** This is a distinct creative workflow worth preserving, but “Dream” obscures its practical purpose. A last-frame chain does not guarantee seamless motion or prevent accumulated identity drift. This feature should not need a separate orchestration system.

**Replacement:** Make “Continue from this frame” a reusable operation and “Continuous sequence” a workflow preset. Allow selecting a continuation frame, retaining anchor references, branching at any clip, and regenerating only the dependent tail. Show the accumulated dependency chain and keep the original sequence intact.

### 10. Audio, editing, rendering, and delivery

**Implemented:** Dialogue audio upload and lip-sync generation; generated-video audio; image/video/audio imports in the media bin; selected-shot media assembled into a timeline; clip ordering, trimming, splitting, deleting, and still duration; cut/dissolve/dip transitions; multiple audio tracks with level, mute/solo and fades; picture/audio linking; playback, seeking, scrubbing, zoom; media probing; preview proxies and cache controls; shot-list/edit reconciliation; render plans and FFmpeg rendering; scene/film concatenation; watermark processing; readable project export.

**Critique:** A lightweight rough-cut editor is valuable because continuity must be judged in sequence. Building a full professional editor is a large distraction. Linked shot selections can also surprise users if changing a take changes an established cut without a clear decision. Static/server differences complicate export expectations.

**Replacement:** Keep a responsive rough-cut timeline, useful audio controls, transitions, render presets, and explicit update-from-shot decisions. Pin edit clips to take IDs by default, with an optional follow-current-selection mode. Export media plus a documented manifest; add OTIO or target-editor interchange where verified to work. Advanced color, compositing, titles, and audio finishing can stay in an external editor.

### 11. Automation interfaces

**Implemented:** HTTP endpoints for the application's own operations. No project MCP server was found in the reviewed implementation.

**Critique:** An internal HTTP API is a useful starting point but does not yet provide a stable agent-facing project model. An external agent needs to inspect relationships and jobs as well as trigger generation.

**Replacement:** Expose the same application commands through UI, API, and MCP. Tools should cover searching assets/references/shots, creating/updating records, linking references, inspecting lineage, compiling/preflighting prompts, estimating and running workflows, checking jobs, choosing takes, building cuts, and exporting. Return structured IDs and results. Mutations should support expected revisions, and generation should support idempotency keys. Scope external access to a project and keep credentials inside provider adapters. MCP access should obey the same selected run budget and review policy as the UI.

## Proposed product model

### The few objects users should understand

| Object | Meaning |
|---|---|
| Project | Creative brief, defaults, assets, shots, edits, jobs |
| Asset / asset version | Reusable subject and a particular appearance or state |
| Media | A file with stable identity and metadata, independent of where it is used |
| Reference binding | A relationship between media and an asset/shot, with role and scope |
| Shot | Intended action, staging, timing, continuity, and chosen takes |
| Take | Immutable generated or imported candidate, with complete input lineage |
| Job / run | Execution and billing history for one operation or a workflow |
| Edit version | Ordered, trimmed take references and audio decisions |

Do not make users learn “prompt groups” as the primary way to find their work. A prompt is part of a take's recipe; the shot is the thing they are making.

### Everyday interface

Use persistent navigation for **Shots, Assets, Gallery, Edit**, plus a jobs drawer. Keep selection synchronized across views. Selecting a shot highlights its assets/references; selecting a reference reveals its shots and takes. A common inspector holds details, reducing modal hopping.

Shot cards should answer: what happens, what it looks like, which take is chosen, whether it is ready, and what needs attention. Add compact status filters: missing assets, needs image, needs video, generating, failed, outdated, needs review, approved, and in edit. Let the user save layouts and filters. Offer an optional dependency view without requiring it for routine work.

### Model-aware generation and prompting knowledge

Maintain three distinct layers:

1. **Capability profile:** operation types, input roles/counts, formats, dimensions, duration rules, audio support, endpoint availability, pricing basis, and constraints that interact with each other.
2. **Prompting profile:** model/version-specific writing guidance, examples, motion vocabulary, reference conventions, common failure modes, and supported negative-prompt behavior. Separate image generation, image editing, text-to-video, and image-to-video guidance.
3. **Provider adapter:** authentication, serialization, media transfer, submission, polling/webhooks, cancellation, downloading, and error normalization.

Each factual rule needs a source, verification date, and confidence. Mark local experiments as observations. Store personal preferences separately from provider facts. Do not assume rules transfer to another host or new model version.

For example, Runway's image-to-video guidance emphasizes motion and how it relates to the source image; Google's Veo guide discusses cinematic direction and audio. These justify different prompt templates, rather than sending the same long descriptive paragraph to every model. Use version-specific documentation before applying a rule. [Runway image-to-video guide](https://help.runwayml.com/hc/en-us/articles/48324313115155-Image-to-Video-Prompting-Guide) · [Google Veo guide](https://deepmind.google/models/veo/prompt-guide/)

The compile preview should show the creative brief, final prompt, numbered/role-labeled inputs, settings, exclusions with reasons, estimated price, and unresolved constraints. When a model supports fewer references, let the user choose what to retain or explicitly generate a composite reference; never imply a composite is equivalent to native independent references.

“Any API model” should mean **extensible to any implementable provider through an adapter**, with user-editable advanced fields and optional schema import. A URL and model name alone are insufficient for arbitrary compatibility.

### One pass and step-by-step are the same workflow

Interpret “one shot describing a video” as one instruction that can produce an entire draft, while also supporting a single literal shot.

Example brief: “Make a 30-second scene of Mara entering an abandoned observatory, discovering a moving star map, and fleeing as the dome opens.”

The system proposes assets and shots, generates or reuses asset versions, makes shot stills, selects draft takes under the run policy, generates motion, and assembles a rough cut. Every intermediate artifact is visible and editable. The user can instead stop after the plan, do only assets, work on one shot, compare images, or continue only approved stills into video. Imported assets or finished footage let them enter at any stage.

Changing Mara's coat should show affected shot bindings and takes, offer a new asset version, and permit regeneration of selected dependent work. It must preserve approved prior takes and existing edit versions. This change-impact interaction is the central feature of the replacement.

## Existing tools: what deserves a trial

This is a public-documentation comparison, not a hands-on product certification. “Unverified” means the reviewed sources did not establish the behavior; it is not proof the product lacks it. Subscription pricing and access should be checked at trial time.

| Tool | Documented overlap | Fit and unresolved question |
|---|---|---|
| **LTX Studio** | Connected generation, storyboard and timeline; reusable Elements; multiple models; shot revision tools. | First trial for the filmmaking workflow. Verify exact take history, reference-use queries, arbitrary provider extensibility, export lineage, and MCP. |
| **FLORA** | Visual generation canvas and reusable Techniques; multiple models; documented MCP/API and agent-driven generation with results on the canvas. | First trial for flexible chains and MCP. Verify whether shot/asset/version management is native or must be manually represented with nodes. |
| **Katalist** | Script breakdown into scenes/shots, character/location assets, storyboard generation and video creation in Story Canvas. | Promising guided workflow. Verify advanced version branching, gallery reverse lookup, automation and model freedom. |
| **Figma Weave, formerly Weavy** | AI workflow environment for imagery, video and audio. | Relevant for composing repeatable workflows; verify film-specific tracking and integration access. Do not confuse it with the unrelated Weavy collaboration-component service. |
| **Magnific Spaces, formerly Freepik Spaces** | Canvas with connected text/image/video/audio tools, reusable workflows, asset inputs and collaboration. | Strong workflow candidate; verify whether asset identity and shot lineage remain manageable at film scale. |
| **Runway Workflows** | Custom pipelines connecting models/modalities, reusable templates, media/text inputs. | Useful generation orchestration. Verify project-wide continuity, version tracking and external endpoint freedom. |
| **ComfyUI / Comfy platform** | Extensible workflows, third-party Partner Nodes, workflow deployment through Comfy API. | Candidate execution backend for a custom shot manager. Its workflow interface is unlikely to resolve your simplicity concerns by itself; that is a design assessment, not a capability limitation. |

Sources: [LTX tutorial](https://ltx.io/blog/ltx-studio-tutorial), [LTX connected projects](https://ltx.io/blog/introducing-projects), [FLORA canvas](https://flora.ai/), [FLORA MCP/API](https://flora.ai/mcp), [Katalist Story Canvas](https://help.katalist.ai/en/articles/16298583-how-to-build-your-storyboard-and-videos-in-story-canvas), [Figma Weave FAQ](https://help.figma.com/hc/en-us/articles/35965787376919-Figma-Weave-FAQ), [Spaces documentation](https://www.freepik.com/ai/docs/introduction-to-spaces), [Runway Workflows](https://runway.com/workflows), [Comfy Partner Nodes](https://support.comfy.org/articles/1982697177-partner-nodes-pricing), [Comfy API](https://support.comfy.org/articles/2703236295-comfy-api-deploy-your-comfyui-workflow-as-an-api).

**Buy:** Choose an existing application if its supported model set and organization cover the practical workflow without external bookkeeping.

**Hybrid:** Build only the shot/asset/version/gallery layer, and delegate generation through supported APIs or MCP and final editing to an established editor. This is attractive if lineage is the sole gap. First verify that the external executor returns enough job/input/output metadata to preserve lineage.

**Full replacement:** Justified if exact relationship queries, endpoint freedom, model-specific prompting, selective regeneration, and edit pinning remain awkward across trials. These capabilities are the reason to build; another prompt box and video gallery are not enough.

## A concrete buy-versus-build exercise

Use the same small project in every candidate: two characters, one location, one prop, twelve reference images, six shots, two image models, and two video models.

1. Import references and create reusable assets without duplicate files.
2. Associate multiple images with the same asset and use one image for several purposes.
3. Create six shots from a brief, then edit two shots manually.
4. Generate three still candidates for one shot; choose the middle candidate, not the newest.
5. Animate it and keep two video takes. Confirm both retain their exact input still and settings.
6. Switch a shot to a lower-capacity model. Check that omitted references and prompt changes are explained.
7. Change a character's wardrobe for only the last two shots. Preserve earlier appearances.
8. Starting from a gallery image, find all linked assets, assigned shots, actual generated uses, and uses in the cut. Filter and sort that result.
9. Regenerate just affected work. Preserve rejected takes and the previous cut.
10. Close/reopen during a generation. Check recovery without duplicate submission.
11. Run the project from one instruction, then repeat using individual stages. Confirm both paths create the same kinds of editable records.
12. Use an external agent to inspect and operate the project if MCP/API is claimed. Export media and enough metadata to reconstruct the project elsewhere.

Record each as native, workaround, unavailable, or unverified. Treat relationship lookup, exact take lineage, selective updates, and your required model access as hard gates. Count manual bookkeeping and context switches as well as generation quality.

## Delivery order if you build

1. **Prove the data model and interface with imported media.** Shots, asset versions, gallery relationships, takes, selections, edit pinning, and impact previews must already feel simple before adding paid APIs.
2. **Complete one vertical workflow.** Brief → assets → shot → image → video → rough cut, with manual control at each stage and durable job recovery.
3. **Add model extensibility and prompting profiles.** Prove it with materially different providers and operations, not two similar endpoints.
4. **Add pipeline execution and MCP.** Both use the same commands and job engine as the interface.
5. **Expand advanced features.** Continuous sequences, lip sync, richer audio, editor interchange, and additional provider plugins.

Preserve import compatibility through a migration tool: create stable media IDs, preserve prompts/output groups as takes, map selections, carry assignments and asset images forward, and mark missing historical provenance as unknown. Keep original projects readable and do not fabricate old generation settings.

Acceptance for the replacement is practical: from any visible image or clip, you can find what made it and where it is used; from any changed asset, you can see what may need updating; from any stage, you can continue automatically or intervene manually without losing history.
