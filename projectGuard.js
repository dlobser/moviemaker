// Refusing the write that loses the film.
//
// The autosave channel is fire-and-forget: the app POSTs whatever it holds in
// memory 600ms after any change, and until this module existed the server took
// it. That is fine exactly as long as what the app holds came from the file it
// is about to overwrite — and two everyday situations break that.
//
//   * The project lives on a drive that goes away. `getActiveProjectPath()`
//     sees no file, the app boots the built-in placeholder, and the first
//     keystroke after the drive comes back writes that placeholder over the
//     real project.
//   * A second tab is left open on an older state. It has no idea the file
//     moved on and reverts it on its next autosave.
//
// Both are the same bug wearing different hats: a save whose baseline is not
// the file's current contents. So every write carries the revision it was based
// on and is refused when that no longer matches (`guardRevision`), and on top of
// that a save that would shrink a real project down to nothing is refused on its
// own terms (`guardContent`) — because a stale-but-matching revision is still
// possible, and losing 45 shots deserves two locks rather than one.
//
// Nothing here deletes or repairs anything. Every refusal is a 409 the app turns
// into a decision for the user: reload from disk, or overwrite deliberately.

'use strict';

/**
 * Text the built-in placeholder project ships with. A project still carrying
 * it has never been touched, so it is never worth writing over real work.
 */
const PLACEHOLDER_MARKERS = [
  'futuristic cyberpunk city skyline',
  'Welcome to New Eden'
];

/** Below this many shots there is nothing meaningful to protect. */
const TRIVIAL_SHOTS = 1;

/** A shrink has to lose at least this many shots before it is worth querying. */
const SHRINK_FLOOR = 5;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** Every shot in the project, however the state happens to be shaped. */
function collectShots(state) {
  const scenes = asArray(state?.scenes);
  if (scenes.length > 0) return scenes.flatMap(scene => asArray(scene?.shots));
  // Pre-scenes projects kept a flat shot list; the loader still migrates them.
  return asArray(state?.shots);
}

/** Enough of a project to compare two of them without reading either in full. */
function summariseProject(state) {
  const shots = collectShots(state);
  return {
    scenes: asArray(state?.scenes).length,
    shots: shots.length,
    // Counted separately: an edit is real work even when the shot list is thin,
    // and a project can carry a long timeline built entirely from imported media.
    editClips: asArray(state?.edit?.video).length,
    assets: asArray(state?.assetLibrary).length
  };
}

/**
 * Whether this is the untouched starter project.
 *
 * Deliberately narrow — one scene, one shot, and that shot still carrying the
 * placeholder prose. A real one-shot project the user actually wrote is not
 * this, and must still be saveable.
 */
function looksLikeDefaultProject(state) {
  const shots = collectShots(state);
  if (shots.length !== 1) return false;
  if (asArray(state?.scenes).length > 1) return false;
  if (asArray(state?.edit?.video).length > 0) return false;

  const text = [shots[0]?.setup, shots[0]?.description, shots[0]?.dialogue]
    .filter(value => typeof value === 'string')
    .join(' ');
  return PLACEHOLDER_MARKERS.some(marker => text.includes(marker));
}

/**
 * How a project file is identified across a read and the write that follows it.
 *
 * Size joins mtime because a same-second rewrite of a different length is
 * exactly the case a coarse clock would miss. `null` means "no file yet",
 * which is its own legitimate baseline: the first save of a new project.
 */
function revisionOf(stat) {
  if (!stat) return null;
  return `${Math.round(stat.mtimeMs)}:${stat.size}`;
}

/**
 * Has the file moved on since the app last read it?
 *
 * `base === undefined` means the client never sent one, which after this change
 * only happens for a client that predates it — refused, because a save with no
 * baseline is precisely the unguarded write this module exists to stop.
 */
function guardRevision(base, current, { force = false } = {}) {
  if (force) return { ok: true };
  if (base === undefined || base === null) {
    return {
      ok: false,
      reason: 'no-baseline',
      message: 'This save did not say which version of the project it was based on.',
      current
    };
  }
  if (base !== current) {
    return {
      ok: false,
      reason: 'stale',
      message: 'The project file changed on disk since this window loaded it.',
      base,
      current
    };
  }
  return { ok: true };
}

/**
 * Would this write throw away a project that is plainly bigger than it is?
 *
 * Three separate refusals rather than one heuristic, so the message the user
 * gets names what actually happened. All of them are overridable: deleting most
 * of your own shot list is a legitimate thing to do, it just should not happen
 * silently at 600ms after a keystroke.
 */
function guardContent(incoming, existing, { force = false } = {}) {
  if (force) return { ok: true };
  if (!existing) return { ok: true };

  const before = summariseProject(existing);
  const after = summariseProject(incoming);

  // Nothing worth protecting yet.
  if (before.shots <= TRIVIAL_SHOTS && before.editClips === 0) return { ok: true };

  if (looksLikeDefaultProject(incoming)) {
    return {
      ok: false,
      reason: 'placeholder',
      message: 'This window is holding the built-in starter project, not this one.',
      before,
      after
    };
  }

  if (after.shots === 0 && after.editClips === 0 && (before.shots > 0 || before.editClips > 0)) {
    return {
      ok: false,
      reason: 'empty',
      message: 'This save is empty and the project on disk is not.',
      before,
      after
    };
  }

  const lost = before.shots - after.shots;
  if (lost >= SHRINK_FLOOR && after.shots < before.shots / 2) {
    return {
      ok: false,
      reason: 'shrink',
      message: `This save would take the project from ${before.shots} shots down to ${after.shots}.`,
      before,
      after
    };
  }

  return { ok: true };
}

module.exports = {
  PLACEHOLDER_MARKERS,
  collectShots,
  summariseProject,
  looksLikeDefaultProject,
  revisionOf,
  guardRevision,
  guardContent
};
