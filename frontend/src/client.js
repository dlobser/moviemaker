// One call surface for both builds.
//
// Server mode  - talks to the Node backend on localhost:3001 (ffmpeg, native
//                dialogs, keys in config.json).
// Static mode  - no backend at all: the File System Access API holds the
//                project folder, localStorage holds the keys, and generation
//                requests go straight from the page to each provider.
//
// Which one is live is decided once at startup by pinging the backend, so a
// single build works both hosted on a static site and next to a local server.

import { loadCredentials, saveCredentials } from './static/keyStore.js';
import {
  readProjectState, writeProjectState, listAssetImages, listAssetMedia,
  importFile, getAssetObjectUrl, getActiveName, getActiveHandle, organizeAssets,
  isFileSystemAccessSupported,
  listCheckpoints, writeCheckpoint, readCheckpoint, deleteCheckpoint
} from './static/fileSystem.js';
import { generateText, listModels, generateImage, generateVideo, runLipSync } from './static/providers.js';

// Overridable so a second instance can be run against a scratch project
// without going near the one you have open.
export const SERVER_BASE = import.meta.env?.VITE_SERVER_BASE || 'http://localhost:3001';

// Force static with `?static=1` (or VITE_STATIC=1 at build time) — handy for
// testing the hosted behaviour while a local backend happens to be running.
const FORCED_STATIC = import.meta.env?.VITE_STATIC === '1'
  || (typeof location !== 'undefined' && new URLSearchParams(location.search).get('static') === '1');

let mode = null; // 'server' | 'static'

/** Resolve which mode we are in. Safe to await repeatedly. */
export async function detectMode() {
  if (mode) return mode;
  if (FORCED_STATIC) {
    mode = 'static';
    return mode;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${SERVER_BASE}/api/config`, { signal: controller.signal });
    clearTimeout(timer);
    mode = res.ok ? 'server' : 'static';
  } catch {
    mode = 'static';
  }
  return mode;
}

export function currentMode() {
  return mode;
}

export function isStatic() {
  return mode === 'static';
}

export function staticCapabilities() {
  return {
    fileSystem: isFileSystemAccessSupported(),
    // Both need a real machine: ffmpeg and the OS shell.
    concatenate: false,
    reveal: false
  };
}

/** Shape a plain value like a fetch Response so call sites stay unchanged. */
function asResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function errorResponse(message, status = 500, reason = undefined) {
  return asResponse({ error: message, reason }, false, status);
}

const DEFAULT_STATE = {
  scenes: [], shots: [], imageGallery: [], videoGallery: [],
  referenceImages: [], assetLibrary: [], promptSnippets: null
};

/**
 * Drop-in for `fetch(`${API_BASE}${path}`, options)`.
 * In server mode it forwards; in static mode it runs the work in the page.
 */
export async function apiFetch(path, options = {}) {
  await detectMode();

  if (mode === 'server') {
    try {
      return await fetch(`${SERVER_BASE}${path}`, options);
    } catch (error) {
      return errorResponse(
        `Cannot connect to MovieMaker backend server (${SERVER_BASE}). ` +
        `Please ensure the backend server is running ("npm start" or "node server.js").`,
        503,
        'offline'
      );
    }
  }

  const credentials = loadCredentials();
  const body = options.body && typeof options.body === 'string' ? JSON.parse(options.body) : null;
  const route = path.split('?')[0];

  try {
    // --- credentials ---
    if (route === '/api/config') {
      if (options.method === 'POST') return asResponse(saveCredentials(body));
      return asResponse(credentials);
    }

    // --- project state ---
    if (route === '/api/state') {
      // Before a folder is picked there is simply nothing stored yet — that is
      // the normal first-run state, not a failure.
      if (!getActiveHandle()) return asResponse(DEFAULT_STATE);
      if (options.method === 'POST') {
        await writeProjectState(body);
        return asResponse({ message: 'saved' });
      }
      const state = await readProjectState();
      return asResponse(state || DEFAULT_STATE);
    }

    // --- checkpoints ---
    if (route === '/api/checkpoints') {
      if (!getActiveHandle()) return asResponse({ checkpoints: [] });
      if (options.method === 'POST') {
        return asResponse({ checkpoint: await writeCheckpoint(body) });
      }
      return asResponse({ checkpoints: await listCheckpoints() });
    }
    if (route.startsWith('/api/checkpoints/')) {
      const id = route.slice('/api/checkpoints/'.length);
      if (options.method === 'DELETE') {
        await deleteCheckpoint(id);
        return asResponse({ ok: true });
      }
      return asResponse({ checkpoint: await readCheckpoint(id) });
    }

    // --- assets ---
    if (route === '/api/project-images') {
      return asResponse(await listAssetImages());
    }

    if (route === '/api/project-media') {
      return asResponse(await listAssetMedia());
    }

    // Clean Files. Same request and reply shape as the server's, so App.jsx
    // never has to know which build it is running in.
    if (route === '/api/assets/organize') {
      if (!getActiveHandle()) return errorResponse('Pick a project folder first.', 400);
      return asResponse(await organizeAssets(body || {}));
    }

    // The hosted build measures sources with a media element instead — see
    // edit/durations.js. An empty result keeps a stray caller from treating
    // this as a failure.
    if (route === '/api/probe') {
      return asResponse({ results: {} });
    }

    if (route === '/api/upload') {
      const file = options.body?.get?.('file');
      if (!file) return errorResponse('No file provided', 400);
      const prefix = file.type?.startsWith('audio') ? 'audio'
        : file.type?.startsWith('video') ? 'video'
        : 'ref';
      let destination = null;
      try {
        const field = options.body?.get?.('destination');
        destination = field ? JSON.parse(field) : null;
      } catch { /* an unreadable descriptor is the same as none */ }
      const filePath = await importFile(file, prefix, destination);
      return asResponse({ filePath, originalName: file.name, mimeType: file.type });
    }

    // --- generation ---
    if (route === '/api/llm/generate') {
      return asResponse({ text: await generateText(body, credentials) });
    }
    if (route === '/api/llm/models') {
      const provider = new URLSearchParams(path.split('?')[1] || '').get('provider');
      return asResponse(await listModels(provider, credentials));
    }
    if (route === '/api/image/generate') {
      return asResponse({ filePath: await generateImage(body, credentials) });
    }
    if (route === '/api/video/generate') {
      return asResponse({ filePath: await generateVideo(body, credentials) });
    }
    if (route === '/api/lipsync') {
      return asResponse({ filePath: await runLipSync(body, credentials) });
    }

    // --- things a page genuinely cannot do ---
    if (route === '/api/concatenate') {
      return errorResponse(
        'Video stitching needs FFmpeg, which is not available in the hosted build. ' +
        'Download the shot videos from your project folder and join them in an editor, or run the local server build.',
        501
      );
    }
    if (route === '/api/render' || route.startsWith('/api/render/')) {
      return errorResponse(
        'Rendering needs FFmpeg, which is not available in the hosted build. ' +
        'Run the local server build to export your edit.',
        501
      );
    }
    if (route === '/api/reveal') {
      return errorResponse('Opening a file manager is not possible from a web page. Your files are in the project folder you picked.', 501);
    }

    return errorResponse(`Unsupported in the hosted build: ${route}`, 501);
  } catch (error) {
    console.error(`[static] ${route} failed:`, error);
    return errorResponse(error.message || String(error));
  }
}

// --- asset URLs -----------------------------------------------------------

/**
 * A displayable URL for a project-relative asset path.
 * Server mode serves it over HTTP; static mode mints a blob: URL from disk.
 */
export async function resolveAssetUrl(assetPath) {
  if (!assetPath) return null;
  await detectMode();
  if (mode === 'server') return `${SERVER_BASE}/${assetPath}`;
  try {
    return await getAssetObjectUrl(assetPath);
  } catch {
    return null; // file missing or folder disconnected
  }
}

export function activeProjectName() {
  return getActiveName();
}
