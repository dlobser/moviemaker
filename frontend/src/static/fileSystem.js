// Project storage for the static (no-backend) build.
//
// A project is still a folder — the same shape as the desktop build — except
// the browser holds a FileSystemDirectoryHandle instead of a path string:
//
//   <picked folder>/project.mmproj.json
//   <picked folder>/assets/*
//
// Handles are structured-cloneable, so they persist in IndexedDB across
// reloads. The browser still requires a user gesture to re-grant permission
// after a restart, which is what reconnectProject() is for.
//
// Requires the File System Access API: Chrome, Edge and other Chromium
// browsers, over HTTPS (or localhost). Firefox and Safari do not implement it.

const DB_NAME = 'moviemaker';
const DB_STORE = 'handles';
const ACTIVE_KEY = 'activeProject';
const RECENT_KEY = 'recentProjects';
export const PROJECT_FILENAME = 'project.mmproj.json';

export function isFileSystemAccessSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

// --- tiny IndexedDB key/value store (handles cannot go in localStorage) ---

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DB_STORE)) {
        request.result.createObjectStore(DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- permissions ---

async function hasPermission(handle, mode = 'readwrite') {
  if (!handle) return false;
  // Handles without the permission API (OPFS, and whatever ships next) are
  // already accessible — treat them as granted rather than permanently denied.
  if (typeof handle.queryPermission !== 'function') return true;
  return (await handle.queryPermission({ mode })) === 'granted';
}

async function ensurePermission(handle, mode = 'readwrite') {
  if (await hasPermission(handle, mode)) return true;
  if (typeof handle.requestPermission !== 'function') return true;
  // Only succeeds inside a user gesture.
  return (await handle.requestPermission({ mode })) === 'granted';
}

// --- active project ---

let activeHandle = null;

export function getActiveHandle() {
  return activeHandle;
}

export function getActiveName() {
  return activeHandle?.name || null;
}

/**
 * Reload the previously used project without prompting.
 * Returns { name, needsPermission } or null when there is nothing stored.
 */
export async function restoreActiveProject() {
  const stored = await idbGet(ACTIVE_KEY);
  if (!stored) return null;
  activeHandle = stored;
  return { name: stored.name, needsPermission: !(await hasPermission(stored)) };
}

/**
 * Forget the active folder — back to the folderless state the app now opens in.
 * Used when adopting a folder is picked but then abandoned, so autosave cannot
 * write into somewhere the user just backed out of. Recents are left alone.
 */
export async function clearActiveProject() {
  activeHandle = null;
  await idbDelete(ACTIVE_KEY);
}

/** Re-grant permission to the restored folder. Must run inside a click handler. */
export async function reconnectProject() {
  if (!activeHandle) return false;
  return ensurePermission(activeHandle);
}

async function rememberRecent(handle) {
  const recent = (await idbGet(RECENT_KEY)) || [];
  const deduped = [];
  for (const entry of recent) {
    // isSameEntry is async, so this loop cannot be a .filter().
    if (entry?.handle && !(await entry.handle.isSameEntry(handle).catch(() => false))) {
      deduped.push(entry);
    }
  }
  const next = [{ name: handle.name, handle, lastOpened: new Date().toISOString() }, ...deduped].slice(0, 12);
  await idbSet(RECENT_KEY, next);
  return next;
}

export async function listRecentProjects() {
  const recent = (await idbGet(RECENT_KEY)) || [];
  return recent.map(entry => ({ name: entry.name, lastOpened: entry.lastOpened, handle: entry.handle }));
}

/** Show the folder picker and adopt the chosen directory as the project. */
export async function pickProjectFolder(mode = 'open') {
  if (!isFileSystemAccessSupported()) {
    throw new Error('This browser cannot open local folders. Use Chrome or Edge.');
  }
  const handle = await window.showDirectoryPicker({ id: 'moviemaker-project', mode: 'readwrite' });
  if (!(await ensurePermission(handle))) {
    throw new Error('Permission to write to that folder was declined.');
  }
  activeHandle = handle;
  await idbSet(ACTIVE_KEY, handle);
  await rememberRecent(handle);

  const existing = await readProjectState();
  return { name: handle.name, isNew: existing === null, created: mode === 'new' };
}

/** Adopt a directory handle taken from the recents list. */
export async function openRecentProject(handle) {
  if (!(await ensurePermission(handle))) {
    throw new Error('Permission to that folder was declined.');
  }
  activeHandle = handle;
  await idbSet(ACTIVE_KEY, handle);
  await rememberRecent(handle);
  return { name: handle.name };
}

function requireProject() {
  if (!activeHandle) {
    throw new Error('No project folder selected. Open Projects and choose a folder.');
  }
  return activeHandle;
}

async function getAssetsDir(create = true) {
  return requireProject().getDirectoryHandle('assets', { create });
}

// --- project state ---

/** The saved state blob, or null when the folder holds no project yet. */
export async function readProjectState() {
  try {
    const handle = await requireProject().getFileHandle(PROJECT_FILENAME);
    const text = await (await handle.getFile()).text();
    const parsed = JSON.parse(text);
    return parsed.state && typeof parsed.state === 'object' ? parsed.state : parsed;
  } catch (error) {
    if (error.name === 'NotFoundError') return null;
    throw error;
  }
}

export async function writeProjectState(state) {
  const dir = requireProject();
  const payload = {
    format: 'moviemaker-project',
    formatVersion: 1,
    name: dir.name,
    savedAt: new Date().toISOString(),
    state: state || {}
  };
  const handle = await dir.getFileHandle(PROJECT_FILENAME, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(payload, null, 2));
  await writable.close();
  await getAssetsDir(true); // make sure media has somewhere to land
}

// --- checkpoints ---
//
// Named snapshots of the whole studio state, one file each in `checkpoints/`,
// mirroring what the server build writes so a project folder means the same
// thing whichever build wrote it. Media is shared, not copied: generated assets
// are written once under timestamped names and never change.

async function getCheckpointsDir(create = true) {
  return requireProject().getDirectoryHandle('checkpoints', { create });
}

function summariseState(state) {
  const scenes = Array.isArray(state?.scenes) ? state.scenes : [];
  const shots = scenes.reduce((total, scene) => total + (scene.shots || []).length, 0);
  return {
    scenes: scenes.length,
    shots,
    shotsWithVideo: scenes.reduce((total, scene) => (
      total + (scene.shots || []).filter(shot => shot.selectedVideo).length
    ), 0),
    editClips: Array.isArray(state?.edit?.video) ? state.edit.video.length : 0
  };
}

export async function listCheckpoints() {
  let dir;
  try {
    dir = await getCheckpointsDir(false);
  } catch (error) {
    if (error.name === 'NotFoundError') return [];
    throw error;
  }

  const records = [];
  for await (const [name, handle] of dir.entries()) {
    if (!name.endsWith('.json') || handle.kind !== 'file') continue;
    try {
      const parsed = JSON.parse(await (await handle.getFile()).text());
      if (!parsed?.id) continue;
      const { state: _omit, ...meta } = parsed;
      records.push(meta);
    } catch { /* a corrupt file should not hide the rest */ }
  }
  return records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function writeCheckpoint({ name, note, state }) {
  const dir = await getCheckpointsDir(true);
  const createdAt = new Date().toISOString();
  const id = `cp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const record = {
    id,
    name: String(name || '').trim() || `Checkpoint ${createdAt.slice(0, 16).replace('T', ' ')}`,
    note: String(note || '').trim(),
    createdAt,
    summary: summariseState(state),
    state
  };

  const handle = await dir.getFileHandle(`${id}.json`, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(record, null, 2));
  await writable.close();

  const { state: _omit, ...meta } = record;
  return meta;
}

export async function readCheckpoint(id) {
  const dir = await getCheckpointsDir(false);
  const handle = await dir.getFileHandle(`${id}.json`);
  return JSON.parse(await (await handle.getFile()).text());
}

export async function deleteCheckpoint(id) {
  const dir = await getCheckpointsDir(false);
  await dir.removeEntry(`${id}.json`);
}

// --- assets ---
//
// The media root is a tree now, not a folder — see shared/assetPaths.js for the
// shape and why. Everything below that used to call `getFileHandle(name)` on
// one directory handle has to walk instead, because 'assets/shots/01-open/…' is
// four handles deep.

import {
  planAssetLayout, destinationDir, destinationStem, nextFileName, BIN_DIR, MEDIA_ROOT
} from '../shared/assetPaths.js';

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const LEDGER_FILE = '.organize-ledger.json';

/** 'assets/a/b/c.png' -> ['a','b','c.png'], with the media root stripped. */
function assetSegments(assetPath) {
  return String(assetPath || '')
    .replace(/\\/g, '/')
    .replace(new RegExp('^' + MEDIA_ROOT + '/'), '')
    .split('/')
    .filter(segment => segment && segment !== '.');
}

/** The directory handle for a project-relative folder, walking every level. */
async function walkToDir(assetDirPath, create = false) {
  let dir = await getAssetsDir(create);
  for (const segment of assetSegments(assetDirPath)) {
    dir = await dir.getDirectoryHandle(segment, { create });
  }
  return dir;
}

/** The file handle for a project-relative path, or a throw if it is not there. */
async function walkToFile(assetPath, create = false) {
  const segments = assetSegments(assetPath);
  const name = segments.pop();
  let dir = await getAssetsDir(create);
  for (const segment of segments) {
    dir = await dir.getDirectoryHandle(segment, { create });
  }
  return dir.getFileHandle(name, { create });
}

/** Every file under the media root, as project-relative paths. */
export async function listMediaFiles() {
  const found = [];
  const walk = async (dir, prefix) => {
    for await (const [name, handle] of dir.entries()) {
      if (name === LEDGER_FILE) continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') await walk(handle, relative);
      else found.push(`${MEDIA_ROOT}/${relative}`);
    }
  };
  try {
    await walk(await getAssetsDir(false), '');
  } catch (error) {
    if (error.name !== 'NotFoundError') throw error;
  }
  return found;
}

// --- the forwarding ledger -------------------------------------------------
//
// The browser twin of the server's. Same file, same job: a path recorded before
// a Clean Files run still has to find its file, and the run renames as well as
// moves so there is no clue left in the file itself.

async function readLedger() {
  try {
    const handle = await (await getAssetsDir(false)).getFileHandle(LEDGER_FILE);
    const parsed = JSON.parse(await (await handle.getFile()).text());
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // absent or corrupt is the same thing here: no forwarding
  }
}

async function writeLedger(ledger) {
  try {
    const handle = await (await getAssetsDir(true)).getFileHandle(LEDGER_FILE, { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(ledger, null, 2));
    await writable.close();
  } catch (error) {
    console.error('Could not write the move ledger:', error);
  }
}

async function appendLedger(moves) {
  if (moves.length === 0) return;
  const ledger = await readLedger();
  const destinations = new Map(moves.map(move => [move.from, move.to]));
  Object.keys(ledger).forEach(from => {
    const movedOn = destinations.get(ledger[from]);
    if (movedOn) ledger[from] = movedOn;
  });
  moves.forEach(move => { ledger[move.from] = move.to; });
  Object.keys(ledger).forEach(from => { if (ledger[from] === from) delete ledger[from]; });
  await writeLedger(ledger);
}

function extensionFor(mimeType, fallback = '.png') {
  if (!mimeType) return fallback;
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return '.jpg';
  if (mimeType.includes('webp')) return '.webp';
  if (mimeType.includes('gif')) return '.gif';
  if (mimeType.includes('png')) return '.png';
  if (mimeType.includes('mp4')) return '.mp4';
  if (mimeType.includes('webm')) return '.webm';
  if (mimeType.includes('mpeg')) return '.mp3';
  if (mimeType.includes('wav')) return '.wav';
  return fallback;
}

/** The bare filenames already in a project-relative folder. */
async function siblingNames(assetDirPath) {
  const names = [];
  try {
    const dir = await walkToDir(assetDirPath, false);
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file') names.push(name);
    }
  } catch { /* no folder yet means no siblings */ }
  return names;
}

/**
 * Where a new file goes, and what it is called.
 *
 * The browser twin of the server's `resolveWritePath`. Same rule about
 * failure: a destination that will not resolve lands in the bin rather than
 * throwing away a generation that has already been paid for.
 */
async function resolveWritePath(destination, prefix, ext, project) {
  const timestamped = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`;
  if (!destination) return { dir: MEDIA_ROOT, name: timestamped };

  try {
    const state = project || (await readProjectState()) || {};
    const dir = destinationDir(destination, state);
    const naming = destinationStem(destination, state);
    if (!naming || dir === BIN_DIR) return { dir: BIN_DIR, name: timestamped };
    return { dir, name: nextFileName(naming.stem, naming.versioned, ext, await siblingNames(dir)) };
  } catch (error) {
    console.error('Could not resolve a destination folder, writing flat:', error);
    return { dir: MEDIA_ROOT, name: timestamped };
  }
}

/** Write a blob into the media tree and return its project-relative path. */
export async function writeAsset(blob, prefix = 'file', explicitExt = null, destination = null) {
  const ext = explicitExt || extensionFor(blob.type);
  const { dir, name } = await resolveWritePath(destination, prefix, ext);
  const relativePath = dir === MEDIA_ROOT ? `${MEDIA_ROOT}/${name}` : `${dir}/${name}`;
  const handle = await walkToFile(relativePath, true);
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
  return relativePath;
}

/** Copy an existing File (user upload) into the project. */
export async function importFile(file, prefix = 'ref', destination = null) {
  const ext = file.name.includes('.') ? `.${file.name.split('.').pop()}` : extensionFor(file.type);
  return writeAsset(file, prefix, ext, destination);
}

function assetFilename(assetPath) {
  return String(assetPath).replace(/\\/g, '/').replace(/^assets\//, '');
}

/**
 * The path a recorded path actually lives at today.
 *
 * Tries where it says it is, then the forwarding ledger, and gives up rather
 * than guessing. The browser has no cheap basename index, so unlike the server
 * there is no third fallback — the ledger covers everything Clean Files did.
 */
export async function resolveRecordedPath(assetPath) {
  try {
    await walkToFile(assetPath, false);
    return assetPath;
  } catch { /* not where it says; try the forwarding address */ }

  const forwarded = (await readLedger())[String(assetPath).replace(/\\/g, '/')];
  if (!forwarded) return null;
  try {
    await walkToFile(forwarded, false);
    return forwarded;
  } catch {
    return null;
  }
}

export async function readAssetFile(assetPath) {
  try {
    return await (await walkToFile(assetPath, false)).getFile();
  } catch (error) {
    const forwarded = await resolveRecordedPath(assetPath);
    if (!forwarded) throw error;
    return (await walkToFile(forwarded, false)).getFile();
  }
}

export async function readAssetDataUrl(assetPath) {
  const file = await readAssetFile(assetPath);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export async function listAssetImages() {
  return (await listMediaFiles())
    .filter(file => IMAGE_EXTENSIONS.some(ext => file.toLowerCase().endsWith(ext)))
    .map(file => ({ name: file.slice(file.lastIndexOf('/') + 1), path: file }));
}

// Everything the media bin can pull from the project folder, by extension —
// the browser twin of the server's /api/project-media.
const MEDIA_EXTENSIONS = {
  image: IMAGE_EXTENSIONS,
  video: ['.mp4', '.mov', '.webm', '.m4v'],
  audio: ['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac']
};

export async function listAssetMedia() {
  const media = [];
  for (const file of await listMediaFiles()) {
    const lower = file.toLowerCase();
    const type = Object.keys(MEDIA_EXTENSIONS)
      .find(kind => MEDIA_EXTENSIONS[kind].some(ext => lower.endsWith(ext)));
    if (!type) continue;
    let mtime = 0;
    try { mtime = (await (await walkToFile(file, false)).getFile()).lastModified; } catch { /* listed anyway */ }
    media.push({ name: file.slice(file.lastIndexOf('/') + 1), path: file, type, mtime });
  }
  return media.sort((a, b) => b.mtime - a.mtime);
}

/** Copy every asset referenced by another project's library into this one. */
export async function copyAssetsFrom(sourceDirHandle, assetPaths) {
  const targetDir = await getAssetsDir();
  const sourceAssets = await sourceDirHandle.getDirectoryHandle('assets', { create: false });
  const mapping = new Map();

  for (const assetPath of assetPaths) {
    try {
      // The source project may itself be organised, so this walks rather than
      // reading one flat folder. Imported files land unfiled and Clean Files
      // sorts them — the importing project's shot list is the only thing that
      // can say where they belong, and it has not seen them yet.
      const segments = assetSegments(assetPath);
      let sourceDir = sourceAssets;
      for (const segment of segments.slice(0, -1)) {
        sourceDir = await sourceDir.getDirectoryHandle(segment);
      }
      const sourceFile = await (await sourceDir.getFileHandle(segments[segments.length - 1])).getFile();
      const ext = sourceFile.name.includes('.') ? `.${sourceFile.name.split('.').pop()}` : '.png';
      const filename = `ref_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`;
      const handle = await targetDir.getFileHandle(filename, { create: true });
      const writable = await handle.createWritable();
      await writable.write(sourceFile);
      await writable.close();
      mapping.set(assetPath, `assets/${filename}`);
    } catch {
      // Missing source file — skip it rather than failing the whole import.
    }
  }
  return mapping;
}

// --- Clean Files ------------------------------------------------------------
//
// The browser twin of the server's organize endpoint. Same plan, from the same
// pure module; only the moving is different, because a directory handle has no
// rename-across-folders unless the browser implements `FileSystemFileHandle
// .move` — Chromium does, and the copy-and-delete fallback covers the rest.

const STAGING_DIR = '.organize-staging';

/** The directory handle holding a project-relative file, plus its bare name. */
async function locate(assetPath, create = false) {
  const segments = assetSegments(assetPath);
  const name = segments.pop();
  const dirPath = segments.length ? `${MEDIA_ROOT}/${segments.join('/')}` : MEDIA_ROOT;
  return { dir: await walkToDir(dirPath, create), name };
}

async function fileExists(assetPath) {
  try {
    await walkToFile(assetPath, false);
    return true;
  } catch {
    return false;
  }
}

/** Move one file, preferring the native rename and copying only if we must. */
async function moveAsset(from, to) {
  const source = await locate(from, false);
  const target = await locate(to, true);
  const handle = await source.dir.getFileHandle(source.name);

  if (typeof handle.move === 'function') {
    await handle.move(target.dir, target.name);
    return;
  }

  const file = await handle.getFile();
  const created = await target.dir.getFileHandle(target.name, { create: true });
  const writable = await created.createWritable();
  await writable.write(file);
  await writable.close();
  await source.dir.removeEntry(source.name);
}

/** Drop folders the moves emptied, deepest first. The root itself survives. */
async function pruneEmptyDirs(dir) {
  const removable = [];
  let empty = true;
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'directory') {
      if (await pruneEmptyDirs(handle)) removable.push(name);
      else empty = false;
    } else {
      empty = false;
    }
  }
  for (const name of removable) {
    try { await dir.removeEntry(name); } catch { empty = false; }
  }
  return empty && removable.length === 0 ? true : empty;
}

/**
 * Plan the layout, and carry it out when asked.
 *
 * Mirrors the server's contract exactly so the client does not care which mode
 * it is in: a dry run reports, an applied run returns the mapping of what
 * actually moved. A file that will not move keeps its path, and the state that
 * points there stays correct.
 */
export async function organizeAssets({ state = {}, apply = false } = {}) {
  const existingFiles = await listMediaFiles();
  const plan = planAssetLayout(state, { existingFiles });

  if (!apply) {
    return {
      applied: false,
      summary: plan.summary,
      preview: plan.moves.slice(0, 40),
      moves: plan.moves.length
    };
  }

  const moved = [];
  const failed = [];
  const staged = [];

  // Anything landing on an occupied name is parked first, so two files
  // exchanging places cannot lose one of themselves.
  for (const move of plan.moves) {
    if (!(await fileExists(move.to))) continue;
    const parked = `${MEDIA_ROOT}/${STAGING_DIR}/${staged.length}_${move.from.slice(move.from.lastIndexOf('/') + 1)}`;
    try {
      await moveAsset(move.from, parked);
      staged.push({ move, parked });
    } catch (error) {
      failed.push({ ...move, error: error.message });
    }
  }
  const parkedFrom = new Set(staged.map(entry => entry.move.from));

  for (const move of plan.moves) {
    if (parkedFrom.has(move.from) || failed.some(entry => entry.from === move.from)) continue;
    try {
      await moveAsset(move.from, move.to);
      moved.push(move);
    } catch (error) {
      failed.push({ ...move, error: error.message });
    }
  }
  for (const entry of staged) {
    try {
      await moveAsset(entry.parked, entry.move.to);
      moved.push(entry.move);
    } catch (error) {
      failed.push({ ...entry.move, error: error.message });
    }
  }

  await appendLedger(moved);
  try {
    await pruneEmptyDirs(await getAssetsDir(false));
  } catch { /* nothing to prune */ }
  clearAssetUrlCache();

  return {
    applied: true,
    summary: plan.summary,
    mapping: moved.map(move => [move.from, move.to]),
    moved: moved.length,
    failed
  };
}

// --- object URLs for <img>/<video> ---

const urlCache = new Map();

/** A blob: URL for a project asset, cached so repeated renders are cheap. */
export async function getAssetObjectUrl(assetPath) {
  if (!assetPath) return null;
  if (urlCache.has(assetPath)) return urlCache.get(assetPath);
  const file = await readAssetFile(assetPath);
  const url = URL.createObjectURL(file);
  urlCache.set(assetPath, url);
  return url;
}

/** Drop a cached URL so the next read picks up rewritten bytes. */
export function invalidateAssetUrl(assetPath) {
  const url = urlCache.get(assetPath);
  if (url) {
    URL.revokeObjectURL(url);
    urlCache.delete(assetPath);
  }
}

export function clearAssetUrlCache() {
  urlCache.forEach(url => URL.revokeObjectURL(url));
  urlCache.clear();
}
