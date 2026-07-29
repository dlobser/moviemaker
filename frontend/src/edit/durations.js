// Source measurement, and the cache that makes it a one-time cost.
//
// Generated assets are timestamp-named and written once — `vid_1784055363288.mp4`
// always means the same bytes — so a probe result never needs invalidating. The
// cache lives in the edit document and rides along with the project file.
//
// Server mode asks ffprobe, which also gets us frame rate and whether there is
// an audio stream at all. The hosted build has neither ffprobe nor a shell, so
// it measures what a media element can tell it and leaves the rest unknown;
// callers must cope with missing fields either way.

import { apiFetch, resolveAssetUrl, isStatic } from '../client.js';

const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

/** Requests already in flight, so a re-render cannot double-probe a path. */
const pending = new Map();

export function isImagePath(assetPath) {
  return IMAGE_EXTENSIONS.test(String(assetPath || ''));
}

/**
 * Measure every path we do not already know about.
 * Returns only the new entries; merge them into `edit.durations` yourself so
 * the caller stays in control of when state changes.
 */
export async function probeMissing(paths, known = {}) {
  const wanted = [...new Set(paths || [])].filter(path => path && !known[path]);
  if (wanted.length === 0) return {};

  const fresh = {};
  const inFlight = [];

  for (const path of wanted) {
    if (pending.has(path)) {
      inFlight.push(pending.get(path).then(result => {
        if (result) fresh[path] = result;
      }));
      continue;
    }
    const job = probeOne(path)
      .catch(error => {
        console.warn(`[edit] could not measure ${path}:`, error?.message || error);
        return null;
      })
      .finally(() => pending.delete(path));
    pending.set(path, job);
    inFlight.push(job.then(result => {
      if (result) fresh[path] = result;
    }));
  }

  await Promise.all(inFlight);
  return fresh;
}

async function probeOne(assetPath) {
  if (isImagePath(assetPath)) {
    const measured = await measureImageInPage(assetPath);
    return { isImage: true, duration: null, hasAudio: false, ...measured };
  }
  if (isStatic()) return measureVideoInPage(assetPath);
  return probeOnServer(assetPath);
}

async function probeOnServer(assetPath) {
  const res = await apiFetch('/api/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: [assetPath] })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'probe failed');
  const result = data.results?.[assetPath];
  if (!result || result.error) throw new Error(result?.error || 'no probe result');
  return result;
}

/**
 * What a <video> element will tell us: duration and natural dimensions. Frame
 * rate and stream layout are not exposed, so they stay undefined and the render
 * path falls back to the project settings.
 */
function measureVideoInPage(assetPath) {
  return withElementUrl(assetPath, (url) => new Promise((resolve, reject) => {
    const element = document.createElement('video');
    element.preload = 'metadata';
    element.muted = true;
    const done = (fn) => {
      element.onloadedmetadata = null;
      element.onerror = null;
      element.removeAttribute('src');
      fn();
    };
    element.onloadedmetadata = () => {
      const result = {
        duration: Number.isFinite(element.duration) ? element.duration : null,
        width: element.videoWidth || null,
        height: element.videoHeight || null,
        fps: null,
        // Unknowable from a media element. Assume there is audio and let the
        // render path substitute silence if ffmpeg disagrees.
        hasAudio: true,
        isImage: false
      };
      done(() => resolve(result));
    };
    element.onerror = () => done(() => reject(new Error('media could not be loaded')));
    element.src = url;
  }));
}

function measureImageInPage(assetPath) {
  return withElementUrl(assetPath, (url) => new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve({ width: element.naturalWidth, height: element.naturalHeight });
    element.onerror = () => reject(new Error('image could not be loaded'));
    element.src = url;
  })).catch(() => ({ width: null, height: null }));
}

/** Resolve a project path to something an element can load, then clean up. */
async function withElementUrl(assetPath, fn) {
  const url = await resolveAssetUrl(assetPath);
  if (!url) throw new Error('asset not found');
  try {
    return await fn(url);
  } finally {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
}
