// Direct browser calls to the generation providers, replacing the Node proxy.
//
// CORS is the whole story here. A static page can only talk to APIs that send
// permissive Access-Control-Allow-Origin headers:
//
//   Gemini    - allows browser requests.
//   OpenAI    - allows browser requests.
//   Anthropic - allows them only with the anthropic-dangerous-direct-browser-access header.
//   Fal.ai    - queue.fal.run generally allows them.
//   Higgsfield / Runway / Kling - undocumented for browser use; may be blocked.
//
// Anything blocked surfaces as a clear "CORS" error rather than a mystery
// network failure, and the optional corsProxy credential lets the user route
// through a proxy they control.

import { writeAsset, readAssetDataUrl } from './fileSystem.js';

/** Wrap a URL in the user's CORS proxy, if they configured one. */
function viaProxy(url, credentials) {
  const proxy = credentials?.corsProxy?.trim();
  if (!proxy) return url;
  return proxy.includes('{url}')
    ? proxy.replace('{url}', encodeURIComponent(url))
    : `${proxy}${proxy.endsWith('=') ? '' : ''}${encodeURIComponent(url)}`;
}

/**
 * fetch that turns the browser's opaque CORS TypeError into something the user
 * can act on. A blocked pre-flight is indistinguishable from a dead network at
 * the JS level, so name both possibilities.
 */
async function callApi(url, options, credentials, providerLabel) {
  try {
    return await fetch(viaProxy(url, credentials), options);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(
        `${providerLabel} could not be reached from the browser. This is usually CORS — the provider refused a direct page request. ` +
        `Set a CORS proxy in Settings, or run the local server build for this provider. (${error.message})`
      );
    }
    throw error;
  }
}

/** Pull a finished generation into the project folder. */
async function downloadToProject(remoteUrl, prefix, fallbackExt, credentials) {
  let response;
  try {
    response = await fetch(viaProxy(remoteUrl, credentials));
  } catch (error) {
    throw new Error(
      `The result was generated but could not be downloaded into your project folder (likely CORS on the media host). ` +
      `URL: ${remoteUrl} (${error.message})`
    );
  }
  if (!response.ok) throw new Error(`Could not download result: ${response.status}`);
  const blob = await response.blob();
  return writeAsset(blob, prefix, blob.type ? null : fallbackExt);
}

// --- LLM ------------------------------------------------------------------

/**
 * Pull the text out of a provider response, failing with something readable.
 *
 * Models return an empty candidate more often than you'd think — safety stops,
 * token limits, recitation blocks — and reaching straight for `.text.trim()`
 * turned those into "Cannot read properties of undefined".
 */
function requireText(value, providerLabel, detail = '') {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(
    `${providerLabel} returned no text${detail ? ` (${detail})` : ''}. ` +
    `This usually means the response was blocked or cut short — try rewording the description, or a different model.`
  );
}

export async function generateText({ provider, prompt, systemPrompt, model }, credentials) {
  if (provider === 'gemini') {
    const apiKey = credentials.geminiKey;
    if (!apiKey) throw new Error('Gemini API key is not configured.');
    const targetModel = model || 'gemini-2.5-flash';
    const res = await callApi(
      `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: `${systemPrompt}\n\nUser text: ${prompt}` }] }] })
      },
      credentials, 'Gemini'
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Gemini API Error');
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.map(part => part.text).filter(Boolean).join('\n');
    return requireText(text, 'Gemini', candidate?.finishReason || data.promptFeedback?.blockReason);
  }

  if (provider === 'chatgpt') {
    const apiKey = credentials.openaiKey;
    if (!apiKey) throw new Error('OpenAI API key is not configured.');
    const res = await callApi(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model || 'gpt-4o-mini',
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
        })
      },
      credentials, 'OpenAI'
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'OpenAI API Error');
    const choice = data.choices?.[0];
    return requireText(choice?.message?.content, 'OpenAI', choice?.finish_reason);
  }

  if (provider === 'claude') {
    const apiKey = credentials.claudeKey;
    if (!apiKey) throw new Error('Claude API key is not configured.');
    const res = await callApi(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          // Required for Anthropic to accept a request straight from a page.
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: model || 'claude-sonnet-5',
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: prompt }]
        })
      },
      credentials, 'Anthropic'
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Claude API Error');
    const text = data.content?.filter(block => block.type === 'text').map(block => block.text).join('\n');
    return requireText(text, 'Claude', data.stop_reason);
  }

  throw new Error(`Unsupported LLM provider: ${provider}`);
}

export async function listModels(provider, credentials) {
  const fallbacks = {
    gemini: [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash (Recommended)' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' }
    ],
    chatgpt: [
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini (Recommended)' },
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' }
    ],
    claude: [
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
      { id: 'claude-opus-5', name: 'Claude Opus 5' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' }
    ]
  };

  try {
    if (provider === 'gemini' && credentials.geminiKey) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${credentials.geminiKey}`);
      if (res.ok) {
        const data = await res.json();
        const models = data.models
          .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
          .map(m => ({ id: m.name.replace('models/', ''), name: m.displayName }));
        if (models.length) return models;
      }
    }
    if (provider === 'chatgpt' && credentials.openaiKey) {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${credentials.openaiKey}` }
      });
      if (res.ok) {
        const data = await res.json();
        const models = data.data
          .filter(m => m.id.startsWith('gpt') || m.id.startsWith('o1'))
          .map(m => ({ id: m.id, name: m.id }));
        if (models.length) return models;
      }
    }
    if (provider === 'claude' && credentials.claudeKey) {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': credentials.claudeKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        }
      });
      if (res.ok) {
        const data = await res.json();
        const models = data.data.map(m => ({ id: m.id, name: m.display_name || m.id }));
        if (models.length) return models;
      }
    }
  } catch {
    // Listing is a nicety; fall through to the static list.
  }
  return fallbacks[provider] || [];
}

// --- Fal.ai queue ---------------------------------------------------------

async function callFalModel(modelId, input, credentials) {
  const apiKey = credentials.falKey;
  if (!apiKey) throw new Error('Fal.ai API key is not configured.');
  const headers = { 'Content-Type': 'application/json', Authorization: `Key ${apiKey}` };

  const submit = await callApi(`https://queue.fal.run/${modelId}`, {
    method: 'POST', headers, body: JSON.stringify(input)
  }, credentials, 'Fal.ai');

  if (!submit.ok) throw new Error(`Fal.ai submission failed (${submit.status}): ${await submit.text()}`);
  const submitData = await submit.json();
  const requestId = submitData.request_id || submitData.gateway_request_id;
  const statusUrl = submitData.status_url || `https://queue.fal.run/${encodeURIComponent(modelId)}/requests/${requestId}/status`;
  const resultUrl = submitData.response_url || `https://queue.fal.run/${encodeURIComponent(modelId)}/requests/${requestId}`;

  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const statusRes = await fetch(viaProxy(statusUrl, credentials), { headers: { Authorization: `Key ${apiKey}` } });
    if (!statusRes.ok) throw new Error(`Fal.ai status check failed: ${statusRes.status}`);
    const status = await statusRes.json();
    if (status.status === 'COMPLETED') {
      const resultRes = await fetch(viaProxy(resultUrl, credentials), { headers: { Authorization: `Key ${apiKey}` } });
      if (!resultRes.ok) throw new Error(`Fal.ai result fetch failed: ${resultRes.status}`);
      return resultRes.json();
    }
    if (status.status === 'FAILED') throw new Error(`Fal.ai task failed: ${status.error || 'unknown error'}`);
  }
  throw new Error('Fal.ai task timed out.');
}

/** Push a local asset into Fal storage so video models can read it by URL. */
async function uploadToFalMedia(assetPath, credentials) {
  const apiKey = credentials.falKey;
  if (!apiKey) throw new Error('Image-to-video needs a Fal.ai key to host the input image.');
  const dataUrl = await readAssetDataUrl(assetPath);
  const blob = await (await fetch(dataUrl)).blob();

  const initRes = await callApi('https://rest.fal.ai/storage/upload/initiate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${apiKey}` },
    body: JSON.stringify({ file_name: assetPath.split('/').pop(), content_type: blob.type || 'image/png' })
  }, credentials, 'Fal.ai storage');
  if (!initRes.ok) throw new Error(`Fal.ai upload init failed: ${await initRes.text()}`);

  const { upload_url, file_url } = await initRes.json();
  const putRes = await fetch(upload_url, {
    method: 'PUT', headers: { 'Content-Type': blob.type || 'image/png' }, body: blob
  });
  if (!putRes.ok) throw new Error(`Fal.ai upload failed: ${putRes.status}`);
  return file_url;
}

// --- Higgsfield -----------------------------------------------------------

const HIGGSFIELD_BASE = 'https://platform.higgsfield.ai';
const HIGGSFIELD_PREFIXES = [
  'higgsfield-ai/', 'reve/', 'google/', 'openai/', 'bytedance/',
  'kling-video/', 'kling/', 'minimax/', 'alibaba/', 'black-forest-labs/'
];

export function isHiggsfieldModel(modelId) {
  return typeof modelId === 'string' && HIGGSFIELD_PREFIXES.some(prefix => modelId.startsWith(prefix));
}

async function callHiggsfieldModel(modelId, input, credentials) {
  const key = credentials.higgsfieldKey;
  if (!key) throw new Error('Higgsfield API key is not configured.');
  const auth = `Key ${credentials.higgsfieldSecret ? `${key}:${credentials.higgsfieldSecret}` : key}`;

  const submit = await callApi(`${HIGGSFIELD_BASE}/${modelId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify(input)
  }, credentials, 'Higgsfield');

  if (!submit.ok) throw new Error(`Higgsfield submission failed (${submit.status}): ${await submit.text()}`);
  const submitData = await submit.json();
  if (submitData.status === 'completed') return submitData;

  const requestId = submitData.request_id || submitData.id;
  const statusUrl = submitData.status_url || `${HIGGSFIELD_BASE}/requests/${requestId}/status`;

  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const statusRes = await fetch(viaProxy(statusUrl, credentials), { headers: { Authorization: auth } });
    if (!statusRes.ok) throw new Error(`Higgsfield status check failed: ${statusRes.status}`);
    const status = await statusRes.json();
    if (status.status === 'completed') return status;
    if (status.status === 'failed') throw new Error(`Higgsfield failed: ${status.error || status.message || 'unknown'}`);
    if (status.status === 'nsfw') throw new Error('Higgsfield rejected the generation as NSFW.');
    if (status.status === 'cancelled') throw new Error('Higgsfield generation was cancelled.');
  }
  throw new Error('Higgsfield generation timed out.');
}

// --- images ---------------------------------------------------------------

export async function generateImage({ provider, prompt, resolution, inputImagePaths = [] }, credentials) {
  if (provider === 'higgsfield' || isHiggsfieldModel(provider)) {
    const modelId = provider === 'higgsfield' ? 'higgsfield-ai/soul/standard' : provider;
    const input = { prompt };
    if (resolution?.includes(':')) input.aspect_ratio = resolution;
    else if (resolution) input.resolution = resolution;

    if (inputImagePaths.length > 0) {
      const dataUrls = await Promise.all(inputImagePaths.map(readAssetDataUrl));
      input.image_url = dataUrls[0];
      input.reference_images = dataUrls;
    }
    const result = await callHiggsfieldModel(modelId, input, credentials);
    const url = result.images?.[0]?.url || result.image?.url;
    if (!url) throw new Error('No image returned from Higgsfield.');
    return downloadToProject(url, 'img', '.png', credentials);
  }

  if (provider === 'google-gemini-image') {
    const apiKey = credentials.geminiKey;
    if (!apiKey) throw new Error('Google AI Studio key is not configured.');
    if (inputImagePaths.length > 3) throw new Error('Gemini Image accepts at most 3 input images.');

    const imageParts = await Promise.all(inputImagePaths.map(async (assetPath) => {
      const dataUrl = await readAssetDataUrl(assetPath);
      const [meta, data] = dataUrl.split(',');
      return { inlineData: { mimeType: meta.slice(5).replace(';base64', ''), data } };
    }));

    const res = await callApi(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, ...imageParts] }],
          generationConfig: { responseModalities: ['IMAGE'] }
        })
      },
      credentials, 'Gemini Image'
    );
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error?.message || 'Gemini Image API error');

    const part = data.candidates?.flatMap(c => c.content?.parts || []).find(p => p.inlineData?.data);
    if (!part) throw new Error('Gemini Image returned no image.');
    const blob = await (await fetch(`data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`)).blob();
    return writeAsset(blob, 'img');
  }

  if (provider === 'chatgpt') {
    const apiKey = credentials.openaiKey;
    if (!apiKey) throw new Error('OpenAI API key is not configured.');
    let size = '1024x1024';
    if (resolution && /16:9|1344|1792|21:9|3:2/.test(resolution)) size = '1792x1024';
    else if (resolution && /9:16|768/.test(resolution)) size = '1024x1792';

    const res = await callApi('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'dall-e-3', prompt, n: 1, size, quality: 'standard' })
    }, credentials, 'DALL-E');
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'DALL-E 3 API Error');
    return downloadToProject(data.data[0].url, 'img', '.png', credentials);
  }

  // Everything else routes through Fal.
  const modelId = provider === 'fal-ai' ? 'fal-ai/flux/schnell' : provider;
  let imageSize = 'landscape_16_9';
  if (resolution === '9:16') imageSize = 'portrait_16_9';
  else if (resolution === '1:1') imageSize = 'square_hd';
  else if (resolution === '4:3') imageSize = 'landscape_4_3';
  else if (resolution === '3:2') imageSize = { width: 1200, height: 800 };
  else if (resolution === '21:9') imageSize = { width: 1536, height: 640 };
  else if (resolution?.includes('x')) imageSize = resolution;

  const input = { prompt, image_size: imageSize, num_inference_steps: 4 };
  if (inputImagePaths.length > 0) {
    input.image_url = await readAssetDataUrl(inputImagePaths[0]);
  } else if (modelId.includes('redux')) {
    throw new Error('Flux Redux needs at least one input reference image.');
  }

  const result = await callFalModel(modelId, input, credentials);
  if (!result.images?.length) throw new Error('No images returned from Fal.ai');
  return downloadToProject(result.images[0].url, 'img', '.png', credentials);
}

// --- video ----------------------------------------------------------------

export async function generateVideo({ provider, prompt, imageUrls = [], resolution, duration }, credentials) {
  const routesToHiggsfield = provider === 'higgsfield' || isHiggsfieldModel(provider);
  const aspect = resolution === '720x1280' ? '9:16' : '16:9';

  if (routesToHiggsfield) {
    const modelId = provider === 'higgsfield' ? 'higgsfield-ai/dop/preview' : provider;
    const input = { prompt, aspect_ratio: aspect, duration: Number(duration) || 5 };
    if (imageUrls.length > 0) {
      const dataUrls = await Promise.all(imageUrls.map(readAssetDataUrl));
      input.image_url = dataUrls[0];
      input.input_images = dataUrls;
    }
    const result = await callHiggsfieldModel(modelId, input, credentials);
    const url = result.video?.url || result.videos?.[0]?.url;
    if (!url) throw new Error('No video returned from Higgsfield.');
    return downloadToProject(url, 'vid', '.mp4', credentials);
  }

  if (provider === 'runway' || provider === 'kling') {
    throw new Error(
      `${provider === 'runway' ? 'Runway' : 'Kling'} does not support direct browser calls — its API has no CORS support. ` +
      `Use a Fal.ai or Higgsfield model, or run the local server build.`
    );
  }

  // Fal video
  const hasImage = imageUrls.length > 0;
  let modelId = provider === 'fal-ai' ? 'fal-ai/kling-video' : provider;
  if (modelId === 'fal-ai/kling-video') {
    modelId = hasImage ? 'fal-ai/kling-video/v2.1/standard/image-to-video' : 'fal-ai/kling-video/v3/standard/text-to-video';
  } else if (modelId === 'fal-ai/luma-dream-machine') {
    modelId = hasImage ? 'fal-ai/luma-dream-machine/image-to-video' : 'fal-ai/luma-dream-machine/text-to-video';
  }

  let durationValue = duration || '5';
  if (modelId.startsWith('fal-ai/veo')) durationValue = durationValue === '10' ? '8s' : '5s';

  const input = { prompt, duration: durationValue, aspect_ratio: aspect };
  if (hasImage) input.image_url = await uploadToFalMedia(imageUrls[0], credentials);

  const result = await callFalModel(modelId, input, credentials);
  const url = result.video?.url || result.videos?.[0]?.url;
  if (!url) throw new Error('No video URL returned from Fal.ai');
  return downloadToProject(url, 'vid', '.mp4', credentials);
}

// --- lip sync -------------------------------------------------------------

export async function runLipSync({ videoPath, audioPath }, credentials) {
  if (!credentials.falKey) throw new Error('Fal.ai API key is required for lip-sync.');
  const [videoUrl, audioUrl] = await Promise.all([
    uploadToFalMedia(videoPath, credentials),
    uploadToFalMedia(audioPath, credentials)
  ]);
  const result = await callFalModel('fal-ai/sync-lipsync', {
    video_url: videoUrl, audio_url: audioUrl, lipsync_mode: 'cut_off'
  }, credentials);
  const url = result.video?.url || result.url;
  if (!url) throw new Error('No synced video returned.');
  return downloadToProject(url, 'sync', '.mp4', credentials);
}
