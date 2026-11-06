// Google (direct AI Studio) adapter: Gemini text and Gemini Flash Image.

import { assetToInlineImage, requireText } from './llmShared.js';

// --- text models -----------------------------------------------------------
//
// Google retires Gemini text models by *refusing* them, not by delisting them:
// on 2026-09-10 `gemini-2.5-flash` still appeared in GET /models on a working
// key while every generateContent call answered "no longer available to new
// users. Please update your code to use models/gemini-3.6-flash". A saved
// project therefore keeps a dead id that passes the "is it in the list" check
// and fails only when the dream, an auto-prompt or an import actually runs.
//
// Three defences, in order of how much they know:
//   1. the default is the model Google named;
//   2. ids Google has already retired are rewritten to it before the request;
//   3. a refusal that names a replacement is retried once with that model, so
//      the next retirement is survived without a code change.

export const GEMINI_TEXT_DEFAULT = 'gemini-3.6-flash';

// Retired ids and the replacement Google's own error message pointed at. Only
// ids known to be refused belong here — a wrong guess would silently swap a
// model the user chose and can still use.
const RETIRED_GEMINI_TEXT_MODELS = {
  'gemini-2.5-flash': GEMINI_TEXT_DEFAULT,
  'gemini-1.5-flash': GEMINI_TEXT_DEFAULT,
  'gemini-1.5-pro': GEMINI_TEXT_DEFAULT
};

// What the model picker offers when the live list cannot be fetched (no key,
// no network). Ids seen on GET /models on 2026-09-10; the live list wins
// whenever it is available.
export const GEMINI_FALLBACK_MODELS = [
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash (Recommended)' },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview' }
];

/**
 * The Gemini text model to ask for: the default when none is set, the current
 * replacement for a retired id, and anything else — another provider's id
 * included — exactly as given.
 */
export function resolveGeminiTextModel(model) {
  const id = String(model || '').trim();
  if (!id) return GEMINI_TEXT_DEFAULT;
  return RETIRED_GEMINI_TEXT_MODELS[id] || id;
}

/** The replacement a Gemini refusal names, or null when it names none. */
export function suggestedGeminiModel(errorMessage) {
  // Dots only inside the id ("gemini-3.6-flash"), never the sentence's own.
  const match = /no longer available[\s\S]*?models\/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/i
    .exec(String(errorMessage || ''));
  return match ? match[1] : null;
}

export async function generateText({ prompt, systemPrompt, model, imagePaths = [] }, ctx) {
  const apiKey = ctx.credentials.geminiKey;
  if (!apiKey) throw new Error('Gemini API key is not configured.');

  const images = await Promise.all((imagePaths || []).filter(Boolean).map(p => assetToInlineImage(p, ctx)));
  // No system prompt has to mean *no system text at all*, not an empty one —
  // on Gemini an empty one leaves the user's text wearing a stray label.
  const system = String(systemPrompt || '').trim();
  const body = JSON.stringify({
    contents: [{
      parts: [
        { text: system ? `${system}\n\nUser text: ${prompt}` : prompt },
        ...images.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.data } }))
      ]
    }]
  });

  const ask = async (targetModel) => {
    const res = await ctx.fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
      'Gemini'
    );
    return res.json();
  };

  const targetModel = resolveGeminiTextModel(model);
  let data = await ask(targetModel);
  if (data.error) {
    // Retired since this build shipped. Google says which model to use: use
    // it, once, and say so if that fails too.
    const replacement = suggestedGeminiModel(data.error.message);
    if (!replacement || replacement === targetModel) throw new Error(data.error.message || 'Gemini API Error');
    const retry = await ask(replacement);
    if (retry.error) {
      throw new Error(
        `${data.error.message} The suggested ${replacement} was refused as well: ` +
        `${retry.error.message || 'Gemini API Error'}. Pick a current model in Settings.`
      );
    }
    data = retry;
  }
  const candidate = data.candidates?.[0];
  return requireText(
    candidate?.content?.parts?.map(part => part.text).filter(Boolean).join('\n'),
    'Gemini', candidate?.finishReason || data.promptFeedback?.blockReason
  );
}

// --- aspect ratio ----------------------------------------------------------
//
// Gemini Image used to be sent no ratio at all: `resolution` reached this
// adapter and was dropped on the floor, so the model fell back to its own
// default (square) or, when editing, to whatever shape the input image was.
// Asking for 16:9 and getting 1:1 was not the model being unreliable — it was
// never asked.
//
// Google has published the field in two places. `generationConfig.imageConfig`
// is what the JS and Python SDKs map onto, and `generationConfig.responseFormat`
// is what the current REST reference shows. Which one a given key and model
// accept is not worth guessing: the request is submitted with one, and an
// unknown-field 400 costs nothing and selects the other. Google rejects unknown
// fields rather than ignoring them, which is what makes this safe.

const GEMINI_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

/** The studio's resolution value as a ratio Gemini accepts, or null. */
export function geminiAspectRatio(resolution) {
  const value = String(resolution || '').trim();
  if (GEMINI_RATIOS.includes(value)) return value;
  // Pixel forms ('1344x768') reduce to their ratio; anything unrecognised
  // sends no constraint rather than a made-up one.
  const pixels = value.match(/^(\d+)\s*[x*]\s*(\d+)$/i);
  if (!pixels) return null;
  const [width, height] = [Number(pixels[1]), Number(pixels[2])];
  const nearest = GEMINI_RATIOS
    .map(ratio => {
      const [rw, rh] = ratio.split(':').map(Number);
      return { ratio, distance: Math.abs((rw / rh) - (width / height)) };
    })
    .sort((a, b) => a.distance - b.distance)[0];
  return nearest && nearest.distance < 0.06 ? nearest.ratio : null;
}

/**
 * The request bodies to try, richest first. Without a usable ratio there is
 * only one, identical to what the adapter has always sent.
 */
export function buildGeminiImageBodies(parts, aspectRatio) {
  const base = { contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE'] } };
  if (!aspectRatio) return [base];
  return [
    { ...base, generationConfig: { ...base.generationConfig, imageConfig: { aspectRatio } } },
    { ...base, generationConfig: { ...base.generationConfig, responseFormat: { image: { aspectRatio } } } },
    base // neither field understood: generate anyway rather than refuse
  ];
}

// Which shape this key accepted, so the losing body is paid for once per
// session rather than on every generation. Keyed by API model: the two image
// models are separate endpoints and need not agree on the config field.
const acceptedRatioShape = new Map();

// --- which model, and how many references it will take ---------------------
//
// "Nano Banana" names two models with very different reference budgets, and
// the studio can reach both. gemini-2.5-flash-image is the 3-image one;
// gemini-3-pro-image-preview (Nano Banana Pro) documents up to 14. Sending a
// fourth image to the small one is a 400 after every reference has already
// been base64'd into the request, so the count is checked here, where the
// message can name the model and say what to switch to.
//
// Nano Banana Pro also holds a *likeness* for at most five of those fourteen —
// a soft limit (more people still generate, they just stop looking like
// themselves), so it is not enforced as a throw.
const GEMINI_IMAGE_MODELS = {
  'google-gemini-image': { model: 'gemini-2.5-flash-image', label: 'Nano Banana', maxImages: 3 },
  'google-gemini-image-pro': { model: 'gemini-3-pro-image-preview', label: 'Nano Banana Pro', maxImages: 14 }
};

const DEFAULT_GEMINI_IMAGE = GEMINI_IMAGE_MODELS['google-gemini-image'];
const PRO_GEMINI_IMAGE = GEMINI_IMAGE_MODELS['google-gemini-image-pro'];

/** The API model and reference ceiling behind a studio image-model id. */
export function geminiImageModel(modelPath) {
  return GEMINI_IMAGE_MODELS[modelPath] || DEFAULT_GEMINI_IMAGE;
}

// --- references ------------------------------------------------------------
//
// Sent as a plain run of image parts, with nothing interleaved.
//
// Labelling each one ("The second image:") was tried, so that a prompt could
// address them by position the way ai.google.dev's composition examples do.
// For multiple views of a single character — the common case here — it made
// identity worse, not better: the numbering invites the model to treat four
// references of one person as four people to reconcile. The prompt names the
// character in prose and the references support it; nothing needs to count.
export function referenceImageParts(images) {
  return images.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.data } }));
}

export async function generateImage({ modelPath, prompt, resolution, inputImagePaths }, ctx) {
  const apiKey = ctx.credentials.geminiKey;
  if (!apiKey) throw new Error('Google AI Studio key is not configured.');

  const target = geminiImageModel(modelPath);
  if (inputImagePaths.length > target.maxImages) {
    throw new Error(
      `${target.label} (${target.model}) accepts at most ${target.maxImages} input ` +
      `image${target.maxImages === 1 ? '' : 's'}; this request has ${inputImagePaths.length}.` +
      (target.maxImages < PRO_GEMINI_IMAGE.maxImages
        ? ` Switch the shot to ${PRO_GEMINI_IMAGE.label} to send up to ${PRO_GEMINI_IMAGE.maxImages}.`
        : '')
    );
  }

  const images = await Promise.all(inputImagePaths.map(assetPath => assetToInlineImage(assetPath, ctx)));
  const imageParts = referenceImageParts(images);

  const aspectRatio = geminiAspectRatio(resolution);
  // Editing is where the config field is least trusted — the model leans hard
  // on the input image's shape and has been reported to ignore the ratio
  // outright. One line of prompt is the documented way through. It is added
  // here rather than in prompt composition so the recipe the project records
  // stays exactly what was typed.
  const promptText = aspectRatio && images.length > 0
    ? `${prompt}\n\nOutput the image in a ${aspectRatio} aspect ratio, recomposing the framing to fill it rather than padding or cropping to the input's shape.`
    : prompt;

  // Instruction first, then the references it describes.
  const bodies = buildGeminiImageBodies([{ text: promptText }, ...imageParts], aspectRatio);
  const cached = acceptedRatioShape.get(target.model);
  const known = cached !== undefined && cached < bodies.length;
  const ordered = known
    ? [bodies[cached], ...bodies.filter((_, i) => i !== cached)]
    : bodies;

  let data = null;
  let lastError = `${target.label} API error`;
  for (const [index, body] of ordered.entries()) {
    const res = await ctx.fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${target.model}:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      `Gemini Image (${target.label})`
    );
    const parsed = await res.json();
    if (res.ok && !parsed.error) {
      acceptedRatioShape.set(target.model, bodies.indexOf(ordered[index]));
      data = parsed;
      break;
    }
    lastError = parsed.error?.message || `${target.label} API error (${res.status})`;
    // Only an argument complaint means the *shape* was wrong. A quota or key
    // problem will not be fixed by reshaping, and retrying it twice more just
    // makes the failure slower.
    if (res.status !== 400) break;
  }
  if (!data) throw new Error(lastError);

  const part = data.candidates?.flatMap(c => c.content?.parts || []).find(p => p.inlineData?.data);
  if (!part) throw new Error(`${target.label} returned no image output.`);

  const mimeType = part.inlineData.mimeType || 'image/png';
  const ext = mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/webp' ? '.webp' : '.png';
  return ctx.saveRemote(`data:${mimeType};base64,${part.inlineData.data}`, 'img', ext);
}
