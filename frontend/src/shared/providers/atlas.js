// Atlas Cloud adapter. An aggregator with one endpoint pair for everything:
// submit a prediction, poll it by id. Unlike Fal it takes a data: URL for the
// input image directly, so there is no upload step.
//
//   POST https://api.atlascloud.ai/api/v1/model/generateImage  -> { data: { id } }
//   POST https://api.atlascloud.ai/api/v1/model/generateVideo  -> { data: { id } }
//   GET  https://api.atlascloud.ai/api/v1/model/prediction/ID  -> { data: { status, outputs } }

import { describeFalError } from './fal.js';

const ATLAS_BASE = 'https://api.atlascloud.ai/api/v1/model';

/**
 * Submit to Atlas, then poll to completion.
 *
 * `candidates` is a list of bodies tried in order: 400+ models from a dozen
 * vendors do not agree on field names (Seedance 2.0 wants `ratio`, Seedance
 * 1.5 wants `aspect_ratio`), and a refused submission costs nothing, so the
 * richest body goes first and falls back to the common fields.
 */
export async function callAtlasModel(endpoint, candidates, ctx) {
  const apiKey = ctx.credentials.atlasKey;
  if (!apiKey) throw new Error('Atlas Cloud API key is not configured. Add it in Settings first.');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  const bodies = Array.isArray(candidates) ? candidates : [candidates];

  let submitBody = '';
  let lastStatus = 0;
  let accepted = false;
  for (const body of bodies) {
    const submit = await ctx.fetch(`${ATLAS_BASE}/${endpoint}`, {
      method: 'POST', headers, body: JSON.stringify(body)
    }, 'Atlas Cloud');
    submitBody = await submit.text();
    lastStatus = submit.status;
    if (submit.ok) { accepted = true; break; }
    if (lastStatus >= 500) break; // Atlas is unwell; reshaping will not help.
  }
  if (!accepted) throw new Error(`Atlas Cloud submission failed (${lastStatus}): ${describeFalError(submitBody)}`);

  const predictionId = JSON.parse(submitBody)?.data?.id;
  if (!predictionId) throw new Error('Atlas Cloud returned no prediction id.');

  for (let attempt = 0; attempt < 150; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 4000));
    const poll = await ctx.fetch(`${ATLAS_BASE}/prediction/${predictionId}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    }, 'Atlas Cloud');
    if (!poll.ok) throw new Error(`Atlas Cloud status check failed: ${poll.status}`);
    const data = (await poll.json())?.data || {};
    if (data.status === 'completed') {
      const url = Array.isArray(data.outputs) ? data.outputs[0] : data.outputs;
      if (!url) throw new Error('Atlas Cloud reported completion but returned no output.');
      return url;
    }
    if (data.status === 'failed' || data.status === 'canceled') {
      throw new Error(`Atlas Cloud generation ${data.status}: ${data.error || 'no reason given'}`);
    }
  }
  throw new Error('Atlas Cloud generation timed out.');
}

// --- request shaping (pure) ------------------------------------------------

/** Atlas wants pixels as "W*H"; the studio speaks in aspect ratios. */
export function atlasImageSize(resolution) {
  const sizes = {
    '16:9': '1344*768', '9:16': '768*1344', '1:1': '1024*1024',
    '4:3': '1152*896', '3:2': '1216*832', '21:9': '1536*640'
  };
  if (sizes[resolution]) return sizes[resolution];
  if (typeof resolution === 'string' && resolution.includes('x')) return resolution.replace('x', '*');
  return '1344*768';
}

export function buildAtlasImageBodies(modelPath, { prompt, resolution, imageDataUrl, safetyChecker }) {
  const input = {
    model: modelPath,
    prompt,
    size: atlasImageSize(resolution),
    num_images: 1
  };
  // Open-weight models on Atlas expose their safety checker as a request
  // flag. It stays on unless the project turns it off, so the default here
  // matches the provider's own.
  if (safetyChecker === false) input.enable_safety_checker = false;
  if (imageDataUrl) input.image = imageDataUrl;

  return [
    input,
    { model: input.model, prompt: input.prompt, ...(input.image ? { image: input.image } : {}) }
  ];
}

export function buildAtlasVideoBodies(modelPath, { prompt, resolution, duration, imageDataUrls = [] }) {
  const aspect = resolution === '720x1280' ? '9:16' : '16:9';
  const core = { model: modelPath, prompt, duration: Number(duration) || 5 };

  // Where the images go depends on the endpoint, not the model family.
  // `reference-to-video` takes an array of up to nine in `reference_images`
  // and the prompt addresses them as @image1..@image9; `image-to-video`
  // takes a single still in `image` and treats it as the first frame.
  const wantsReferenceArray = /reference-to-video/.test(modelPath);
  const candidates = [];

  if (wantsReferenceArray) {
    // Never fall back to a single-image body here. A reduced body would be
    // accepted and would quietly produce a video missing eight of the nine
    // references the prompt points at — an expensive silent wrong answer,
    // where a rejection costs nothing and says what happened.
    const refs = { ...core, reference_images: imageDataUrls };
    candidates.push({ ...refs, resolution: '720p', ratio: aspect });
    candidates.push({ ...refs, aspect_ratio: aspect });
    candidates.push(refs);
  } else {
    if (imageDataUrls.length > 0) core.image = imageDataUrls[0];
    candidates.push({ ...core, resolution: '720p', ratio: aspect }); // Seedance 2.0 and friends
    candidates.push({ ...core, aspect_ratio: aspect });              // Seedance 1.5 / OpenAPI naming
    candidates.push(core);                                           // last resort: the common fields
  }
  return candidates;
}

// --- generation ------------------------------------------------------------

export async function generateImage({ modelPath, prompt, resolution, inputImagePaths, safetyChecker }, ctx) {
  const imageDataUrl = inputImagePaths.length > 0 ? await ctx.readAssetDataUrl(inputImagePaths[0]) : null;
  const bodies = buildAtlasImageBodies(modelPath, { prompt, resolution, imageDataUrl, safetyChecker });
  const url = await callAtlasModel('generateImage', bodies, ctx);
  return ctx.saveRemote(url, 'img', '.png');
}

export async function generateVideo({ modelPath, prompt, resolution, duration, inputImagePaths }, ctx) {
  // Atlas takes frames inline, so unlike Fal there is no upload step.
  const imageDataUrls = await Promise.all(inputImagePaths.map(ctx.readAssetDataUrl));
  const bodies = buildAtlasVideoBodies(modelPath, { prompt, resolution, duration, imageDataUrls });
  const url = await callAtlasModel('generateVideo', bodies, ctx);
  return ctx.saveRemote(url, 'vid', '.mp4');
}
