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
  { id: 'alibaba/z-image', label: 'Z-Image (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 0 }
];

export const VIDEO_MODELS = [
  // --- Fal.ai ---
  { id: 'fal-ai/kling-video', label: 'Fal.ai - Kling Video', provider: 'fal-ai', priceNote: '~$0.35 / 5s (standard)', refImages: 1 },
  { id: 'fal-ai/veo3.1', label: 'Fal.ai - Google Veo 3.1', provider: 'fal-ai', priceNote: '~$0.40 / s', refImages: 1 },
  { id: 'fal-ai/veo2', label: 'Fal.ai - Google Veo 2', provider: 'fal-ai', priceNote: '~$0.50 / s', refImages: 1 },
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
  { id: 'alibaba/wan/2.2', label: 'Wan 2.2 (via Higgsfield)', provider: 'higgsfield', priceNote: 'credit based - see gallery', refImages: 1 }
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

/** How many reference images this model will actually accept. */
export function refImageCapacity(type, id) {
  const model = type === 'image' ? getImageModel(id) : getVideoModel(id);
  if (!model) return type === 'image' ? 1 : 1; // unknown/custom model: assume single input
  return model.refImages;
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
  kling: 'Kling AI'
};
