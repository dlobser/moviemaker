// Fal.ai adapter: queue submit + poll, and the request shaping for Fal-served
// image and video models. Pure `build*` helpers are exported so request bodies
// are unit-testable without touching the network.

/**
 * The queue endpoints for a Fal model hang off the *app*, not the full model
 * path: a request submitted to `fal-ai/bytedance/seedance-2.0/image-to-video`
 * is polled and collected at `fal-ai/bytedance/requests/{id}`. Keeping the
 * sub-path yields a 404 naming the part Fal could not route.
 */
export function falQueueBase(modelId) {
  return String(modelId).split('/').filter(Boolean).slice(0, 2).join('/');
}

/** The result URL for a status URL: the same address without its /status. */
function falResultUrlFromStatus(statusUrl) {
  try {
    const url = new URL(statusUrl);
    url.pathname = url.pathname.replace(/\/status$/, '');
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Turn a Fal error body into something a director can act on: the `msg` out of
 * its FastAPI-shaped `detail`, rather than that message buried inside an echo
 * of the whole request.
 */
export function describeFalError(body) {
  try {
    const parsed = JSON.parse(body);
    const detail = parsed.detail;
    const entries = Array.isArray(detail) ? detail : detail ? [detail] : [];
    const messages = entries
      .map(entry => (typeof entry === 'string' ? entry : entry && (entry.msg || entry.message)))
      .filter(Boolean);
    if (messages.length === 0) return body;

    const policy = entries.some(entry => entry && entry.type === 'content_policy_violation');
    if (!policy) return messages.join('; ');

    // Two unrelated refusals arrive wearing the same type. One is about what
    // the prompt asked for; the other is about the reference images — and
    // "reword the prompt" sent people to rewrite text that was never the
    // problem while the offending picture stayed attached.
    const aboutInputs = /likeness|real (people|person|individual)|private information|images or videos provided/i
      .test(messages.join(' '));
    return `${messages.join('; ')} ${aboutInputs
      ? 'This is moderation refusing your reference images, not the prompt — rewording will not help. '
        + 'Swap the reference for a less photoreal or clearly synthetic image. Note that a face and a '
        + 'voice together trip this far more readily than either alone.'
      : 'This is the model host\'s own moderation refusing the finished result — it ran, then was '
        + 'withheld. Rewording the prompt is the only route through.'}`;
  } catch {
    return body; // not JSON after all
  }
}

/** Submit to the Fal queue, poll to completion, return the result payload. */
export async function callFalModel(modelId, input, ctx) {
  const apiKey = ctx.credentials.falKey;
  if (!apiKey) throw new Error('Fal.ai API key is not configured.');
  const headers = { 'Content-Type': 'application/json', Authorization: `Key ${apiKey}` };

  const submit = await ctx.fetch(`https://queue.fal.run/${modelId}`, {
    method: 'POST', headers, body: JSON.stringify(input)
  }, 'Fal.ai');
  if (!submit.ok) throw new Error(`Fal.ai submission failed (${submit.status}): ${await submit.text()}`);

  const submitData = await submit.json();
  const requestId = submitData.request_id || submitData.gateway_request_id;
  const queueBase = `https://queue.fal.run/${falQueueBase(modelId)}/requests/${requestId}`;
  const statusUrl = submitData.status_url || `${queueBase}/status`;
  const resultUrl = submitData.response_url || falResultUrlFromStatus(statusUrl) || queueBase;

  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const statusRes = await ctx.fetch(statusUrl, { headers: { Authorization: `Key ${apiKey}` } }, 'Fal.ai');
    if (!statusRes.ok) throw new Error(`Fal.ai status check failed: ${statusRes.status}`);
    const status = await statusRes.json();

    if (status.status === 'COMPLETED') {
      // Already generated and already billed by this point, so a 404 on
      // collection is the worst possible failure — try the canonical
      // app-level URL too rather than losing the result to one bad address.
      const candidates = [resultUrl, queueBase]
        .filter((url, index, all) => url && all.indexOf(url) === index);

      let lastStatus = 0;
      let lastBody = '';
      for (const url of candidates) {
        const resultRes = await ctx.fetch(url, { headers: { Authorization: `Key ${apiKey}` } }, 'Fal.ai');
        if (resultRes.ok) return resultRes.json();
        lastStatus = resultRes.status;
        lastBody = await resultRes.text();
        // Only a 404 means we may have asked at the wrong address; anything
        // else is a real answer about this request.
        if (resultRes.status !== 404) break;
      }
      throw new Error(lastStatus === 404
        ? `Fal.ai result fetch failed (${lastStatus}): ${describeFalError(lastBody)}`
        : `Fal.ai refused the finished result (${lastStatus}): ${describeFalError(lastBody)}`);
    }
    if (status.status === 'FAILED') throw new Error(`Fal.ai task failed: ${status.error || 'unknown error'}`);
  }
  throw new Error('Fal.ai task timed out.');
}

// --- request shaping (pure) ------------------------------------------------

/** The studio's aspect ratios in Fal's image_size vocabulary. */
export function falImageSize(resolution) {
  if (resolution === '9:16') return 'portrait_16_9';
  if (resolution === '1:1') return 'square_hd';
  if (resolution === '4:3') return 'landscape_4_3';
  if (resolution === '3:2') return { width: 1200, height: 800 };
  if (resolution === '21:9') return { width: 1536, height: 640 };
  if (typeof resolution === 'string' && resolution.includes('x')) return resolution;
  return 'landscape_16_9';
}

export function buildFalImageRequest(modelPath, { prompt, resolution }) {
  const modelId = modelPath === 'fal-ai' ? 'fal-ai/flux/schnell' : modelPath;
  return {
    modelId,
    input: { prompt, image_size: falImageSize(resolution), num_inference_steps: 4 }
  };
}

/**
 * Kling and Luma publish separate endpoints for text-to-video and
 * image-to-video, so the bare family id resolves differently depending on
 * whether an input frame travels with the request.
 */
export function resolveFalVideoModel(modelPath, hasImage) {
  let modelId = modelPath === 'fal-ai' ? 'fal-ai/kling-video' : modelPath;
  if (modelId === 'fal-ai/kling-video') {
    modelId = hasImage
      ? 'fal-ai/kling-video/v2.1/standard/image-to-video'
      : 'fal-ai/kling-video/v3/standard/text-to-video';
  } else if (modelId === 'fal-ai/luma-dream-machine') {
    modelId = hasImage
      ? 'fal-ai/luma-dream-machine/image-to-video'
      : 'fal-ai/luma-dream-machine/text-to-video';
  }
  return modelId;
}

/**
 * Seedance 2.0's reference endpoints take arrays — `image_urls` for up to nine
 * stills and `audio_urls` for up to three clips — where every other video model
 * here takes a single `image_url` first frame. The prompt addresses both by
 * position, as @image1 and @audio1.
 */
export function isFalReferenceEndpoint(modelId) {
  return /reference-to-video/.test(String(modelId));
}

export function buildFalVideoRequest(modelPath, { prompt, resolution, duration, hasImage }) {
  const modelId = resolveFalVideoModel(modelPath, hasImage);

  let durationValue = duration || '5';
  // Veo speaks in '5s' / '8s' and tops out at 8; projects saved before the
  // catalog offered those two still hold 10, so both round to the nearest.
  if (modelId.startsWith('fal-ai/veo')) durationValue = Number(durationValue) >= 8 ? '8s' : '5s';

  const input = {
    prompt,
    duration: durationValue,
    aspect_ratio: resolution === '720x1280' ? '9:16' : '16:9'
  };
  // Seedance documents resolution separately from aspect; without it Fal picks
  // its own default rather than the 720p the studio prices against.
  if (isFalReferenceEndpoint(modelId)) input.resolution = '720p';

  return { modelId, input };
}

// --- generation ------------------------------------------------------------

export async function generateImage({ modelPath, prompt, resolution, inputImagePaths }, ctx) {
  const { modelId, input } = buildFalImageRequest(modelPath, { prompt, resolution });

  if (inputImagePaths.length > 0) {
    input.image_url = await ctx.readAssetDataUrl(inputImagePaths[0]);
  } else if (modelId.includes('redux')) {
    throw new Error('Flux Redux requires at least one input reference image. Please add a reference image to this shot first.');
  }

  const result = await callFalModel(modelId, input, ctx);
  if (!result.images?.length) throw new Error('No images returned from Fal.ai');
  return ctx.saveRemote(result.images[0].url, 'img', '.png');
}

/**
 * An audio reference as a URL Fal can hand the model.
 *
 * A file in the project is uploaded to Fal storage, which is the whole reason
 * audio works here and not on Atlas: the model is given a fal.media address
 * rather than whatever host you happened to have.
 */
async function falAudioUrl(audioRef, ctx) {
  if (/^asset:\/\//i.test(audioRef)) {
    throw new Error(
      `"${audioRef}" is an Atlas Asset Library id and means nothing to Fal. Add the clip as a file ` +
      `or an https:// URL, or point this shot at one of the Atlas Seedance models.`
    );
  }
  if (/^https?:\/\//i.test(audioRef)) return audioRef;
  return ctx.uploadPublicUrl(audioRef);
}

export async function generateVideo({ modelPath, prompt, resolution, duration, inputImagePaths, inputAudioPaths = [] }, ctx) {
  const hasImage = inputImagePaths.length > 0;
  const { modelId, input } = buildFalVideoRequest(modelPath, { prompt, resolution, duration, hasImage });

  if (isFalReferenceEndpoint(modelId)) {
    // Every reference goes, in slot order: the prompt points at them by
    // position, so sending a subset silently re-aims every pointer past the gap.
    input.image_urls = await Promise.all(inputImagePaths.map(path => ctx.uploadPublicUrl(path)));
    if (inputAudioPaths.length > 0) {
      input.audio_urls = [];
      for (const audioRef of inputAudioPaths) input.audio_urls.push(await falAudioUrl(audioRef, ctx));
    }
  } else if (hasImage) {
    input.image_url = await ctx.uploadPublicUrl(inputImagePaths[0]);
  }

  const result = await callFalModel(modelId, input, ctx);
  const url = result.video?.url || result.videos?.[0]?.url;
  if (!url) throw new Error('No video URL returned from Fal.ai');
  return ctx.saveRemote(url, 'vid', '.mp4');
}

/** Lip-sync runs on Fal regardless of which models made the inputs. */
export async function runLipSync({ videoPath, audioPath }, ctx) {
  if (!ctx.credentials.falKey) throw new Error('Fal.ai API key is required for lip-sync.');
  const [videoUrl, audioUrl] = await Promise.all([
    ctx.uploadPublicUrl(videoPath),
    ctx.uploadPublicUrl(audioPath)
  ]);
  const result = await callFalModel('fal-ai/sync-lipsync', {
    video_url: videoUrl, audio_url: audioUrl, lipsync_mode: 'cut_off'
  }, ctx);
  const url = result.video?.url || result.url;
  if (!url) throw new Error('No synced video returned.');
  return ctx.saveRemote(url, 'sync', '.mp4');
}
