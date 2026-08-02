// Everything in a project you could plausibly want as a shot's active still.
//
// The studio scatters images across five places that grew separately: a shot's
// own generation outputs, the master gallery, the reference board, each asset's
// reference artwork, and whatever else is sitting in the project's assets
// folder (captured frames, hand-copied files, imports). Only the second was
// ever offered, and only when the slot happened to be empty.
//
// This gathers all of them into one labelled, de-duplicated list. Order is
// nearest-first: the shot's own takes, then the project's, then the wider
// folder — because the thing you want is almost always the thing closest to
// the shot you are looking at.

/** Outputs generated for this shot, newest group last, as the studio stores them. */
function shotOutputs(shot, kind) {
  const groups = (kind === 'video' ? shot?.videoPrompts : shot?.imagePrompts) || [];
  const entries = [];
  groups.forEach(group => {
    (group.outputs || []).forEach(output => {
      if (output?.path) entries.push({ path: output.path, name: output.name || 'Iteration' });
    });
  });
  return entries;
}

/**
 * Grouped media for a picker.
 *
 * `projectFiles` is the raw assets-folder listing (`/api/project-images`); it
 * is the catch-all, so anything it holds that the named sources already
 * covered is dropped rather than shown twice.
 */
export function collectShotMedia({
  kind = 'image',
  shot = null,
  imageGallery = [],
  videoGallery = [],
  referenceImages = [],
  assetLibrary = [],
  projectFiles = []
} = {}) {
  const seen = new Set();
  const groups = [];

  const add = (label, entries) => {
    const items = [];
    entries.forEach(entry => {
      if (!entry?.path || seen.has(entry.path)) return;
      seen.add(entry.path);
      items.push(entry);
    });
    if (items.length > 0) groups.push({ label, items });
  };

  add('This shot', shotOutputs(shot, kind));

  if (kind === 'video') {
    add('Generated videos', (videoGallery || []).map(v => ({ path: v.path, name: v.name || 'Video' })));
    // A video has no reference board or asset artwork to draw on, and the
    // assets folder listing only enumerates images, so it stops here.
    return groups;
  }

  add('Generated images', (imageGallery || []).map(img => ({ path: img.path, name: img.name || 'Image' })));

  add('Reference board', (referenceImages || [])
    .filter(ref => ref?.path)
    .map(ref => ({ path: ref.path, name: ref.name || 'Reference' })));

  const assetArt = [];
  (assetLibrary || []).forEach(asset => {
    (asset.images || []).forEach(path => {
      assetArt.push({
        path,
        name: asset.name || asset.tag || 'Asset',
        note: asset.tag ? `<${asset.tag}>` : null
      });
    });
  });
  add('Asset artwork', assetArt);

  add('Elsewhere in the project', (projectFiles || [])
    .filter(file => file?.path)
    .map(file => ({ path: file.path, name: file.name || file.path })));

  return groups;
}

/** Filter grouped media by a search string, dropping groups left empty. */
export function filterShotMedia(groups, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return groups;
  return groups
    .map(group => ({
      ...group,
      items: group.items.filter(item => (
        `${item.name || ''} ${item.note || ''} ${item.path || ''}`.toLowerCase().includes(needle)
      ))
    }))
    .filter(group => group.items.length > 0);
}

/** How many items a grouped list holds. */
export function countShotMedia(groups) {
  return groups.reduce((total, group) => total + group.items.length, 0);
}
