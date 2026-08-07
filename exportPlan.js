// Turning a project into a folder a human can read.
//
// Inside the project everything is content-addressed rubbish — `img_1738...png`,
// `vid_1738...mp4` — which is right for a working store and useless the moment
// you hand the film to an editor, an archive, or yourself in a year. This walks
// the project and produces a *plan*: which file goes where, under what name,
// and what text file explains it.
//
// A plan rather than a pile of fs calls, for the usual reason — the naming and
// collision rules are the part that goes wrong, and they are testable only if
// nothing here touches a disk.
//
// Layout:
//
//   export/
//     project.json                     the state blob, as saved
//     checkpoints/<name>.json
//     assets/<Tag> - 1.png             the library, by tag
//     reference/<kind> - <name>.png    the board, by kind
//     Scene 01 - Act One/
//       Shot 01 - Henry Mops - image 1 (selected).png
//       Shot 01 - Henry Mops - video 1.mp4
//       Shot 01 - Henry Mops.txt       every prompt, model and reference

const FALLBACK = 'untitled';

/**
 * A filename that survives Windows, macOS and a zip.
 *
 * Windows is the strict one: it rejects <>:"/\|?* outright, and silently
 * mangles trailing dots and spaces. Length is capped well under the 255-byte
 * limit because these names get nested three folders deep.
 */
function sanitizeName(value, fallback = FALLBACK) {
  const ILLEGAL = '<>:"/\|?*';
  const cleaned = String(value == null ? '' : value)
    .split('')
    .map(char => (char < ' ' || ILLEGAL.includes(char) ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 80)
    .replace(/[\s.]+$/g, '');
  if (!cleaned) return fallback;
  // CON, PRN, AUX… are device names on Windows and cannot be files whatever
  // the extension. Unlikely in a scene name, and baffling when it happens.
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned) ? `${cleaned}_` : cleaned;
}

/** The extension of a stored asset, lowercased, or a sensible default. */
function extensionOf(assetPath, fallback = '.png') {
  const match = /\.([a-z0-9]{2,5})$/i.exec(String(assetPath || ''));
  return match ? `.${match[1].toLowerCase()}` : fallback;
}

// A reference's `name` is the file it was uploaded as, extension and all, so
// naming a copy from it and then appending the extension gives `x.png.png`.
// Only known media extensions are stripped — a shot called "Act 2.5" keeps its
// dot.
const MEDIA_EXTENSION = /\.(png|jpe?g|webp|gif|bmp|tiff?|mp4|mov|webm|m4v|mp3|wav|m4a|aac|ogg|flac)$/i;

function withoutExtension(value) {
  return String(value == null ? '' : value).replace(MEDIA_EXTENSION, '');
}

/**
 * Keep every destination distinct.
 *
 * Two shots called "Untitled" in one scene, or the same still selected twice,
 * would otherwise silently overwrite each other and the export would be short
 * a file with nothing to say so.
 */
function uniqueDestination(taken, destination) {
  if (!taken.has(destination.toLowerCase())) {
    taken.add(destination.toLowerCase());
    return destination;
  }
  const dot = destination.lastIndexOf('.');
  const stem = dot > 0 ? destination.slice(0, dot) : destination;
  const extension = dot > 0 ? destination.slice(dot) : '';
  let counter = 2;
  let candidate = `${stem} (${counter})${extension}`;
  while (taken.has(candidate.toLowerCase())) {
    counter += 1;
    candidate = `${stem} (${counter})${extension}`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

function pad(index) {
  return String(index + 1).padStart(2, '0');
}

/** Every output a prompt group produced, flattened with its group's recipe. */
function outputsOf(groups) {
  const rows = [];
  (groups || []).forEach(group => {
    (group.outputs || []).forEach(output => {
      if (output && output.path) rows.push({ output, group });
    });
  });
  return rows;
}

/**
 * `label: value` when it fits on a line, an indented block when it does not.
 *
 * A model id on its own line under a `model:` heading is three lines of
 * scrolling for one fact; a paragraph-long prompt crammed after a colon is
 * unreadable. Neither form works for both.
 */
function wrap(label, value, indent = '  ') {
  const text = String(value == null ? '' : value).trim();
  if (!text) return [];
  if (!text.includes('\n') && text.length <= 72) return [`${indent}${label}: ${text}`];
  return [`${indent}${label}:`, ...text.split('\n').map(line => `${indent}  ${line}`)];
}

/**
 * The plan.
 *
 * `copies` are files to duplicate out of the project; `writes` are text files
 * to create. Both are relative to the export root, so the caller decides where
 * that lives and this stays testable.
 */
function buildExportPlan({
  scenes = [],
  assetLibrary = [],
  referenceImages = [],
  checkpoints = []
} = {}) {
  const copies = [];
  const writes = [];
  const taken = new Set();
  // Where each source file ended up, so a shot's metadata can point at the
  // reference and asset copies rather than at paths inside the project.
  const placed = new Map();

  const place = (sourcePath, destination) => {
    if (!sourcePath) return null;
    if (placed.has(sourcePath)) return placed.get(sourcePath);
    const unique = uniqueDestination(taken, destination);
    copies.push({ from: sourcePath, to: unique });
    placed.set(sourcePath, unique);
    return unique;
  };

  // --- assets --------------------------------------------------------------
  // Placed first so a shot's references can already point at them.
  assetLibrary.forEach(asset => {
    const tag = sanitizeName(asset.tag || asset.name, 'asset');
    const images = [...new Set([asset.primaryImage, ...(asset.images || [])].filter(Boolean))];
    images.forEach((imagePath, index) => {
      const marker = imagePath === asset.primaryImage ? ' (primary)' : '';
      place(imagePath, `assets/${tag} - ${pad(index)}${marker}${extensionOf(imagePath)}`);
    });
  });

  if (assetLibrary.length > 0) {
    writes.push({
      to: 'assets/assets.txt',
      contents: assetLibrary.flatMap(asset => [
        `<${asset.tag || ''}>  ${asset.name || ''}`.trim(),
        ...wrap('type', asset.type),
        ...wrap('description', asset.description),
        ...wrap('image prompt', asset.imagePrompt),
        ''
      ]).join('\n')
    });
  }

  // --- reference board -----------------------------------------------------
  referenceImages.forEach(ref => {
    const kind = sanitizeName(ref.kind || 'other', 'other');
    const name = sanitizeName(withoutExtension(ref.name) || 'reference', 'reference');
    place(ref.path, `reference/${kind} - ${name}${extensionOf(ref.path)}`);
  });

  if (referenceImages.length > 0) {
    writes.push({
      to: 'reference/reference.txt',
      contents: referenceImages.flatMap(ref => {
        const asset = assetLibrary.find(entry => entry.id === ref.assetId);
        return [
          placed.get(ref.path) ? placed.get(ref.path).replace(/^reference\//, '') : (ref.name || ''),
          ...wrap('kind', ref.kind),
          ...wrap('tags', (ref.tags || []).join(', ')),
          ...wrap('asset', asset ? `<${asset.tag}>` : ''),
          ...wrap('notes', ref.notes),
          ''
        ];
      }).join('\n')
    });
  }

  // --- scenes and shots ----------------------------------------------------
  scenes.forEach((scene, sceneIndex) => {
    const sceneFolder = `Scene ${pad(sceneIndex)} - ${sanitizeName(scene.name, 'Scene')}`;
    (scene.shots || []).forEach((shot, shotIndex) => {
      const shotLabel = `Shot ${pad(shotIndex)} - ${sanitizeName(shot.name, 'Shot')}`;
      const lines = [shotLabel, `${sceneFolder}`, ''];
      // Every reference this shot actually sent, across all its generations.
      const referencesUsed = new Set();

      [['image', shot.imagePrompts, shot.selectedImage], ['video', shot.videoPrompts, shot.selectedVideo]]
        .forEach(([kind, groups, selected]) => {
          const rows = outputsOf(groups);
          if (rows.length === 0) return;
          lines.push(kind === 'image' ? 'IMAGES' : 'VIDEOS');

          rows.forEach(({ output, group }, index) => {
            const isSelected = output.path === selected;
            const destination = place(
              output.path,
              `${sceneFolder}/${shotLabel} - ${kind} ${pad(index)}${isSelected ? ' (selected)' : ''}${extensionOf(output.path, kind === 'image' ? '.png' : '.mp4')}`
            );
            lines.push(`  ${destination ? destination.split('/').pop() : output.path}${isSelected ? '   << selected' : ''}`);
            lines.push(...wrap('model', group.model || (kind === 'image' ? shot.imageModel : shot.videoModel), '    '));
            lines.push(...wrap('prompt', group.prompt, '    '));
            (group.inputImagePaths || []).forEach(inputPath => referencesUsed.add(inputPath));
            lines.push('');
          });
        });

      if (referencesUsed.size > 0) {
        lines.push('REFERENCES SENT');
        // Relative to this scene folder, so the links work in a file browser.
        referencesUsed.forEach(inputPath => {
          const destination = placed.get(inputPath);
          lines.push(`  ${destination ? `../${destination}` : `(not exported) ${inputPath}`}`);
        });
        lines.push('');
      }

      const notes = [
        ...wrap('setup', shot.setup),
        ...wrap('description', shot.description),
        ...wrap('dialogue', shot.dialogue),
        ...wrap('notes', shot.notes)
      ];
      if (notes.length > 0) lines.push('SHOT', ...notes, '');

      writes.push({ to: `${sceneFolder}/${shotLabel}.txt`, contents: lines.join('\n') });
    });
  });

  // --- checkpoints ---------------------------------------------------------
  checkpoints.forEach((checkpoint, index) => {
    const name = sanitizeName(checkpoint.name || checkpoint.id, `checkpoint ${pad(index)}`);
    const destination = uniqueDestination(taken, `checkpoints/${name}.json`);
    writes.push({ to: destination, contents: JSON.stringify(checkpoint, null, 2) });
  });

  return { copies, writes };
}

module.exports = { buildExportPlan, sanitizeName, uniqueDestination, extensionOf, withoutExtension };
