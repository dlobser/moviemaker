// Higgsfield adapter. The platform API mirrors Fal's submit-then-poll shape:
//   POST https://platform.higgsfield.ai/{model_id}   -> { request_id, status_url }
//   GET  https://platform.higgsfield.ai/requests/{id}/status
// Auth is a combined "Key {key}:{secret}" bearer.

const HIGGSFIELD_BASE = 'https://platform.higgsfield.ai';

function authHeader(credentials) {
  const key = credentials.higgsfieldKey;
  if (!key) throw new Error('Higgsfield API key is not configured. Add it in Settings first.');
  const secret = credentials.higgsfieldSecret;
  return `Key ${secret ? `${key}:${secret}` : key}`;
}

export async function callHiggsfieldModel(modelId, input, ctx) {
  const auth = authHeader(ctx.credentials);

  const submit = await ctx.fetch(`${HIGGSFIELD_BASE}/${modelId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify(input)
  }, 'Higgsfield');
  if (!submit.ok) throw new Error(`Higgsfield submission failed (${submit.status}): ${await submit.text()}`);

  const submitData = await submit.json();
  // Some models return inline on the first response.
  if (submitData.status === 'completed') return submitData;

  const requestId = submitData.request_id || submitData.id;
  const statusUrl = submitData.status_url || `${HIGGSFIELD_BASE}/requests/${requestId}/status`;

  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const statusRes = await ctx.fetch(statusUrl, { headers: { Authorization: auth } }, 'Higgsfield');
    if (!statusRes.ok) throw new Error(`Higgsfield status check failed: ${statusRes.status}`);
    const status = await statusRes.json();
    if (status.status === 'completed') return status;
    if (status.status === 'failed') throw new Error(`Higgsfield failed: ${status.error || status.message || 'unknown'}`);
    if (status.status === 'nsfw') throw new Error('Higgsfield rejected the generation as NSFW.');
    if (status.status === 'cancelled') throw new Error('Higgsfield generation was cancelled.');
  }
  throw new Error('Higgsfield generation timed out.');
}

// --- request shaping (pure) ------------------------------------------------

export function buildHiggsfieldImageRequest(modelPath, { prompt, resolution, imageDataUrls = [] }) {
  const modelId = modelPath === 'higgsfield' ? 'higgsfield-ai/soul/standard' : modelPath;
  const input = { prompt };
  if (resolution?.includes(':')) input.aspect_ratio = resolution;
  else if (resolution) input.resolution = resolution;

  if (imageDataUrls.length > 0) {
    // Higgsfield accepts a single `image_url` on edit endpoints, a list of
    // `reference_images` on identity-preserving ones, and `image_references`
    // on the multi-reference models (nano banana, seedream, kling omni — see
    // higgsfield-ai/cli MODELS.md). Send all three shapes so whichever the
    // chosen model reads is populated; only `image_url` can carry one image,
    // so a multi-image request that lands on it silently drops the rest,
    // which is the failure this alias exists to avoid.
    input.image_url = imageDataUrls[0];
    input.reference_images = imageDataUrls;
    input.image_references = imageDataUrls;
  }
  return { modelId, input };
}

export function buildHiggsfieldVideoRequest(modelPath, { prompt, resolution, duration, imageDataUrls = [] }) {
  const modelId = modelPath === 'higgsfield' ? 'higgsfield-ai/dop/preview' : modelPath;
  const input = {
    prompt,
    aspect_ratio: resolution === '720x1280' ? '9:16' : '16:9',
    duration: Number(duration) || 5
  };
  if (imageDataUrls.length > 0) {
    input.image_url = imageDataUrls[0];
    input.input_images = imageDataUrls;
  }
  return { modelId, input };
}

// --- generation ------------------------------------------------------------

export async function generateImage({ modelPath, prompt, resolution, inputImagePaths }, ctx) {
  const imageDataUrls = await Promise.all(inputImagePaths.map(ctx.readAssetDataUrl));
  const { modelId, input } = buildHiggsfieldImageRequest(modelPath, { prompt, resolution, imageDataUrls });
  const result = await callHiggsfieldModel(modelId, input, ctx);
  const url = result.images?.[0]?.url || result.image?.url;
  if (!url) throw new Error('No image returned from Higgsfield.');
  return ctx.saveRemote(url, 'img', '.png');
}

export async function generateVideo({ modelPath, prompt, resolution, duration, inputImagePaths }, ctx) {
  // Higgsfield takes inline data URLs, so there is no upload step.
  const imageDataUrls = await Promise.all(inputImagePaths.map(ctx.readAssetDataUrl));
  const { modelId, input } = buildHiggsfieldVideoRequest(modelPath, { prompt, resolution, duration, imageDataUrls });
  const result = await callHiggsfieldModel(modelId, input, ctx);
  const url = result.video?.url || result.videos?.[0]?.url;
  if (!url) throw new Error('No video returned from Higgsfield.');
  return ctx.saveRemote(url, 'vid', '.mp4');
}
