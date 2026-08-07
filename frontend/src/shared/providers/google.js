// Google (direct AI Studio) adapter: Gemini text and Gemini Flash Image.

import { assetToInlineImage, requireText } from './llmShared.js';

export async function generateText({ prompt, systemPrompt, model, imagePaths = [] }, ctx) {
  const apiKey = ctx.credentials.geminiKey;
  if (!apiKey) throw new Error('Gemini API key is not configured.');

  const images = await Promise.all((imagePaths || []).filter(Boolean).map(p => assetToInlineImage(p, ctx)));
  // No system prompt has to mean *no system text at all*, not an empty one —
  // on Gemini an empty one leaves the user's text wearing a stray label.
  const system = String(systemPrompt || '').trim();
  const targetModel = model || 'gemini-2.5-flash';

  const res = await ctx.fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: system ? `${system}\n\nUser text: ${prompt}` : prompt },
            ...images.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.data } }))
          ]
        }]
      })
    },
    'Gemini'
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Gemini API Error');
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
// session rather than on every generation.
let acceptedRatioShape = null;

export async function generateImage({ prompt, resolution, inputImagePaths }, ctx) {
  const apiKey = ctx.credentials.geminiKey;
  if (!apiKey) throw new Error('Google AI Studio key is not configured.');
  // ai.google.dev caps gemini-2.5-flash-image at 3 images per prompt.
  if (inputImagePaths.length > 3) throw new Error('Gemini Image accepts at most 3 input images.');

  const imageParts = await Promise.all(inputImagePaths.map(async (assetPath) => {
    const img = await assetToInlineImage(assetPath, ctx);
    return { inlineData: { mimeType: img.mimeType, data: img.data } };
  }));

  const aspectRatio = geminiAspectRatio(resolution);
  // Editing is where the config field is least trusted — the model leans hard
  // on the input image's shape and has been reported to ignore the ratio
  // outright. One line of prompt is the documented way through. It is added
  // here rather than in prompt composition so the recipe the project records
  // stays exactly what was typed.
  const promptText = aspectRatio && imageParts.length > 0
    ? `${prompt}\n\nOutput the image in a ${aspectRatio} aspect ratio, recomposing the framing to fill it rather than padding or cropping to the input's shape.`
    : prompt;

  const bodies = buildGeminiImageBodies([{ text: promptText }, ...imageParts], aspectRatio);
  const known = acceptedRatioShape !== null && acceptedRatioShape < bodies.length;
  const ordered = known
    ? [bodies[acceptedRatioShape], ...bodies.filter((_, i) => i !== acceptedRatioShape)]
    : bodies;

  let data = null;
  let lastError = 'Gemini Image API error';
  for (const [index, body] of ordered.entries()) {
    const res = await ctx.fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      'Gemini Image'
    );
    const parsed = await res.json();
    if (res.ok && !parsed.error) {
      acceptedRatioShape = bodies.indexOf(ordered[index]);
      data = parsed;
      break;
    }
    lastError = parsed.error?.message || `Gemini Image API error (${res.status})`;
    // Only an argument complaint means the *shape* was wrong. A quota or key
    // problem will not be fixed by reshaping, and retrying it twice more just
    // makes the failure slower.
    if (res.status !== 400) break;
  }
  if (!data) throw new Error(lastError);

  const part = data.candidates?.flatMap(c => c.content?.parts || []).find(p => p.inlineData?.data);
  if (!part) throw new Error('Gemini Image returned no image output.');

  const mimeType = part.inlineData.mimeType || 'image/png';
  const ext = mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/webp' ? '.webp' : '.png';
  return ctx.saveRemote(`data:${mimeType};base64,${part.inlineData.data}`, 'img', ext);
}
