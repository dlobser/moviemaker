# MovieMaker roadmap

Drafted November 6, 2026. This records the priorities set on that date and maps them onto the staged restructure in `SCHEMA_V2.md`. The six decisions in `SCHEMA_V2.md` §9 were accepted as recommended. This file supersedes `PLAN.md`, whose phases are either landed or folded in here.

## Priorities, in order

1. **The reference → asset → shot flow must be clear and fluid.** At any shot you can see what prompts and attachments are going where, and edit them in place.
2. **MCP.** Drive MovieMaker from Claude, ChatGPT and Gemini through their own subscription logins instead of paying per token for LLM APIs. Same approach as the Novel project's kids-book server (`C:\_Main\projects\web\Novel\mcp\server.mjs`).
3. **A compact, app-first interface.** Adobe and ArtCraft density, not a website.
4. **Bigger shot thumbnails with a hover preview.** Done in the current app on November 6; the component carries into the new shot card.

## 1. The flow: references → assets → shots

### The three questions every screen answers

For any shot, operation and model, the interface separates:

- **Assigned**: what is attached here, directly or by inheritance from the scene, the project or an asset look.
- **Included**: what will actually be sent on the next generate, in slot order, after capacity and enable flags.
- **Used**: what was sent for the take currently selected or being looked at.

Today these are smeared across `composeGenerationPrompt`, `refResolver.js`, `resolveShotReferences` and the group's `inputImagePaths`. The fix is structural, not cosmetic.

### One resolver, three consumers

```
resolveInputs(state, { shotId, operation: 'image' | 'video', model }) → {
  slots:    [ { slot, token, mediaId, role, enabled,
                via: { kind: 'look' | 'binding' | 'explicit' | 'frame' | 'selection',
                       assetId?, lookId?, scope?, bindingId?, sourceTakeId? } } ],
  excluded: [ { mediaId, via, reason: 'capacity' | 'disabled' | 'unsupported-kind' | 'excluded-here' | 'duplicate' } ],
  capacity: { used, max, kinds },
  prompt:   { text, segments: [ { text, origin: { kind: 'shot' | 'asset' | 'pre' | 'post' | 'snippet' | 'override' | 'profile', id, field } } ] }
}
```

The shot inspector draws it, the MCP tool `explain_inputs` returns it, and the generation path sends exactly it and stores it on the take as `inputs`. One function, so the three never disagree. It is the schema's §9 plus §12 of the product spec in one place and reuses the existing resolver code with origins added.

### Shot inspector: the Inputs panel

- Slots in send order with their numbered tokens. Each chip shows thumbnail, name and an origin badge: "Mara / Default · primary", "Scene 2 · style", "Board · subject", "Frame from Shot 3".
- Inline controls on the chip: enable toggle, drag to reorder, and × which excludes the item for this shot only. Excluding never edits the asset, the board or the scene.
- A "Not sent" list under the slots, each with its reason and the one-click fix for that reason: raise priority, enable, or choose which to drop.
- "+" opens the picker prefiltered to this shot's assets and the board; from the picker an item can be assigned at shot, scene or project scope with add and replace as distinct actions.
- A capacity meter for the selected model (n of N image slots, audio and video slots when the model takes them) that updates live when the model changes, with the inputs that would fall off highlighted before anything is generated.

### Prompt view: compiled, with origins

- The compiled prompt is rendered as segments. Hovering a segment names its origin; clicking jumps to and focuses the source field (the shot description, the asset's shot description, a pre or post slot, a snippet).
- Three tabs in the same inspector, not three panels: **Brief** (what you wrote), **Compiled** (what goes out), **Request** (the exact inputs and settings).
- Override mode locks the compiled text. When inputs or sources change afterwards, the prompt is marked "needs review" with a diff, never replaced.

### Asset panel: looks and usage

- Looks as tabs. Each image shows primary, enabled and view. "Used by" lists shots by look.
- Editing a look's shot description bumps its revision and shows the impact: "4 shots have takes at revision 2", with show, regenerate selected, or keep.
- From an asset: add to selected shots, or create a shot featuring it.

### Reference board: relationships both ways

- Selecting a reference shows clickable chips: assets and looks, scenes and shots it is assigned to, takes that actually used it, clips in the edit that resolve to it. Selecting a shot while the board is docked highlights that shot's references.
- Three distinct filters, never one "unused": not assigned, never used in a generation, not in the current edit. Plus by asset or look, scope, role, origin.

### Editing rules that make it fluid

- Every change applies immediately; undo covers it. No modal save buttons.
- Inherited items are drawn greyed with their scope label. Local exclusion never edits the parent.
- When a model takes fewer inputs than are assigned, the interface asks which to keep and remembers the answer on the shot. Nothing is dropped silently.
- Selection carries across views: shot → its assets and references; reference → its shots and takes.

## 2. MCP

### What the Novel server does, and is reused

`mcp/server.mjs` in the Novel project is an MCP server with 25 tools over a file store. Launched without flags it serves stdio MCP (Claude Desktop starts it) plus an HTTP bridge on `127.0.0.1:7801`; with `--http-only` it serves Streamable HTTP MCP at `/mcp/<token>` so ChatGPT can reach it through a `cloudflared` tunnel. It has a CORS allowlist, a DNS-rebinding guard, an SSE channel (`/api/events`) so the web page reloads when a tool writes, and a store with `rev` plus a 409 conflict. The chat app does the writing (`get_writing_brief` → `write_story`); image generation still uses the configured providers.

### What is different for MovieMaker

- **MovieMaker already has a server that owns the project.** `server.js` holds the project file, the revision guard (`GET /api/state/revision`, 409 on a stale save), the `assets/` layout and FFmpeg. The MCP server must not grow a second store. Mount `/mcp` into `server.js` (Streamable HTTP) and add a small `mcp/stdio.mjs` entry that imports the same service functions in-process. Both call the pure `project/commands.js` from `SCHEMA_V2.md` §6 and save through the same revision guard, so a tool and a click produce the same validated record and the same history entry (product spec §24).
- **The browser has to notice external writes.** The UI already polls nothing; it will subscribe to an SSE channel (or poll `/api/state/revision`, which exists) and reload the document when a tool bumps the revision, exactly as the Novel page does.
- **Clients.** Claude Desktop and Claude Code: stdio, local, no tunnel. Claude.ai custom connectors and ChatGPT connectors: HTTPS only, so a `cloudflared` tunnel plus the path token, as in Novel. Gemini CLI: stdio or HTTP. Whether the Gemini consumer app accepts a custom MCP server has to be verified when this is implemented; do not assume it.
- **"OAuth" here means the chat app's own login.** The MovieMaker endpoint itself is protected by the path token, which is enough for one person behind a tunnel. Real OAuth on the MovieMaker endpoint only matters if it is ever hosted for more than one user, and is out of scope.
- **What the assistant replaces, and what it does not.** It replaces the LLM stages: script to shot list, auto prompts, asset descriptions, Dream's "what happens next". It does not replace image and video provider keys (Fal, Atlas, Higgsfield, …), which stay necessary and billed. The in-app LLM path stays available for people without a chat subscription.
- **An LLM-facing contract already exists.** `buildLlmImportPrompt` and `normalizeImportedShotList` define the shot-list JSON MovieMaker imports today. A `get_shot_list_brief` tool returns that prompt and schema; `import_shot_list` ingests the assistant's JSON through the same normalizer. These two tools cost almost nothing and deliver the biggest win first.

### Tool set, first cut

| Area | Tools |
|---|---|
| Project | `list_projects`, `open_project`, `get_project` (scenes, shots, assets, counts, what is missing) |
| Story | `get_shot_list_brief`, `import_shot_list`, `add_shot`, `update_shot`, `reorder_shots` |
| Assets | `list_assets`, `upsert_asset`, `upsert_look`, `add_look_image`, `get_asset_usage` |
| References | `list_media`, `add_reference` (path or URL), `bind_reference`, `unbind_reference` |
| Prompts and inputs | `explain_inputs`, `compile_prompt`, `set_prompt` (with override flag) |
| Generation | `generate_image`, `generate_video`, `generate_asset_image`, `get_job`, `list_jobs`, `cancel_job` |
| Takes | `list_takes`, `select_take`, `rate_take`, `view_take` (returns a thumbnail as image content) |
| Edit and render | `assemble_edit`, `render_edit`, `concatenate_shots` |

Every mutation accepts an optional `expectedRevision`. Generation tools return a job id and the known cost estimate, with "unknown" where it is unknown. Read tools are annotated read-only so clients can call them without confirmation.

### Sequencing

Write tools wait for `commands.js` (`SCHEMA_V2.md` §6 step 3), because they must share validation with the interface. Read tools and the two shot-list tools can ship earlier against the v1 document, since `normalizeImportedShotList` already exists and the import path is unchanged by the schema.

## 3. Compact, app-first interface

### Principles, taken from Adobe- and ArtCraft-style tools

- **A persistent frame.** The page never scrolls; panels do. Top bar: workspace tabs (Shots, Assets, Gallery, Edit), project name and save state, jobs indicator. Left rail: navigator (scenes and shots, or the asset list). Centre: board, grid or timeline. Right: inspector, resizable between about 320 and 480 px. Bottom: jobs drawer, or the timeline in Edit.
- **Density.** 12 to 13 px interface type, 24 to 28 px rows, a 4/8 px spacing grid, 1 px borders, 2 to 4 px radii, icon toolbars with tooltips and shortcut hints. The current theme's neon shadows, 14 to 20 px radii, page gradients and blur go.
- **Chrome.** Dark neutral greys in the `#1e1e1e` to `#2d2d30` range, one accent for selection and focus, status shown by icon plus text, never colour alone. A light theme stays available but is not the design target.
- **Everything edits in place.** Click-to-edit text, scrub-to-change numbers for durations, multi-select with bulk edit in the table view, no modal forms for routine work.
- **Keyboard first.** Arrows select, Enter expands, G generates, I and V pick image and video takes, Space plays, Ctrl+Z undoes, Ctrl+F filters the current list.
- **A context-sensitive inspector.** Shot: Brief, Inputs, Prompt, Takes tabs. Asset: Looks, Usage. Reference: Relationships. The inspector never hides the board.

### Tokens

A `tokens.css` replaces the `:root` block in `index.css`: `--ui-font-size: 12px`, `--row-h: 26px`, `--space-1` to `--space-4` as 4/8/12/16, `--radius: 3px`, `--panel-bg`, `--panel-border`, `--input-bg`, `--accent`, `--text-1`, `--text-2`, `--text-3`. Components use only tokens, so density can be tuned in one file.

### Implementation

This happens during the App split (`SCHEMA_V2.md` §6, after step 4), one workspace at a time, starting with Shots because priority 1 lives there. The current `App.jsx` keeps running for the workspaces not yet replaced.

## 4. Shot thumbnails

Collapsed shot rows showed 50 × 30 px thumbnails. They are now 96 × 54, and hovering one for 150 ms opens a 480 px floating preview (image, or a looping muted video) beside it; double-click still opens the full zoom viewer. The component is `frontend/src/HoverPreview.jsx` and the storyboard grid uses it too. The new shot card will keep it.

## Order of work

1. Schema v2 modules, migration and tests (`SCHEMA_V2.md` §6 steps 1 and 2).
2. `commands.js` and `selectors.js`; the App's write sites, then read sites, converted (steps 3 and 4).
3. `resolveInputs` with origins; takes store the manifest they ran with.
4. MCP: `get_shot_list_brief` and `import_shot_list` plus read tools first; write tools once `commands.js` exists; SSE reload in the browser.
5. The Shots workspace rebuilt compact with the Inputs panel and prompt origins; then Assets with looks, Gallery with relationships, Edit.
6. Impact preview, clip pinning in the interface, the server-side in-flight job ledger.
