// Atlas Cloud adapter. An aggregator with one endpoint pair for everything:
// submit a prediction, poll it by id. Unlike Fal it takes a data: URL for the
// input image directly, so there is no upload step.
//
//   POST https://api.atlascloud.ai/api/v1/model/generateImage  -> { data: { id } }
//   POST https://api.atlascloud.ai/api/v1/model/generateVideo  -> { data: { id } }
//   GET  https://api.atlascloud.ai/api/v1/model/prediction/ID  -> { data: { status, outputs } }

import { describeFalError } from './fal.js';
// Google's ratio vocabulary is Google's whether the request goes direct or
// through an aggregator: Atlas documents exactly the same ten values for
// `aspect_ratio` on its Gemini image endpoints. One table, not two that drift.
import { geminiAspectRatio } from './google.js';

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
  let acceptedIndex = -1;
  for (const [index, body] of bodies.entries()) {
    const submit = await ctx.fetch(`${ATLAS_BASE}/${endpoint}`, {
      method: 'POST', headers, body: JSON.stringify(body)
    }, 'Atlas Cloud');
    submitBody = await submit.text();
    lastStatus = submit.status;
    if (submit.ok) { acceptedIndex = index; break; }
    if (lastStatus >= 500) break; // Atlas is unwell; reshaping will not help.
  }
  if (acceptedIndex < 0) throw new Error(`Atlas Cloud submission failed (${lastStatus}): ${describeFalError(submitBody)}`);

  const predictionId = JSON.parse(submitBody)?.data?.id;
  if (!predictionId) throw new Error('Atlas Cloud returned no prediction id.');

  // Which body Atlas took. A ladder that reshapes the request until one is
  // accepted is only debuggable if the failure can say what was accepted —
  // "it took the one with reference_audio as a bare string" is the whole
  // answer to a class of confusing downstream errors.
  const acceptedFields = Object.keys(bodies[acceptedIndex])
    .filter(key => key !== 'model' && key !== 'prompt')
    .join(', ');

  // Field names alone are not enough for the fields whose *value* is the thing
  // in dispute. ByteDance rejects an audio reference with a bare "invalid url"
  // that names neither the clip nor the reason, and a stale server sending the
  // previous build's data: URL looks identical from here — so the value goes in
  // the error, truncated, rather than being guessed at from the outside.
  const audioValues = [bodies[acceptedIndex].reference_audio].flat().filter(Boolean);
  const audioSummary = audioValues.length
    ? `; audio ${audioValues.map(value => `"${String(value).slice(0, 72)}${String(value).length > 72 ? '…' : ''}"`).join(', ')}`
    : '';

  for (let attempt = 0; attempt < 150; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 4000));
    const poll = await ctx.fetch(`${ATLAS_BASE}/prediction/${predictionId}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    }, 'Atlas Cloud');
    if (!poll.ok) {
      // The status code alone says nothing actionable. Atlas explains itself in
      // the body, and a rejected *poll* on an accepted submission usually means
      // the submission was only shallowly validated — so the request that was
      // taken matters as much as the complaint.
      throw new Error(
        `Atlas Cloud status check failed (${poll.status}): ${describeFalError(await poll.text())} ` +
        `[prediction ${predictionId}; submitted with ${acceptedFields || 'no extra fields'}${audioSummary}]`
      );
    }
    const data = (await poll.json())?.data || {};
    if (data.status === 'completed') {
      const url = Array.isArray(data.outputs) ? data.outputs[0] : data.outputs;
      if (!url) throw new Error('Atlas Cloud reported completion but returned no output.');
      return url;
    }
    if (data.status === 'failed' || data.status === 'canceled') {
      throw new Error(
        `Atlas Cloud generation ${data.status}: ${data.error || 'no reason given'}` +
        `${audioSummary ? ` [submitted with${audioSummary.slice(1)}]` : ''}`
      );
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

// Atlas's Gemini image endpoints do not share the field vocabulary the
// open-weight models use, and every difference fails quietly rather than
// loudly:
//
//   * references go in `images`, an array of 1..10. The single `image` every
//     other Atlas image model takes is not a first reference here, it is a
//     field with no schema behind it.
//   * shape is `aspect_ratio` ('16:9'), never the 'W*H' `size` string.
//   * `num_images` and `enable_safety_checker` are not part of these
//     endpoints at all.
//
// Only the /edit endpoints take images; /text-to-image is a different endpoint
// rather than the same one with the input left out, which is why the catalog
// lists both separately.
const ATLAS_GEMINI_IMAGE = /^google\/nano-banana/;
const ATLAS_EDIT_ENDPOINT = /\/edit(-developer)?$/;

/** True when this Atlas image model speaks Gemini's field names. */
export function isAtlasGeminiImage(modelPath) {
  return ATLAS_GEMINI_IMAGE.test(String(modelPath || ''));
}

/** True when this Atlas image model takes its references in `images`. */
export function usesAtlasImageArray(modelPath) {
  const path = String(modelPath || '');
  return isAtlasGeminiImage(path) && ATLAS_EDIT_ENDPOINT.test(path);
}

export function buildAtlasImageBodies(modelPath, { prompt, resolution, imageDataUrls = [], safetyChecker }) {
  const images = (imageDataUrls || []).filter(Boolean);

  if (isAtlasGeminiImage(modelPath)) {
    const aspectRatio = geminiAspectRatio(resolution);
    const input = { model: modelPath, prompt };
    // An unrecognised shape sends no constraint rather than a made-up one.
    if (aspectRatio) input.aspect_ratio = aspectRatio;
    // A t2i endpoint gets no images however many the shot collected — sending
    // them would be the silent-drop this whole branch exists to prevent, just
    // one layer further in.
    if (images.length && usesAtlasImageArray(modelPath)) input.images = images;

    // The fallback drops the ratio, never the references: a body without
    // `images` is a text-to-image request that succeeds, bills, and returns a
    // picture that ignored every reference the prompt points at.
    const fallback = { model: modelPath, prompt };
    if (input.images) fallback.images = input.images;
    return [input, fallback];
  }

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
  // Everything on this branch documents a single `image`, so extra references
  // have nowhere to go. The catalog is where that ceiling is enforced; by here
  // the list has already been cut to what the model accepts.
  if (images.length) input.image = images[0];

  return [
    input,
    { model: input.model, prompt: input.prompt, ...(input.image ? { image: input.image } : {}) }
  ];
}

export function buildAtlasVideoBodies(modelPath, { prompt, resolution, duration, imageDataUrls = [], audioAssetRefs = [] }) {
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
    // Seedance 2.0 names the shape `ratio`; 1.5 names it `aspect_ratio`, and
    // both take `resolution`. The 1.5 rung used to omit the resolution, so a
    // 1.5 request that got past the first rung asked for no size at all and
    // took whatever the model defaulted to.
    candidates.push({ ...core, resolution: '720p', ratio: aspect });        // Seedance 2.0 and friends
    candidates.push({ ...core, resolution: '720p', aspect_ratio: aspect }); // Seedance 1.5, as documented
    candidates.push({ ...core, aspect_ratio: aspect });                     // older 1.5 shape, no resolution
    candidates.push(core);                                                  // last resort: the common fields
  }

  if (audioAssetRefs.length === 0) return candidates;

  // One shape, not a ladder. Reshaping until something is accepted works for
  // the aspect fields, where a wrong guess is rejected outright — but Atlas
  // accepts a `reference_audio` it cannot use and only fails once the
  // prediction runs. A ladder there would keep picking the body that submits
  // and then dies, so audio gets the shape the evidence supports and nothing
  // else. Every candidate still carries it: a body that quietly dropped the
  // audio would produce a silent video at full price.
  return candidates.map(body => ({ ...body, reference_audio: audioAssetRefs }));
}

// --- audio references ------------------------------------------------------
//
// Images and audio look symmetrical and are not. Handed an inline data: URL,
// Atlas ingests the image into its own library and rewrites the field to
// `asset://…`. It does no such thing for `reference_audio`: that string is
// forwarded verbatim to ByteDance, which puts it in `content[].audio_url.url`
// and requires a URL it can fetch — a data: URL comes back "invalid url".
//
// So audio is the one input the studio cannot carry for you. It has to live at
// an address the model host can reach, which is why the shot takes a URL
// rather than a file.

/** Check an audio reference is something ByteDance can actually fetch. */
export async function resolveAudioReference(audioRef, ctx) {
  // A clip already in Atlas's own Asset Library, uploaded through their
  // dashboard. Nothing to verify and nothing that could be verified — the id
  // only resolves inside Atlas — but it is the sturdiest form of all, because
  // the file then sits on storage the model host is known to reach.
  if (/^asset:\/\//i.test(audioRef)) return audioRef;

  if (!/^https?:\/\//i.test(audioRef)) {
    throw new Error(
      `Audio reference "${audioRef}" is not a URL. Unlike images, audio is not uploaded with the ` +
      `request — the model fetches it itself — so the clip has to be hosted somewhere public and ` +
      `added to the shot as an https:// link, or uploaded to the Atlas Asset Library and added ` +
      `here as its asset:// id.`
    );
  }

  // One cheap read before anything is billed. ByteDance's own complaint for a
  // dead or wrong link is "invalid url", which says nothing about which of the
  // three clips was wrong or why.
  const res = await ctx.fetch(audioRef, {}, 'the audio host');
  if (!res.ok) {
    throw new Error(
      `Could not read the audio reference (${res.status}): ${audioRef} — it has to be reachable ` +
      `without a login. On GitHub that means the raw.githubusercontent.com address, not /blob/.`
    );
  }
  const contentType = res.headers?.get?.('content-type') || '';
  if (contentType && !/^(audio|application\/octet-stream)/i.test(contentType)) {
    throw new Error(
      `${audioRef} served "${contentType}" rather than audio. If that is a GitHub link, ` +
      `use the raw.githubusercontent.com address instead of the /blob/ page.`
    );
  }
  return audioRef;
}

// --- generation ------------------------------------------------------------

export async function generateImage({ modelPath, prompt, resolution, inputImagePaths, safetyChecker }, ctx) {
  // Every reference travels, not just the first. Which of them the request can
  // actually carry is the body builder's decision, and it is made from the
  // endpoint rather than from how many happened to be picked.
  const imageDataUrls = await Promise.all((inputImagePaths || []).map(ctx.readAssetDataUrl));
  const bodies = buildAtlasImageBodies(modelPath, { prompt, resolution, imageDataUrls, safetyChecker });
  const url = await callAtlasModel('generateImage', bodies, ctx);
  return ctx.saveRemote(url, 'img', '.png');
}

export async function generateVideo({ modelPath, prompt, resolution, duration, inputImagePaths, inputAudioPaths = [] }, ctx) {
  // Atlas takes frames inline, so unlike Fal there is no upload step.
  const imageDataUrls = await Promise.all(inputImagePaths.map(ctx.readAssetDataUrl));
  // Audio does not: it is forwarded to ByteDance as a URL to fetch, so all
  // that happens here is checking each link is real before anything is billed.
  const audioUrls = [];
  for (const audioRef of inputAudioPaths) {
    audioUrls.push(await resolveAudioReference(audioRef, ctx));
  }
  const bodies = buildAtlasVideoBodies(modelPath, {
    prompt, resolution, duration, imageDataUrls, audioAssetRefs: audioUrls
  });
  const url = await callAtlasModel('generateVideo', bodies, ctx);
  return ctx.saveRemote(url, 'vid', '.mp4');
}
