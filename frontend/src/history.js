// Undo/redo for the whole studio.
//
// The studio already has the two halves this needs: `buildStatePayload()`
// serialises every piece of project state, and `applyLoadedState()` pushes such
// a blob back into every hook — that is how a project, a checkpoint and an
// import all load. So undo is not a command pattern with a class per action; it
// is a ring buffer of those blobs, and undoing is loading one.
//
// The cost of that choice is that undo is whole-project, not per-field: it
// steps back to how the project was, rather than reversing one specific act.
// The benefit is that it covers everything by construction — every action the
// app has now and every action it grows later — with nothing to keep in sync.
//
// Snapshots are stored as live object graphs, not JSON strings. React's state
// updates replace only the objects that changed, so an unedited shot is the
// same object in fifty consecutive snapshots and costs nothing to keep.

export const HISTORY_LIMIT = 60;

export function createHistory() {
  return { past: [], future: [] };
}

export function canUndo(history) {
  return (history?.past?.length || 0) > 0;
}

export function canRedo(history) {
  return (history?.future?.length || 0) > 0;
}

/** The label of the step undo would take back, for the menu. */
export function undoLabel(history) {
  return canUndo(history) ? history.past[history.past.length - 1].label : null;
}

export function redoLabel(history) {
  return canRedo(history) ? history.future[0].label : null;
}

/**
 * Record a new state. Anything that had been undone is dropped — redoing onto
 * a branch the user has since edited away from would restore a project that
 * never existed.
 */
export function pushHistory(history, entry) {
  return {
    past: [...history.past, entry].slice(-HISTORY_LIMIT),
    future: []
  };
}

/** Step back. Returns { entry, history }, or null when there is nothing to undo. */
export function undoHistory(history, current) {
  if (!canUndo(history)) return null;
  return {
    entry: history.past[history.past.length - 1],
    history: {
      past: history.past.slice(0, -1),
      future: [current, ...history.future].slice(0, HISTORY_LIMIT)
    }
  };
}

/** Step forward again. */
export function redoHistory(history, current) {
  if (!canRedo(history)) return null;
  return {
    entry: history.future[0],
    history: {
      past: [...history.past, current].slice(-HISTORY_LIMIT),
      future: history.future.slice(1)
    }
  };
}

// --- labelling -------------------------------------------------------------
//
// "Undo" on its own is a coin flip — the user has to take it on faith that the
// thing they want reversed is the thing that will be. Comparing two snapshots
// is cheap and turns the menu item into "Undo delete shot", which is a promise
// rather than a gamble.

function shotsOf(state) {
  return (state?.scenes || []).flatMap(scene => scene.shots || []);
}

function counts(state) {
  return {
    scenes: (state?.scenes || []).length,
    shots: shotsOf(state).length,
    assets: (state?.assetLibrary || []).length,
    references: (state?.referenceImages || []).length,
    images: (state?.imageGallery || []).length,
    videos: (state?.videoGallery || []).length,
    snippets: (state?.promptSnippets || []).length,
    clips: (state?.edit?.video || []).length
  };
}

const COUNT_NOUNS = [
  ['shots', 'shot', 'shots'],
  ['scenes', 'scene', 'scenes'],
  ['assets', 'asset', 'assets'],
  ['videos', 'video', 'videos'],
  ['images', 'image', 'images'],
  ['references', 'reference', 'references'],
  ['snippets', 'snippet', 'snippets'],
  ['clips', 'timeline clip', 'timeline clips']
];

const SHOT_TEXT_FIELDS = ['name', 'setup', 'description', 'dialogue', 'notes', 'draftImagePrompt', 'draftVideoPrompt'];

/** A short description of what changed between two snapshots. */
export function describeChange(before, after) {
  const a = counts(before);
  const b = counts(after);

  for (const [key, one, many] of COUNT_NOUNS) {
    const delta = b[key] - a[key];
    if (delta > 0) return `add ${delta} ${delta === 1 ? one : many}`;
    if (delta < 0) return `delete ${-delta} ${-delta === 1 ? one : many}`;
  }

  // Same shape, so something was edited in place. Name the shot when we can —
  // "Undo edit Shot 3" is worth far more than "Undo edit".
  const beforeShots = shotsOf(before);
  const afterShots = shotsOf(after);
  const beforeById = new Map(beforeShots.map(shot => [shot.id, shot]));

  for (const shot of afterShots) {
    const previous = beforeById.get(shot.id);
    if (!previous) continue;

    if (previous.selectedImage !== shot.selectedImage) return `image choice on ${shot.name || 'a shot'}`;
    if (previous.selectedVideo !== shot.selectedVideo) return `video choice on ${shot.name || 'a shot'}`;
    if (SHOT_TEXT_FIELDS.some(field => previous[field] !== shot[field])) {
      return `edit to ${shot.name || 'a shot'}`;
    }
    if ((previous.imagePrompts || []).length !== (shot.imagePrompts || []).length
      || (previous.videoPrompts || []).length !== (shot.videoPrompts || []).length) {
      return `generation on ${shot.name || 'a shot'}`;
    }
  }

  // Shots are identical — so the order changed, or something outside them did.
  if (beforeShots.map(s => s.id).join() !== afterShots.map(s => s.id).join()) return 'reorder';

  const beforeScenes = before?.scenes || [];
  const afterScenes = after?.scenes || [];
  const renamed = afterScenes.find((scene, i) => beforeScenes[i] && beforeScenes[i].name !== scene.name);
  if (renamed) return `rename scene to ${renamed.name}`;

  if (JSON.stringify(before?.promptSettings || {}) !== JSON.stringify(after?.promptSettings || {})) return 'prompt settings';
  if (JSON.stringify(before?.refAssignments || []) !== JSON.stringify(after?.refAssignments || [])) return 'reference assignment';
  if (JSON.stringify(before?.assetLibrary || []) !== JSON.stringify(after?.assetLibrary || [])) return 'asset edit';
  if (JSON.stringify(before?.edit || {}) !== JSON.stringify(after?.edit || {})) return 'timeline edit';

  return 'change';
}
