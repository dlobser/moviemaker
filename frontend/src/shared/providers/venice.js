// Venice.ai adapter. One key, three endpoint shapes, and the reason the studio
// wants it: an uncensored catalog that no other host here serves.
//
//   POST https://api.venice.ai/api/v1/image/generate    -> { images: [base64] }
//   POST https://api.venice.ai/api/v1/image/multi-edit  -> raw image bytes
//   POST https://api.venice.ai/api/v1/video/queue       -> { queue_id, download_url? }
//   POST https://api.venice.ai/api/v1/video/retrieve    -> JSON status, or raw mp4
//
// Three shapes rather than one because Venice splits a model in two: the
// generator (`qwen-image-3-pro`) has no image input at all, and its editor
// (`qwen-image-3-pro-edit`) is a *different model id on a different endpoint*.
// That split is why the catalog lists both separately — see the note there.
//
// api.venice.ai answers pre-flight with `access-control-allow-origin: *`, so
// the static build reaches it directly and needs no CORS proxy. Verified
// against a real OPTIONS pre-flight, not assumed from the docs.

const VENICE_BASE = 'https://api.venice.ai/api/v1';

// How long to wait on a queued video, and how often to ask.
//
// The ceiling is measured, not chosen. Venice returns `average_execution_time`
// (its P80, in ms) with every PROCESSING status, and a five second clip on a
// cheap model reported 831s — fourteen minutes. An earlier version of this loop
// polled 150 times at five seconds, which capped the wait at 12.5 minutes:
// under the provider's own average, so a perfectly healthy generation would be
// abandoned unfinished and still billed. Forty-five minutes covers the long
// models with room to spare, and the interval opens up once it is clear this is
// a minutes-long wait rather than a seconds-long one.
const VIDEO_DEADLINE_MS = 45 * 60 * 1000;
const VIDEO_POLL_FAST_MS = 5000;
const VIDEO_POLL_SLOW_MS = 15000;

// --- what each model accepts ------------------------------------------------
//
// Pinned from GET /api/v1/models (types image, inpaint and video) rather than
// looked up live: a request that is shaped wrong should fail here, before it is
// sent, not after a round trip. Re-check these against the models endpoint
// before adding a model — the constraint blocks are per-model and they differ
// even between siblings (Seedream V5 Pro has no 21:9; Qwen Image 3 Pro does).

const IMAGE_RATIOS = {
  'qwen-image-3-pro': ['1:1', '3:2', '16:9', '21:9', '9:16', '2:3', '3:4', '4:5'],
  'seedream-v5-pro': ['1:1', '3:2', '16:9', '9:16', '2:3', '3:4'],
  'qwen-edit-uncensored': ['1:1', '3:2', '16:9', '21:9', '9:16', '2:3', '3:4', '4:5'],
  'qwen-image-3-pro-edit': ['1:1', '3:2', '16:9', '21:9', '9:16', '2:3', '3:4', '4:5'],
  'seedream-v5-pro-edit': ['1:1', '3:2', '16:9', '9:16', '2:3', '3:4']
};

// Venice's resolution tiers are names, not pixel counts, and the set differs by
// model — Wan speaks '720p'/'1080p', MiniMax speaks '768P'/'2K'. The studio
// speaks in 'WxH'. This table is what lets one studio setting land on the right
// name for whichever model the shot picked.
const TIER_HEIGHTS = {
  '256p': 256, '360p': 360, '480p': 480, '540p': 540, '580p': 580,
  '720p': 720, '768P': 768, '1080p': 1080, true_1080p: 1080,
  '2K': 1440, '1440p': 1440, '2160p': 2160, '4k': 2160
};

const VIDEO_SHAPES = {
  // `ratios: []` is a fact, not a placeholder: Wan 2.7 publishes an empty
  // aspect_ratios list because it takes the shape from the input frame. Sending
  // one anyway is a field the model has no use for.
  'wan-2-7-image-to-video': { resolutions: ['720p', '1080p'], ratios: [] },
  'wan-2-7-enhanced-image-to-video': { resolutions: ['720p', '1080p'], ratios: [] },
  'minimax-h3-enhanced-reference-to-video': {
    resolutions: ['768P', '2K'],
    ratios: ['16:9', '21:9', '4:3', '1:1', '3:4', '9:16']
  },
  // Wan 3.0 publishes 'adaptive' alongside its real ratios, meaning "take the
  // shape from the frame". It is held in its own field rather than listed among
  // `ratios` because it is not a ratio the nearest-match arithmetic could ever
  // compare against — it is the answer to a different question. See
  // buildVeniceVideoBody for when it is used instead of a ratio.
  'wan-3-0-image-to-video': {
    resolutions: ['480p', '720p', '1080p'],
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    adaptive: true
  },
  'longcat-distilled-image-to-video': { resolutions: ['720p'], ratios: [] },
  'minimax-h3-image-to-video': {
    resolutions: ['768P', '2K'],
    ratios: ['16:9', '21:9', '4:3', '1:1', '3:4', '9:16']
  }
};

// --- request shaping (pure) -------------------------------------------------

/**
 * True when this id is one of Venice's *editors* rather than its generators.
 *
 * The distinction decides the endpoint, so it is drawn from the id rather than
 * from a list: every Venice inpaint model spells it in the name, either as a
 * `-edit` suffix (`qwen-image-3-pro-edit`) or as an infix
 * (`qwen-edit-uncensored`, `firered-image-edit`). A hand-typed path that gets
 * this wrong is refused by Venice with a model-not-found, which costs nothing.
 */
export function isVeniceEditModel(modelPath) {
  return /(^|-)edit(-|$)/.test(String(modelPath || ''));
}

/** True when this video id takes a flat array of subject references. */
export function isVeniceReferenceVideo(modelPath) {
  return /reference-to-video/.test(String(modelPath || ''));
}

/** True when this video id animates a single still as its first frame. */
export function isVeniceImageVideo(modelPath) {
  return /image-to-video/.test(String(modelPath || ''));
}

/**
 * The studio's shape setting as an aspect ratio this model actually lists, or
 * null. Pixel forms reduce to the ratio they are nearest; a shape the model
 * does not list sends no constraint rather than one it will reject.
 */
export function veniceAspectRatio(modelPath, resolution, ratios) {
  const supported = ratios || IMAGE_RATIOS[modelPath] || [];
  if (!supported.length) return null;
  const value = String(resolution || '').trim();
  if (supported.includes(value)) return value;

  const pixels = value.match(/^(\d+)\s*[x*]\s*(\d+)$/i);
  if (!pixels) return null;
  const [width, height] = [Number(pixels[1]), Number(pixels[2])];
  // Only real W:H tokens can be compared. Venice mixes words into these lists
  // ('adaptive', 'auto'), and Number('adaptive') is NaN, which poisons the sort
  // and can hand back a word where a ratio was wanted.
  const nearest = supported
    .filter(ratio => /^\d+:\d+$/.test(ratio))
    .map(ratio => {
      const [rw, rh] = ratio.split(':').map(Number);
      return { ratio, distance: Math.abs((rw / rh) - (width / height)) };
    })
    .sort((a, b) => a.distance - b.distance)[0];
  return nearest && nearest.distance < 0.06 ? nearest.ratio : null;
}

/**
 * The tier name closest to the height the studio asked for, or null when the
 * model publishes no tiers.
 *
 * Nearest rather than exact because the two vocabularies do not line up: a
 * 1280x720 shot has no '720p' on MiniMax, and the honest answer there is
 * '768P' — the tier that is 48 pixels away — not silence, which would take
 * whatever the model defaulted to.
 */
export function veniceResolutionTier(modelPath, resolution, tiers) {
  const supported = tiers || VIDEO_SHAPES[modelPath]?.resolutions || [];
  if (!supported.length) return null;
  const value = String(resolution || '').trim();
  if (supported.includes(value)) return value;

  const pixels = value.match(/^(\d+)\s*[x*]\s*(\d+)$/i);
  // Without a size to match, the model's own first tier is the cheapest
  // truthful answer — never the largest, which quietly bills more.
  if (!pixels) return supported[0];
  const wanted = Math.min(Number(pixels[1]), Number(pixels[2]));
  return supported
    .map(tier => ({ tier, distance: Math.abs((TIER_HEIGHTS[tier] ?? 720) - wanted) }))
    .sort((a, b) => a.distance - b.distance)[0].tier;
}

/** Venice states durations as '5s'; the studio stores plain seconds. */
export function veniceDuration(duration) {
  const seconds = Number(duration);
  return Number.isFinite(seconds) && seconds > 0 ? `${Math.round(seconds)}s` : '5s';
}

/**
 * A text-to-image body for /image/generate.
 *
 * `format: 'png'` is not cosmetic: Venice defaults to WebP, and the studio
 * writes whatever comes back under the extension the caller named. PNG is the
 * one that matches.
 */
export function buildVeniceImageBody(modelPath, { prompt, resolution, safetyChecker }) {
  const body = { model: modelPath, prompt, format: 'png', hide_watermark: true };
  const aspectRatio = veniceAspectRatio(modelPath, resolution);
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  // safe_mode defaults to true at Venice and *blurs* what it catches rather
  // than refusing it — a blurred frame is billed, saved, and looks like the
  // model simply failed. The studio's own safety toggle is what turns it off.
  body.safe_mode = safetyChecker !== false;
  return body;
}

/**
 * A body for /image/multi-edit, which takes `images` (base64 or URL) with the
 * first entry as the base and the rest as layers.
 *
 * The reference list is never trimmed to one here. How many this model accepts
 * is the catalog's ruling and the list has already been cut to it; silently
 * dropping the rest at this layer would bill an edit that ignored them.
 */
export function buildVeniceEditBody(modelPath, { prompt, resolution, imageDataUrls = [], safetyChecker }) {
  const images = (imageDataUrls || []).filter(Boolean);
  const body = { modelId: modelPath, prompt, images, output_format: 'png', safe_mode: safetyChecker !== false };
  const aspectRatio = veniceAspectRatio(modelPath, resolution);
  // 'auto' rather than nothing when the shape does not resolve: these models
  // set `singleImageAspectRatio`, so 'auto' means "keep the input's shape",
  // which is what an edit almost always wants.
  body.aspect_ratio = aspectRatio || 'auto';
  return body;
}

/**
 * A body for /video/queue.
 *
 * Which field the images travel in is a property of the endpoint, not the
 * vendor: `reference-to-video` takes a flat `reference_image_urls` array whose
 * members the prompt addresses as @Image1..@ImageN, while `image-to-video`
 * takes one still in `image_url` and treats it as the first frame. Reference
 * models are never reduced to a single frame — that body would be accepted and
 * would produce a video missing every reference the prompt points at.
 */
export function buildVeniceVideoBody(modelPath, { prompt, resolution, duration, imageDataUrls = [] }) {
  const images = (imageDataUrls || []).filter(Boolean);
  const body = { model: modelPath, prompt, duration: veniceDuration(duration) };

  const tier = veniceResolutionTier(modelPath, resolution);
  if (tier) body.resolution = tier;
  const shape = VIDEO_SHAPES[modelPath];
  // A first frame *is* the shape. Asserting a ratio next to one is redundant at
  // best and a contradiction at worst: the studio's "16:9" is 1.7778 and the
  // frame it is describing was 1376x768, which is 1.7917. Telling an
  // image-to-video model both things leaves it to reconcile a conflict nobody
  // needed to create. Wan 3.0 publishes `adaptive` for precisely this case;
  // models without it are sent no ratio at all, which is the same answer said
  // more quietly.
  //
  // Reference-to-video is the opposite: its images are subjects, not a canvas,
  // so the output shape has to be stated or the model picks one.
  const framesTheCanvas = images.length > 0 && !isVeniceReferenceVideo(modelPath);
  const aspectRatio = framesTheCanvas
    ? (shape?.adaptive ? 'adaptive' : null)
    : veniceAspectRatio(modelPath, resolution, shape?.ratios || []);
  if (aspectRatio) body.aspect_ratio = aspectRatio;

  if (!images.length) return body;
  if (isVeniceReferenceVideo(modelPath)) body.reference_image_urls = images;
  else body.image_url = images[0];
  return body;
}

/** Venice explains itself in the body; the status code alone never does. */
export function describeVeniceError(body) {
  if (!body) return 'no response body';
  try {
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.map(issue => issue.message).filter(Boolean).join('; ')
      : '';
    return [parsed.error, issues].filter(Boolean).join(' — ') || String(body).slice(0, 400);
  } catch {
    return String(body).slice(0, 400);
  }
}

// --- transport --------------------------------------------------------------

/** Bearer auth, or a refusal that says where the key goes. */
function veniceHeaders(ctx, json = true) {
  const apiKey = ctx.credentials.veniceKey;
  if (!apiKey) throw new Error('Venice.ai API key is not configured. Add it in Settings first.');
  const headers = { Authorization: `Bearer ${apiKey}` };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

/**
 * A binary response body as a data: URL, so it can go to `ctx.saveRemote`
 * exactly like a hosted result would.
 *
 * Two of Venice's three endpoints answer with raw bytes rather than a link, and
 * the host contract only knows how to fetch URLs — this is the bridge. Chunked
 * because `String.fromCharCode(...bytes)` blows the argument limit on anything
 * video-sized.
 */
async function responseToDataUrl(response, fallbackType) {
  const contentType = (response.headers?.get?.('content-type') || fallbackType).split(';')[0].trim();
  const bytes = new Uint8Array(await response.arrayBuffer());
  return `data:${contentType || fallbackType};base64,${bytesToBase64(bytes)}`;
}

/** base64 in whichever runtime this is — Node's Buffer or the browser's btoa. */
export function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

// --- generation -------------------------------------------------------------

export async function generateImage({ modelPath, prompt, resolution, inputImagePaths, safetyChecker }, ctx) {
  const headers = veniceHeaders(ctx);
  const images = await Promise.all((inputImagePaths || []).filter(Boolean).map(ctx.readAssetDataUrl));

  // A generator handed references would silently drop them: /image/generate has
  // no field to put them in, and Venice would bill a picture that never saw
  // them. Say so instead, and name the editor that would have worked.
  if (images.length && !isVeniceEditModel(modelPath)) {
    throw new Error(
      `${modelPath} is a Venice text-to-image model and takes no reference images. Venice serves ` +
      `the editing half as a separate model — try "${modelPath}-edit" for this shot, or remove ` +
      `the references.`
    );
  }

  if (isVeniceEditModel(modelPath)) {
    if (!images.length) {
      throw new Error(`${modelPath} is a Venice image editor and needs at least one input image.`);
    }
    const body = buildVeniceEditBody(modelPath, { prompt, resolution, imageDataUrls: images, safetyChecker });
    const res = await ctx.fetch(`${VENICE_BASE}/image/multi-edit`, {
      method: 'POST', headers, body: JSON.stringify(body)
    }, 'Venice.ai');
    if (!res.ok) throw new Error(`Venice.ai edit failed (${res.status}): ${describeVeniceError(await res.text())}`);
    return ctx.saveRemote(await responseToDataUrl(res, 'image/png'), 'img', '.png');
  }

  const body = buildVeniceImageBody(modelPath, { prompt, resolution, safetyChecker });
  const res = await ctx.fetch(`${VENICE_BASE}/image/generate`, {
    method: 'POST', headers, body: JSON.stringify(body)
  }, 'Venice.ai');
  if (!res.ok) throw new Error(`Venice.ai generation failed (${res.status}): ${describeVeniceError(await res.text())}`);

  const payload = await res.json();
  const base64 = Array.isArray(payload.images) ? payload.images[0] : null;
  if (!base64) throw new Error('Venice.ai returned no image.');
  // Already base64 in the JSON, so there is nothing to decode — only a prefix
  // to add, which is what saveRemote reads.
  return ctx.saveRemote(`data:image/png;base64,${base64}`, 'img', '.png');
}

/**
 * Run the settings past Venice's pricing endpoint before queueing anything.
 *
 * `/video/queue` validates `duration` against an enum that spans every model on
 * the host — 1s through 30s — rather than against the model being asked for. So
 * a shot carrying 4s from a previous model is accepted, queued, billed, and
 * then dies in inference as a bare "An unknown error occurred". That is exactly
 * how this was found, and it cost real money three times over.
 *
 * `/video/quote` checks the same fields against *this* model and is free:
 *
 *   {"duration":{"_errors":["Invalid enum value. Expected '5s' | '10s' | '15s',
 *    received '4s'"]}}
 *
 * Only a 400 stops the run. A quote that fails for any other reason — Venice
 * unwell, a model whose pricing is not published — must not block a generation
 * that would have worked.
 */
async function quoteBeforeQueueing(body, headers, ctx) {
  const { model, duration, resolution, aspect_ratio: aspectRatio } = body;
  const quote = await ctx.fetch(`${VENICE_BASE}/video/quote`, {
    method: 'POST', headers,
    body: JSON.stringify({ model, duration, ...(resolution ? { resolution } : {}), ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}) })
  }, 'Venice.ai');
  if (quote.status !== 400) return;
  throw new Error(
    `Venice.ai will not accept these settings for ${model}: ${describeVeniceError(await quote.text())}. ` +
    `Nothing was queued or billed. Check the shot's length and resolution against what this model offers.`
  );
}

/**
 * Frames for a video request, as links where that is possible and inline where
 * it is not.
 *
 * Venice documents both forms for `image_url`, and the inline one is a trap at
 * this size. A 5MB still is ~6.5MB of base64, every byte of which has to travel
 * to Venice and then again to whichever backend actually runs the model — and a
 * backend that cannot read a `data:` URL fails at ingestion, minutes before any
 * inference, as a bare "An unknown error occurred". The images endpoints are
 * left inline deliberately: those run on Venice's own inference and are known
 * to take data URLs.
 *
 * The fork is on the Fal key rather than hidden, because uploading needs one.
 * Without it the inline form is still tried — a large frame that might work is
 * better than a refusal — and the failure path says which form was used.
 */
async function videoFrameUrls(inputImagePaths, ctx) {
  const paths = (inputImagePaths || []).filter(Boolean);
  if (!paths.length) return { urls: [], hosted: false };
  if (!ctx.credentials.falKey) {
    return { urls: await Promise.all(paths.map(ctx.readAssetDataUrl)), hosted: false };
  }
  return { urls: await Promise.all(paths.map(ctx.uploadPublicUrl)), hosted: true };
}

export async function generateVideo({ modelPath, prompt, resolution, duration, inputImagePaths = [] }, ctx) {
  const headers = veniceHeaders(ctx);
  const { urls: images, hosted } = await videoFrameUrls(inputImagePaths, ctx);

  if (isVeniceImageVideo(modelPath) && !images.length) {
    throw new Error(`${modelPath} animates a still and needs one input image.`);
  }

  const body = buildVeniceVideoBody(modelPath, { prompt, resolution, duration, imageDataUrls: images });
  await quoteBeforeQueueing(body, headers, ctx);

  const submit = await ctx.fetch(`${VENICE_BASE}/video/queue`, {
    method: 'POST', headers, body: JSON.stringify(body)
  }, 'Venice.ai');
  const submitBody = await submit.text();
  if (!submit.ok) throw new Error(`Venice.ai video submission failed (${submit.status}): ${describeVeniceError(submitBody)}`);

  const queued = JSON.parse(submitBody);
  if (!queued.queue_id) throw new Error('Venice.ai returned no queue id.');

  // Which fields the request went out with, and in which form the frames
  // travelled. A failure that arrives minutes later is only debuggable if it
  // can say what was actually asked for — and "the frame went inline" is the
  // single most useful thing to know about a Venice video that dies early.
  // Values, not just field names. "submitted with duration, resolution" cost
  // several rounds of guessing at what those actually were; the settings are
  // short enough to print and they are the first thing anyone needs.
  // A URL is printed whole or not at all. Truncating one produces a link that
  // looks complete, is not, and answers "Specified object does not exist" when
  // anybody pastes it — which cost a round of chasing a hosting bug that did
  // not exist. Only inlined data is abbreviated, and it is labelled as such.
  const describeValue = (value) => {
    if (Array.isArray(value)) return `${value.length} image(s)`;
    const text = String(value);
    if (text.startsWith('data:')) return `<inline ${text.slice(5, text.indexOf(';')) || 'data'}, ${text.length} chars>`;
    return text;
  };
  const sentFields = Object.entries(body)
    .filter(([key]) => key !== 'model' && key !== 'prompt')
    .map(([key, value]) => `${key}=${describeValue(value)}`)
    .join(', ');
  const frameForm = images.length ? `; frames sent as ${hosted ? 'hosted URLs' : 'inline data URLs'}` : '';
  const context = `[queue ${queued.queue_id}; submitted with ${sentFields || 'no extra fields'}${frameForm}]`;
  let serverErrors = 0;
  let attempt = 0;
  const deadline = Date.now() + VIDEO_DEADLINE_MS;

  while (Date.now() < deadline) {
    // Sleep *between* polls, not before the first one. Venice registers the
    // queue id at submission, so the opening check costs nothing and a job that
    // has already failed says so at once instead of five seconds from now.
    //
    // Five seconds is what Venice asks for and it is right only at the start.
    // These jobs run for minutes — every PROCESSING reply carries an
    // `average_execution_time` that was 831s for a five second clip — so after
    // the first minute the fast interval is just noise, and the poll slows to
    // match what is actually being waited for.
    //
    // `ctx.pollIntervalMs` is an optional host override. No host sets it; the
    // tests use it to exercise this ladder without waiting out a real one.
    if (attempt > 0) {
      const wait = ctx.pollIntervalMs ?? (attempt < 12 ? VIDEO_POLL_FAST_MS : VIDEO_POLL_SLOW_MS);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
    attempt++;
    const poll = await ctx.fetch(`${VENICE_BASE}/video/retrieve`, {
      method: 'POST', headers, body: JSON.stringify({ model: modelPath, queue_id: queued.queue_id })
    }, 'Venice.ai');
    // 503 is the model being busy, not the job being dead — Venice says to try
    // again, and abandoning a queued job here would bill for a video that was
    // still coming.
    if (poll.status === 503) continue;
    // 500 is documented as "inference processing failed", but it is also what a
    // queue id that has not finished registering answers, so a single one
    // cannot be told apart from a dead job. A job that really has died keeps
    // saying so; one that was merely early moves on to PROCESSING. Give it a
    // few polls before writing off a generation that is already paid for.
    if (poll.status === 500 && ++serverErrors < 4) continue;
    if (!poll.ok) {
      const detail = describeVeniceError(await poll.text());
      // A 500 on retrieve is Venice's "inference processing failed": the job
      // died, the status check was fine. Calling that a failed status check
      // sends you looking in the wrong place entirely.
      const what = poll.status === 500
        ? 'Venice.ai could not generate this video'
        : `Venice.ai status check failed (${poll.status})`;
      const hint = poll.status === 500 && images.length && !hosted
        ? ' The frame went inline as a data URL; add a Fal.ai key in Settings and the studio will host it ' +
          'as a link instead, which is the form every video backend can read.'
        : '';
      throw new Error(`${what}: ${detail}${hint} ${context}`);
    }

    // The content type is the status. A finished clip comes back as the mp4
    // itself; anything still running comes back as JSON.
    const contentType = poll.headers?.get?.('content-type') || '';
    if (!/json/i.test(contentType)) {
      return ctx.saveRemote(await responseToDataUrl(poll, 'video/mp4'), 'vid', '.mp4');
    }

    const status = await poll.json();
    if (status.status === 'COMPLETED') {
      // Some models hand back a pre-signed link at queue time and stream
      // nothing; others stream the mp4 and issue no link. Which of the two a
      // model does is not something the model list tells you — a `private`
      // model was observed queueing with no download_url at all — so a
      // COMPLETED without a link is not an error yet. Ask once more and take
      // the stream, and only give up if the link never appears either.
      if (queued.download_url) return ctx.saveRemote(queued.download_url, 'vid', '.mp4');
      if (++completions < 3) continue;
      throw new Error(
        `Venice.ai reported this video complete three times without ever returning it — no ` +
        `download link at submission and no video on retrieve. ${context}`
      );
    }
    if (status.status && status.status !== 'PROCESSING') {
      throw new Error(`Venice.ai video generation ${status.status}. ${context}`);
    }
  }
  throw new Error(
    `Venice.ai video generation timed out after ${Math.round(VIDEO_DEADLINE_MS / 60000)} minutes. ` +
    `The job may still finish — it is queued at Venice under this id. ${context}`
  );
}
