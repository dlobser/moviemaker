// Which service a model id belongs to, shared by both hosts.
//
// The prefix guess is no longer decidable on its own: the same vendor
// namespaces exist on both hosts, so `bytedance/seedance-2.0/image-to-video`
// (Fal) and `bytedance/seedance/v1/pro/image-to-video` (Higgsfield) are
// indistinguishable. A custom path may therefore declare its host inline as
// `fal:<path>` or `higgsfield:<path>`, and the client also sends the family it
// resolved. Without either, the old prefix guess still applies unchanged.

import { normalizeFamily, parseModelId } from '../../catalog.js';

export { normalizeFamily, parseModelId, formatModelId } from '../../catalog.js';

// Model ids routed through Higgsfield when nothing declares a host. Kept so
// older saved projects still route the way they always did.
const HIGGSFIELD_PREFIXES = [
  'higgsfield-ai/', 'reve/', 'google/', 'openai/', 'bytedance/',
  'kling-video/', 'kling/', 'minimax/', 'alibaba/', 'black-forest-labs/'
];

export function isHiggsfieldModel(modelId) {
  return typeof modelId === 'string' && HIGGSFIELD_PREFIXES.some(prefix => modelId.startsWith(prefix));
}

/**
 * An id may declare its host explicitly (`fal:path`), the caller may pass one
 * alongside, and failing both the old prefix guess still applies.
 */
export function resolveRouting(id, declaredFamily) {
  const { family, path } = parseModelId(id);
  return { family: family || normalizeFamily(declaredFamily), path };
}

/** True when this id should be sent to Higgsfield rather than Fal. */
export function routesToHiggsfield(family, modelPath) {
  if (family) return family === 'higgsfield';
  return modelPath === 'higgsfield' || isHiggsfieldModel(modelPath);
}

/**
 * True when this id may fall through to Fal. An explicitly declared host wins
 * over the "starts with fal-ai" guess; an id that matches neither must fail
 * loudly rather than bill a mis-routed Fal request.
 */
export function routesToFal(family, modelPath) {
  if (family) return family === 'fal-ai';
  return modelPath === 'fal-ai' || modelPath.startsWith('fal-ai');
}
