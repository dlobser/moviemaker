// Every prompt the studio sends to an LLM, and every fragment it wraps around a
// generation prompt, in one place.
//
// Before this module these lived inline at their call sites — the shot-to-prompt
// user message inside the modal handler, the asset reference-writer system
// prompt inside the asset editor, the per-type asset templates inside
// promptTags.js — which made half of them impossible to tune without editing
// source. Everything here is overridable per project via `promptSettings`, and
// every slot can be reset to the default kept alongside it.
//
// A slot's body may contain {placeholders}. `fillTemplate` substitutes them and
// drops the lines it can't fill, so a prompt that references {notes} still reads
// correctly for a shot with no notes.

// This module deliberately imports nothing from the studio's own code: both
// promptTags.js and shotListImport.js read from it, so any import back the other
// way would close a cycle and leave these consts in the temporal dead zone.

// --- DEFAULTS --------------------------------------------------------------

export const DEFAULT_IMAGE_SYSTEM_PROMPT = "You are a professional cinematographic prompt engineer. Based on the user's details, write a single highly visual description optimized for AI generation (like Flux/Midjourney or Kling). Output ONLY the final visual prompt itself. Do not include titles, introductions, quotes, or conversational preamble.";

export const DEFAULT_VIDEO_SYSTEM_PROMPT = "You are a professional cinematographic prompt engineer. Based on the user's details, write a single highly visual video description optimized for AI generation (like Kling, Runway, or Veo). Output ONLY the final visual prompt itself. Do not include titles, introductions, quotes, or conversational preamble.";

export const DEFAULT_IMAGE_USER_TEMPLATE = `Write a visual prompt based on this scene description: "{description}"
Camera/Shot setup to apply: "{setup}"
Additional Notes: "{notes}"`;

export const DEFAULT_VIDEO_USER_TEMPLATE = `Write a motion prompt based on this scene description: "{description}"
Camera/Shot setup to apply: "{setup}"
Additional Notes: "{notes}"`;

export const DEFAULT_ASSET_WRITER_SYSTEM = `You write prompts for clean REFERENCE artwork used to keep a subject consistent across many shots of a film — not cinematic frames.

The image must isolate the subject: neutral pose, plain uncluttered background, even lighting, whole subject in frame, no motion blur, no dramatic grade, no other characters.

You are given a subject and the lines from the script where it appears. Infer concrete visual specifics that the script implies but never states — age, build, hair, wardrobe, materials, colour, wear and era. Be decisive and specific; do not hedge or offer alternatives. Never invent plot.

Reply with ONLY a JSON object, no markdown fence:
{"description":"<one dense sentence of physical description, reusable wherever this subject is named>","imagePrompt":"<the full reference image prompt>"}`;

export const DEFAULT_ASSET_WRITER_USER = `Subject type: {type}
Name: {name}
Existing description: {description}
{context}
{styleHint}`;

// Reference art wants the opposite of a cinematic frame: neutral pose, plain
// background, even light — anything the model can lift the subject cleanly out of.
/**
 * The editable half of the shot-list import prompt: the role, the output rules
 * and the field notes. Everything factual — the schema, the live model catalog,
 * the project's own asset tags — is appended after it by buildLlmImportPrompt
 * and is deliberately not editable, since getting those wrong produces an
 * import that silently fails to parse.
 */
export const DEFAULT_IMPORT_INTRO = `You are a professional storyboard supervisor. Convert the material below into a single JSON document that MovieMaker Studio can import directly.

=== OUTPUT RULES ===
1. Return ONLY raw JSON. No markdown fences, no commentary before or after.
2. Use the exact key names shown in the schema. Omit keys you have no value for; never invent new keys.
3. Do not generate "id" fields — the studio assigns those on import.
4. Escape all inner quotes properly, or use single quotes inside dialogue strings.

=== FIELD NOTES ===
- "prePrompt" / "postPrompt" are prepended/appended to EVERY image prompt in the
  project — put global film-stock, lens and grade language there, not in shots.
- "videoPrePrompt" / "videoPostPrompt" do the same for video prompts.
- "imageSystemPrompt" / "videoSystemPrompt" are the system instructions used when
  the studio asks an LLM to rewrite a shot description into a model prompt.
- "setup" is camera/lens/blocking. "description" is what happens on screen.
  "dialogue" is spoken lines. "notes" is director intent.
- "imagePrompt" / "videoPrompt" are the ready-to-run model prompts. Write them as
  dense visual descriptions, not sentences about the story.
- Per-shot "imageModel"/"videoModel" override the project defaults; include them
  only when a specific shot genuinely needs a different model.
- Recurring characters, environments, props and styles go in the "assets" array.
  Use tags aggressively: every time a named character, location or signature prop
  appears in a shot, tag it rather than re-describing it.`;

export const DEFAULT_ASSET_TEMPLATES = {
  character: 'full body character reference sheet of {name}, {description}, neutral standing pose, facing camera, plain light grey studio background, soft even lighting, sharp focus, full figure visible',
  environment: 'establishing wide shot of {name}, {description}, no people in frame, natural lighting, deep focus',
  prop: 'product photograph of {name}, {description}, centred, plain neutral background, soft studio lighting, sharp focus',
  style: 'style reference board: {description}, cohesive colour palette and texture treatment',
  vehicle: 'three-quarter front view of {name}, {description}, plain neutral background, even studio lighting, full vehicle in frame'
};

// --- SLOT REGISTRY ---------------------------------------------------------
// Drives the Settings → Prompts tab. `group` buckets them into sections;
// `placeholders` is documentation shown under the editor.

export const PROMPT_GROUPS = [
  { id: 'shot', label: 'Shot prompt writing', hint: 'Used when you press Auto Prompt on a shot — the LLM turns the shot’s written description into a model prompt.' },
  { id: 'wrap', label: 'Pre / post prompts', hint: 'Wrapped around every prompt at generation time. Put film stock, lens and grade language here instead of repeating it in each shot.' },
  { id: 'asset', label: 'Asset reference generation', hint: 'Used by the Asset library when writing and generating a character / environment / prop reference image.' },
  { id: 'import', label: 'Shot list import', hint: 'The text behind Copy LLM Prompt — what you paste into an outside LLM to get an importable shot list back.' }
];

export const PROMPT_SLOTS = [
  {
    id: 'imageSystemPrompt',
    group: 'shot',
    label: 'Image prompt — system instruction',
    description: 'How the LLM should behave when writing an image prompt for a shot.',
    default: DEFAULT_IMAGE_SYSTEM_PROMPT,
    rows: 4
  },
  {
    id: 'imageUserTemplate',
    group: 'shot',
    label: 'Image prompt — user message',
    description: 'The shot’s own material, as handed to the LLM. Lines whose placeholder is empty are dropped.',
    default: DEFAULT_IMAGE_USER_TEMPLATE,
    placeholders: ['{description}', '{setup}', '{notes}', '{dialogue}', '{name}', '{sceneName}'],
    rows: 4
  },
  {
    id: 'videoSystemPrompt',
    group: 'shot',
    label: 'Video prompt — system instruction',
    description: 'How the LLM should behave when writing a video/motion prompt for a shot.',
    default: DEFAULT_VIDEO_SYSTEM_PROMPT,
    rows: 4
  },
  {
    id: 'videoUserTemplate',
    group: 'shot',
    label: 'Video prompt — user message',
    description: 'The shot’s own material for a motion prompt. Lines whose placeholder is empty are dropped.',
    default: DEFAULT_VIDEO_USER_TEMPLATE,
    placeholders: ['{description}', '{setup}', '{notes}', '{dialogue}', '{name}', '{sceneName}'],
    rows: 4
  },

  {
    id: 'prePrompt',
    group: 'wrap',
    label: 'Image pre-prompt',
    description: 'Prepended to every image prompt.',
    default: '',
    placeholder: 'cinematic film still, shot on 35mm anamorphic,',
    rows: 2
  },
  {
    id: 'postPrompt',
    group: 'wrap',
    label: 'Image post-prompt',
    description: 'Appended to every image prompt.',
    default: '',
    placeholder: ', volumetric lighting, ultra detailed, 8k',
    rows: 2
  },
  {
    id: 'videoPrePrompt',
    group: 'wrap',
    label: 'Video pre-prompt',
    description: 'Prepended to every video prompt.',
    default: '',
    placeholder: 'Leave blank to add nothing',
    rows: 2
  },
  {
    id: 'videoPostPrompt',
    group: 'wrap',
    label: 'Video post-prompt',
    description: 'Appended to every video prompt.',
    default: '',
    placeholder: ', smooth cinematic camera motion',
    rows: 2
  },
  {
    id: 'assetPrePrompt',
    group: 'wrap',
    label: 'Asset reference pre-prompt',
    description: 'Prepended when generating an asset’s reference artwork. Separate from the image pre-prompt because reference art wants neutral treatment, not the film’s grade.',
    default: '',
    placeholder: 'clean reference artwork,',
    rows: 2
  },
  {
    id: 'assetPostPrompt',
    group: 'wrap',
    label: 'Asset reference post-prompt',
    description: 'Appended when generating an asset’s reference artwork.',
    default: '',
    placeholder: ', plain background, even lighting, no grade',
    rows: 2
  },

  {
    id: 'assetWriterSystem',
    group: 'asset',
    label: 'Asset prompt writer — system instruction',
    description: 'Drives “Write prompt with LLM” in the asset editor and the asset batch. Must keep asking for the JSON reply, or the description field stops being filled.',
    default: DEFAULT_ASSET_WRITER_SYSTEM,
    rows: 10
  },
  {
    id: 'assetWriterUser',
    group: 'asset',
    label: 'Asset prompt writer — user message',
    description: 'What the writer is told about this asset. {context} expands to the script lines that mention it.',
    default: DEFAULT_ASSET_WRITER_USER,
    placeholders: ['{type}', '{name}', '{tag}', '{description}', '{context}', '{styleHint}'],
    rows: 6
  },
  {
    id: 'assetTemplate.character',
    group: 'asset',
    label: 'Fallback template — character',
    description: 'Used when an asset has no written prompt of its own.',
    default: DEFAULT_ASSET_TEMPLATES.character,
    placeholders: ['{name}', '{description}'],
    rows: 3
  },
  {
    id: 'assetTemplate.environment',
    group: 'asset',
    label: 'Fallback template — environment',
    description: 'Used when an asset has no written prompt of its own.',
    default: DEFAULT_ASSET_TEMPLATES.environment,
    placeholders: ['{name}', '{description}'],
    rows: 3
  },
  {
    id: 'assetTemplate.prop',
    group: 'asset',
    label: 'Fallback template — prop',
    description: 'Used when an asset has no written prompt of its own.',
    default: DEFAULT_ASSET_TEMPLATES.prop,
    placeholders: ['{name}', '{description}'],
    rows: 3
  },
  {
    id: 'assetTemplate.style',
    group: 'asset',
    label: 'Fallback template — style',
    description: 'Used when an asset has no written prompt of its own.',
    default: DEFAULT_ASSET_TEMPLATES.style,
    placeholders: ['{name}', '{description}'],
    rows: 3
  },
  {
    id: 'assetTemplate.vehicle',
    group: 'asset',
    label: 'Fallback template — vehicle',
    description: 'Used when an asset has no written prompt of its own.',
    default: DEFAULT_ASSET_TEMPLATES.vehicle,
    placeholders: ['{name}', '{description}'],
    rows: 3
  },
  {
    id: 'assetContextLimit',
    group: 'asset',
    label: 'Script lines fed to the writer',
    description: 'How many shot lines mentioning an asset are passed to the LLM. Higher is more faithful and more expensive.',
    default: '12',
    kind: 'number',
    min: 0,
    max: 60
  },

  {
    id: 'importIntro',
    group: 'import',
    label: 'Import prompt — role, rules and field notes',
    description: 'The editable opening of Copy LLM Prompt. The JSON schema, the live model catalog and your existing asset tags are appended after it automatically, so they can never drift out of date.',
    default: DEFAULT_IMPORT_INTRO,
    rows: 12
  }
];

const SLOT_BY_ID = new Map(PROMPT_SLOTS.map(slot => [slot.id, slot]));

/** The shipped default for a slot, or '' for an unknown id. */
export function promptDefault(slotId) {
  const slot = SLOT_BY_ID.get(slotId);
  return slot && slot.default !== null && slot.default !== undefined ? slot.default : '';
}

/**
 * The effective text for a slot: the project's override when it has one,
 * otherwise the default.
 *
 * An override of '' is honoured, not treated as absent — several slots
 * (the pre/post pair especially) are legitimately empty, and a user who clears
 * one means it.
 */
export function promptText(promptSettings, slotId) {
  const override = promptSettings ? promptSettings[slotId] : undefined;
  return typeof override === 'string' ? override : promptDefault(slotId);
}

/** Same, as a number — for the numeric slots. */
export function promptNumber(promptSettings, slotId) {
  const parsed = parseInt(promptText(promptSettings, slotId), 10);
  return Number.isFinite(parsed) ? parsed : parseInt(promptDefault(slotId), 10) || 0;
}

/** True when the project has changed this slot away from its default. */
export function isPromptOverridden(promptSettings, slotId) {
  const override = promptSettings ? promptSettings[slotId] : undefined;
  return typeof override === 'string' && override !== promptDefault(slotId);
}

/**
 * Substitute {placeholders} in a template.
 *
 * A line whose only placeholders resolve to empty is dropped entirely, so
 * `Additional Notes: "{notes}"` disappears for a shot with no notes rather than
 * asking the model to work with an empty pair of quotes.
 */
export function fillTemplate(template, vars = {}) {
  const lines = String(template || '').split('\n');
  const kept = lines.filter(line => {
    const used = line.match(/\{(\w+)\}/g);
    if (!used) return true;                       // no placeholders — always keep
    // Keep the line if at least one of its placeholders has content.
    return used.some(token => {
      const key = token.slice(1, -1);
      return String(vars[key] ?? '').trim() !== '';
    });
  });

  return kept
    .map(line => line.replace(/\{(\w+)\}/g, (whole, key) => (
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : whole
    )))
    .join('\n')
    .trim();
}

/** The per-type fallback template text for an asset. */
export function assetTemplateText(promptSettings, type) {
  const id = `assetTemplate.${type}`;
  return SLOT_BY_ID.has(id)
    ? promptText(promptSettings, id)
    : promptText(promptSettings, 'assetTemplate.character');
}

/**
 * Only the keys that differ from their defaults, for persisting into project
 * state. Keeps saved projects small and lets a later change to a default reach
 * projects that never touched that slot.
 */
export function compactPromptSettings(promptSettings) {
  const out = {};
  Object.entries(promptSettings || {}).forEach(([key, value]) => {
    if (typeof value !== 'string') return;
    if (value === promptDefault(key)) return;
    out[key] = value;
  });
  return out;
}

/**
 * Fold the flat pre/post and system-prompt fields older projects saved at the
 * top level into `promptSettings`, so both shapes load identically.
 */
export function migratePromptSettings(state = {}) {
  const settings = { ...(state.promptSettings || {}) };
  const legacy = {
    imageSystemPrompt: state.imageSystemPrompt,
    videoSystemPrompt: state.videoSystemPrompt,
    prePrompt: state.prePrompt,
    postPrompt: state.postPrompt,
    videoPrePrompt: state.videoPrePrompt,
    videoPostPrompt: state.videoPostPrompt
  };
  Object.entries(legacy).forEach(([key, value]) => {
    if (typeof value === 'string' && settings[key] === undefined) settings[key] = value;
  });
  return settings;
}
