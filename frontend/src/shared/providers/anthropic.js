// Anthropic adapter: Claude text.

import { assetToInlineImage, requireText } from './llmShared.js';

export async function generateText({ prompt, systemPrompt, model, imagePaths = [], maxTokens }, ctx) {
  const apiKey = ctx.credentials.claudeKey;
  if (!apiKey) throw new Error('Claude API key is not configured.');

  const images = await Promise.all((imagePaths || []).filter(Boolean).map(p => assetToInlineImage(p, ctx)));
  const system = String(systemPrompt || '').trim();

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };
  // Required for Anthropic to accept a request straight from a page; a server
  // never needs (or sends) it.
  if (ctx.capabilities?.direct === false) headers['anthropic-dangerous-direct-browser-access'] = 'true';

  const res = await ctx.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model || 'claude-sonnet-5',
      // 1024 was enough for one-line prompt writing but silently truncated a
      // full script JSON mid-array. Anthropic requires the field, so pick a
      // ceiling generous enough for a whole shot list.
      max_tokens: Number.isFinite(maxTokens) ? maxTokens : 8192,
      ...(system ? { system } : {}),
      messages: [{
        role: 'user',
        // Images before text: Anthropic's own guidance for image questions.
        content: images.length === 0 ? prompt : [
          ...images.map(img => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mimeType, data: img.data }
          })),
          { type: 'text', text: prompt }
        ]
      }]
    })
  }, 'Anthropic');
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Claude API Error');
  return requireText(
    data.content?.filter(block => block.type === 'text').map(block => block.text).join('\n'),
    'Claude', data.stop_reason
  );
}
