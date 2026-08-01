// Central catalog of every generation model the studio can talk to.
//
// One source of truth so the generation modal, the settings defaults, the batch
// runner and the "Copy LLM Prompt" export never drift apart.
//
// price   - USD per generation when the provider publishes a flat per-unit rate.
// priceNote - shown instead of / next to price when billing is credit based or
//             varies by duration. Never invent a number here; say what it is.
// refImages - how many input/reference images the model accepts (0 = none).
//             Drives which <Tag> assets get uploaded with the request.
//             These are the *host's* documented ceilings, not the underlying
//             model's marketing number — the same model allows a different
//             count depending on who is serving it (Gemini 2.5 Flash Image is
//             3 direct from Google but 8 through Higgsfield). Sources are noted
//             per line; re-check before raising one, an over-count is a request
//             the provider rejects after you have already paid for the tokens.

export const IMAGE_MODELS = [
  // --- Fal.ai ---
  { id: 'fal-ai/flux/schnell', label: 'Flux Schnell (fast)', provider: 'fal-ai', price: 0.003, refImages: 0 },
  { id: 'fal-ai/flux/dev', label: 'Flux Dev (high quality)', provider: 'fal-ai', price: 0.025, refImages: 0 },
  { id: 'fal-ai/flux/schnell/redux', label: 'Flux Schnell Redux (img2img)', provider: 'fal-ai', price: 0.008, refImages: 1 },
  { id: 'fal-ai/flux/dev/redux', label: 'Flux Dev Redux (img2img)', provider: 'fal-ai', price: 0.03, refImages: 1 },
  { id: 'fal-ai/stable-diffusion-v35-large', label: 'SD 3.5 Large', provider: 'fal-ai', price: 0.035, refImages: 0 },
  { id: 'fal-ai/stable-diffusion-v35-medium', label: 'SD 3.5 Medium', provider: 'fal-ai', price: 0.015, refImages: 0 },

  // --- Google (direct) ---
  // ai.google.dev caps gemini-2.5-flash-image at 3 images per prompt.
  { id: 'google-gemini-image', label: 'Gemini 2.5 Flash Image (Nano Banana)', provider: 'google', priceNote: 'per Google AI Studio rates', refImages: 3 },

  // --- OpenAI (direct) ---
  { id: 'chatgpt', label: 'DALL-E 3', provider: 'openai', price: 0.04, priceNote: 'standard 1024px', refImages: 0 },

  // --- Higgsfield ---
  // Endpoint paths are POSTed directly to https://platform.higgsfield.ai/{id}.
  // Higgsfield bills in credits rather than a published per-call USD rate, so
  // prices below are the rates Higgsfield/its resellers advertise where known
  // and flagged as approximate everywhere else. Check the Models Gallery at
  // https://cloud.higgsfield.ai for the authoritative number before a big batch.
  { id: 'higgsfield-ai/soul/standard', label: 'Higgsfield Soul (flagship t2i)', provider: 'higgsfield', priceNote: '~$0.09-0.12 / image (credits)', refImages: 0 },
  { id: 'higgsfield-ai/soul/turbo', label: 'Higgsfield Soul Turbo', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 0 },
  { id: 'higgsfield-ai/soul/image-to-image', label: 'Higgsfield Soul Image-to-Image', provider: 'higgsfield', priceNote: '~$0.09 / run (credits)', refImages: 1 },
  { id: 'higgsfield-ai/soul-id', label: 'Higgsfield Soul ID (character consistency)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 4 },
  { id: 'reve/text-to-image', label: 'Reve Text-to-Image', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 0 },
  // Counts below follow higgsfield-ai/cli MODELS.md ("At most N image_references
  // are allowed"): nano_banana_2 14, nano_banana 8, openai 16, seedream_v4_5 14,
  // kling_omni_image 10. FLUX.2 has no Higgsfield-published number, so it takes
  // Black Forest Labs' own API ceiling of 8.
  { id: 'google/nano-banana-pro', label: 'Nano Banana Pro (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 14 },
  { id: 'google/nano-banana', label: 'Nano Banana (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 8 },
  { id: 'openai/gpt-image-1.5', label: 'GPT Image 1.5 (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 16 },
  { id: 'bytedance/seedream/v4', label: 'Seedream 4 (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 10 },
  { id: 'black-forest-labs/flux.2', label: 'FLUX.2 (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 8 },
  { id: 'kling/o1/image', label: 'Kling O1 Image (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 10 },
  { id: 'alibaba/z-image', label: 'Z-Image (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 0 },

  // --- Atlas Cloud ---
  // An aggregator: one key, one endpoint, models re-served from many vendors.
  // The `atlas:` prefix is mandatory rather than cosmetic — these ids collide
  // with Fal's and Higgsfield's, so nothing but an explicit host can tell them
  // apart. Ids taken from the model page URLs on atlascloud.ai; the full list
  // lives at atlascloud.ai/models.
  { id: 'atlas:black-forest-labs/flux-dev', label: 'FLUX.1 Dev (Atlas, open weights)', provider: 'atlas', price: 0.012, refImages: 1, sizes: [
    { value: '16:9', label: 'Landscape (16:9)' },
    { value: '9:16', label: 'Portrait (9:16)' },
    { value: '1:1', label: 'Square (1:1)' },
    { value: '4:3', label: 'Standard (4:3)' },
    { value: '3:4', label: 'Tall (3:4)' },
    { value: '3:2', label: 'Photo (3:2)' },
    { value: '2:3', label: 'Portrait photo (2:3)' }
  ] },
  { id: 'atlas:qwen/qwen-image-2.0/text-to-image', label: 'Qwen-Image 2.0 (Atlas, open weights)', provider: 'atlas', priceNote: 'see atlascloud.ai/pricing', refImages: 1 },
  { id: 'atlas:z-image/turbo', label: 'Z-Image Turbo (Atlas, open weights)', provider: 'atlas', priceNote: 'see atlascloud.ai/pricing', refImages: 1 },
  { id: 'atlas:bytedance/seedream-v5.0-pro/text-to-image', label: 'Seedream 5.0 Pro (Atlas)', provider: 'atlas', priceNote: 'see atlascloud.ai/pricing', refImages: 1 },
  { id: 'atlas:google/nano-banana-pro/text-to-image', label: 'Nano Banana Pro (Atlas)', provider: 'atlas', priceNote: 'see atlascloud.ai/pricing', refImages: 1 }
];

export const VIDEO_MODELS = [
  // --- Fal.ai ---
  { id: 'fal-ai/kling-video', label: 'Fal.ai - Kling Video', provider: 'fal-ai', priceNote: '~$0.35 / 5s (standard)', refImages: 1 },
  // Veo takes 5s or 8s, never 10 — the request builder has always coerced it,
  // so the studio was offering a length the model cannot produce.
  { id: 'fal-ai/veo3.1', label: 'Fal.ai - Google Veo 3.1', provider: 'fal-ai', priceNote: '~$0.40 / s', refImages: 1, durations: ['5', '8'] },
  { id: 'fal-ai/veo2', label: 'Fal.ai - Google Veo 2', provider: 'fal-ai', priceNote: '~$0.50 / s', refImages: 1, durations: ['5', '8'] },
  { id: 'fal-ai/luma-dream-machine', label: 'Fal.ai - Luma Dream Machine', provider: 'fal-ai', priceNote: '~$0.50 / 5s', refImages: 1 },

  // --- Direct provider APIs ---
  { id: 'runway', label: 'RunwayML Gen-3', provider: 'runway', priceNote: 'per Runway credit rates', refImages: 1 },
  { id: 'kling', label: 'Kling AI Developer API', provider: 'kling', priceNote: 'per Kling credit rates', refImages: 1 },

  // --- Higgsfield ---
  { id: 'higgsfield-ai/dop/preview', label: 'Higgsfield DoP (preview)', provider: 'higgsfield', priceNote: '~$0.86 / video (credits)', refImages: 1 },
  { id: 'higgsfield-ai/dop/standard', label: 'Higgsfield DoP (standard)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 1 },
  { id: 'higgsfield-ai/dop/turbo', label: 'Higgsfield DoP (turbo)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 1 },
  { id: 'higgsfield-ai/cinema-studio', label: 'Higgsfield Cinema Studio', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 1 },
  { id: 'bytedance/seedance/v1/pro/image-to-video', label: 'Seedance 1 Pro i2v (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 1 },
  { id: 'bytedance/seedance/v1/pro/text-to-video', label: 'Seedance 1 Pro t2v (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 0 },
  { id: 'bytedance/seedance/v1.5/pro/image-to-video', label: 'Seedance 1.5 Pro i2v (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 1 },
  { id: 'kling-video/v2.1/pro/image-to-video', label: 'Kling 2.1 Pro i2v (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 1 },
  { id: 'kling-video/v2.5/pro/image-to-video', label: 'Kling 2.5 Pro i2v (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 1 },
  { id: 'kling-video/v2.6/pro/image-to-video', label: 'Kling 2.6 Pro i2v (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 1 },
  { id: 'kling-video/o1/image-to-video', label: 'Kling O1 i2v (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 1 },
  { id: 'google/veo/3.1', label: 'Google Veo 3.1 (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 1 },
  { id: 'google/veo/3', label: 'Google Veo 3 (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 1 },
  { id: 'openai/sora-2', label: 'Sora 2 (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 1 },
  { id: 'minimax/hailuo', label: 'Minimax Hailuo (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 1 },
  { id: 'alibaba/wan/2.5', label: 'Wan 2.5 (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 1 },
  { id: 'alibaba/wan/2.6', label: 'Wan 2.6 (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 1 },
  { id: 'alibaba/wan/2.2', label: 'Wan 2.2 (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 1 },

  // --- Atlas Cloud ---
  // Atlas publishes each model's ranges on its API tab. Seedance 2.0 documents
  // duration 4-15, Seedance 1.5 documents 4-12 — the sets below are a usable
  // subset of those ranges, not the whole integer span.
  { id: 'atlas:bytedance/seedance-2.0/image-to-video', label: 'Seedance 2.0 i2v (Atlas)', provider: 'atlas', priceNote: '$0.112 / s', refImages: 1, durations: ['4', '5', '6', '8', '10', '12', '15'] },
  { id: 'atlas:bytedance/seedance-2.0-fast/image-to-video', label: 'Seedance 2.0 Fast i2v (Atlas)', provider: 'atlas', priceNote: '$0.09 / s', refImages: 1, durations: ['4', '5', '6', '8', '10', '12', '15'] },
  { id: 'atlas:bytedance/seedance-2.0/text-to-video', label: 'Seedance 2.0 t2v (Atlas)', provider: 'atlas', priceNote: '$0.112 / s', refImages: 0, durations: ['4', '5', '6', '8', '10', '12', '15'] },
  { id: 'atlas:bytedance/seedance-v1.5-pro/image-to-video-spicy', label: 'Seedance 1.5 Pro i2v Spicy (Atlas)', provider: 'atlas', priceNote: 'see atlascloud.ai/pricing', refImages: 1, durations: ['4', '5', '6', '8', '10', '12'] }
];

export const IMAGE_ASPECT_RATIOS = [
  { value: '16:9', label: 'Landscape (16:9)' },
  { value: '9:16', label: 'Portrait (9:16)' },
  { value: '1:1', label: 'Square (1:1)' },
  { value: '4:3', label: 'Standard (4:3)' },
  { value: '3:2', label: 'Photo (3:2)' },
  { value: '21:9', label: 'Widescreen (21:9)' }
];

export const VIDEO_RESOLUTIONS = [
  { value: '1280x720', label: 'Landscape (16:9 - 1280x720)' },
  { value: '720x1280', label: 'Portrait (9:16 - 720x1280)' }
];

export const LLM_PROVIDERS = [
  { id: 'gemini', label: 'Google Gemini' },
  { id: 'chatgpt', label: 'OpenAI ChatGPT' },
  { id: 'claude', label: 'Anthropic Claude' }
];

// --- CUSTOM MODEL PATHS ----------------------------------------------------
//
// Which service a model id belongs to used to be guessed from its prefix, and
// that guess is no longer decidable: the same vendor namespaces exist on both
// hosts. `bytedance/seedance-2.0/image-to-video` is a real Fal id and
// `bytedance/seedance/v1/pro/image-to-video` is a real Higgsfield one.
//
// So a custom path may carry its host explicitly, as `fal:<path>` or
// `higgsfield:<path>`. Nothing in the catalog is written that way and an id
// without a prefix still falls back to the prefix heuristic, so every saved
// project, prompt group and shot list keeps working untouched.

export const MODEL_FAMILIES = [
  { id: 'fal-ai', label: 'Fal.ai' },
  { id: 'higgsfield', label: 'Higgsfield' },
  { id: 'atlas', label: 'Atlas Cloud' }
];

const FAMILY_ALIASES = {
  fal: 'fal-ai',
  'fal-ai': 'fal-ai',
  falai: 'fal-ai',
  higgsfield: 'higgsfield',
  'higgsfield-ai': 'higgsfield',
  hf: 'higgsfield',
  atlas: 'atlas',
  atlascloud: 'atlas',
  'atlas-cloud': 'atlas'
};

/** A family name normalised to a catalog family id, or null. */
export function normalizeFamily(family) {
  return FAMILY_ALIASES[String(family || '').trim().toLowerCase()] || null;
}

/**
 * Split a model id into its declared host and the path the provider expects.
 *
 * The colon must come before any slash, so a path that merely contains one is
 * left alone rather than being read as a host.
 */
export function parseModelId(id) {
  const raw = String(id || '').trim();
  const colon = raw.indexOf(':');
  const slash = raw.indexOf('/');
  if (colon > 0 && (slash === -1 || colon < slash)) {
    const family = normalizeFamily(raw.slice(0, colon));
    if (family) return { family, path: raw.slice(colon + 1).trim() };
  }
  return { family: null, path: raw };
}

/** Build an id from a host and a path. A null host yields the bare path. */
export function formatModelId(family, path) {
  const clean = String(path || '').trim();
  const normalized = normalizeFamily(family);
  return normalized && clean ? `${normalized}:${clean}` : clean;
}

/** Just the path a provider should be called with. */
export function modelPath(id) {
  return parseModelId(id).path;
}

const byId = (list) => list.reduce((acc, m) => { acc[m.id] = m; return acc; }, {});
const IMAGE_BY_ID = byId(IMAGE_MODELS);
const VIDEO_BY_ID = byId(VIDEO_MODELS);

export function getImageModel(id) {
  return IMAGE_BY_ID[id] || null;
}

export function getVideoModel(id) {
  return VIDEO_BY_ID[id] || null;
}

export function isKnownImageModel(id) {
  return Boolean(IMAGE_BY_ID[id]);
}

export function isKnownVideoModel(id) {
  return Boolean(VIDEO_BY_ID[id]);
}

// --- CAPABILITIES ----------------------------------------------------------
//
// What a model will actually accept, as data rather than as hardcoded <option>
// lists. Before this the studio offered every model the same 5/10 seconds and
// the same six aspect ratios, which was wrong in both directions: Veo cannot
// make a 10 second clip (the request builder quietly coerced it to 8), and
// Seedance will happily make a 15 second one that you could not ask for.
//
// A model with nothing recorded falls back to the studio-wide defaults, so an
// unknown or custom path behaves exactly as it always did.

export const DEFAULT_VIDEO_DURATIONS = ['5', '10'];

/**
 * Everything the UI needs to know about a model, with defaults filled in.
 * `known` is false for a custom path, which is the cue to keep the fallbacks
 * rather than pretend to have checked.
 */
export function modelCapabilities(type, id) {
  const model = type === 'image' ? getImageModel(id) : getVideoModel(id);
  return {
    id,
    label: model?.label || id,
    known: Boolean(model),
    maxRefImages: model ? model.refImages : 1, // unknown model: assume one input
    durations: type === 'video' ? (model?.durations || DEFAULT_VIDEO_DURATIONS) : null,
    sizes: model?.sizes || (type === 'image' ? IMAGE_ASPECT_RATIOS : VIDEO_RESOLUTIONS)
  };
}

/** How many reference images this model will actually accept. */
export function refImageCapacity(type, id) {
  return modelCapabilities(type, id).maxRefImages;
}

/**
 * Keep a saved value selectable even when the model does not list it.
 *
 * A shot saved at 10 seconds that is later pointed at Veo would otherwise show
 * a blank dropdown and silently submit whatever happened to be first. Marking
 * it rather than dropping it keeps the project honest about what it holds.
 */
function withSelected(options, selected) {
  const value = selected === null || selected === undefined ? '' : String(selected);
  if (!value || options.some(option => option.value === value)) return options;
  return [...options, { value, label: `${value} — as saved, not offered by this model` }];
}

/** The length options for a video model, as {value,label}. */
export function durationOptions(id, selected) {
  const { durations } = modelCapabilities('video', id);
  const options = (durations || DEFAULT_VIDEO_DURATIONS)
    .map(value => ({ value: String(value), label: `${value} seconds` }));
  return withSelected(options, selected);
}

/** The aspect (image) or resolution (video) options for a model. */
export function sizeOptions(type, id, selected) {
  return withSelected(modelCapabilities(type, id).sizes, selected);
}

/** Human readable price for a model, e.g. "$0.003 / img". */
export function priceLabel(model, unit) {
  if (!model) return '';
  if (typeof model.price === 'number') {
    const base = `$${model.price} / ${unit}`;
    return model.priceNote ? `${base} (${model.priceNote})` : base;
  }
  return model.priceNote || '';
}

/** Options for a <select>, grouped by provider. */
export function groupedModelOptions(list) {
  const groups = [];
  const seen = new Map();
  list.forEach(model => {
    if (!seen.has(model.provider)) {
      const group = { provider: model.provider, models: [] };
      seen.set(model.provider, group);
      groups.push(group);
    }
    seen.get(model.provider).models.push(model);
  });
  return groups;
}

export const PROVIDER_LABELS = {
  'fal-ai': 'Fal.ai',
  google: 'Google',
  openai: 'OpenAI',
  higgsfield: 'Higgsfield',
  runway: 'RunwayML',
  kling: 'Kling AI',
  atlas: 'Atlas Cloud'
};
