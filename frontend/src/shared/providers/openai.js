// OpenAI (direct) adapter: ChatGPT text and DALL-E 3 images.

import { assetToInlineImage, requireText } from './llmShared.js';

export async function generateText({ prompt, systemPrompt, model, imagePaths = [] }, ctx) {
  const apiKey = ctx.credentials.openaiKey;
  if (!apiKey) throw new Error('OpenAI API key is not configured.');

  const images = await Promise.all((imagePaths || []).filter(Boolean).map(p => assetToInlineImage(p, ctx)));
  const system = String(systemPrompt || '').trim();

  const res = await ctx.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        {
          role: 'user',
          content: images.length === 0 ? prompt : [
            { type: 'text', text: prompt },
            ...images.map(img => ({
              type: 'image_url',
              image_url: { url: `data:${img.mimeType};base64,${img.data}` }
            }))
          ]
        }
      ]
    })
  }, 'OpenAI');
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'OpenAI API Error');
  const choice = data.choices?.[0];
  return requireText(choice?.message?.content, 'OpenAI', choice?.finish_reason);
}

// --- request shaping (pure) ------------------------------------------------

/** Map studio resolutions/ratios to DALL-E's three sizes. */
export function dalleSize(resolution) {
  if (resolution && (resolution.includes('16:9') || resolution.includes('1344') || resolution.includes('1792') || resolution === '21:9' || resolution === '3:2')) {
    return '1792x1024';
  }
  if (resolution && (resolution.includes('9:16') || resolution.includes('768'))) {
    return '1024x1792';
  }
  return '1024x1024';
}

export async function generateImage({ prompt, resolution }, ctx) {
  const apiKey = ctx.credentials.openaiKey;
  if (!apiKey) throw new Error('OpenAI API key is not configured.');

  const res = await ctx.fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'dall-e-3', prompt, n: 1, size: dalleSize(resolution), quality: 'standard' })
  }, 'DALL-E');
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'DALL-E 3 API Error');
  return ctx.saveRemote(data.data[0].url, 'img', '.png');
}
