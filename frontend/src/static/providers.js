// Static-mode host for the shared provider module: direct browser calls to
// the generation providers, replacing the Node proxy.
//
// The dispatch and per-provider request shaping live in
// ../shared/providers/ — one implementation for both modes. What remains here
// is the browser transport: CORS handling, the optional proxy, File System
// Access API IO, and Fal storage uploads from in-browser blobs.
//
// CORS is the whole story for the transport. A static page can only talk to
// APIs that send permissive Access-Control-Allow-Origin headers:
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
import * as shared from '../shared/providers/index.js';

export { isHiggsfieldModel } from '../shared/providers/index.js';

/** Wrap a URL in the user's CORS proxy, if they configured one. */
function viaProxy(url, credentials) {
  const proxy = credentials?.corsProxy?.trim();
  if (!proxy) return url;
  return proxy.includes('{url}')
    ? proxy.replace('{url}', encodeURIComponent(url))
    : `${proxy}${encodeURIComponent(url)}`;
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

/** Pull a finished generation (remote or data: URL) into the project folder. */
async function downloadToProject(remoteUrl, prefix, fallbackExt, credentials) {
  let response;
  try {
    // data: URLs need no proxy and always "download".
    response = await fetch(remoteUrl.startsWith('data:') ? remoteUrl : viaProxy(remoteUrl, credentials));
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

/** Push a local asset into Fal storage so remote models can read it by URL. */
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

/** The shared module's host contract, browser edition. */
function buildCtx(credentials) {
  return {
    fetch: (url, options, providerLabel) => callApi(url, options, credentials, providerLabel || 'The provider'),
    credentials,
    readAssetDataUrl,
    uploadPublicUrl: (assetPath) => uploadToFalMedia(assetPath, credentials),
    saveRemote: (url, prefix, ext) => downloadToProject(url, prefix, ext, credentials),
    capabilities: { direct: false }
  };
}

export const generateImage = (req, credentials) => shared.generateImage(req, buildCtx(credentials));
export const generateVideo = (req, credentials) => shared.generateVideo(req, buildCtx(credentials));
export const generateText = (req, credentials) => shared.generateText(req, buildCtx(credentials));
export const runLipSync = (req, credentials) => shared.runLipSync(req, buildCtx(credentials));

// --- model listing ----------------------------------------------------------
// A nicety, not a dispatch concern: stays host-local because the browser needs
// its own auth header shape and its own fallback lists.

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
