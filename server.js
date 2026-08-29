const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec, execFile, spawn } = require('child_process');
const { buildRenderGraph } = require('./renderGraph.js');
const { buildWatermarkGraph } = require('./watermarkGraph.js');
const { buildExportPlan } = require('./exportPlan.js');
const {
  summariseProject, revisionOf, guardRevision, guardContent
} = require('./projectGuard.js');
const { ProxyCache, readSettings: readCacheSettings, defaultWorkFolder } = require('./proxyCache.js');
const assetOrganizer = require('./assetOrganizer.js');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Config & State file paths
// Overridable so the guard tests can point a whole server at a scratch
// project without going anywhere near the real one.
const CONFIG_FILE = process.env.MM_CONFIG || path.join(__dirname, 'config.json');

// Helper to read JSON safely
function readJsonFile(filePath, defaultVal = {}) {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error(`Error reading ${filePath}:`, error);
  }
  return defaultVal;
}

// --- PROJECTS ---------------------------------------------------------------
// A project is a folder. It holds one `<name>.mmproj.json` alongside an
// `assets/` directory, so the folder can be zipped, moved or dropped on a
// shared drive and still open. The project file records its own workingFolder,
// but the file's actual location always wins — that is what makes a moved or
// copied project folder just work.

const PROJECT_EXT = '.mmproj.json';

function projectNameFromPath(projectPath) {
  return path.basename(projectPath).replace(/\.mmproj\.json$/i, '');
}

/**
 * Give a generically named project file its folder's name.
 *
 * A file literally called `project.mmproj.json` says nothing about which
 * project it is, so a save landing in the wrong folder looks exactly like a
 * save landing in the right one. The folder is the project's identity under
 * the folder-per-project rule, so opening such a file renames it after its
 * folder. Anything that stops the rename (the distinct name already taken,
 * a locked file, a read-only share) just keeps the old name — opening still
 * works.
 */
function migrateGenericProjectFile(projectPath) {
  if (projectNameFromPath(projectPath).toLowerCase() !== 'project') return projectPath;
  const dir = path.dirname(projectPath);
  const folderName = path.basename(dir);
  if (!folderName || folderName.toLowerCase() === 'project') return projectPath;
  const distinct = path.join(dir, `${folderName}${PROJECT_EXT}`);
  if (fs.existsSync(distinct)) return projectPath;
  try {
    fs.renameSync(projectPath, distinct);
    console.log(`Renamed generic project file to ${distinct}`);
    return distinct;
  } catch (error) {
    console.error(`Could not rename ${projectPath}:`, error.message);
    return projectPath;
  }
}

/**
 * Where the active project is, and whether we can actually see it.
 *
 * The distinction is the whole point. A project on a removable or network
 * drive disappears and comes back; treating "gone" as "there is no project"
 * silently demotes the app to the loose legacy state file, which is how a
 * placeholder ends up written over a real film. `unreachable` is reported as
 * an error everywhere instead, so nothing is read or written until the drive
 * is back.
 */
function activeProjectStatus() {
  const config = readJsonFile(CONFIG_FILE);
  const active = config.activeProjectPath;
  if (!active) return { path: null, state: 'none' };
  if (fs.existsSync(active)) return { path: active, state: 'ok' };
  return { path: active, state: 'unreachable' };
}

/** The active project file, or null when running on the legacy loose state file. */
function getActiveProjectPath() {
  const status = activeProjectStatus();
  return status.state === 'ok' ? status.path : null;
}

// Helper to get current project working root from config
function getWorkingRoot() {
  // Folder-per-project: the project file's own directory is the working root.
  const active = getActiveProjectPath();
  if (active) return path.dirname(active);

  const config = readJsonFile(CONFIG_FILE);
  if (config.workingFolder && fs.existsSync(config.workingFolder)) {
    return config.workingFolder;
  }
  return __dirname;
}

function readProjectFile(projectPath) {
  const raw = readJsonFile(projectPath, null);
  if (!raw) throw new Error(`Could not read project file: ${projectPath}`);
  // Accept both the wrapped format and a bare legacy state blob.
  return raw.state && typeof raw.state === 'object' ? raw : { state: raw };
}

function writeProjectFile(projectPath, state, name) {
  const dir = path.dirname(projectPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const payload = {
    format: 'moviemaker-project',
    formatVersion: 1,
    name: name || projectNameFromPath(projectPath),
    workingFolder: dir,
    savedAt: new Date().toISOString(),
    state: state || {}
  };
  if (!writeJsonFile(projectPath, payload)) {
    throw new Error(`Failed to write project file: ${projectPath}`);
  }
  // Every project owns its media directory.
  const assetsDir = path.join(dir, 'assets');
  if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
  return payload;
}

/** Remember this project at the top of the recent list and make it active. */
function setActiveProject(projectPath) {
  const config = readJsonFile(CONFIG_FILE);
  const recent = (config.recentProjects || []).filter(entry => (
    entry && entry.path && path.resolve(entry.path) !== path.resolve(projectPath)
  ));
  recent.unshift({
    path: projectPath,
    name: projectNameFromPath(projectPath),
    lastOpened: new Date().toISOString()
  });
  config.activeProjectPath = projectPath;
  config.recentProjects = recent.slice(0, 12);
  writeJsonFile(CONFIG_FILE, config);
  return config;
}

// Helper to get dynamic assets directory path
function getAssetsDir() {
  const dir = path.join(getWorkingRoot(), 'assets');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// --- CHECKPOINTS ------------------------------------------------------------
// A checkpoint is a named snapshot of the whole studio state — shot list,
// settings, galleries and the edit — kept beside the project so you can branch
// an idea without branching the project.
//
// They live as one file each in `checkpoints/` rather than inside the project
// file: the state is tens of kilobytes, and burying a dozen copies of it in the
// document autosave rewrites every few seconds would be miserable.
//
// Media is deliberately not copied. Generated assets are written once under
// timestamped names and never change, so every checkpoint can share them. The
// cost is that deleting an asset also breaks the checkpoints referencing it.

function getCheckpointsDir(create = true) {
  const dir = path.join(getWorkingRoot(), 'checkpoints');
  if (create && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Enough to describe a checkpoint in a list without reading all of it. */
function summariseState(state) {
  const scenes = Array.isArray(state?.scenes) ? state.scenes : [];
  const shots = scenes.reduce((total, scene) => total + (scene.shots || []).length, 0);
  const withVideo = scenes.reduce((total, scene) => (
    total + (scene.shots || []).filter(shot => shot.selectedVideo).length
  ), 0);
  return {
    scenes: scenes.length,
    shots,
    shotsWithVideo: withVideo,
    editClips: Array.isArray(state?.edit?.video) ? state.edit.video.length : 0
  };
}

function readCheckpointFile(file) {
  const raw = readJsonFile(file, null);
  if (!raw || !raw.id) return null;
  return raw;
}

function listCheckpoints() {
  const dir = getCheckpointsDir(false);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => readCheckpointFile(path.join(dir, name)))
    .filter(Boolean)
    .map(({ state, ...meta }) => meta)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// Helper to get dynamic project state file path
function getStateFilePath() {
  return getActiveProjectPath() || path.join(getWorkingRoot(), 'project_state.json');
}

// Serve assets statically (wrapped dynamically to support runtime config updates)
//
// The fallback behind it is what lets the tree be reorganised at all. Every
// checkpoint, auto-backup and exported project holds paths recorded before the
// move, and rewriting all of them was never going to be reliable. So a URL that
// does not resolve is looked up by filename before it is called a 404 — old
// state keeps rendering, and the only cost is one directory walk the first time
// a stale path is asked for.
app.use('/assets', (req, res, next) => {
  express.static(getAssetsDir())(req, res, () => {
    let recorded;
    try {
      recorded = `assets${decodeURIComponent(req.path)}`;
    } catch {
      return next(); // a malformed escape is not a path worth chasing
    }
    const found = assetOrganizer.resolveRecordedPath(getWorkingRoot(), recorded);
    if (!found) return next();
    res.sendFile(path.resolve(getWorkingRoot(), found));
  });
});

/**
 * Write JSON, or leave what was there alone.
 *
 * Straight to the destination meant a crash or a drive dropping mid-write left
 * a truncated file — a project that no longer parses at all. Writing beside it
 * and renaming makes the swap atomic on every filesystem we run on, so the
 * worst case is a stale project rather than a destroyed one.
 */
function writeJsonFile(filePath, data) {
  const temporary = `${filePath}.tmp${process.pid}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(temporary, filePath);
    return true;
  } catch (error) {
    console.error(`Error writing ${filePath}:`, error);
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* nothing to clean */ }
    return false;
  }
}

// Where a newly generated file goes.
//
// A generation request may carry a `destination` — which shot, which asset, the
// reference board — and when it does, the file is written straight into the
// right folder under the right name. Clean Files exists to repair everything
// that arrived without one; the point of this path is that it should have very
// little left to repair.
//
// A destination that will not resolve is never fatal. The generation has
// already been paid for by the time this runs, so anything unrecognised lands
// in the bin — visible, sweepable, and far better than discarding a picture
// that cost money or scattering it at the root.
async function resolveWritePath(destination, prefix, ext) {
  const workingRoot = getWorkingRoot();
  const timestamped = `${prefix}_${Date.now()}${ext}`;
  const flat = () => ({
    absolutePath: path.join(getAssetsDir(), timestamped),
    relativePath: `assets/${timestamped}`
  });
  if (!destination) return flat();

  try {
    const paths = await getAssetPaths();
    // A descriptor normally carries its own scene and shot names; the saved
    // project is only consulted when it carried an id instead.
    const project = readProjectStateForPaths();
    const dir = paths.destinationDir(destination, project);
    const naming = paths.destinationStem(destination, project);
    // The bin keeps the timestamped name: there is nothing to name it after,
    // and the timestamp is the only clue left about when it arrived.
    if (!naming || dir === paths.BIN_DIR) {
      return assetOrganizer.reserveNewFile(workingRoot, paths.BIN_DIR, timestamped);
    }
    const siblings = assetOrganizer.siblingNames(workingRoot, dir);
    const filename = paths.nextFileName(naming.stem, naming.versioned, ext, siblings);
    return assetOrganizer.reserveNewFile(workingRoot, dir, filename);
  } catch (error) {
    console.error('Could not resolve a destination folder, writing flat:', error.message);
    return flat();
  }
}

// Helper to download a file from a URL to assets
async function downloadFile(url, prefix, ext, destination = null) {
  const { absolutePath, relativePath } = await resolveWritePath(destination, prefix, ext);
  // If it's a data URL, handle base64
  if (url.startsWith('data:')) {
    // Digits and dots belong in the character class: every media type that has
    // reached here so far happened to be letters only ("image/png"), but a
    // provider that hands back the file itself rather than a link to it can
    // easily say "video/mp4", and this used to reject that as an invalid data
    // URL after the generation had already been paid for.
    const matches = url.match(/^data:([A-Za-z0-9-+.\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      throw new Error('Invalid data URL');
    }
    fs.writeFileSync(absolutePath, Buffer.from(matches[2], 'base64'));
    assetOrganizer.invalidateIndex(getWorkingRoot());
    return relativePath;
  }

  // Handle standard HTTP/HTTPS URLs
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch remote asset: ${response.statusText}`);
  }

  fs.writeFileSync(absolutePath, Buffer.from(await response.arrayBuffer()));
  assetOrganizer.invalidateIndex(getWorkingRoot());
  return relativePath;
}

// Multer Storage Configuration for user uploads (audio, reference images)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, getAssetsDir());
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const prefix = file.fieldname === 'audio' || file.mimetype?.startsWith('audio/') ? 'audio'
      : file.mimetype?.startsWith('video/') ? 'video'
      : 'ref';
    cb(null, `${prefix}_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

// --- CONFIG API ENDPOINTS ---
app.get('/api/config', (req, res) => {
  const config = readJsonFile(CONFIG_FILE, {
    geminiKey: '',
    openaiKey: '',
    claudeKey: '',
    falKey: '',
    runwayKey: '',
    klingKey: '',
    klingSecret: '',
    higgsfieldKey: '',
    higgsfieldSecret: '',
    atlasKey: '',
    veniceKey: ''
  });
  res.json(config);
});

app.post('/api/config', (req, res) => {
  const success = writeJsonFile(CONFIG_FILE, req.body);
  if (success) {
    res.json({ message: 'Configuration saved successfully' });
  } else {
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

// --- PROJECT STATE API ENDPOINTS ---
//
// Every read hands back the revision it read, every write says which revision
// it was based on, and a write whose baseline no longer matches is refused
// rather than applied. See projectGuard.js for why.

/** The revision string for whatever file the state currently lives in. */
function currentStateRevision() {
  try {
    const file = getStateFilePath();
    if (!fs.existsSync(file)) return 'none';
    return revisionOf(fs.statSync(file)) || 'none';
  } catch {
    return 'none';
  }
}

/** Stamp a state response with what it came from, so the save can quote it back. */
function stampRevision(res, target) {
  res.set('X-MM-Revision', currentStateRevision());
  res.set('X-MM-Target', target || getStateFilePath());
  // The app is on a different origin in dev; without this the fetch sees no
  // custom headers at all and every save would look like it had no baseline.
  res.set('Access-Control-Expose-Headers', 'X-MM-Revision, X-MM-Target');
}

/** Whatever is on disk right now, for the guards to compare against. */
function readCurrentState() {
  const activePath = getActiveProjectPath();
  try {
    if (activePath) return readProjectFile(activePath).state || null;
    const file = getStateFilePath();
    return fs.existsSync(file) ? readJsonFile(file, null) : null;
  } catch {
    // Unreadable is not the same as absent, and guessing "absent" here would
    // wave through the very write the guards exist to stop.
    return undefined;
  }
}

/**
 * Keep a copy of what we are about to overwrite.
 *
 * Only ever called on a save the guards refused and the user forced through,
 * which is exactly the save worth being able to undo. Named for the moment so
 * a folder of them reads as a timeline.
 */
function backupBeforeOverwrite(reason) {
  try {
    const file = getStateFilePath();
    if (!fs.existsSync(file)) return null;
    const dir = path.join(getWorkingRoot(), 'checkpoints', 'auto-backups');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(dir, `${stamp}_before-${reason}.json`);
    fs.copyFileSync(file, target);
    console.warn(`[state] forced ${reason} save; previous file kept at ${target}`);
    return target;
  } catch (error) {
    console.error('Could not take a pre-overwrite backup:', error);
    return null;
  }
}

/** A cheap poll so a window can notice the file moved on under it. */
app.get('/api/state/revision', (req, res) => {
  const status = activeProjectStatus();
  if (status.state === 'unreachable') {
    return res.status(503).json({ reason: 'project-unreachable', path: status.path });
  }
  res.json({ revision: currentStateRevision(), target: getStateFilePath() });
});

app.get('/api/state', (req, res) => {
  const defaultState = {
    shots: [
      {
        id: 'shot_' + Date.now(),
        name: 'Shot 1',
        setup: 'Wide establishing shot of a futuristic cyberpunk city skyline, neon lights reflecting in the rain.',
        description: 'A glowing hover-car slowly flies between towering skyscrapers. Rain streaks the camera lens.',
        dialogue: 'A voiceover says: "Welcome to New Eden, where dreams are manufactured."',
        notes: 'Needs to feel atmospheric and slow.',
        selectedImage: null,
        selectedVideo: null,
        referenceImages: [],
        lipSyncAudio: null
      }
    ],
    imagePrompts: [],
    videoPrompts: [],
    referenceImages: [],
    prePrompt: 'Create a cinematic, photorealistic visual description for a high-budget sci-fi film of the following scene: ',
    postPrompt: ', ultra realistic, highly detailed, octane render, 8k, volumetric lighting',
    activeLlm: 'gemini',
    activeImageGenerator: 'fal-ai',
    imageResolution: '1344x768',
    activeVideoGenerator: 'fal-ai',
    videoResolution: '1280x720',
    videoModel: 'fal-ai/kling-video' // fallback / flexible model selection
  };
  const status = activeProjectStatus();

  // The drive is away, or the file was moved. Handing back the placeholder here
  // is what let the app boot a default project and then autosave it over the
  // real one the moment the drive returned.
  if (status.state === 'unreachable') {
    return res.status(503).json({
      error: `The project file is not reachable: ${status.path}`,
      reason: 'project-unreachable',
      path: status.path
    });
  }

  if (status.state === 'ok') {
    try {
      const project = readProjectFile(status.path);
      stampRevision(res, status.path);
      return res.json(Object.keys(project.state || {}).length > 0 ? project.state : defaultState);
    } catch (error) {
      console.error('Failed to read active project:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  const state = readJsonFile(getStateFilePath(), defaultState);
  stampRevision(res);
  res.json(state);
});

/**
 * Autosave channel. Writes into the active project file when one is open,
 * otherwise the legacy loose project_state.json.
 *
 * Three things have to be true before the write happens: the project is where
 * we last saw it, the client based this save on the file's current contents,
 * and the save is not obviously a wipe. Each failure is a 409 carrying enough
 * detail for the app to offer the user the two real choices - reload what is on
 * disk, or say "yes, overwrite it" and send `X-MM-Force`.
 */
app.post('/api/state', (req, res) => {
  const status = activeProjectStatus();
  if (status.state === 'unreachable') {
    return res.status(503).json({
      error: `Refusing to save: the project file is not reachable (${status.path}).`,
      reason: 'project-unreachable',
      path: status.path
    });
  }

  const force = req.get('X-MM-Force') === '1';
  const target = getStateFilePath();
  const revision = currentStateRevision();

  const claimedTarget = req.get('X-MM-Target');
  if (claimedTarget && !force && path.resolve(claimedTarget) !== path.resolve(target)) {
    // The active project changed under this window - usually a drive coming
    // back, or another window opening something else.
    return res.status(409).json({
      error: 'This window is saving to a different project than the one now open.',
      reason: 'target-changed',
      expected: claimedTarget,
      current: target,
      revision
    });
  }

  const baseline = guardRevision(req.get('X-MM-Base-Revision'), revision, { force });
  if (!baseline.ok) {
    return res.status(409).json({ ...baseline, ok: undefined, error: baseline.message, revision, target });
  }

  const existing = readCurrentState();
  if (existing === undefined && !force) {
    return res.status(409).json({
      error: 'The project file on disk could not be read, so this save was held back.',
      reason: 'unreadable',
      revision,
      target
    });
  }

  const content = guardContent(req.body, existing || null, { force });
  if (!content.ok) {
    return res.status(409).json({ ...content, ok: undefined, error: content.message, revision, target });
  }

  try {
    if (force) backupBeforeOverwrite('forced-overwrite');
    if (status.state === 'ok') {
      writeProjectFile(status.path, req.body);
    } else if (!writeJsonFile(target, req.body)) {
      throw new Error('Failed to save project state');
    }
    stampRevision(res, status.path || target);
    res.json({
      message: 'Project state saved successfully',
      revision: currentStateRevision(),
      target,
      summary: summariseProject(req.body)
    });
  } catch (error) {
    console.error('Save error:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- PROJECT MANAGEMENT ENDPOINTS ---

app.get('/api/project', (req, res) => {
  const config = readJsonFile(CONFIG_FILE);
  const activePath = getActiveProjectPath();
  res.json({
    path: activePath,
    name: activePath ? projectNameFromPath(activePath) : 'Untitled (loose state file)',
    workingFolder: getWorkingRoot(),
    isLegacy: !activePath,
    recent: (config.recentProjects || []).filter(entry => entry && fs.existsSync(entry.path))
  });
});

app.post('/api/project/new', (req, res) => {
  const { directory, name } = req.body;
  if (!directory || !name) {
    return res.status(400).json({ error: 'directory and name are required' });
  }
  try {
    const safeName = String(name).replace(/[<>:"/\\|?*]/g, '_').trim();
    if (!safeName) throw new Error('Project name is empty after removing illegal characters.');

    // Each project gets its own folder named after it.
    const projectDir = path.join(directory, safeName);
    const projectPath = path.join(projectDir, `${safeName}${PROJECT_EXT}`);
    if (fs.existsSync(projectPath)) {
      return res.status(409).json({ error: `A project already exists at ${projectPath}` });
    }

    writeProjectFile(projectPath, {}, safeName);
    setActiveProject(projectPath);
    stampRevision(res, projectPath);
    res.json({
      path: projectPath, name: safeName, workingFolder: projectDir,
      revision: currentStateRevision(), target: getStateFilePath()
    });
  } catch (error) {
    console.error('New project error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/project/open', (req, res) => {
  const { path: requestedPath } = req.body;
  if (!requestedPath) return res.status(400).json({ error: 'path is required' });
  if (!fs.existsSync(requestedPath)) {
    return res.status(404).json({ error: `Project file not found: ${requestedPath}` });
  }
  try {
    const projectPath = migrateGenericProjectFile(requestedPath);
    const project = readProjectFile(projectPath);
    setActiveProject(projectPath);

    const actualDir = path.dirname(projectPath);
    const moved = project.workingFolder && path.resolve(project.workingFolder) !== path.resolve(actualDir);
    const renamed = projectPath !== requestedPath;
    if (moved || renamed) {
      // The folder was moved or copied, or the file was just renamed —
      // re-anchor the recorded workingFolder and name to where the file
      // actually is. The filename wins over whatever the payload said.
      writeProjectFile(projectPath, project.state);
    }

    stampRevision(res, projectPath);
    res.json({
      path: projectPath,
      name: projectNameFromPath(projectPath),
      workingFolder: actualDir,
      renamedFrom: renamed ? requestedPath : null,
      relocatedFrom: moved ? project.workingFolder : null,
      state: project.state,
      revision: currentStateRevision(),
      target: getStateFilePath()
    });
  } catch (error) {
    console.error('Open project error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save As branches the whole project: it always creates its own folder (so the
// one-folder-per-project rule holds) and copies the current media across, or
// every thumbnail in the new copy would be dead.
app.post('/api/project/save-as', (req, res) => {
  const { path: rawPath, state } = req.body;
  if (!rawPath) return res.status(400).json({ error: 'path is required' });

  try {
    const chosen = rawPath.replace(/\.mmproj\.json$/i, '').replace(/\.json$/i, '');
    const name = path.basename(chosen);
    if (!name) throw new Error('Could not derive a project name from that path.');

    const projectDir = path.join(path.dirname(chosen), name);
    const projectPath = path.join(projectDir, `${name}${PROJECT_EXT}`);
    if (fs.existsSync(projectPath)) {
      return res.status(409).json({ error: `A project already exists at ${projectPath}` });
    }

    const sourceAssets = getAssetsDir();
    writeProjectFile(projectPath, state || {}, name);

    // Copy media forward so the branch is immediately usable.
    let copied = 0;
    const targetAssets = path.join(projectDir, 'assets');
    if (fs.existsSync(sourceAssets) && path.resolve(sourceAssets) !== path.resolve(targetAssets)) {
      for (const entry of fs.readdirSync(sourceAssets, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        fs.copyFileSync(path.join(sourceAssets, entry.name), path.join(targetAssets, entry.name));
        copied++;
      }
    }

    setActiveProject(projectPath);
    stampRevision(res, projectPath);
    res.json({
      path: projectPath, name, workingFolder: projectDir, copiedAssets: copied,
      revision: currentStateRevision(), target: getStateFilePath()
    });
  } catch (error) {
    console.error('Save-as error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Pull the asset library out of another project, copying its reference images
// into this project so the result stays self-contained.
app.post('/api/project/import-assets', (req, res) => {
  const { path: sourcePath } = req.body;
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return res.status(404).json({ error: 'Source project not found' });
  }
  try {
    const source = readProjectFile(sourcePath);
    const sourceDir = path.dirname(sourcePath);
    const targetAssets = getAssetsDir();
    const assets = source.state?.assetLibrary || [];

    const copyInto = (relativePath) => {
      if (!relativePath) return null;
      const from = path.resolve(sourceDir, relativePath);
      if (!fs.existsSync(from)) return null;
      const filename = `ref_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${path.extname(from)}`;
      fs.copyFileSync(from, path.join(targetAssets, filename));
      return `assets/${filename}`;
    };

    const imported = assets.map(asset => {
      const remap = new Map();
      (asset.images || []).forEach(imagePath => {
        const copied = copyInto(imagePath);
        if (copied) remap.set(imagePath, copied);
      });
      const images = (asset.images || []).map(p => remap.get(p)).filter(Boolean);
      return {
        ...asset,
        id: `asset_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        images,
        primaryImage: remap.get(asset.primaryImage) || images[0] || null
      };
    });

    res.json({ assets: imported, sourceName: projectNameFromPath(sourcePath) });
  } catch (error) {
    console.error('Import assets error:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- CLEAN FILES ------------------------------------------------------------
//
// Two calls, deliberately. `POST /api/assets/organize` with `apply: false`
// answers "what would happen" and touches nothing; with `apply: true` it moves
// the files and reports what actually moved.
//
// The client sends its live state rather than the server reading the saved
// project, because the two differ by however long ago the last autosave was and
// planning against a stale shot list would file this morning's work in the bin.
//
// The mapping that comes back is built from what *moved*, never from the plan.
// A file that could not be renamed — open in another program is the usual
// reason on Windows — keeps its old path, and the state that still points there
// is correct.
app.post('/api/assets/organize', async (req, res) => {
  try {
    const paths = await getAssetPaths();
    const workingRoot = getWorkingRoot();
    const state = req.body?.state || {};
    const existingFiles = assetOrganizer.listMediaFiles(workingRoot);
    const plan = paths.planAssetLayout(state, { existingFiles });

    if (!req.body?.apply) {
      return res.json({
        applied: false,
        summary: plan.summary,
        // Enough for a dialog to show the shape of it without shipping
        // thousands of rows to render.
        preview: plan.moves.slice(0, 40),
        moves: plan.moves.length
      });
    }

    const { moved, failed } = assetOrganizer.applyMoves(workingRoot, plan.moves);
    res.json({
      applied: true,
      summary: plan.summary,
      mapping: moved.map(move => [move.from, move.to]),
      moved: moved.length,
      failed
    });
  } catch (error) {
    console.error('Organize error:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- FILE UPLOAD ENDPOINT ---
//
// Multer still writes where it always did; the file is filed afterwards. Doing
// it in this handler rather than in multer's own destination callback keeps the
// async layout lookup out of a synchronous callback, and means an upload whose
// destination cannot be resolved is still a successful upload.
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  let filePath = `assets/${req.file.filename}`;

  // Multipart fields are parsed by the time the handler runs, so the client can
  // say what the upload is for the same way a generation does.
  let destination = null;
  try {
    destination = req.body?.destination ? JSON.parse(req.body.destination) : null;
  } catch { /* an unreadable descriptor is the same as none */ }

  if (destination) {
    try {
      const target = await resolveWritePath(destination, 'ref', path.extname(req.file.filename));
      fs.renameSync(req.file.path, target.absolutePath);
      assetOrganizer.invalidateIndex(getWorkingRoot());
      filePath = target.relativePath;
    } catch (error) {
      console.error('Could not file the upload, leaving it at the root:', error.message);
    }
  }

  res.json({
    filePath,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype
  });
});

// --- PROJECT IMAGES ENUMERATION ENDPOINT ---
app.get('/api/project-images', (req, res) => {
  try {
    // A walk rather than a readdir: the pickers are how you find an image, and
    // an image filed under its shot is exactly the one you are looking for.
    const images = assetOrganizer.listMediaFiles(getWorkingRoot())
      .filter(file => ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(path.extname(file).toLowerCase()))
      .map(file => ({ name: file.slice(file.lastIndexOf('/') + 1), path: file }));
    res.json(images);
  } catch (err) {
    console.error('Error reading assets directory:', err);
    res.status(500).json({ error: 'Failed to read assets directory' });
  }
});

// Everything the media bin can pull from the project folder, classified by
// extension. /api/project-images stays untouched (older pickers read it).
const MEDIA_EXTENSIONS = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
  video: ['.mp4', '.mov', '.webm', '.m4v'],
  audio: ['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac']
};

app.get('/api/project-media', (req, res) => {
  try {
    const media = assetOrganizer.listMediaFiles(getWorkingRoot())
      .map(file => {
        const ext = path.extname(file).toLowerCase();
        const type = Object.keys(MEDIA_EXTENSIONS).find(kind => MEDIA_EXTENSIONS[kind].includes(ext));
        if (!type) return null;
        let mtime = 0;
        try { mtime = fs.statSync(path.resolve(getWorkingRoot(), file)).mtimeMs; } catch { /* listed anyway */ }
        return { name: file.slice(file.lastIndexOf('/') + 1), path: file, type, mtime };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    res.json(media);
  } catch (err) {
    console.error('Error reading assets directory:', err);
    res.status(500).json({ error: 'Failed to read assets directory' });
  }
});

// --- SHARED PROVIDER MODULE -------------------------------------------------
// One provider dispatch for both modes, in frontend/src/shared/providers/
// (ESM). The server stays CommonJS and consumes it through a cached dynamic
// import; every generation route is already async, so the await costs nothing.
let providersPromise;
const getProviders = () => (providersPromise ??= import('./frontend/src/shared/providers/index.js'));

// Where files belong is decided by the same ESM module the browser build uses,
// reached the same way. Keeping one copy of the layout rules is the point: two
// would drift, and a drifted layout means Clean Files moving files that
// generation then writes somewhere else.
let assetPathsPromise = null;
const getAssetPaths = () => (assetPathsPromise ??= import('./frontend/src/shared/assetPaths.js'));

/**
 * The saved project's state, for resolving a destination given by id.
 *
 * Deliberately the file on disk rather than anything cached: it is only read
 * when a descriptor did not carry its own names, which is the uncommon path.
 */
function readProjectStateForPaths() {
  const active = getActiveProjectPath();
  if (!active) return {};
  return readJsonFile(active, {}).state || {};
}

/** The shared module's host contract, server edition. */
function buildProviderCtx(config, destination = null) {
  return {
    fetch: (url, options) => fetch(url, options),
    credentials: config,
    readAssetDataUrl: async (assetPath) => assetToDataUrl(assetPath),
    uploadPublicUrl: async (assetPath) => {
      const normalized = String(assetPath).replace(/\\/g, '/');
      const absolutePath = path.resolve(getWorkingRoot(), normalized);
      if (!fs.existsSync(absolutePath)) throw new Error(`Input file was not found: ${normalized}`);
      if (!config.falKey) throw new Error('A Fal.ai key is required to upload input files to cloud-accessible storage.');
      return uploadToFalMedia(absolutePath, config.falKey);
    },
    saveRemote: (url, prefix, ext) => downloadFile(url, prefix, ext, destination),
    capabilities: { direct: true }
  };
}

// --- LLM PROXY ENDPOINTS ---
// `imagePaths` is optional and defaults to none, so every existing text-only
// caller keeps sending exactly the request it always sent.
app.post('/api/llm/generate', async (req, res) => {
  const config = readJsonFile(CONFIG_FILE);
  try {
    const { generateText } = await getProviders();
    const text = await generateText(req.body, buildProviderCtx(config));
    res.json({ text });
  } catch (error) {
    console.error('LLM Generation Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET list of models from providers
app.get('/api/llm/models', async (req, res) => {
  const { provider } = req.query;
  const config = readJsonFile(CONFIG_FILE);

  try {
    let models = [];

    if (provider === 'gemini') {
      const apiKey = config.geminiKey;
      if (apiKey) {
        try {
          const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
          if (response.ok) {
            const data = await response.json();
            models = data.models
              .filter(m => m.supportedGenerationMethods.includes('generateContent'))
              .map(m => ({ id: m.name.replace('models/', ''), name: m.displayName }));
          }
        } catch (e) {
          console.error('Failed to fetch Gemini models from API:', e);
        }
      }
      if (models.length === 0) {
        models = [
          { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash (Recommended)' },
          { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
          { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
          { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' }
        ];
      }

    } else if (provider === 'chatgpt') {
      const apiKey = config.openaiKey;
      if (apiKey) {
        try {
          const response = await fetch('https://api.openai.com/v1/models', {
            headers: { 'Authorization': `Bearer ${apiKey}` }
          });
          if (response.ok) {
            const data = await response.json();
            models = data.data
              .filter(m => m.id.startsWith('gpt') || m.id.startsWith('o1'))
              .map(m => ({ id: m.id, name: m.id }));
          }
        } catch (e) {
          console.error('Failed to fetch OpenAI models from API:', e);
        }
      }
      if (models.length === 0) {
        models = [
          { id: 'gpt-4o-mini', name: 'GPT-4o Mini (Recommended)' },
          { id: 'gpt-4o', name: 'GPT-4o' },
          { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
          { id: 'o1-mini', name: 'o1 Mini' }
        ];
      }

    } else if (provider === 'claude') {
      const apiKey = config.claudeKey;
      if (apiKey) {
        try {
          const response = await fetch('https://api.anthropic.com/v1/models', {
            headers: {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01'
            }
          });
          if (response.ok) {
            const data = await response.json();
            models = data.data.map(m => ({ id: m.id, name: m.display_name || m.id }));
          }
        } catch (e) {
          console.error('Failed to fetch Claude models from API:', e);
        }
      }
      if (models.length === 0) {
        models = [
          { id: 'claude-3-5-sonnet-latest', name: 'Claude 3.5 Sonnet (Latest)' },
          { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet (2024-10-22)' },
          { id: 'claude-3-5-haiku-latest', name: 'Claude 3.5 Haiku (Latest)' },
          { id: 'claude-3-opus-latest', name: 'Claude 3 Opus (Latest)' }
        ];
      }
    } else {
      return res.status(400).json({ error: 'Invalid provider' });
    }

    res.json(models);
  } catch (error) {
    console.error('Error fetching models:', error);
    res.status(500).json({ error: error.message });
  }
});

// Read a project asset into a data URL so it can be shipped inline to providers
// that accept base64 image inputs.
function assetToDataUrl(inputPath) {
  // A generation whose input was filed away since the shot recorded it must
  // still find its reference. Same fallback the static route uses.
  const current = assetOrganizer.resolveRecordedPath(getWorkingRoot(), inputPath);
  if (current) inputPath = current;
  const normalizedPath = String(inputPath).replace(/\\/g, '/');
  const assetPath = path.resolve(getWorkingRoot(), normalizedPath);
  if (!fs.existsSync(assetPath)) {
    throw new Error(`Input image was not found: ${normalizedPath}`);
  }
  const ext = path.extname(assetPath).toLowerCase();
  const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
    : ext === '.gif' ? 'image/gif'
    : 'image/png';
  return `data:${mimeType};base64,${fs.readFileSync(assetPath).toString('base64')}`;
}

// --- IMAGE GENERATION PROXY ---
// Dispatch and per-provider request shaping live in the shared module; this
// route is transport only. The HTTP shape is unchanged.
app.post('/api/image/generate', async (req, res) => {
  const config = readJsonFile(CONFIG_FILE);
  try {
    const { generateImage } = await getProviders();
    const filePath = await generateImage(req.body, buildProviderCtx(config, req.body.destination));
    res.json({ filePath });
  } catch (error) {
    console.error('Image Generation Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- VIDEO GENERATION PROXY ---
app.post('/api/video/generate', async (req, res) => {
  const config = readJsonFile(CONFIG_FILE);
  try {
    const { generateVideo } = await getProviders();
    const filePath = await generateVideo(req.body, buildProviderCtx(config, req.body.destination));
    res.json({ filePath });
  } catch (error) {
    console.error('Video Generation Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// What Fal storage should serve a file as. It used to be png-or-jpeg, which
// was harmless while only stills were uploaded — but audio and video go
// through here too now, and a host that reads the Content-Type (Atlas does,
// when it fetches a registered asset) will refuse an mp3 labelled as a jpeg.
const FAL_UPLOAD_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac'
};

// Helper: Upload file to Fal.media so external models can access it
async function uploadToFalMedia(filePath, falKey) {
  const fileBuffer = fs.readFileSync(filePath);
  const mimeType = FAL_UPLOAD_MIME[path.extname(filePath).toLowerCase()] || 'image/jpeg';

  // Ask Fal.ai for an upload URL
  const initRes = await fetch('https://rest.fal.ai/storage/upload/initiate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Key ${falKey}`
    },
    body: JSON.stringify({
      file_name: path.basename(filePath),
      content_type: mimeType
    })
  });

  if (!initRes.ok) {
    throw new Error(`Failed to initiate Fal media upload: ${await initRes.text()}`);
  }

  const { upload_url, file_url } = await initRes.json();

  // Upload actual file binary
  const uploadRes = await fetch(upload_url, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType
    },
    body: fileBuffer
  });

  if (!uploadRes.ok) {
    throw new Error(`Failed to upload file content to Fal media storage: ${await uploadRes.text()}`);
  }

  return file_url;
}

// --- LIP SYNC PROXY (FAL.AI SYNC-LIPSYNC) ---
app.post('/api/lipsync', async (req, res) => {
  const { videoPath, audioPath } = req.body;
  const config = readJsonFile(CONFIG_FILE);

  if (!config.falKey) {
    return res.status(400).json({ error: 'Fal.ai API key is required for Lip-Sync.' });
  }
  if (!videoPath || !audioPath) {
    return res.status(400).json({ error: 'Both videoPath and audioPath are required.' });
  }

  try {
    const { runLipSync } = await getProviders();
    const filePath = await runLipSync({ videoPath, audioPath }, buildProviderCtx(config));
    res.json({ filePath });
  } catch (error) {
    console.error('Lip Sync API Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- FFMPEG VIDEO CONCATENATION ENDPOINT ---

function runFfmpeg(args, label) {
  return new Promise((resolve, reject) => {
    const command = `ffmpeg -y ${args}`;
    exec(command, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`FFmpeg (${label}) failed:`, stderr?.slice(-1500));
        reject(new Error(`${label} failed. ${stderr ? stderr.trim().split('\n').slice(-3).join(' ') : error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

// --- CHECKPOINT ENDPOINTS ---------------------------------------------------

app.get('/api/checkpoints', (req, res) => {
  try {
    res.json({ checkpoints: listCheckpoints() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/checkpoints', (req, res) => {
  const { name, note, state } = req.body || {};
  if (!state || typeof state !== 'object') {
    return res.status(400).json({ error: 'No state to save.' });
  }

  try {
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

    const file = path.join(getCheckpointsDir(), `${id}.json`);
    if (!writeJsonFile(file, record)) throw new Error('Could not write the checkpoint file.');

    const { state: _omit, ...meta } = record;
    res.json({ checkpoint: meta });
  } catch (error) {
    console.error('Checkpoint save failed:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/checkpoints/:id', (req, res) => {
  const file = path.join(getCheckpointsDir(false), `${path.basename(req.params.id)}.json`);
  const record = fs.existsSync(file) ? readCheckpointFile(file) : null;
  if (!record) return res.status(404).json({ error: 'No such checkpoint.' });
  res.json({ checkpoint: record });
});

app.delete('/api/checkpoints/:id', (req, res) => {
  const file = path.join(getCheckpointsDir(false), `${path.basename(req.params.id)}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'No such checkpoint.' });
  try {
    fs.rmSync(file);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- SOURCE MEASUREMENT -----------------------------------------------------

/**
 * Measure assets for the editor.
 *
 * The timeline needs a real duration before it can clamp a trim to the end of
 * its source, and the project needs frame sizes before it can default its
 * resolution to whatever most of the footage already is. Generated assets are
 * written once under timestamped names, so the caller caches these results
 * forever rather than asking twice.
 */
const PROBE_IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

function parseFrameRate(rate) {
  if (!rate || typeof rate !== 'string') return null;
  const [numerator, denominator] = rate.split('/').map(Number);
  if (!numerator || !denominator) return null;
  const fps = numerator / denominator;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

function runFfprobe(filePath) {
  return new Promise((resolve, reject) => {
    const command = `ffprobe -v error -print_format json -show_format -show_streams "${filePath}"`;
    exec(command, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(/not recognized|ENOENT/i.test(stderr || error.message)
          ? 'FFprobe is not installed or not on PATH.'
          : (stderr || error.message).trim().split('\n').slice(-2).join(' ')));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('FFprobe returned output that could not be parsed.'));
      }
    });
  });
}

// --- PREVIEW PROXY CACHE ----------------------------------------------------
//
// See proxyCache.js. The server's job here is small: resolve the settings and
// the source paths, hand the cache the order the editor wants things built in,
// and serve the results.

const previewCache = new ProxyCache({
  resolveSettings: () => readCacheSettings(readJsonFile(CONFIG_FILE)),
  resolveSource: (relative) => {
    // Only ever inside the project. A path that climbs out of it is either a
    // bug or an attempt to transcode something we were not asked to.
    const root = getWorkingRoot();
    const absolute = path.resolve(root, relative);
    return absolute.startsWith(path.resolve(root)) ? absolute : null;
  },
  probeDuration: async (absolute) => {
    const probe = await runFfprobe(absolute);
    return Number(probe.format?.duration) || 0;
  }
});

// Proxies are immutable — the source's size and mtime are in the filename — so
// the browser may keep them for as long as it likes.
app.use('/cache', (req, res, next) => {
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  express.static(readCacheSettings(readJsonFile(CONFIG_FILE)).folder)(req, res, next);
});

app.get('/api/cache/settings', (req, res) => {
  const settings = readCacheSettings(readJsonFile(CONFIG_FILE));
  res.json({ ...settings, defaultFolder: defaultWorkFolder(), usage: previewCache.usage() });
});

app.post('/api/cache/settings', (req, res) => {
  const config = readJsonFile(CONFIG_FILE);
  const next = { ...(config.previewCache || {}) };
  if (req.body.enabled !== undefined) next.enabled = Boolean(req.body.enabled);
  if (typeof req.body.folder === 'string') next.folder = req.body.folder.trim();
  if (req.body.height !== undefined) next.height = Number(req.body.height);

  const settings = readCacheSettings({ previewCache: next });
  try {
    if (!fs.existsSync(settings.folder)) fs.mkdirSync(settings.folder, { recursive: true });
    // Prove it is writable now rather than failing silently on every encode.
    const probe = path.join(settings.folder, '.mm-write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (error) {
    return res.status(400).json({ error: `That work folder cannot be written to: ${error.message}` });
  }

  // Changing where the proxies live means nothing in flight is going to the
  // right place any more.
  previewCache.cancelAll();
  config.previewCache = next;
  writeJsonFile(CONFIG_FILE, config);
  res.json({ ...settings, defaultFolder: defaultWorkFolder(), usage: previewCache.usage() });
});

app.post('/api/cache/status', (req, res) => {
  const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
  const results = {};
  for (const relative of paths) {
    if (typeof relative === 'string' && relative) results[relative] = previewCache.statusOf(relative);
  }
  res.json({ results, settings: readCacheSettings(readJsonFile(CONFIG_FILE)) });
});

/** `paths` is a priority order, not a set: nearest the playhead first. */
app.post('/api/cache/build', (req, res) => {
  const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
  const settings = readCacheSettings(readJsonFile(CONFIG_FILE));
  if (!settings.enabled) return res.json({ queued: 0, enabled: false });
  res.json({ queued: previewCache.request(paths), enabled: true });
});

app.post('/api/cache/clear', (req, res) => {
  res.json(previewCache.clear());
});

app.post('/api/probe', async (req, res) => {
  const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
  if (paths.length === 0) return res.json({ results: {} });

  const root = getWorkingRoot();
  const results = {};

  for (const relative of paths) {
    if (typeof relative !== 'string' || !relative) continue;
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) {
      results[relative] = { error: 'File not found.' };
      continue;
    }

    try {
      const probe = await runFfprobe(absolute);
      const streams = Array.isArray(probe.streams) ? probe.streams : [];
      const video = streams.find(s => s.codec_type === 'video') || null;
      const audio = streams.find(s => s.codec_type === 'audio') || null;
      const isImage = PROBE_IMAGE_EXT.test(relative);
      // Stills report a nominal duration; the timeline decides how long to hold
      // them, so reporting null keeps that decision in one place.
      const duration = isImage ? null : Number(probe.format?.duration) || null;

      results[relative] = {
        duration,
        width: video?.width || null,
        height: video?.height || null,
        fps: isImage ? null : parseFrameRate(video?.avg_frame_rate || video?.r_frame_rate),
        hasAudio: Boolean(audio),
        isImage
      };
    } catch (error) {
      results[relative] = { error: error.message };
    }
  }

  res.json({ results });
});

/** Everything in the mix runs at one layout so amix and concat cannot object. */
const SEGMENT_AUDIO_FORMAT = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

/** What a source is made of, as far as the mix is concerned. */
async function probeForMix(filePath) {
  try {
    const probe = await runFfprobe(filePath);
    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    return {
      hasAudio: streams.some(stream => stream.codec_type === 'audio'),
      duration: Number(probe.format?.duration) || null
    };
  } catch {
    // A probe failure is not a reason to refuse the compile: without a length
    // the silent bed simply runs long and -shortest ends the segment instead.
    return { hasAudio: false, duration: null };
  }
}

/**
 * Concatenate a timeline into one file.
 *
 * `items` is an ordered list of { video?, image?, audio?, duration? }. A shot
 * with no video contributes its still image held for `duration` seconds, so a
 * partly generated edit still plays end to end as an animatic.
 *
 * Every segment is re-encoded to identical parameters first. The concat demuxer
 * with `-c copy` only works when inputs already agree on codec, resolution and
 * timebase, which generated clips and stills never do.
 *
 * Sound follows the same rule as picture: whatever the shot actually has ends up
 * in the master. That is the clip's own soundtrack — models that generate audio
 * used to have it thrown away here — plus the shot's own audio file if it has
 * one. Both are mixed, which is what the editor does too; a shot whose clip is
 * already a lip-synced render therefore doubles its dialogue, and wants its
 * audio file detached rather than compiled twice.
 */
app.post('/api/concatenate', async (req, res) => {
  const { videoPaths, items, width = 1280, height = 720, fps = 24, placeholderSeconds = 5 } = req.body;

  // Accept the legacy videoPaths array as well as the richer items list.
  const timeline = Array.isArray(items) && items.length > 0
    ? items
    : (Array.isArray(videoPaths) ? videoPaths.map(v => ({ video: v })) : []);

  if (timeline.length === 0) {
    return res.status(400).json({ error: 'Nothing to concatenate.' });
  }

  const root = getWorkingRoot();
  const resolve = (relative) => {
    if (!relative) return null;
    const absolute = path.join(root, relative);
    return fs.existsSync(absolute) ? absolute : null;
  };

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm_concat_'));
  const segments = [];
  let videoCount = 0;
  let stillCount = 0;
  let audioCount = 0;
  const skipped = [];
  const missingAudio = [];

  try {
    // Normalise every entry to one common encode.
    const videoChain = `scale=${width}:${height}:force_original_aspect_ratio=decrease,`
      + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`;
    const encode = '-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p '
      + '-c:a aac -b:a 192k -ar 48000 -ac 2';
    const seconds = (value) => Math.round(value * 1000) / 1000;

    for (let index = 0; index < timeline.length; index++) {
      const entry = timeline[index] || {};
      const videoPath = resolve(entry.video);
      const imagePath = resolve(entry.image);
      const segmentPath = path.join(workDir, `seg_${String(index).padStart(3, '0')}.mp4`);

      if (!videoPath && !imagePath) {
        skipped.push(entry.name || `#${index + 1}`);
        continue;
      }

      // The shot's own audio file — dialogue, narration, a scratch track. A path
      // that no longer resolves is worth saying out loud rather than compiling
      // a silent shot and leaving you to wonder.
      const audioPath = entry.audio ? resolve(entry.audio) : null;
      if (entry.audio && !audioPath) missingAudio.push(entry.name || `#${index + 1}`);

      const inputs = [];
      const sounds = [];   // input indices that carry real sound
      let length = null;

      if (videoPath) {
        const probed = await probeForMix(videoPath);
        length = probed.duration;
        inputs.push(`-i "${videoPath}"`);
        if (probed.hasAudio) sounds.push(inputs.length - 1);
        videoCount++;
      } else {
        length = Number(entry.duration) > 0 ? Number(entry.duration) : placeholderSeconds;
        inputs.push(`-loop 1 -t ${seconds(length)} -i "${imagePath}"`);
        stillCount++;
      }

      if (audioPath) {
        inputs.push(`-i "${audioPath}"`);
        sounds.push(inputs.length - 1);
      }

      // A silent bed under every segment. The concat demuxer copies streams
      // rather than re-encoding them, so a segment with no sound still has to
      // carry a track of exactly the same shape as one that does.
      const bedIndex = inputs.length;
      inputs.push(`-f lavfi ${length ? `-t ${seconds(length)} ` : ''}`
        + '-i anullsrc=channel_layout=stereo:sample_rate=48000');

      const chains = [`[0:v]${videoChain}[v]`];
      const mixed = sounds.map((inputIndex, slot) => {
        chains.push(`[${inputIndex}:a]asetpts=PTS-STARTPTS,${SEGMENT_AUDIO_FORMAT}[sa${slot}]`);
        return `[sa${slot}]`;
      });
      chains.push(`[${bedIndex}:a]${SEGMENT_AUDIO_FORMAT}[bed]`);
      mixed.push('[bed]');
      if (mixed.length === 1) {
        chains.push(`${mixed[0]}anull[a]`);
      } else {
        // normalize=0 matters: left on, amix divides every input by the number
        // of them, so the silent bed alone would halve the shot.
        chains.push(`${mixed.join('')}amix=inputs=${mixed.length}:normalize=0:dropout_transition=0[a]`);
      }

      if (sounds.length > 0) audioCount++;

      // -shortest ends the segment with its picture: the bed is only as long as
      // the probe said, and a shot audio file longer than its shot is cut there
      // rather than pushing everything after it out of sync.
      await runFfmpeg(
        `${inputs.join(' ')} -filter_complex "${chains.join(';')}" `
        + `-map "[v]" -map "[a]" ${encode} -shortest "${segmentPath}"`,
        `segment ${index + 1} (${videoPath ? 'video' : 'still'})`
      );
      segments.push(segmentPath);
    }

    if (segments.length === 0) {
      throw new Error('No shot had a video or an image to use.');
    }

    const listFilePath = path.join(workDir, 'concat_list.txt');
    fs.writeFileSync(listFilePath, segments.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'), 'utf8');

    const outputFilename = `master_${Date.now()}.mp4`;
    const outputFilePath = path.join(getAssetsDir(), outputFilename);
    await runFfmpeg(`-f concat -safe 0 -i "${listFilePath}" -c copy "${outputFilePath}"`, 'concatenation');

    res.json({
      filePath: `assets/${outputFilename}`,
      videoCount,
      stillCount,
      audioCount,
      missingAudio,
      skipped
    });
  } catch (error) {
    console.error('Concatenation error:', error);
    res.status(500).json({
      error: /not recognized|ENOENT/i.test(error.message)
        ? 'FFmpeg is not installed or not on PATH.'
        : error.message
    });
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// --- PROJECT EXPORT ---------------------------------------------------------

/**
 * Write the project out as a folder a person can read.
 *
 * The working store is content-addressed on purpose — `img_1738…png` never
 * collides and never needs renaming — and that is exactly what makes it opaque
 * to anyone opening the folder later. This copies rather than moves, so the
 * project keeps working while the export is something you can zip and send.
 *
 * `export/` is wiped first: a stale file from a deleted shot sitting in an
 * export is worse than no export, because nothing in it says how old it is.
 */
app.post('/api/export', async (req, res) => {
  try {
    const root = getWorkingRoot();
    const exportRoot = path.join(root, 'export');

    // A project file wraps its state; the legacy loose file is the state.
    const activePath = getActiveProjectPath();
    const state = activePath
      ? (readProjectFile(activePath).state || {})
      : readJsonFile(getStateFilePath(), {});

    // The listing drops `state` to stay cheap; an export wants the whole thing.
    const checkpointsDir = getCheckpointsDir(false);
    const checkpoints = fs.existsSync(checkpointsDir)
      ? fs.readdirSync(checkpointsDir)
        .filter(name => name.endsWith('.json'))
        .map(name => readCheckpointFile(path.join(checkpointsDir, name)))
        .filter(Boolean)
      : [];

    const plan = buildExportPlan({
      scenes: state.scenes || [],
      assetLibrary: state.assetLibrary || [],
      referenceImages: state.referenceImages || [],
      checkpoints
    });

    fs.rmSync(exportRoot, { recursive: true, force: true });
    fs.mkdirSync(exportRoot, { recursive: true });

    const ensureDir = (relative) => {
      const dir = path.dirname(path.join(exportRoot, relative));
      fs.mkdirSync(dir, { recursive: true });
    };

    // A file referenced by the project but missing from disk is reported rather
    // than aborting the run — one lost still should not cost you the export.
    const missing = [];
    for (const { from, to } of plan.copies) {
      const source = path.join(root, from);
      if (!fs.existsSync(source)) { missing.push(from); continue; }
      ensureDir(to);
      fs.copyFileSync(source, path.join(exportRoot, to));
    }

    for (const { to, contents } of plan.writes) {
      ensureDir(to);
      fs.writeFileSync(path.join(exportRoot, to), contents, 'utf8');
    }

    // The project file itself, so the export can be re-opened rather than only
    // read.
    fs.writeFileSync(path.join(exportRoot, 'project.json'), JSON.stringify(state, null, 2), 'utf8');

    res.json({
      folder: 'export',
      files: plan.copies.length - missing.length,
      sheets: plan.writes.length,
      missing
    });
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- WATERMARK PASS ---------------------------------------------------------

/**
 * Stamp a moving mark onto a finished video.
 *
 * A second pass on purpose. Marking is a decision made after watching the cut,
 * and re-encoding every shot to change the mark — or to produce a clean master
 * beside a marked one — would be absurd. The source is left untouched and the
 * result lands beside it as its own file.
 */
app.post('/api/watermark', async (req, res) => {
  const { videoPath, markPath, motion = 'drift', seed, hold, scale, periodX, periodY } = req.body || {};

  const root = getWorkingRoot();
  const resolve = (relative) => {
    if (!relative) return null;
    const absolute = path.join(root, relative);
    return fs.existsSync(absolute) ? absolute : null;
  };

  const sourcePath = resolve(videoPath);
  const watermarkPath = resolve(markPath);
  if (!sourcePath) return res.status(400).json({ error: 'No video to watermark — concatenate one first.' });
  if (!watermarkPath) return res.status(400).json({ error: 'No watermark image found at that path.' });

  try {
    // The length decides how many positions jump mode lays out, and the frame
    // size decides how big the mark is drawn — both come from the file rather
    // than being assumed. A probe failure only stops the render for jump mode,
    // which cannot proceed without a length.
    let duration = 60;
    let frameWidth = null;
    let frameHeight = null;
    try {
      const probed = await runFfprobe(sourcePath);
      const seconds = Number(probed?.format?.duration);
      if (Number.isFinite(seconds) && seconds > 0) duration = seconds;
      const video = (probed?.streams || []).find(stream => stream.codec_type === 'video');
      if (Number(video?.width) > 0 && Number(video?.height) > 0) {
        frameWidth = Number(video.width);
        frameHeight = Number(video.height);
      }
    } catch (error) {
      if (motion === 'jump') throw error;
    }

    const graph = buildWatermarkGraph({
      motion,
      duration,
      frameWidth,
      frameHeight,
      // A stamp that cannot be reproduced is a stamp you cannot re-cut around,
      // so the seed travels back with the response.
      seed: Number.isFinite(Number(seed)) ? Number(seed) : Date.now() % 100000,
      ...(Number(hold) > 0 ? { hold: Number(hold) } : {}),
      ...(Number(scale) > 0 ? { scale: Number(scale) } : {}),
      ...(Number(periodX) > 0 ? { periodX: Number(periodX) } : {}),
      ...(Number(periodY) > 0 ? { periodY: Number(periodY) } : {})
    });

    const outputFilename = `marked_${Date.now()}.mp4`;
    const outputFilePath = path.join(getAssetsDir(), outputFilename);

    // The mark is a still, so it loops; -shortest in the blend ends the output
    // with the film rather than running forever. Audio is copied untouched —
    // nothing here has any business re-encoding it.
    await runFfmpeg(
      `-i "${sourcePath}" -loop 1 -i "${watermarkPath}" `
      + `-filter_complex "${graph}" -map "[v]" -map 0:a? `
      + `-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a copy -shortest "${outputFilePath}"`,
      'watermark'
    );

    res.json({ filePath: `assets/${outputFilename}` });
  } catch (error) {
    console.error('Watermark error:', error);
    res.status(500).json({
      error: /not recognized|ENOENT/i.test(error.message)
        ? 'FFmpeg is not installed or not on PATH.'
        : error.message
    });
  }
});

// --- TIMELINE RENDER --------------------------------------------------------

/**
 * Render an edit.
 *
 * Unlike /api/concatenate this takes the editor's resolved timeline — trims,
 * transitions, levels and all — and encodes it in a single pass rather than
 * normalising every shot to its own file first.
 *
 * It answers immediately with a job id and works in the background: a couple of
 * minutes of footage takes long enough that holding the request open would just
 * be a timeout waiting to happen, and ffmpeg's own progress output gives the
 * editor something real to show meanwhile.
 */
const renderJobs = new Map();
const RENDER_JOB_TTL_MS = 60 * 60 * 1000;

function pruneRenderJobs() {
  const now = Date.now();
  for (const [id, job] of renderJobs) {
    if (job.state !== 'running' && now - job.finishedAt > RENDER_JOB_TTL_MS) {
      renderJobs.delete(id);
    }
  }
}

function planDuration(plan) {
  const ends = [
    ...(plan.video || []).map(clip => Number(clip.end) || 0),
    ...(plan.audio || []).map(clip => (Number(clip.start) || 0) + (Number(clip.length) || 0))
  ];
  return ends.length ? Math.max(...ends) : 0;
}

app.post('/api/render', (req, res) => {
  pruneRenderJobs();

  const plan = req.body || {};
  if (!Array.isArray(plan.video) || plan.video.length === 0) {
    return res.status(400).json({ error: 'Nothing on the timeline to render.' });
  }

  const root = getWorkingRoot();
  const missing = [];
  const resolvePath = (relative) => {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) missing.push(relative);
    return absolute;
  };

  const outputFilename = `edit_${Date.now()}.mp4`;
  const outputFilePath = path.join(getAssetsDir(), outputFilename);

  let graph;
  try {
    graph = buildRenderGraph(plan, {
      resolvePath,
      outputPath: outputFilePath,
      encoder: plan.encoder === 'h264_nvenc' ? 'h264_nvenc' : 'libx264'
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  if (missing.length > 0) {
    return res.status(400).json({
      error: `Missing media: ${[...new Set(missing)].slice(0, 5).join(', ')}`
    });
  }

  // The graph goes in a file: a long edit produces one far past the 8191
  // character limit Windows puts on a command line.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm_render_'));
  const scriptPath = path.join(workDir, 'graph.txt');
  fs.writeFileSync(scriptPath, graph.filterScript, 'utf8');

  const args = ['-y', '-hide_banner', '-nostats', '-progress', 'pipe:1',
    ...graph.args.map(arg => (arg === '__FILTER_SCRIPT__' ? scriptPath : arg))];

  const jobId = `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const job = {
    id: jobId,
    state: 'running',
    progress: 0,
    duration: planDuration(plan),
    filePath: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null
  };
  renderJobs.set(jobId, job);

  let stderrTail = '';
  let child;
  try {
    // No shell: the argument array sidesteps quoting entirely, which matters
    // for paths with spaces and for the filter graph.
    child = spawn('ffmpeg', args, { windowsHide: true });
  } catch (error) {
    job.state = 'error';
    job.error = 'FFmpeg could not be started. Is it installed and on PATH?';
    job.finishedAt = Date.now();
    return res.status(500).json({ error: job.error });
  }

  child.stdout.on('data', (chunk) => {
    // -progress emits key=value lines; out_time_us is the one worth reading.
    for (const line of String(chunk).split('\n')) {
      const match = /^out_time_us=(\d+)/.exec(line.trim());
      if (match && job.duration > 0) {
        job.progress = Math.min(1, (Number(match[1]) / 1e6) / job.duration);
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
  });

  child.on('error', (error) => {
    job.state = 'error';
    job.error = /ENOENT/i.test(error.message)
      ? 'FFmpeg is not installed or not on PATH.'
      : error.message;
    job.finishedAt = Date.now();
  });

  child.on('close', (code) => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
    if (job.state === 'error') return;

    if (code === 0) {
      job.state = 'done';
      job.progress = 1;
      job.filePath = `assets/${outputFilename}`;
    } else {
      job.state = 'error';
      job.error = stderrTail.trim().split('\n').slice(-4).join(' ') || `FFmpeg exited with code ${code}.`;
      console.error('Render failed:', stderrTail.slice(-1500));
    }
    job.finishedAt = Date.now();
  });

  res.json({ jobId, duration: job.duration, inputs: graph.inputCount });
});

app.get('/api/render/:jobId', (req, res) => {
  const job = renderJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'No such render job.' });
  res.json({
    state: job.state,
    progress: job.progress,
    duration: job.duration,
    filePath: job.filePath,
    error: job.error
  });
});

// --- NATIVE WINDOWS FILE / FOLDER PICKER ---
// Runs a WinForms dialog through PowerShell. Needs -STA (the dialogs require a
// single-threaded apartment) and a TopMost owner form, otherwise the dialog can
// open behind the browser and look like a hang. The script goes to a temp file
// so we avoid nested-quote escaping through cmd.
app.post('/api/project/browse', (req, res) => {
  const { mode = 'open', defaultName = '' } = req.body;

  if (process.platform !== 'win32') {
    return res.status(501).json({ error: 'The native picker is Windows-only. Paste a path instead.' });
  }

  const scripts = {
    open: `
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Open MovieMaker Project'
$dialog.Filter = 'MovieMaker Project (*.mmproj.json)|*.mmproj.json|JSON (*.json)|*.json'
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.FileName }`,
    saveAs: `
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Title = 'Save MovieMaker Project As'
$dialog.Filter = 'MovieMaker Project (*.mmproj.json)|*.mmproj.json'
$dialog.FileName = '${String(defaultName).replace(/'/g, "''")}'
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.FileName }`,
    folder: `
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '${String(defaultName || 'Choose the folder to create the project in').replace(/'/g, "''")}'
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }`
  };

  const body = scripts[mode];
  if (!body) return res.status(400).json({ error: `Unknown browse mode: ${mode}` });

  // The dialog is modal to $owner, so $owner has to be a *shown* top-most
  // window. A Form that is only constructed is never activated and never gets
  // a taskbar button, and neither does a dialog owned by it — so the picker
  // opens behind the browser, invisible, and just sits there until the timeout.
  // It is parked 1x1 at the middle of the work area: effectively invisible, but
  // real, and centred so owner-centred dialogs land on screen rather than off it.
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace MM -Name Fg -MemberDefinition '
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);'

$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$owner = New-Object System.Windows.Forms.Form
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Location = New-Object System.Drawing.Point(
  [int]($area.Left + $area.Width / 2), [int]($area.Top + $area.Height / 2))
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.Show()
$owner.Activate()
[void][MM.Fg]::SetForegroundWindow($owner.Handle)
[System.Windows.Forms.Application]::DoEvents()
${body}
$owner.Close()
$owner.Dispose()
`;

  const scriptPath = path.join(os.tmpdir(), `mm_browse_${Date.now()}.ps1`);
  try {
    fs.writeFileSync(scriptPath, script, 'utf8');
  } catch (error) {
    return res.status(500).json({ error: `Could not stage picker script: ${error.message}` });
  }

  // execFile, not exec: exec goes through cmd.exe, so the timeout kills the
  // shell and leaves the PowerShell holding the dialog running forever. One
  // stranded invisible dialog per click adds up fast.
  execFile(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', scriptPath],
    { timeout: 5 * 60 * 1000, windowsHide: true },
    (error, stdout, stderr) => {
      try { fs.unlinkSync(scriptPath); } catch { /* best effort */ }

      if (error && error.killed) {
        return res.status(504).json({ error: 'The file dialog timed out.' });
      }
      if (error) {
        console.error('Picker error:', stderr || error);
        return res.status(500).json({ error: 'Could not open the file dialog. Paste a path instead.' });
      }

      const selected = String(stdout).trim();
      // Empty output means the user pressed Cancel — not an error.
      res.json({ path: selected || null, cancelled: !selected });
    }
  );
});

// --- EXPOSE FILE IN WINDOWS EXPLORER ---
app.post('/api/reveal', (req, res) => {
  const { filePath } = req.body;
  if (!filePath) {
    return res.status(400).json({ error: 'filePath is required' });
  }

  try {
    const currentWorkingRoot = getWorkingRoot();
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(path.join(currentWorkingRoot, filePath));

    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'File does not exist on disk' });
    }

    // Use child_process.exec to reliably launch explorer.exe in active user session
    const { exec } = require('child_process');
    const windowsPath = absolutePath.replace(/\//g, '\\');
    console.log(`Running reveal: explorer.exe /select,"${windowsPath}"`);
    
    exec(`explorer.exe /select,"${windowsPath}"`, (err) => {
      // Ignore exit code errors from explorer.exe since it returns non-zero even on success
      if (err) {
        console.log('Explorer reveal completed.');
      }
    });

    res.json({ message: 'Exposed file in Explorer' });
  } catch (error) {
    console.error('Error revealing file:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`MovieMaker backend running at http://localhost:${PORT}`);
});
