// Where a file belongs, and what it should be called when it gets there.
//
// Every generated and uploaded file used to land in one flat `assets/` folder
// under a name like `img_1761420033.png`. That is fine for the machine and
// useless for a person: a finished film is a few thousand files with no way to
// tell a character sheet from the eleventh iteration of shot 3.
//
// So the media root grows three trees and a waiting room:
//
//   assets/library/<kind>/<tag>/   the asset library — characters, locations,
//                                 props, the things a prompt names with <Tag>
//   assets/shots/<scene>/<shot>/   everything made for one shot, split into
//                                 images/ video/ audio/
//   assets/reference/              the reference board
//   assets/bin/                    files nothing in the project points at
//
// It stays *inside* `assets/` deliberately. Every path ever written into a
// project file, a checkpoint or an auto-backup begins with `assets/`, and so
// does the one static mount that serves them. Keeping the prefix means old
// projects keep resolving and the only thing that changes is what follows it.
//
// This module is pure on purpose — no filesystem, no fetch. It decides, the
// hosts act. `planAssetLayout` is the whole decision in one function, which is
// what makes "did Clean Files do the right thing?" a question a test can ask
// rather than something you find out after two thousand files have moved.

export const MEDIA_ROOT = 'assets';
export const LIBRARY_DIR = `${MEDIA_ROOT}/library`;
export const SHOTS_DIR = `${MEDIA_ROOT}/shots`;
export const REFERENCE_DIR = `${MEDIA_ROOT}/reference`;
export const BIN_DIR = `${MEDIA_ROOT}/bin`;

// The asset library's folder per asset type. Mostly the plural of the type,
// with one deliberate exception: the type is `environment` because that is what
// the prompt vocabulary calls it, and the folder is `locations` because that is
// what a person looking for one calls it.
export const LIBRARY_FOLDERS = {
  character: 'characters',
  environment: 'locations',
  prop: 'props',
  style: 'styles',
  vehicle: 'vehicles'
};

const LIBRARY_FALLBACK = 'other';

// Which subfolder of a shot a file lands in, by what it is.
export const SHOT_MEDIA_DIRS = { image: 'images', video: 'video', audio: 'audio' };

const EXTENSION_KIND = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image',
  '.mp4': 'video', '.mov': 'video', '.webm': 'video', '.mkv': 'video',
  '.mp3': 'audio', '.wav': 'audio', '.m4a': 'audio', '.aac': 'audio', '.ogg': 'audio', '.flac': 'audio'
};

/** The last segment of a path, with either separator. */
export function basename(filePath) {
  const normalized = String(filePath || '').split('\\').join('/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/** Everything before the last separator, or '' for a bare filename. */
export function dirname(filePath) {
  const normalized = String(filePath || '').split('\\').join('/');
  const cut = normalized.lastIndexOf('/');
  return cut < 0 ? '' : normalized.slice(0, cut);
}

/** 'shot.PNG' -> '.png'. '' when there is no extension. */
export function extensionOf(filePath) {
  const name = basename(filePath);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** What kind of media this is, from its extension. Images are the fallback. */
export function mediaKindOf(filePath) {
  return EXTENSION_KIND[extensionOf(filePath)] || 'image';
}

// Folder and file names have to survive Windows, macOS and a zip round trip, so
// the safe set is small: lower-case letters, digits and single hyphens. The
// length cap is not cosmetic — Windows still enforces a 260-character path and
// these names nest four deep.
const MAX_SLUG = 40;
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** A name as a filesystem-safe slug: "Mercer's Garage" -> 'mercers-garage'. */
export function slugify(text, fallback = 'untitled') {
  const slug = String(text || '')
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')     // drop the accents NFKD just split off
    .toLowerCase()
    .replace(/['\u2019]/g, '')        // apostrophes join rather than separate
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');             // the slice may have landed mid-hyphen
  return slug || fallback;
}

// Shot lists are written by people, and people number their shots in the name:
// "1.1 - The Dawn", "07 Interior Garage". The folder gets its own ordering
// prefix from the shot's position, so leaving the written one in produces
// `01-1-1-the-dawn`. Strip it and the folder reads `01-the-dawn`.
//
// Only a leading run of digits and separators goes, and only when something is
// left afterwards: a shot actually named "7" keeps its name rather than
// slugifying to 'untitled'.
export function stripLeadingNumber(name) {
  const text = String(name || '').trim();
  const stripped = text.replace(/^\d+(?:[.\-_)\s]+\d+)*[.\-_)\s]+/, '').trim();
  return stripped || text;
}

/** `01-the-dawn` — an ordering prefix plus the readable part of the name. */
export function orderedSlug(index, name, fallback = 'untitled') {
  const position = String(Math.max(0, Math.floor(index)) + 1).padStart(2, '0');
  return `${position}-${slugify(stripLeadingNumber(name), fallback)}`;
}

// --- where each kind of file lives -----------------------------------------

/** `assets/library/characters/ralph` — the folder for one asset's images. */
export function libraryDir(asset) {
  const folder = LIBRARY_FOLDERS[asset?.type] || LIBRARY_FALLBACK;
  return `${LIBRARY_DIR}/${folder}/${slugify(asset?.tag || asset?.name, 'untagged')}`;
}

/** `assets/shots/01-cold-open/02-the-dawn/images` — one shot's stills. */
export function shotDir(sceneIndex, scene, shotIndex, shot, mediaKind) {
  const sub = SHOT_MEDIA_DIRS[mediaKind] || SHOT_MEDIA_DIRS.image;
  // A scene's own `number` is what the shot list said; its position in the
  // list is the fallback, so an unnumbered scene still sorts where it sits.
  const sceneOrder = Number.isFinite(scene?.number) ? scene.number - 1 : sceneIndex;
  return [
    SHOTS_DIR,
    orderedSlug(sceneOrder, scene?.name, 'scene'),
    orderedSlug(shotIndex, shot?.name, 'shot'),
    sub
  ].join('/');
}

/** The reference board is one flat folder — the board does its own sorting. */
export function referenceDir() {
  return REFERENCE_DIR;
}

/** True for a path the layout owns, so a host knows what it may reorganise. */
export function isManagedPath(filePath) {
  const normalized = String(filePath || '').split('\\').join('/');
  return [LIBRARY_DIR, SHOTS_DIR, REFERENCE_DIR, BIN_DIR]
    .some(dir => normalized.startsWith(`${dir}/`));
}

// --- the plan --------------------------------------------------------------
//
// One pass over the project produces an ordered list of *claims*: this file
// belongs to that asset / that reference / that shot. Order is precedence, and
// the first claim on a path wins, because a file can only live in one place:
//
//   1. the asset library — a character's face is that character's, even when
//      a shot has also selected it
//   2. the reference board
//   3. shots, in scene then shot then group order
//   4. nothing — the galleries hold crops, uploads and imports that were never
//      filed, and the disk holds whatever else is lying around. Both go to the
//      bin, which is the honest place for "we do not know what this is".
//
// The watermark is deliberately absent. It is a project-level file that the
// render pipeline resolves by path, it belongs to no shot or asset, and moving
// it would be churn for its own sake.

const SHOT_MEDIA_FIELDS = ['selectedImage', 'selectedVideo', 'lipSyncAudio'];

/** Every path a shot points at, in a stable order: outputs first, then picks. */
function shotPaths(shot) {
  const found = [];
  const add = (value) => {
    if (typeof value === 'string' && value.startsWith(`${MEDIA_ROOT}/`)) found.push(value);
  };
  // Prompt-group outputs come first so iteration order — the order they were
  // generated in — is what the version numbers end up reflecting. The selected
  // image is almost always one of them, and would otherwise take v01 by virtue
  // of being read first.
  [...(shot.imagePrompts || []), ...(shot.videoPrompts || [])].forEach(group => {
    (group.outputs || []).forEach(output => add(output?.path));
    (group.inputImagePaths || []).forEach(add);
    add(group.imageInput);
  });
  SHOT_MEDIA_FIELDS.forEach(field => add(shot[field]));
  (shot.audioRefs || []).forEach(add);
  return found;
}

/**
 * Every file the project points at, paired with where it should live.
 *
 * Returns claims in precedence order, each already deduplicated: a path that
 * two owners both point at appears once, under the first owner to claim it.
 */
export function collectClaims({ scenes = [], assetLibrary = [], referenceImages = [] } = {}) {
  const claims = [];
  const seen = new Set();
  const claim = (filePath, dir, stem, versioned, owner) => {
    if (typeof filePath !== 'string' || !filePath.startsWith(`${MEDIA_ROOT}/`)) return;
    if (seen.has(filePath)) return;
    seen.add(filePath);
    claims.push({ path: filePath, dir, stem, versioned, owner });
  };

  assetLibrary.forEach(asset => {
    const dir = libraryDir(asset);
    const stem = slugify(asset?.tag || asset?.name, 'untagged');
    // The primary first, so the picture that represents the asset is _01.
    [asset?.primaryImage, ...(asset?.images || [])]
      .forEach(imagePath => claim(imagePath, dir, stem, false, 'library'));
  });

  referenceImages.forEach(ref => {
    claim(ref?.path, referenceDir(), slugify(ref?.name, 'reference'), false, 'reference');
  });

  scenes.forEach((scene, sceneIndex) => {
    (scene?.shots || []).forEach((shot, shotIndex) => {
      const stem = slugify(stripLeadingNumber(shot?.name), 'shot');
      shotPaths(shot).forEach(filePath => {
        const dir = shotDir(sceneIndex, scene, shotIndex, shot, mediaKindOf(filePath));
        claim(filePath, dir, stem, true, 'shot');
      });
    });
  });

  return claims;
}

// A file already sitting in its own destination folder under its own name keeps
// the version number it has. Renumbering from one on every run would mean
// deleting iteration 2 of a shot renames 3 to 2 and 4 to 3, invalidating every
// path in every checkpoint that mentioned them — a lot of churn to close a gap
// nobody was troubled by.
function existingSequence(filePath, dir, stem, versioned, extension) {
  if (dirname(filePath) !== dir) return null;
  const pattern = new RegExp(`^${escapeRegExp(stem)}_${versioned ? 'v' : ''}(\\d+)$`);
  const name = basename(filePath);
  if (!name.toLowerCase().endsWith(extension)) return null;
  const match = pattern.exec(name.slice(0, name.length - extension.length));
  return match ? Number(match[1]) : null;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Decide where every file goes.
 *
 * `existingFiles` is what the media root actually holds — pass it and anything
 * the project does not reference is swept into the bin; leave it out and the
 * plan only covers what the state points at.
 *
 * The result is a list of moves plus the `from -> to` mapping, which is exactly
 * what `remapStateAssetPaths` needs to rewrite the project in the same pass.
 */
export function planAssetLayout(project = {}, { existingFiles = [] } = {}) {
  const claims = collectClaims(project);
  const claimed = new Set(claims.map(entry => entry.path));

  // The bin takes what nothing claims: gallery-only crops and uploads, plus
  // any file on disk the state has forgotten about. Both are the same problem.
  const orphans = [];
  const seenOrphan = new Set();
  const orphan = (filePath) => {
    if (typeof filePath !== 'string' || !filePath.startsWith(`${MEDIA_ROOT}/`)) return;
    if (claimed.has(filePath) || seenOrphan.has(filePath)) return;
    seenOrphan.add(filePath);
    orphans.push(filePath);
  };
  (project.imageGallery || []).forEach(item => orphan(item?.path));
  (project.videoGallery || []).forEach(item => orphan(item?.path));
  existingFiles.forEach(orphan);

  // Pinned files keep their path whatever else moves. The watermark is one:
  // it belongs to the project rather than to any shot.
  const pinned = new Set([project.watermarkImage].filter(Boolean));

  // Pass one hands every already-correct file the number it already has, so
  // pass two can only fill the gaps rather than shuffling the whole folder.
  const taken = new Map();
  const reserve = (dir, stem, sequence) => {
    const key = `${dir}\u0000${stem}`;
    if (!taken.has(key)) taken.set(key, new Set());
    taken.get(key).add(sequence);
  };
  const nextFree = (dir, stem) => {
    const used = taken.get(`${dir}\u0000${stem}`) || new Set();
    let candidate = 1;
    while (used.has(candidate)) candidate += 1;
    return candidate;
  };

  const settled = new Map();
  claims.forEach(entry => {
    if (pinned.has(entry.path)) return;
    const extension = extensionOf(entry.path);
    const sequence = existingSequence(entry.path, entry.dir, entry.stem, entry.versioned, extension);
    if (sequence !== null) {
      reserve(entry.dir, entry.stem, sequence);
      settled.set(entry.path, entry.path);
    }
  });

  const moves = [];
  claims.forEach(entry => {
    if (pinned.has(entry.path) || settled.has(entry.path)) return;
    const extension = extensionOf(entry.path);
    const sequence = nextFree(entry.dir, entry.stem);
    reserve(entry.dir, entry.stem, sequence);
    const suffix = String(sequence).padStart(2, '0');
    const to = `${entry.dir}/${entry.stem}_${entry.versioned ? 'v' : ''}${suffix}${extension}`;
    settled.set(entry.path, to);
    moves.push({ from: entry.path, to, owner: entry.owner });
  });

  // Binned files keep the name they arrived with — there is nothing to name
  // them after, and the old name is the only clue left about where they came
  // from. A collision only happens if two folders held the same basename.
  const binNames = new Set();
  orphans.forEach(filePath => {
    if (pinned.has(filePath)) return;
    let name = basename(filePath);
    if (binNames.has(name)) {
      const extension = extensionOf(name);
      const stem = name.slice(0, name.length - extension.length);
      let attempt = 2;
      while (binNames.has(`${stem}_${attempt}${extension}`)) attempt += 1;
      name = `${stem}_${attempt}${extension}`;
    }
    binNames.add(name);
    const to = `${BIN_DIR}/${name}`;
    if (to === filePath) return;
    settled.set(filePath, to);
    moves.push({ from: filePath, to, owner: 'bin' });
  });

  return {
    moves,
    mapping: new Map(moves.map(move => [move.from, move.to])),
    // What a confirmation dialog needs to say before anything is touched.
    summary: {
      total: claims.length + orphans.length,
      moving: moves.length,
      alreadyPlaced: claims.length + orphans.length - moves.length,
      binned: moves.filter(move => move.owner === 'bin').length
    }
  };
}

// --- writing new files in the right place ----------------------------------
//
// The other half of the job. Clean Files is a repair tool; if generation keeps
// writing flat, the tree is only tidy for as long as it takes to render the
// next shot. So a generation request carries a `destination` — who this file is
// for — and the host turns it into a folder before saving.
//
// A destination the studio cannot resolve is not an error. It falls back to the
// bin, which is visible, sweepable by Clean Files, and much better than either
// failing a paid generation or silently scattering files at the root.

// A descriptor describes rather than points. It carries the scene and shot it
// is for — name, number, position — instead of an id to look up, and that is
// what makes it correct rather than merely convenient: the server's copy of the
// project is whatever the last autosave wrote, so a shot generated ten seconds
// after it was created would resolve to nothing and land in the bin.
//
// Nothing in a descriptor reaches the filesystem unslugified. `slugify` keeps
// only [a-z0-9-], so a name of '../../etc' becomes 'etc' — a descriptor is
// untrusted input and is treated as one.
//
// Ids still work, resolved against whatever state the host has, because the
// asset library changes far more slowly than a shot list does.

/** The asset a descriptor is about, from its own copy or from the library. */
function describedAsset(destination, project) {
  if (destination?.asset?.tag || destination?.asset?.name) return destination.asset;
  return (project.assetLibrary || []).find(entry => entry?.id === destination?.assetId) || null;
}

/** The scene/shot pair a descriptor is about, from its own copy or by id. */
function describedShot(destination, project) {
  if (destination?.shot && destination?.scene) {
    return {
      sceneIndex: Number(destination.scene.index) || 0,
      scene: destination.scene,
      shotIndex: Number(destination.shot.index) || 0,
      shot: destination.shot
    };
  }
  const scenes = project.scenes || [];
  for (let sceneIndex = 0; sceneIndex < scenes.length; sceneIndex += 1) {
    const shots = scenes[sceneIndex]?.shots || [];
    const shotIndex = shots.findIndex(shot => shot?.id === destination?.shotId);
    if (shotIndex >= 0) {
      return { sceneIndex, scene: scenes[sceneIndex], shotIndex, shot: shots[shotIndex] };
    }
  }
  return null;
}

/**
 * The folder a new file should be written to, from a destination descriptor.
 *
 * `{ kind: 'shot', media, scene: { index, name, number }, shot: { index, name } }`
 * `{ kind: 'asset', asset: { type, tag } }` — or `assetId` / `shotId` to look
 * up in `project` instead. `{ kind: 'reference' }` needs nothing else.
 */
export function destinationDir(destination, project = {}) {
  if (!destination || typeof destination !== 'object') return BIN_DIR;

  if (destination.kind === 'reference') return referenceDir();

  if (destination.kind === 'asset') {
    const asset = describedAsset(destination, project);
    return asset ? libraryDir(asset) : BIN_DIR;
  }

  if (destination.kind === 'shot') {
    const found = describedShot(destination, project);
    if (found) {
      return shotDir(found.sceneIndex, found.scene, found.shotIndex, found.shot, destination.media);
    }
  }

  return BIN_DIR;
}

/** The stem a new file in that folder should be named with. */
export function destinationStem(destination, project = {}) {
  if (destination?.kind === 'asset') {
    const asset = describedAsset(destination, project);
    if (asset) return { stem: slugify(asset.tag || asset.name, 'untagged'), versioned: false };
  }
  if (destination?.kind === 'shot') {
    const found = describedShot(destination, project);
    if (found) return { stem: slugify(stripLeadingNumber(found.shot?.name), 'shot'), versioned: true };
  }
  if (destination?.kind === 'reference') return { stem: 'reference', versioned: false };
  return null;
}

/**
 * The next free name in a folder, given what is already in it.
 *
 * The host supplies `siblings` (bare filenames). Numbering continues from the
 * highest that is already there rather than filling gaps, because two
 * generations racing for the same shot must not be handed the same name.
 */
export function nextFileName(stem, versioned, extension, siblings = []) {
  const prefix = `${stem}_${versioned ? 'v' : ''}`;
  const pattern = new RegExp(`^${escapeRegExp(prefix)}(\\d+)${escapeRegExp(extension)}$`, 'i');
  let highest = 0;
  siblings.forEach(name => {
    const match = pattern.exec(String(name));
    if (match) highest = Math.max(highest, Number(match[1]));
  });
  return `${prefix}${String(highest + 1).padStart(2, '0')}${extension}`;
}
