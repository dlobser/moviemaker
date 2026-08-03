// Kling Developer API adapter (video only). Like Runway, no CORS support, so
// it is reachable only where the host can make direct server-side requests.

const KLING_BASE = 'https://api-singapore.klingai.com';

export async function generateVideo({ prompt, resolution, duration, inputImagePaths }, ctx) {
  if (ctx.capabilities?.direct === false) {
    throw new Error(
      'Kling does not support direct browser calls — its API has no CORS support. ' +
      'Use a Fal.ai or Higgsfield model, or run the local server build.'
    );
  }

  const apiKey = ctx.credentials.klingKey;
  if (!apiKey) throw new Error('Kling API key is not configured.');

  const hasImage = inputImagePaths.length > 0;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  const payload = {
    model: 'kling-v1-5',
    prompt,
    cfg_scale: 0.5,
    duration: duration || '5',
    aspect_ratio: resolution === '720x1280' ? '9:16' : '16:9'
  };
  if (hasImage) payload.image = await ctx.uploadPublicUrl(inputImagePaths[0]);

  const endpoint = hasImage ? '/v1/videos/image2video' : '/v1/videos/text2video';
  const submitRes = await ctx.fetch(`${KLING_BASE}${endpoint}`, {
    method: 'POST', headers, body: JSON.stringify(payload)
  }, 'Kling');
  const submitData = await submitRes.json();
  if (submitData.code !== 0) throw new Error(`Kling Task failed to submit: ${submitData.message}`);

  const taskId = submitData.data.task_id;
  for (let attempt = 0; attempt < 60; attempt++) {
    const pollRes = await ctx.fetch(`${KLING_BASE}/v1/videos/status?task_id=${taskId}`, { headers }, 'Kling');
    const pollData = await pollRes.json();
    if (pollData.code === 0 && pollData.data.task_status === 'SUCCESS') {
      return ctx.saveRemote(pollData.data.task_result.videos[0].url, 'vid', '.mp4');
    }
    if (pollData.code !== 0 || pollData.data.task_status === 'FAILED') {
      throw new Error(`Kling Task failed: ${pollData.message || 'generation failed'}`);
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw new Error('Kling task timed out.');
}
