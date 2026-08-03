// One provider dispatch for both hosts.
//
// The same code runs in the Node server (via a cached dynamic `import()`) and
// in the browser build. Everything host-specific — transport, credentials,
// file IO — arrives through `ctx`, built by each host:
//
//   ctx = {
//     fetch(url, options, providerLabel), // static wraps CORS proxy + clearer errors
//     credentials,                        // config.json (server) / keyStore (static)
//     readAssetDataUrl(path),             // project asset -> data: URL
//     uploadPublicUrl(path),              // project asset -> publicly fetchable URL (Fal storage)
//     saveRemote(url, prefix, ext),       // remote or data: URL -> project-relative path
//     capabilities: { direct: bool }      // false: no-CORS providers (Runway/Kling) unreachable,
//   }                                     //        and Anthropic needs its browser header
//
// Per-model facts (limits, counts, required inputs) live in the catalog;
// per-provider request shaping (field aliases, endpoint swaps, retry ladders,
// polling) lives in the adapter files here. Routing is the only logic in this
// file.

import { resolveRouting, routesToHiggsfield, routesToFal } from './routing.js';
import * as fal from './fal.js';
import * as higgsfield from './higgsfield.js';
import * as atlas from './atlas.js';
import * as google from './google.js';
import * as openai from './openai.js';
import * as anthropic from './anthropic.js';
import * as runway from './runway.js';
import * as kling from './kling.js';

export { resolveRouting, routesToHiggsfield, routesToFal, isHiggsfieldModel } from './routing.js';
export { runLipSync } from './fal.js';

/** Returns the project-relative path of the generated image. */
export async function generateImage({ provider, providerFamily, prompt, resolution, inputImagePaths = [], safetyChecker }, ctx) {
  const { family, path: modelPath } = resolveRouting(provider, providerFamily);
  const req = { modelPath, prompt, resolution, inputImagePaths: (inputImagePaths || []).filter(Boolean), safetyChecker };

  if (family === 'atlas') return atlas.generateImage(req, ctx);
  if (routesToHiggsfield(family, modelPath)) return higgsfield.generateImage(req, ctx);
  if (modelPath === 'google-gemini-image') return google.generateImage(req, ctx);
  if (modelPath === 'chatgpt') return openai.generateImage(req, ctx);
  if (routesToFal(family, modelPath)) return fal.generateImage(req, ctx);
  throw new Error(`Unsupported image provider: ${provider}`);
}

/**
 * Returns the project-relative path of the generated video.
 *
 * `imageUrls` keeps its historical name (it carries project-relative asset
 * paths, not URLs) because it is part of the /api/video/generate shape.
 */
export async function generateVideo({ provider, providerFamily, videoModel, prompt, imageUrls = [], resolution, duration }, ctx) {
  const { family, path: modelPath } = resolveRouting(provider, providerFamily);
  const inputImagePaths = (imageUrls || []).filter(Boolean);
  const req = { modelPath, prompt, resolution, duration, inputImagePaths };

  if (family === 'atlas') return atlas.generateVideo(req, ctx);
  if (routesToHiggsfield(family, modelPath)) return higgsfield.generateVideo(req, ctx);
  if (modelPath === 'runway') return runway.generateVideo(req, ctx);
  if (modelPath === 'kling') return kling.generateVideo(req, ctx);
  if (routesToFal(family, modelPath)) {
    // The bare 'fal-ai' id may carry the real model in `videoModel`.
    if (modelPath === 'fal-ai' && videoModel) {
      const fallback = resolveRouting(videoModel, providerFamily).path;
      if (fallback) return fal.generateVideo({ ...req, modelPath: fallback }, ctx);
    }
    return fal.generateVideo(req, ctx);
  }
  throw new Error(`Unsupported video provider: ${provider}`);
}

/** Returns the model's text reply. */
export async function generateText({ provider, prompt, systemPrompt, model, imagePaths = [] }, ctx) {
  const req = { prompt, systemPrompt, model, imagePaths };
  if (provider === 'gemini') return google.generateText(req, ctx);
  if (provider === 'chatgpt') return openai.generateText(req, ctx);
  if (provider === 'claude') return anthropic.generateText(req, ctx);
  throw new Error(`Unsupported LLM provider: ${provider}`);
}
