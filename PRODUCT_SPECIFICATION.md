# AI Film Studio — Standalone Product Specification

## 1. Product purpose

An editable production workspace for making films and other videos with AI generation, imported media, and manual editing. It connects an idea to reusable assets, scenes, shots, images, video takes, audio, and finished edits while retaining the relationships between everything.

A creator can describe a complete video once and ask for a rough cut, or perform each production step individually. They can begin with a script, a single shot, a character reference, an image collection, generated footage, or an existing edit. Switching between automatic and manual work never creates a separate project or hides intermediate results.

The central promise is control: the creator can see what exists, what is selected, what depends on what, what will be generated next, and what will change when they revise something.

This document specifies intended product behavior. Features labeled **Design recommendation** explain how to make that behavior easier to understand or more useful. Capabilities supplied by external models are conditional on the selected endpoint supporting them.

## 2. Core concepts

| Concept | Description |
|---|---|
| Project | A film or video production containing its brief, settings, scenes, assets, media, generations, and edits. |
| Scene | An ordered collection of shots sharing a narrative situation or production context. |
| Shot | A planned piece of screen action, with creative intent, references, image/video candidates, and selected takes. |
| Asset | A reusable character, location, prop, vehicle, style, or other recurring element. |
| Asset look | A named appearance or state of an asset, such as a costume, age, damage state, or lighting condition. |
| Asset revision | A recorded change to the definition or references of a particular asset look. |
| Media item | An image, video, or audio file with a stable identity and metadata. |
| Reference binding | A relationship assigning media to an asset, scene, shot, or project for a particular purpose. |
| Generation recipe | The prompt, inputs, model, settings, and contextual information used to request an output. |
| Take | A generated or imported candidate result. Its original media and generation recipe remain unchanged. |
| Selection | The take currently chosen for a particular purpose, such as a shot's opening image or video. |
| Job | One operation being executed, such as image generation, video generation, or export. |
| Workflow run | A connected set of jobs, selections, and optional review steps. |
| Edit | An arrangement of particular takes, trims, transitions, and audio. |

**Design recommendation:** Keep these distinctions in the data model, but introduce them gradually in the interface. Everyday work should revolve around shots, assets, and media. Users should not need to understand a dependency graph to create a video.

## 3. Workspace and navigation

Provide four primary workspaces: **Shots**, **Assets**, **Gallery**, and **Edit**. A persistent project header shows the project name, save state, active jobs, and access to project settings. A jobs drawer remains available from every workspace.

The Shots workspace offers storyboard cards and a table. Assets offers visual cards and a searchable list. Gallery offers a thumbnail grid and a metadata table. Edit offers a preview monitor, media bin, timeline, and inspector.

Selection carries across workspaces. Opening an asset from a shot retains the shot as context. Opening the gallery from a reference picker prefilters relevant media. Back navigation restores the previous selection, scroll position, and filters.

A shared inspector displays the selected item's details without hiding the surrounding work. It supports resizing and docking. The reference gallery can stay beside the shot board or expand to fill the workspace. Previewing media supports fullscreen viewing.

Users can resize thumbnails, choose visible table columns, collapse groups, save views, and use keyboard shortcuts for selection, navigation, undo/redo, playback, and common actions. Multiselection supports range selection, select-all within a filtered result, and explicit bulk actions. Bulk actions state how many items they affect, including whether hidden items are included.

**Design recommendation:** Keep the primary action contextual: “Generate image,” “Animate selected image,” or “Continue workflow.” Put advanced model settings in the inspector. Use status text and icons together; color alone should not communicate failures or approval.

## 4. Project management and persistence

Users can create, name, open, duplicate, archive, and reopen projects. Recent projects show a thumbnail, last-opened time, location, and recovery state. Projects may start blank or from a reusable template containing settings, assets, prompt guidance, and workflow presets.

Project settings include a creative brief, target duration, aspect ratio, delivery resolution, frame rate, default models, visual style, audio preferences, and generation policy. Defaults can be overridden at narrower scopes without duplicating every setting.

Edits autosave. The interface distinguishes saved, saving, unsaved, disconnected, and failed-to-save states. Reopening restores the workspace and project state. Conflicting writes are detected and resolved without silently replacing newer work.

Undo/redo applies to document edits, assignments, selections, ordering, and timeline changes. Named checkpoints capture recoverable project states. Restoring a checkpoint creates a new recoverable state rather than erasing later history. Undoing a generation-related action does not imply that an external paid request has been canceled or refunded.

Project duplication offers either a self-contained copy or shared media references with a clear explanation. Portable project export includes a manifest, media, relationships, prompts, takes, and edits. Reimport preserves stable identities or remaps them consistently.

**Design recommendation:** Use one reliable primary runtime for file access, background jobs, and rendering. If additional runtimes are offered, disclose unavailable operations before a workflow starts. Keep recoverable media for checkpoints; a document snapshot alone cannot recover deleted files.

## 5. Story development and planning

The user can enter a short idea, detailed brief, script, scene outline, or shot list. An AI planning assistant can expand it into scenes, shots, recurring assets, approximate timing, and suggested visual direction.

Planning instructions can specify intended audience, tone, style, pacing, total duration, aspect ratio, number of shots, narration, dialogue, and elements that must appear or must remain unchanged. Empty fields remain optional.

The generated plan is editable. Users can accept the whole plan, selected scenes, selected shots, or asset suggestions only. Regenerating a scene or shot respects locked items and shows proposed changes before replacing deliberate edits. The assistant can shorten a sequence, add a reaction shot, split an overcomplicated shot, or propose missing coverage.

Shot lists can be imported from structured files or pasted structured text. Import supports creating a project, appending scenes, or updating matched items. A preview reports changes, invalid fields, unmatched assets, and missing media. Export includes a machine-readable shot list and a human-readable production document. A schema-and-instructions export lets users prepare compatible plans in an external assistant.

**Design recommendation:** Treat generated plans as drafts. Separate what the user explicitly requested from inferred visual details, and make it easy to revise an inference across all affected shots.

## 6. Scenes and shots

Scenes have names, ordering, summaries, notes, associated assets, reference assignments, and optional defaults. Users can add, duplicate, reorder, merge, split, and remove scenes. Deleting a scene does not immediately destroy its media.

Shots have a stable ID, display number, name, description of on-screen action, camera/framing instructions, dialogue, notes, target duration, asset bindings, reference bindings, and generation settings. They maintain separate image and video recipes and take collections.

Users can add, duplicate, move, reorder, split, archive, and restore shots. Duplicating a shot can copy its creative setup without making copies of media files. Display numbers can change with ordering; stable IDs do not.

A compact shot card displays its selected thumbnail, short description, intended duration, linked assets, selected take, and work status. Expanding it exposes prompts, reference inputs, model choices, and alternatives. Table view supports inline edits and batch assignment of models, assets, durations, and status.

Shots may contain only text, imported stills, generated stills, imported footage, or generated video. A still can serve as an animatic frame without requiring video generation. Multiple images may serve distinct roles such as opening frame, end frame, identity, composition, or style.

Users can filter by scene, asset/look, model, missing media, generation status, review status, outdated inputs, favorites, and inclusion in an edit. Storyboard playback previews the chosen results in order.

**Design recommendation:** Show creative duration and model request duration separately when they differ. For example, a shot may need three seconds in the cut while a selected model generates a longer clip. Do not silently change the intended pacing to match generation options.

## 7. Reusable assets and appearance consistency

The asset library supports characters, environments, props, vehicles, visual styles, and custom categories. Each asset has a stable identity, name, searchable tags, description, concise prompt description, notes, and reference media.

Assets can be created manually, suggested from a script, imported from another project, or created from selected gallery media. Existing assets can be reused in a newly generated plan instead of creating duplicate characters or locations.

An asset can have multiple named looks. A character might have “travel clothes” and “formal uniform”; a location might have “intact daylight” and “damaged night.” Each look has versioned descriptions and references. Shots bind a particular look and revision, or explicitly follow a chosen revision policy.

Reference images can represent front, profile, rear, close-up, expression, costume, material, or detail views. Users can designate preferred references and enable or disable individual images for generation. Different operations may use different reference subsets.

The application can write reference-image prompts and generate reference artwork individually or in batches. Templates vary by purpose: character study, environment establishing image, prop detail, vehicle turntable-style views, or style board. The user can override templates and generate variants from existing references.

Asset usage lists show all associated shots, media, takes, and edits. From an asset, users can create a shot featuring it, add it to selected shots, or generate a shot image using its selected references. From a shot result, users can promote an image or captured detail into an asset reference with provenance retained.

**Design recommendation:** Separate identity from appearance. Changing a costume should not rewrite every earlier shot. Reference consistency is an input strategy; allow human review because a model may still alter identity or details.

## 8. Reference gallery and media organization

The gallery contains imported and generated images, videos, audio, and captured frames. Image-focused reference views can hide other media types. Files are represented once and may participate in many relationships.

Media metadata includes name, type, dimensions, duration where applicable, creation/import date, origin, tags, notes, rating, and linked production items. Generated media additionally links to its take and recipe. Renaming or relocating a file does not break its identity.

Users can upload, drag and drop, choose existing project files, import from another project, and add supported URLs. Generated media appears automatically. Similar filenames can suggest asset associations; the suggestions remain reviewable.

The gallery supports bulk tagging, renaming, assigning, unassigning, adding to assets, marking favorites, archiving, and exporting. Removing a relationship is separate from removing a media item. Permanent deletion reports all uses and offers recovery where supported.

Every media inspector answers:

- Which assets and looks use this reference?
- Which projects, scenes, and shots assign it?
- Which generations actually received it?
- Which outputs were derived from it?
- Which selected takes and edit clips depend on it?

Gallery filters include media type, reference category, tag, asset/look/revision, scene, shot, role, source model/provider, imported/generated origin, rating, selected/rejected state, date range, and direct/inherited use. Users can combine filters with explicit AND/OR behavior and save them as named views.

Grouping supports asset, scene, shot, category, role, tag, and generation family. Sorting supports name, date added, date generated, last used, rating, direct usage count, downstream usage count, and generation cost when known. A media item may appear in multiple relationship groups; counts distinguish unique files from group occurrences.

Provide separate “not assigned,” “never used in a generation,” and “not used in any current edit” filters. A single ambiguous “unused” label is insufficient.

**Design recommendation:** Make relationship chips clickable in both directions. A user should be able to select a reference, see its shots, select a shot, and immediately see its actual inputs without opening several dialogs.

## 9. Reference assignment and input resolution

References can apply at project, scene, shot, or asset-look scope. A binding records the reference, purpose, priority, enabled state, and optional operation scope. Purposes include identity, style, composition, environment, wardrobe, lighting, opening frame, end frame, motion, and audio guidance.

Users can assign one reference to many targets or many references to one target. Add and replace are distinct operations. Inherited references are visible at the shot level and can be excluded locally without changing other shots.

Before a generation, the application resolves all bindings into an ordered input manifest. Explicitly designated frame inputs occupy their required roles. Duplicate files are consolidated where permitted. The chosen model's actual limits determine whether the request is valid.

The preview separates **assigned**, **included in this request**, and **used by this past take**. It shows input roles, positional tokens, source of inheritance, and why an assigned item is excluded. Missing required references block submission. Excess references require an explicit selection policy or user resolution.

**Design recommendation:** Priority should express creative importance, not just insertion order. If combining references into a contact sheet is offered, treat that as a separate, visible operation with its own output and provenance. Do not imply that every model understands all reference-role labels natively.

## 10. Provider and model system

The application supports image, video, and text models through an extensible provider interface. Supported operations may include text-to-image, image editing, text-to-video, image-to-video, reference-to-video, video editing, extension, upscaling, speech, and lip sync.

Each model selection identifies the underlying model, its version when available, the hosting provider, the endpoint, and the operation. The same model hosted by two services may expose different capabilities or prices.

A capability profile records accepted media formats and roles, reference counts, file-size limits, dimensions, aspect ratios, duration rules, prompt limits, negative-prompt support, audio behavior, seeds, output count, and operation-specific constraints. Unknown values are explicitly unknown. Recommended values are distinct from hard limits.

The model picker can filter by required capabilities, provider, price basis, speed preference, and known compatibility with the current inputs. The settings interface adapts to the selected endpoint. Advanced users can enter custom model identifiers, configure documented parameters, and install or define provider adapters.

Provider adapters handle credentials, request formatting, media transfer, asynchronous status, cancellation when supported, downloading outputs, and normalized errors. Extensibility to arbitrary APIs requires an adapter or compatible schema; a model name alone cannot establish compatibility.

Defaults resolve predictably: an explicit operation override wins, followed by shot or asset settings, then scene or asset-category defaults where applicable, then project defaults. Each effective value shows where it came from. Clearing an override restores inheritance.

**Design recommendation:** Changing models should show a compatibility summary: which settings change, which inputs no longer fit, and whether the prompt needs adapting. Preserve the user's creative intent and offer explicit choices instead of silently dropping inputs or choosing another model.

## 11. Model-specific prompting knowledge

The system maintains editable prompting profiles for model versions and operation types. These profiles explain how to express visual content, motion, camera behavior, timing, transitions, reference use, dialogue, and audio for that model.

A profile contains recommended structure, examples, supported controls, common failure modes, misleading phrasing to avoid, and guidance on balancing complexity against clip duration. Image-to-video guidance can differ from text-to-video guidance for the same model.

Rules distinguish provider documentation, measured local observations, and user preferences. Documented rules include a source and verification date. Experimental guidance includes context and confidence. Profiles can be updated without altering the recorded recipes of prior takes.

Users can inspect and edit profiles, create personal variants, reset changes, and assign profiles to models. They can annotate results with issues such as identity drift, missed action, incorrect camera motion, or unwanted cuts. Those observations can inform future suggestions without silently becoming universal rules.

**Design recommendation:** Add a small evaluation library: reusable shot briefs, reference sets, and human ratings for comparing prompting strategies. “Works best” should be supported by documented guidance or observed results, and should remain sensitive to model version and task.

## 12. Prompt authoring and compilation

Users can write prompts directly or ask an AI assistant to draft them from the shot description, camera setup, dialogue, notes, asset bindings, and neighboring shots. They control how much context is included.

Image and video prompts are separate. Asset-reference prompts are separate from shot prompts. Reusable snippets support frequently used visual directions. Project-wide style guidance can apply to many shots, with local exclusions and overrides.

Asset mentions are inserted through autocomplete or chips and resolve to stable asset identities. Human-readable tags may be displayed in text, but renaming an asset must not break its references. The compiler inserts the relevant asset description and creates model-specific input references where needed.

The prompt editor offers a brief view, a compiled-prompt view, and an exact-request preview. The user can inspect which text came from the shot, style instructions, assets, snippets, and model guidance. Warnings identify unresolved mentions, contradictory settings, overlong prompts, and unsupported inputs.

Users can edit the final prompt directly and lock it. Later changes to inputs mark it as potentially needing review rather than replacing it silently. Recompilation shows a diff and can preserve deliberate overrides. Prompt recipes can be saved as reusable templates with documented placeholders.

**Design recommendation:** Keep one clear creative brief and derive technical prompts from it. Avoid requiring the same description to be manually maintained in several fields. Keep every layer inspectable without forcing every layer onto the default screen.

## 13. Image generation and editing

Image generation can target an asset reference, a shot still, an opening/end frame, or an unassigned gallery image. Users choose compatible inputs, model, resolution, aspect ratio, number of candidates, and supported advanced settings.

Generation can run once, in batches, or as part of a workflow. Results arrive as separate takes, with thumbnails and full-resolution preview. Users can compare, rate, reject, select, duplicate a recipe, or create a variation. Editing an image through a model produces a derived take and retains the source.

Image inputs may be uploaded, chosen from the gallery, selected from another shot, or captured from video. Derived frames record their source video and timestamp. Generated images can become reusable asset references without losing their original relationship to a shot or generation.

**Design recommendation:** Separate generating candidates from choosing a winner. Automatic selection should follow a visible policy and label the result provisional until reviewed when review is enabled.

## 14. Video generation, continuation, and revision

Users can generate video from a shot description, an image, supported reference sets, or an existing clip. Inputs may include opening/end frames, identity references, motion-reference video, and reference audio when supported.

Settings include requested duration, output dimensions, audio behavior, and endpoint-specific controls. The system validates combinations, not just individual fields. A compatible model can generate a shot directly without a mandatory intermediate still.

Video candidates support playback, scrubbing, looping, comparison, rating, rejection, selection, and recipe reuse. Frame capture allows a chosen moment to become a reference, an asset image, or the start of another shot. A video-edit operation produces a new take linked to the original.

Continuous-sequence workflows support two modes: following an existing shot sequence, or inventing successive actions within standing creative instructions. Users choose the starting frame or clip, continuation count, duration, contextual history, and persistent anchor references. Each continuation records its predecessor and source frame.

Users can branch at any clip, replace a continuation, regenerate the dependent tail, or stop after any segment. The application can assemble the chosen chain into a preview.

**Design recommendation:** Describe this feature as “Continue from frame” or “Continuous sequence.” Show potential continuity issues between segments and provide review points; last-frame conditioning alone does not guarantee seamless motion or stable identity.

## 15. Takes, versions, comparison, and provenance

Every generated take records the exact prompt, model/provider identifiers, known model version, inputs and roles, source asset revisions, settings, seed when available, prompt-profile version, timestamps, job IDs, and cost information. Imported takes record their origin and mark unavailable generation metadata as unknown.

Take recipes and original media are immutable. Renaming, rating, notes, and selection are editable annotations. A modified recipe creates a new take or branch. Users can organize candidates into named groups without losing individual history.

Image comparison supports side-by-side and overlay/wipe where appropriate. Video comparison supports synchronized playback where durations permit. A recipe diff explains which inputs or settings changed between takes.

Selection is explicit for each purpose. Selecting a new still does not delete the earlier still or its derived videos. Selecting a new video does not automatically replace pinned clips in saved edits. Users can restore an earlier selection at any time.

**Design recommendation:** Keep favorites, approval, selection, and freshness separate. A favorite may be outdated; an approved take may intentionally use an earlier asset look; a selected take may still be awaiting review.

## 16. Change impact and consistency management

The application tracks dependency relationships from references and asset revisions through recipes, takes, and edits. When a meaningful input changes, it can identify potentially affected outputs and explain the reason.

Changes include asset descriptions, references, shot intent, prompt snippets, global style instructions, model settings, prompt profiles, and source-image selections. Presentation-only changes, such as renaming a folder, should not trigger creative staleness.

An impact preview lists affected shots and takes, whether they are selected or approved, and whether they appear in an edit. Users can update selected bindings, preserve pinned revisions, create a branch, dismiss an intentional mismatch, or regenerate chosen outputs.

Freshness is relative to a specified recipe or revision policy. A take remains a valid historical result even if newer inputs exist. Regeneration never overwrites the old take.

**Design recommendation:** Use “Inputs changed” with a concrete reason rather than a vague warning badge. Provide “Show what changed” and “Update these shots” actions. Avoid turning every global edit into an unexplained wall of warnings.

## 17. One-instruction and step-by-step workflows

A user can describe a video and choose a destination: plan, asset references, storyboard, generated shots, or rough cut. The workflow determines missing dependencies and uses existing approved materials where appropriate.

A complete run may perform planning, asset identification, asset-reference generation, shot creation, prompt compilation, shot-image generation, take selection, video generation, audio preparation, and rough-cut assembly. Stages may be skipped when unnecessary or already satisfied.

The same operations are individually accessible. Users can run only assets, generate one shot, stop after images, animate selected approved stills, or assemble imported footage. They can pause a workflow, edit an intermediate item, and continue from the affected stage.

Run policies specify target scope, model choices, maximum spend, candidate count, concurrency, review points, retry policy, and whether automatic selections are provisional. Fully automatic mode follows the chosen policy; guided mode pauses at designated checkpoints.

The plan preview shows intended work, reused inputs, dependencies, known cost estimates, and unknown costs. After planning reveals additional shots, the estimate is updated and checked against the run budget. An unknown estimate is never displayed as zero.

**Design recommendation:** Present automation as “Continue to…” from the current state. Use the same records and commands for manual and automatic work, so automation remains interruptible and inspectable.

## 18. Jobs, batches, failure recovery, and costs

Jobs show queued, running, waiting for provider, waiting for review, paused, completed, failed, canceled, and uncertain states. Progress is reported only at the granularity actually available. The jobs drawer links directly to affected assets or shots.

Batch operations support current selection, filtered results, missing outputs, outdated selected outputs, and explicit lists. Jobs can continue while the user edits unrelated work. Each submitted job captures its inputs so later edits do not silently change an in-flight request.

Pausing stops new submissions. Cancellation distinguishes stopping local scheduling from confirmed remote cancellation. Unsupported remote cancellation is stated clearly. Dependent jobs wait for successful prerequisites; unrelated jobs may continue after a failure.

Job state and provider IDs persist across restarts. Recovery checks existing remote jobs before submitting replacements. Retries distinguish transient failures from invalid inputs and account errors. Uncertain submission outcomes are reconciled where possible to avoid duplicate charges.

Cost reporting separates estimates, reported charges, and unknown amounts. Users can view totals by run, shot, asset, provider, and project. Spending limits stop new work according to policy without falsely claiming already-submitted requests can be unbilled.

**Design recommendation:** A workflow with failures should finish as “Completed with issues,” not an undifferentiated success. Provide targeted retry and explain exactly what remains blocked.

## 19. Dialogue, audio, and lip sync

Shots can store dialogue text, speaker/asset association, delivery notes, and audio clips. Users can upload recordings and use compatible speech-generation integrations. Original audio remains available when a processed version is created.

Supported lip-sync operations combine a selected video and dialogue audio into a new take. The result retains links to both sources. Duration mismatches are shown before processing, with explicit choices where trimming or padding is supported.

Generated video audio can be retained, muted, detached, or replaced in the edit. Music, voiceover, ambience, and sound effects can be imported and organized. Audio files can also serve as model references when the endpoint accepts them.

**Design recommendation:** Keep dialogue intent, source recording, generated speech, and synchronized output distinguishable. A new video take should not silently replace a carefully edited audio track.

## 20. Timeline and rough-cut editing

An edit can be built from selected shots, a selected scene, or manually chosen media. Images act as still clips with editable duration. Video clips point to specific takes and retain source in/out points.

Users can insert, reorder, trim, split, duplicate, remove, and restore clips. Transitions include cuts, cross dissolves, and dips to black with editable duration. The application validates transitions against available media and displays the actual sequence duration.

Audio supports multiple tracks, clip placement, trims, gain, mute, solo, fades, and linking/unlinking with picture. Moving a linked picture clip moves its linked audio according to a visible policy. Users can detach and independently edit sound.

Playback supports scrubbing, seeking, frame stepping, timeline zoom, looping, and source/sequence preview. Proxy media improves responsiveness while full-quality originals remain the render source. Cache controls show status, storage use, and rebuilding options.

When shot order or selections change, the edit offers a reconciliation preview. Users choose whether to add new shots, update takes, preserve trims, or retain the current cut. Edits can be duplicated and named for alternate versions.

**Design recommendation:** Pin clips to takes by default. Offer an explicit “follow shot selection” option for exploratory cuts. Focus on reliable assembly and continuity review; advanced finishing can use an external editor.

## 21. Rendering and delivery

Users can render a scene, a selected range, a continuous sequence, or a full edit. Output settings include container/codec presets, dimensions, frame rate, audio settings, and quality. Aspect-fit behavior such as crop, fit, or padding is explicit.

Simple concatenation is available for selected shot videos without building a detailed edit. Full rendering uses the edit's trims, transitions, audio, and overlays. Watermarks can be configured with image, position, scale, and opacity where supported.

Render jobs run in the background with progress, failure details, output location, and playback after completion. Exported media identifies the edit version that produced it.

Delivery can include a final video, selected takes, all takes, a readable scene/shot folder structure, shot sheets, prompt/recipe records, or a complete portable project. Editor interchange is supported through explicitly tested formats, with any unsupported effects reported.

**Design recommendation:** Include a delivery manifest that identifies missing files and unsupported interchange features. Users should be able to understand and recover their work outside the application.

## 22. File management and storage

Projects maintain stable media identities independent of filenames. The application can locate media, reveal files in the operating system, relink moved files, detect duplicates, and organize files into readable folders.

File organization provides a preview and updates stored paths consistently. References to the same file do not require duplicate physical copies. Importing from another project preserves attribution and relationships where possible.

Storage tools distinguish original media, generated takes, proxies, temporary downloads, and exports. Cleaning previews can remove rebuildable caches separately from valuable media. Orphan detection accounts for historical takes and checkpoints as well as current selections.

**Design recommendation:** Archive before permanent deletion, and make cleanup a deliberate maintenance operation. A rejected take can still be useful history or the parent of another result.

## 23. Settings and customization

Settings cover provider connections, credentials, model defaults, asset-category defaults, generation parameters, prompt templates, prompting profiles, snippets, workflow policies, concurrency, storage, cache limits, and export presets.

Application preferences are distinct from project settings. Project exports include reproducibility settings but exclude secrets. Credentials are stored through the selected runtime's protected mechanism and are not embedded in prompts or job logs.

Each inherited setting shows its effective value and origin. Users can reset a field, a group, or a whole profile to defaults. Advanced parameters are available without overwhelming ordinary generation forms.

**Design recommendation:** Offer a useful default path that requires only a brief, a model connection, and a generate action. Customization should deepen control as needed rather than become mandatory setup.

## 24. API and MCP support

The application exposes structured operations through an API and an MCP server. External assistants can inspect the same project state and perform the same meaningful actions as the user interface.

Read operations include listing/searching projects, scenes, shots, assets, references, takes, models, jobs, and edits; retrieving recipes; explaining dependencies; and reporting changes, costs, and missing work.

Write operations include creating/updating plans and assets, linking references, compiling prompts, creating workflow plans, starting jobs, selecting takes, applying reviewed changes, assembling edits, and exporting results. Long-running operations return job IDs and can be monitored independently.

Tools use stable IDs and structured results. Mutations support expected revisions to detect conflicting edits. Paid submissions support idempotency keys. Requests respect project access, run limits, and the selected review policy. Agent activity appears in normal project history with affected items visible.

An optional MCP-client integration can call external generation or media tools. Returned media is imported with provenance; unavailable external recipe details remain explicitly unknown.

**Design recommendation:** Provide previewable, high-level tools such as “plan regeneration for these shots” rather than requiring an assistant to manipulate internal storage. UI and agent actions must use the same validation and execution services.

## 25. End-to-end examples

### A. One instruction to a rough cut

The creator requests a thirty-second scene about an explorer discovering a moving star map. They specify visual style, aspect ratio, preferred providers, and a spending ceiling. The system proposes the explorer, observatory, star-map prop, and a shot list; creates missing references; produces stills and motion; and assembles a rough cut under the chosen review policy. Every asset, prompt, take, and edit remains available for revision.

### B. Assets first

The creator imports twelve character and location images, organizes them into asset looks, and chooses the most useful identity references. They create six shots using these assets, generate only storyboard stills, choose preferred takes, then animate selected shots. Gallery queries show exactly which references were used.

### C. A selective appearance change

The creator adds an injured look for a character in the final two shots. The system preserves earlier appearances, previews the two affected bindings and their downstream results, generates new takes, and offers to update only the corresponding edit clips. The prior cut remains available.

### D. Footage first

The creator imports a video, captures a frame, creates a reusable location asset from it, and generates a continuation. The original footage and generated material can coexist in an edit, with the captured frame's origin traceable.

### E. Agent-assisted revision

An external assistant is asked to find shots using an outdated prop reference and propose updates. Through MCP it returns a change plan and estimate. It applies or runs the plan according to the user's established execution policy. The creator sees the same jobs, new takes, and impact report in the interface.

## 26. Product-level acceptance criteria

The product is complete when the following behaviors work together:

1. A single brief can produce an editable rough cut, and each intermediate stage can also be performed independently.
2. Users can start from imported assets or footage without completing unrelated earlier stages.
3. Two substantially different provider integrations demonstrate that settings, prompts, reference roles, and validation adapt to the selected endpoint.
4. Adding a provider does not require redesigning shot, asset, gallery, or edit behavior.
5. Every reference can reveal its asset associations, shot assignments, actual generation uses, and downstream edit uses.
6. Gallery filters and sorting can answer specific relationship questions without manual inspection of every image.
7. Asset appearance changes can affect selected shots while preserving earlier looks and historical outputs.
8. Every take retains its exact known recipe and inputs; unavailable metadata is marked unknown.
9. A selected take can differ from the newest take, and an edit can retain a take after the shot selection changes.
10. The application explains why an output is outdated and can regenerate only chosen dependent work.
11. Manual and automated work create the same editable records and can be freely interleaved.
12. Restarting during generation recovers known job state without blindly resubmitting paid requests.
13. Invalid or over-capacity requests are resolved before submission; unknown costs are not presented as free.
14. A failed job does not conceal successful work or block unrelated shots.
15. Timeline preview and export agree on timing, selected media, transitions, and audio.
16. Undo, checkpoints, take history, and edit versions remain distinct and recoverable.
17. API/MCP operations produce the same validation, history, and results as equivalent interface actions.
18. A portable export preserves media and enough relationships to reconstruct the production.

## 27. Recommended implementation sequence

First establish shots, assets, media identity, relationships, take selection, and edit pinning using imported files. Validate that creators can understand and navigate these relationships at a glance.

Next complete one generation workflow from asset references through a shot image, video, and rough cut, including durable jobs and provenance. Add a second provider with different capabilities to test the abstraction.

Then introduce model-specific prompting profiles, batch execution, automatic planning, selective regeneration, and MCP over the same operations. Extend audio, continuous sequences, and external-editor delivery after the core workflow is coherent.

The guiding design test throughout is: can the creator understand what they are about to change, perform the change, and see its consequences without losing their place or their previous work?
