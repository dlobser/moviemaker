// Shot-list import: the schema an LLM should emit, the prompt that asks for it,
// and the normaliser that turns whatever comes back into studio state.

import { IMAGE_MODELS, VIDEO_MODELS, LLM_PROVIDERS } from './catalog.js';
import { ASSET_TYPES } from './promptTags.js';
import { DEFAULT_IMPORT_INTRO } from './prompts.js';

export const SHOT_LIST_SCHEMA_VERSION = 1;

/** Every field the importer understands, documented for the LLM prompt. */
const SCHEMA_EXAMPLE = `{
  "schemaVersion": 1,
  "project": {
    "name": "The Ash Lands",
    "prePrompt": "cinematic film still, shot on 35mm anamorphic,",
    "postPrompt": ", volumetric lighting, ultra detailed, 8k",
    "videoPrePrompt": "",
    "videoPostPrompt": ", smooth cinematic camera motion",
    "imageSystemPrompt": "You are a cinematographic prompt engineer. Output ONLY the final visual prompt.",
    "videoSystemPrompt": "You are a cinematographic prompt engineer. Output ONLY the final motion prompt.",
    "activeLlm": "gemini",
    "llmModel": "gemini-2.5-flash",
    "imageModel": "fal-ai/flux/dev",
    "imageResolution": "16:9",
    "videoModel": "fal-ai",
    "videoResolution": "1280x720",
    "videoDuration": "5"
  },
  "assets": [
    {
      "tag": "Ralph",
      "type": "character",
      "name": "Ralph Mercer",
      "description": "grizzled mechanic in his 60s, oil-stained canvas overalls, deep smile lines, close-cropped grey beard"
    },
    {
      "tag": "Garage",
      "type": "environment",
      "name": "Mercer's Garage",
      "description": "cramped 1970s auto shop, hanging work lamps, tool pegboard, dust in the air"
    }
  ],
  "promptSnippets": [
    { "name": "Establish", "text": "wide establishing shot, scale detail" }
  ],
  "scenes": [
    {
      "name": "Act 1 - Cold Open",
      "number": 1,
      "shots": [
        {
          "name": "1.1 - The Dawn",
          "setup": "Extreme close-up macro, EXT. CLIFFSIDE - DAWN. Low-angle rack focus.",
          "description": "Ash falls on tafoni sandstone in golden morning light.",
          "dialogue": "Narrator: 'Long ago, the ash lands lay quiet.'",
          "notes": "Should feel still and patient.",
          "imagePrompt": "<Ralph> stands in <Garage>, backlit by a single work lamp, dust motes drifting",
          "videoPrompt": "slow push in on <Ralph> as he wipes his hands, dust drifting through the light",
          "imageModel": "fal-ai/flux/dev",
          "imageResolution": "16:9",
          "videoModel": "fal-ai",
          "videoResolution": "1280x720",
          "videoDuration": "5"
        }
      ]
    }
  ]
}`;

/**
 * The text behind the "Copy LLM Prompt" button. Includes the live model
 * catalog and the project's existing asset tags so the LLM writes prompts that
 * reference assets that actually exist.
 */
export function buildLlmImportPrompt({ assetLibrary = [], sourceMaterial = '', intro = '' } = {}) {
  const imageModelList = IMAGE_MODELS
    .map(m => `  - "${m.id}" — ${m.label}${m.refImages ? ` (accepts up to ${m.refImages} reference image${m.refImages === 1 ? '' : 's'})` : ''}`)
    .join('\n');
  const videoModelList = VIDEO_MODELS
    .map(m => `  - "${m.id}" — ${m.label}`)
    .join('\n');
  const llmList = LLM_PROVIDERS.map(p => `  - "${p.id}" — ${p.label}`).join('\n');
  const assetTypeList = ASSET_TYPES.map(t => `"${t.id}"`).join(', ');

  const existingAssets = assetLibrary.length > 0
    ? assetLibrary
      .map(a => `  - <${a.tag}> (${a.type || 'character'}): ${a.name || a.tag}${a.description ? ` — ${a.description}` : ''}`)
      .join('\n')
    : '  (none yet — invent the assets this story needs and list them in "assets")';

  return `${intro || DEFAULT_IMPORT_INTRO}

=== SCHEMA ===
${SCHEMA_EXAMPLE}

=== ASSET TAGS ===
Anywhere in an "imagePrompt" or "videoPrompt" you may reference an asset by
wrapping its tag in angle brackets, e.g. <Ralph>. On generation the studio
substitutes the asset's name and description into the prompt AND uploads that
asset's reference image to any model that accepts image inputs — this is how
character consistency is maintained across shots.

Tags must be a single word (letters, digits, _ or -), and every tag used in a
prompt must exist in the "assets" array.
Valid asset "type" values: ${assetTypeList}.

Assets already defined in this project (reuse these tags, do not redefine them):
${existingAssets}

=== AVAILABLE IMAGE MODELS ===
${imageModelList}

=== AVAILABLE VIDEO MODELS ===
${videoModelList}

=== AVAILABLE LLM PROVIDERS ===
${llmList}

=== SOURCE MATERIAL ===
${sourceMaterial || '<<< PASTE YOUR SCRIPT, TREATMENT OR SHOT LIST HERE >>>'}
`;
}

let idCounter = 0;
function makeId(prefix) {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Turn an imported document into studio-shaped state.
 *
 * Accepts both the rich shot-list schema above and the legacy export format
 * (bare `scenes`/`shots` with no `project` block), so old project_state.json
 * files still import cleanly.
 *
 * Returns { project, assets, promptSnippets, scenes, warnings }.
 */
export function normalizeImportedShotList(raw) {
  const warnings = [];
  if (!raw || typeof raw !== 'object') {
    throw new Error('Imported file is not a JSON object.');
  }

  // --- project settings ---
  const projectSource = raw.project && typeof raw.project === 'object' ? raw.project : raw;
  const project = {};
  const passthrough = [
    'name', 'prePrompt', 'postPrompt', 'videoPrePrompt', 'videoPostPrompt',
    'imageSystemPrompt', 'videoSystemPrompt', 'activeLlm', 'llmModel',
    'imageModel', 'imageResolution', 'videoModel', 'videoResolution', 'videoDuration'
  ];
  passthrough.forEach(key => {
    if (typeof projectSource[key] === 'string' && projectSource[key] !== '') {
      project[key] = projectSource[key];
    }
  });
  // Legacy exports stored the image provider separately from the model id.
  if (!project.imageModel && typeof raw.activeImageGenerator === 'string') {
    project.imageModel = raw.activeImageGenerator;
  }

  // --- assets ---
  const assets = [];
  const seenTags = new Set();
  (Array.isArray(raw.assets) ? raw.assets : []).forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const tag = asString(entry.tag || entry.name).trim().replace(/^<|>$/g, '');
    if (!tag) {
      warnings.push(`Asset #${index + 1} has no tag and was skipped.`);
      return;
    }
    const key = tag.toLowerCase();
    if (seenTags.has(key)) {
      warnings.push(`Duplicate asset tag "${tag}" — only the first was kept.`);
      return;
    }
    seenTags.add(key);

    const images = Array.isArray(entry.images) ? entry.images.filter(p => typeof p === 'string') : [];
    const inputImages = Array.isArray(entry.inputImages)
      ? entry.inputImages.filter(p => typeof p === 'string' && images.includes(p))
      : [];
    assets.push({
      id: makeId('asset'),
      tag,
      type: asString(entry.type, 'character'),
      name: asString(entry.name, tag),
      description: asString(entry.description),
      images,
      primaryImage: asString(entry.primaryImage) || images[0] || null,
      inputImages
    });
  });

  // --- prompt snippets ---
  const promptSnippets = (Array.isArray(raw.promptSnippets) ? raw.promptSnippets : [])
    .filter(s => s && typeof s === 'object' && s.name && s.text)
    .map(s => ({ id: makeId('snip'), name: asString(s.name), text: asString(s.text) }));

  // --- scenes & shots ---
  let sceneSource = Array.isArray(raw.scenes) ? raw.scenes : null;
  if (!sceneSource && Array.isArray(raw.shots)) {
    sceneSource = [{ name: 'Scene 1', shots: raw.shots }];
  }
  if (!sceneSource || sceneSource.length === 0) {
    throw new Error('No "scenes" (or legacy "shots") array found in the imported file.');
  }

  const scenes = sceneSource.map((rawScene, sceneIndex) => {
    const rawShots = Array.isArray(rawScene?.shots) ? rawScene.shots : [];
    if (rawShots.length === 0) {
      warnings.push(`Scene "${rawScene?.name || sceneIndex + 1}" has no shots.`);
    }

    return {
      id: makeId('scene'),
      name: asString(rawScene?.name, `Scene ${sceneIndex + 1}`),
      number: Number(rawScene?.number) || sceneIndex + 1,
      sceneConcatenatedVideo: null,
      shots: rawShots.map((rawShot, shotIndex) => {
        const shot = rawShot && typeof rawShot === 'object' ? rawShot : {};
        return {
          id: makeId('shot'),
          name: asString(shot.name, `Shot ${shotIndex + 1}`),
          setup: asString(shot.setup),
          description: asString(shot.description),
          dialogue: asString(shot.dialogue),
          notes: asString(shot.notes),
          // Prompt drafts are what the generation modal and batch runner read.
          draftImagePrompt: asString(shot.imagePrompt || shot.draftImagePrompt),
          draftVideoPrompt: asString(shot.videoPrompt || shot.draftVideoPrompt),
          imageModel: asString(shot.imageModel) || null,
          imageResolution: asString(shot.imageResolution) || null,
          videoModel: asString(shot.videoModel) || null,
          videoResolution: asString(shot.videoResolution) || null,
          videoDuration: shot.videoDuration != null ? String(shot.videoDuration) : null,
          selectedImage: asString(shot.selectedImage) || null,
          selectedVideo: asString(shot.selectedVideo) || null,
          referenceImages: Array.isArray(shot.referenceImages) ? shot.referenceImages : [],
          lipSyncAudio: asString(shot.lipSyncAudio) || null,
          // Preserve generated history when re-importing a full project export.
          imagePrompts: Array.isArray(shot.imagePrompts) ? shot.imagePrompts : [],
          videoPrompts: Array.isArray(shot.videoPrompts) ? shot.videoPrompts : []
        };
      })
    };
  });

  return { project, assets, promptSnippets, scenes, warnings };
}
