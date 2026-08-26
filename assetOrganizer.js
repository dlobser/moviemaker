// Doing what `assetPaths` decides: walking the media root, moving files into
// the tree, and finding a file whose recorded path is out of date.
//
// The split is deliberate. `frontend/src/shared/assetPaths.js` is pure — it
// works out where everything belongs and is exhaustively testable without a
// disk. This module is the half that can fail: directories that do not exist,
// names that collide, a rename that dies halfway through a thousand files.
//
// Three rules govern everything here:
//
//   * Nothing leaves the media root. Every source and destination is resolved
//     and checked against it before a single rename happens, because the input
//     is project state and project state can say anything.
//   * A move that would land on an occupied name goes through a staging folder
//     first. Two files swapping places is rare, and losing one to a blind
//     rename is unrecoverable.
//   * A recorded path that no longer resolves is looked up by filename before
//     being called missing. Checkpoints and auto-backups hold state blobs that
//     point at where files used to be, and reorganising the tree must not turn
//     every one of them into a project full of broken thumbnails.

const fs = require('fs');
const path = require('path');

const MEDIA_ROOT = 'assets';
const STAGING_DIR = '.organize-staging';
const LEDGER_FILE = '.organize-ledger.json';

/** The absolute media root for a project working directory. */
function mediaRoot(workingRoot) {
  return path.join(workingRoot, MEDIA_ROOT);
}

/** A project-relative 'assets/...' path as an absolute one, or null if it escapes. */
function resolveInsideRoot(workingRoot, relativePath) {
  const normalized = String(relativePath || '').split('\\').join('/');
  if (!normalized.startsWith(`${MEDIA_ROOT}/`)) return null;
  const absolute = path.resolve(workingRoot, normalized);
  const root = path.resolve(mediaRoot(workingRoot));
  // `startsWith` on the root alone would accept a sibling named `assets-old`.
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return null;
  return absolute;
}

/**
 * Every file under the media root, as project-relative paths.
 *
 * The staging folder is skipped: it only ever holds files mid-move, and
 * offering them as strays would invite a second run to file the debris of the
 * first one.
 */
function listMediaFiles(workingRoot) {
  const root = mediaRoot(workingRoot);
  const found = [];
  if (!fs.existsSync(root)) return found;

  const walk = (absoluteDir, relativeDir) => {
    let entries;
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      return; // an unreadable folder is not worth failing the whole scan over
    }
    for (const entry of entries) {
      if (entry.name === STAGING_DIR || entry.name === LEDGER_FILE) continue;
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(absoluteDir, entry.name), relative);
      } else if (entry.isFile()) {
        found.push(`${MEDIA_ROOT}/${relative}`);
      }
    }
  };
  walk(root, '');
  return found;
}

// --- finding a file that has moved ------------------------------------------
//
// Reorganising renames as well as moves, so there is no clue left in the file
// itself about what it used to be called. Every checkpoint, auto-backup and
// exported copy of the project holds paths recorded before the move, and
// rewriting all of them was never going to be reliable — an auto-backup from
// three weeks ago is not something a Clean Files run should be editing.
//
// So the move leaves a forwarding address. `assets/.organize-ledger.json` maps
// every path that has ever moved to where it went. It lives inside the media
// root so it travels with the project when the folder is zipped or copied, and
// it is compressed on every write: when b moves on to c, the entry pointing a
// at b is repointed at c rather than growing a chain to walk.
//
// The basename index behind it is the second line of defence, for a file that
// moved without being renamed — an older layout, or a hand-drag in Explorer.
// Where a name is ambiguous it keeps nothing rather than guessing: showing the
// wrong picture is worse than showing a missing one, because only one of the
// two looks like a problem.

function ledgerPath(workingRoot) {
  return path.join(mediaRoot(workingRoot), LEDGER_FILE);
}

/** Every forwarding address recorded so far, as a plain object. */
function readLedger(workingRoot) {
  try {
    const file = ledgerPath(workingRoot);
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // a corrupt ledger costs a fallback, never a failed run
  }
}

/** Record where these files went, repointing anything that pointed at them. */
function appendLedger(workingRoot, moves = []) {
  if (moves.length === 0) return;
  const ledger = readLedger(workingRoot);
  const destinations = new Map(moves.map(move => [move.from, move.to]));

  Object.keys(ledger).forEach(from => {
    const movedOn = destinations.get(ledger[from]);
    if (movedOn) ledger[from] = movedOn;
  });
  moves.forEach(move => { ledger[move.from] = move.to; });
  // A file that has come back to its own name needs no forwarding address.
  Object.keys(ledger).forEach(from => { if (ledger[from] === from) delete ledger[from]; });

  try {
    fs.mkdirSync(mediaRoot(workingRoot), { recursive: true });
    fs.writeFileSync(ledgerPath(workingRoot), JSON.stringify(ledger, null, 2), 'utf8');
  } catch (error) {
    console.error('Could not write the move ledger:', error.message);
  }
}

const indexCache = new Map();

function basenameIndex(workingRoot) {
  const key = path.resolve(workingRoot);
  if (indexCache.has(key)) return indexCache.get(key);

  const index = new Map();
  const ambiguous = new Set();
  for (const relative of listMediaFiles(workingRoot)) {
    const name = relative.slice(relative.lastIndexOf('/') + 1);
    if (index.has(name)) ambiguous.add(name);
    index.set(name, relative);
  }
  ambiguous.forEach(name => index.delete(name));
  indexCache.set(key, index);
  return index;
}

/** Forget the cached index — call after anything moves, renames or deletes. */
function invalidateIndex(workingRoot) {
  if (workingRoot === undefined) indexCache.clear();
  else indexCache.delete(path.resolve(workingRoot));
}

/**
 * The project-relative path a recorded path actually lives at today.
 *
 * Returns the recorded path when the file is where it says it is, the current
 * path when it has moved and its name is unambiguous, and null when it is
 * genuinely gone.
 */
function resolveRecordedPath(workingRoot, recordedPath) {
  const absolute = resolveInsideRoot(workingRoot, recordedPath);
  if (!absolute) return null;
  const normalized = String(recordedPath).split('\\').join('/');
  if (fs.existsSync(absolute)) return normalized;

  // The forwarding address, for a file that was renamed as well as moved.
  const forwarded = readLedger(workingRoot)[normalized];
  if (forwarded) {
    const target = resolveInsideRoot(workingRoot, forwarded);
    if (target && fs.existsSync(target)) return forwarded;
  }

  // And behind that, a file that moved without ever being renamed.
  const name = path.basename(absolute);
  const found = basenameIndex(workingRoot).get(name);
  return found && found !== normalized ? found : null;
}

// --- moving ------------------------------------------------------------------

function ensureDir(absoluteDir) {
  if (!fs.existsSync(absoluteDir)) fs.mkdirSync(absoluteDir, { recursive: true });
}

/**
 * Apply a plan's moves, reporting what happened rather than throwing.
 *
 * A rename that fails — a file open in another program is the usual reason on
 * Windows — leaves that one file where it was and is reported. The state
 * remapping the caller does afterwards is driven by `moved`, never by the plan,
 * so a file that did not move keeps a path that still points at it.
 */
function applyMoves(workingRoot, moves = []) {
  const moved = [];
  const failed = [];
  const staged = [];
  const stagingRoot = path.join(mediaRoot(workingRoot), STAGING_DIR);

  const prepared = [];
  moves.forEach(move => {
    const from = resolveInsideRoot(workingRoot, move.from);
    const to = resolveInsideRoot(workingRoot, move.to);
    if (!from || !to) {
      failed.push({ ...move, error: 'Path is outside the media root.' });
      return;
    }
    if (from === to) return;
    if (!fs.existsSync(from)) {
      failed.push({ ...move, error: 'Source file no longer exists.' });
      return;
    }
    prepared.push({ move, from, to });
  });

  // Anything whose destination is currently occupied goes to staging first.
  // Without it, two files exchanging names lose one of themselves.
  prepared.forEach(entry => {
    if (!fs.existsSync(entry.to)) return;
    try {
      ensureDir(stagingRoot);
      const parked = path.join(stagingRoot, `${staged.length}_${path.basename(entry.from)}`);
      fs.renameSync(entry.from, parked);
      staged.push({ ...entry, parked });
      entry.parked = parked;
    } catch (error) {
      failed.push({ ...entry.move, error: error.message });
      entry.failed = true;
    }
  });

  const land = (entry, source) => {
    try {
      ensureDir(path.dirname(entry.to));
      fs.renameSync(source, entry.to);
      moved.push(entry.move);
    } catch (error) {
      failed.push({ ...entry.move, error: error.message });
    }
  };

  prepared.forEach(entry => {
    if (entry.failed || entry.parked) return;
    land(entry, entry.from);
  });
  staged.forEach(entry => {
    if (entry.failed) return;
    land(entry, entry.parked);
  });

  try {
    if (fs.existsSync(stagingRoot) && fs.readdirSync(stagingRoot).length === 0) {
      fs.rmdirSync(stagingRoot);
    }
  } catch { /* an occupied staging folder is not worth failing the run over */ }

  appendLedger(workingRoot, moved);
  pruneEmptyDirs(mediaRoot(workingRoot));
  invalidateIndex(workingRoot);
  return { moved, failed };
}

/**
 * Remove folders the moves emptied out, deepest first.
 *
 * The media root itself always survives, empty or not — it is where the next
 * generation gets written and recreating it on every save is noise.
 */
function pruneEmptyDirs(absoluteRoot) {
  if (!fs.existsSync(absoluteRoot)) return;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let empty = true;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!walk(path.join(dir, entry.name))) empty = false;
      } else {
        empty = false;
      }
    }
    if (empty && dir !== absoluteRoot) {
      try { fs.rmdirSync(dir); return true; } catch { return false; }
    }
    return empty;
  };
  walk(absoluteRoot);
}

/**
 * Where to write a new file, and what to call it.
 *
 * `dir` is a project-relative folder from `destinationDir`; the folder is
 * created if it is not there, and the name continues the numbering already in
 * it. Returns the project-relative path to write to.
 */
function reserveNewFile(workingRoot, dir, name) {
  const absoluteDir = resolveInsideRoot(workingRoot, `${dir}/${name}`);
  if (!absoluteDir) throw new Error(`Refusing to write outside the media root: ${dir}/${name}`);
  ensureDir(path.dirname(absoluteDir));
  invalidateIndex(workingRoot);
  return { absolutePath: absoluteDir, relativePath: `${dir}/${name}` };
}

/** The bare filenames already in a project-relative folder. */
function siblingNames(workingRoot, dir) {
  const target = resolveInsideRoot(workingRoot, dir);
  if (!target || !fs.existsSync(target)) return [];
  try {
    return fs.readdirSync(target, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

module.exports = {
  MEDIA_ROOT,
  STAGING_DIR,
  LEDGER_FILE,
  readLedger,
  mediaRoot,
  resolveInsideRoot,
  listMediaFiles,
  resolveRecordedPath,
  invalidateIndex,
  applyMoves,
  pruneEmptyDirs,
  reserveNewFile,
  siblingNames
};
