// Google (direct AI Studio) adapter: Gemini text and Gemini Flash Image.

import { assetToInlineImage, requireText } from './llmShared.js';

export async function generateText({ prompt, systemPrompt, model, imagePaths = [] }, ctx) {
  const apiKey = ctx.credentials.geminiKey;
  if (!apiKey) throw new Error('Gemini API key is not configured.');

  const images = await Promise.all((imagePaths || []).filter(Boolean).map(p => assetToInlineImage(p, ctx)));
  // No system prompt has to mean *no system text at all*, not an empty one —
  // on Gemini an empty one leaves the user's text wearing a stray label.
  const system = String(systemPrompt || '').trim();
  const targetModel = model || 'gemini-2.5-flash';

  const res = await ctx.fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: system ? `${system}\n\nUser text: ${prompt}` : prompt },
            ...images.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.data } }))
          ]
        }]
      })
    },
    'Gemini'
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Gemini API Error');
  const candidate = data.candidates?.[0];
  return requireText(
    candidate?.content?.parts?.map(part => part.text).filter(Boolean).join('\n'),
    'Gemini', candidate?.finishReason || data.promptFeedback?.blockReason
  );
}

export async function generateImage({ prompt, inputImagePaths }, ctx) {
  const apiKey = ctx.credentials.geminiKey;
  if (!apiKey) throw new Error('Google AI Studio key is not configured.');
  // ai.google.dev caps gemini-2.5-flash-image at 3 images per prompt.
  if (inputImagePaths.length > 3) throw new Error('Gemini Image accepts at most 3 input images.');

  const imageParts = await Promise.all(inputImagePaths.map(async (assetPath) => {
    const img = await assetToInlineImage(assetPath, ctx);
    return { inlineData: { mimeType: img.mimeType, data: img.data } };
  }));

  const res = await ctx.fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, ...imageParts] }],
        generationConfig: { responseModalities: ['IMAGE'] }
      })
    },
    'Gemini Image'
  );
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message || 'Gemini Image API error');

  const part = data.candidates?.flatMap(c => c.content?.parts || []).find(p => p.inlineData?.data);
  if (!part) throw new Error('Gemini Image returned no image output.');

  const mimeType = part.inlineData.mimeType || 'image/png';
  const ext = mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/webp' ? '.webp' : '.png';
  return ctx.saveRemote(`data:${mimeType};base64,${part.inlineData.data}`, 'img', ext);
}
