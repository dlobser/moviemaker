// The client half of the autosave guard. See ../../projectGuard.js for the why.
//
// The app keeps one baseline — which version of which file the state in memory
// came from — and quotes it back on every save. The server refuses a save whose
// baseline no longer matches, and this module turns that refusal into something
// the user can act on rather than a console warning nobody reads.
//
// Nothing here writes anything. It is the vocabulary; App.jsx holds the state.

/** Nothing has been read yet, so nothing may be written. */
export function emptyBaseline() {
  return { revision: null, target: null, loaded: false };
}

/**
 * Pull the baseline out of a response.
 *
 * Headers first, body second: the hosted build's `apiFetch` returns a plain
 * object with no headers at all, and project-switching endpoints report the new
 * baseline in their JSON. A field that is absent leaves the old value alone —
 * clearing it would look like "never loaded" and stop autosave dead.
 */
export function adoptBaseline(previous, res, body) {
  const header = (name) => {
    try {
      return res?.headers?.get?.(name) ?? null;
    } catch {
      return null;
    }
  };
  const revision = header('X-MM-Revision') ?? body?.revision ?? null;
  const target = header('X-MM-Target') ?? body?.target ?? null;
  return {
    revision: revision === null ? previous.revision : revision,
    target: target === null ? previous.target : target,
    loaded: true
  };
}

/** Headers that say what this save is based on, and whether it is deliberate. */
export function saveHeaders(baseline, { force = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (baseline.revision !== null && baseline.revision !== undefined) {
    headers['X-MM-Base-Revision'] = baseline.revision;
  }
  if (baseline.target) headers['X-MM-Target'] = baseline.target;
  if (force) headers['X-MM-Force'] = '1';
  return headers;
}

/**
 * What to tell the user, and what the two buttons should say.
 *
 * Every one of these is a fork with the same shape — take what is on disk, or
 * insist on what is in this window — so the copy's only job is making it
 * obvious which one keeps the work.
 */
export function describeBlock(block) {
  if (!block) return null;
  const { reason, detail } = block;
  const before = detail?.before;
  const after = detail?.after;
  const counts = before && after
    ? ` The file holds ${before.shots} shot${before.shots === 1 ? '' : 's'}; this window holds ${after.shots}.`
    : '';

  switch (reason) {
    case 'offline':
      return {
        title: 'The backend is not running',
        body: 'Nothing can be saved until it is. Start it with "npm start" in the MovieMaker '
          + 'folder, then reload — what is on screen stays here in the meantime.',
        canReload: true,
        canForce: false,
        reloadLabel: 'Try again'
      };
    case 'project-unreachable':
      return {
        title: 'The project file is not reachable',
        body: `${detail?.path || block.message} — nothing is being saved. `
          + 'Reconnect the drive, then reload. Whatever you change until then stays in this window only.',
        canReload: true,
        canForce: false,
        reloadLabel: 'Try again'
      };
    case 'target-changed':
      return {
        title: 'A different project is open now',
        body: 'This window is still holding the project it opened with, but the app has since '
          + `switched to ${detail?.current || 'another file'}. Saving would write one film into the other.`,
        canReload: true,
        canForce: false,
        reloadLabel: 'Load the project that is open'
      };
    case 'stale':
      return {
        title: 'The project changed on disk',
        body: 'Another window — or a restored checkpoint — wrote this project after this window '
          + 'loaded it. Autosave is paused so the newer version is not reverted.'
          + ' Reload to take what is on disk, or overwrite it with what is on screen here.',
        canReload: true,
        canForce: true
      };
    case 'placeholder':
      return {
        title: 'This window is holding the starter project',
        body: 'What is on screen is the built-in placeholder, not this project, so the save was '
          + `refused.${counts} This is almost always a stale tab or a drive that dropped out — reload.`,
        canReload: true,
        canForce: true
      };
    case 'empty':
      return {
        title: 'Refused an empty save',
        body: `This window has nothing in it and the project on disk does.${counts} `
          + 'Reload to get the project back.',
        canReload: true,
        canForce: true
      };
    case 'shrink':
      return {
        title: 'That save would drop most of the project',
        body: `${block.message || ''}${counts} If you meant to delete them, overwrite; `
          + 'the previous file is copied into checkpoints/auto-backups first either way.',
        canReload: true,
        canForce: true
      };
    case 'unreadable':
      return {
        title: 'The project file could not be read',
        body: 'Saving is paused rather than writing over a file we cannot compare against. '
          + 'Check the file, then reload.',
        canReload: true,
        canForce: true
      };
    default:
      return {
        title: 'Autosave is paused',
        body: block.message || 'The last save was refused.',
        canReload: true,
        canForce: true
      };
  }
}
