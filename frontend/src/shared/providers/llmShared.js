// Small helpers shared by the LLM-capable adapters.

/**
 * Pull the text out of a provider response, failing with something readable.
 *
 * Models return an empty candidate more often than you'd think — safety stops,
 * token limits, recitation blocks — and reaching straight for `.text.trim()`
 * turned those into "Cannot read properties of undefined".
 */
export function requireText(value, providerLabel, detail = '') {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(
    `${providerLabel} returned no text${detail ? ` (${detail})` : ''}. ` +
    `This usually means the response was blocked or cut short — try rewording the description, or a different model.`
  );
}

/** Split a project asset into the { mimeType, data } pair every vision API wants. */
export async function assetToInlineImage(assetPath, ctx) {
  const dataUrl = await ctx.readAssetDataUrl(assetPath);
  const [meta, data] = dataUrl.split(',');
  return { mimeType: meta.slice(5).replace(';base64', ''), data };
}
