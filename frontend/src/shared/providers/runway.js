// RunwayML adapter (video only). Runway's API has no CORS support, so it is
// reachable only where the host can make direct server-side requests.

export async function generateVideo({ prompt, resolution, inputImagePaths }, ctx) {
  if (ctx.capabilities?.direct === false) {
    throw new Error(
      'Runway does not support direct browser calls — its API has no CORS support. ' +
      'Use a Fal.ai or Higgsfield model, or run the local server build.'
    );
  }

  const apiKey = ctx.credentials.runwayKey;
  if (!apiKey) throw new Error('Runway API key is not configured.');

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'X-Runway-Version': '2024-11-06'
  };

  const payload = {
    model: 'gen3a_turbo',
    promptText: prompt,
    ratio: resolution === '720x1280' ? '720:1280' : '1280:720'
  };
  if (inputImagePaths.length > 0) payload.imageUrl = await ctx.uploadPublicUrl(inputImagePaths[0]);

  const submitRes = await ctx.fetch('https://api.dev.runwayml.com/v1/image_to_video', {
    method: 'POST', headers, body: JSON.stringify(payload)
  }, 'Runway');
  if (!submitRes.ok) throw new Error(`Runway task submission failed: ${await submitRes.text()}`);
  const { id } = await submitRes.json();

  for (let attempt = 0; attempt < 60; attempt++) {
    const pollRes = await ctx.fetch(`https://api.dev.runwayml.com/v1/tasks/${id}`, { headers }, 'Runway');
    const task = await pollRes.json();
    if (task.status === 'SUCCEEDED') return ctx.saveRemote(task.output[0], 'vid', '.mp4');
    if (task.status === 'FAILED') throw new Error(`Runway task failed: ${task.failureReason || 'unknown error'}`);
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw new Error('Runway task timed out.');
}
