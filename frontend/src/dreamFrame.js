// Pull the last frame out of a generated clip and park it in the project.
//
// Dream mode needs this between every clip: the frame a video ends on becomes
// the still the next clip is animated from, which is the only reason the run
// reads as one unbroken shot rather than a stack of cuts.
//
// The studio already captures frames off a <video> the user is watching
// (handleCaptureVideoFrame in App.jsx). This is the headless twin — same canvas
// trick, no element on screen — because a dream runs unattended.

import { apiFetch, resolveAssetUrl } from './client.js';

// Seeking a freshly attached video can genuinely take a while on a long clip;
// hanging forever would silently stall the whole dream.
const SEEK_TIMEOUT_MS = 30000;

/**
 * Decode `videoPath`'s final frame and draw it to a PNG blob.
 *
 * `epsilon` backs off from the very end because a seek to exactly `duration`
 * lands past the last decodable frame in most browsers and never fires `seeked`.
 */
function grabFinalFrameBlob(url, epsilon) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous'; // keeps the canvas untainted in server mode
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    // Off-screen rather than out of the document: some browsers will not decode
    // for an element that was never attached.
    video.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    document.body.appendChild(video);

    let settled = false;
    const timer = setTimeout(
      () => fail(new Error('Timed out waiting for the clip to seek to its last frame.')),
      SEEK_TIMEOUT_MS
    );

    function cleanup() {
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      video.remove();
    }
    function fail(error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
    function done(blob) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(blob);
    }

    video.addEventListener('error', () => fail(new Error('The browser could not decode that clip.')));

    video.addEventListener('loadedmetadata', () => {
      const { duration } = video;
      // A stream with no reported duration still clamps an absurd seek to its
      // real end, which is exactly where we want to land.
      video.currentTime = Number.isFinite(duration) && duration > 0
        ? Math.max(0, duration - epsilon)
        : 1e7;
    });

    video.addEventListener('seeked', () => {
      try {
        if (!video.videoWidth) throw new Error('The clip reported no picture size.');
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          blob => (blob ? done(blob) : fail(new Error('Frame capture produced no data.'))),
          'image/png'
        );
      } catch (error) {
        fail(/tainted|SecurityError/i.test(error.message || error.name)
          ? new Error('The browser blocked reading this clip (CORS). Reload the page and try again.')
          : error);
      }
    });

    video.src = url;
    video.load();
  });
}

/**
 * Capture `videoPath`'s last frame into the project's assets folder.
 * Returns the new project-relative image path.
 */
export async function captureLastFrame(videoPath, { epsilon = 0.06 } = {}) {
  const url = await resolveAssetUrl(videoPath);
  if (!url) throw new Error(`Could not open ${videoPath} — the file may be missing from the project folder.`);

  const blob = await grabFinalFrameBlob(url, epsilon);

  const formData = new FormData();
  formData.append('file', blob, `dream_frame_${Date.now()}.png`);
  const res = await apiFetch('/api/upload', { method: 'POST', body: formData });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not save the captured frame into the project.');
  return data.filePath;
}
