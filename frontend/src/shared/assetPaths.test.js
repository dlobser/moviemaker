import test from 'node:test';
import assert from 'node:assert/strict';

import {
  slugify, stripLeadingNumber, orderedSlug, mediaKindOf, isManagedPath,
  libraryDir, shotDir, collectClaims, planAssetLayout,
  destinationDir, destinationStem, nextFileName,
  BIN_DIR
} from './assetPaths.js';

// --- names -----------------------------------------------------------------

test('a name becomes something a filesystem and a person can both read', () => {
  assert.equal(slugify("Mercer's Garage"), 'mercers-garage');
  assert.equal(slugify('Act 1 — Cold Open'), 'act-1-cold-open');
  assert.equal(slugify('Café Noir'), 'cafe-noir');
  assert.equal(slugify('   '), 'untitled');
  assert.equal(slugify('!!!', 'ref'), 'ref');
});

test('a slug never ends on the hyphen the length cap landed in', () => {
  const long = slugify('a'.repeat(38) + ' the quick brown fox');
  assert.ok(long.length <= 40);
  assert.equal(long.endsWith('-'), false);
});

test('the number a person wrote into the shot name is not repeated by the folder', () => {
  assert.equal(stripLeadingNumber('1.1 - The Dawn'), 'The Dawn');
  assert.equal(stripLeadingNumber('07 Interior Garage'), 'Interior Garage');
  assert.equal(orderedSlug(0, '1.1 - The Dawn'), '01-the-dawn');
  assert.equal(orderedSlug(11, 'Cold Open'), '12-cold-open');
});

test('a shot actually named after a number keeps it rather than becoming untitled', () => {
  assert.equal(stripLeadingNumber('7'), '7');
  assert.equal(orderedSlug(0, '7'), '01-7');
});

test('what a file is comes from its extension, and an unknown one is a still', () => {
  assert.equal(mediaKindOf('assets/a.MP4'), 'video');
  assert.equal(mediaKindOf('assets/a.wav'), 'audio');
  assert.equal(mediaKindOf('assets/a.png'), 'image');
  assert.equal(mediaKindOf('assets/a.zzz'), 'image');
});

test('only the managed trees are managed — a loose legacy file is not', () => {
  assert.equal(isManagedPath('assets/shots/01-x/01-y/images/y_v01.png'), true);
  assert.equal(isManagedPath('assets/bin/img_1.png'), true);
  assert.equal(isManagedPath('assets/img_1761420033.png'), false);
});

// --- the plan --------------------------------------------------------------

const ralph = { id: 'a1', tag: 'Ralph', type: 'character', primaryImage: 'assets/ref_2.png', images: ['assets/ref_1.png', 'assets/ref_2.png'] };
const garage = { id: 'a2', tag: 'Garage', type: 'environment', images: ['assets/ref_3.png'] };

const project = () => ({
  assetLibrary: [ralph, garage],
  referenceImages: [{ id: 'r1', path: 'assets/ref_9.png', name: 'Rain lighting', kind: 'lighting' }],
  scenes: [{
    name: 'Act 1 - Cold Open',
    number: 1,
    shots: [{
      id: 's1',
      name: '1.1 - The Dawn',
      selectedImage: 'assets/img_20.png',
      selectedVideo: 'assets/vid_30.mp4',
      imagePrompts: [{ outputs: [{ path: 'assets/img_10.png' }, { path: 'assets/img_20.png' }] }]
    }]
  }],
  imageGallery: [{ path: 'assets/img_10.png' }, { path: 'assets/crop_99.png' }],
  videoGallery: []
});

test('an asset owns its images, and the primary is the one numbered first', () => {
  const { mapping } = planAssetLayout(project());
  assert.equal(mapping.get('assets/ref_2.png'), 'assets/library/characters/ralph/ralph_01.png');
  assert.equal(mapping.get('assets/ref_1.png'), 'assets/library/characters/ralph/ralph_02.png');
});

test('an environment asset files under locations, which is what people call it', () => {
  assert.equal(libraryDir(garage), 'assets/library/locations/garage');
  assert.equal(planAssetLayout(project()).mapping.get('assets/ref_3.png'),
    'assets/library/locations/garage/garage_01.png');
});

test('shot media splits by kind under the scene and shot it belongs to', () => {
  const { mapping } = planAssetLayout(project());
  assert.equal(mapping.get('assets/img_10.png'), 'assets/shots/01-act-1-cold-open/01-the-dawn/images/the-dawn_v01.png');
  assert.equal(mapping.get('assets/img_20.png'), 'assets/shots/01-act-1-cold-open/01-the-dawn/images/the-dawn_v02.png');
  assert.equal(mapping.get('assets/vid_30.mp4'), 'assets/shots/01-act-1-cold-open/01-the-dawn/video/the-dawn_v01.mp4');
});

test('version numbers follow the order the iterations were generated in', () => {
  // The selected image is read after the outputs on purpose: reading it first
  // would hand whichever iteration happens to be selected the number v01 and
  // renumber the rest around it every time the selection changed.
  const { mapping } = planAssetLayout(project());
  assert.equal(mapping.get('assets/img_10.png').endsWith('_v01.png'), true);
  assert.equal(mapping.get('assets/img_20.png').endsWith('_v02.png'), true);
});

test('the reference board is one flat folder named after each reference', () => {
  assert.equal(planAssetLayout(project()).mapping.get('assets/ref_9.png'),
    'assets/reference/rain-lighting_01.png');
});

test('a file two owners point at lands once, under the stronger claim', () => {
  // ref_2 is Ralph's primary; a shot also picked it. It is Ralph's.
  const state = project();
  state.scenes[0].shots[0].selectedImage = 'assets/ref_2.png';
  const { moves, mapping } = planAssetLayout(state);
  assert.equal(mapping.get('assets/ref_2.png'), 'assets/library/characters/ralph/ralph_01.png');
  assert.equal(moves.filter(move => move.from === 'assets/ref_2.png').length, 1);
});

test('a gallery crop nothing else points at goes to the bin', () => {
  assert.equal(planAssetLayout(project()).mapping.get('assets/crop_99.png'), 'assets/bin/crop_99.png');
});

test('a file on disk the project has forgotten goes to the bin too', () => {
  const { mapping } = planAssetLayout(project(), { existingFiles: ['assets/img_stray.png'] });
  assert.equal(mapping.get('assets/img_stray.png'), 'assets/bin/img_stray.png');
});

test('a file the project does point at is never swept up as a stray', () => {
  const { mapping } = planAssetLayout(project(), { existingFiles: ['assets/img_10.png'] });
  assert.equal(mapping.get('assets/img_10.png').startsWith('assets/shots/'), true);
});

test('the watermark is pinned — it belongs to the project, not to a shot', () => {
  const state = { ...project(), watermarkImage: 'assets/mark.png' };
  const { mapping } = planAssetLayout(state, { existingFiles: ['assets/mark.png'] });
  assert.equal(mapping.has('assets/mark.png'), false);
});

test('running it twice moves nothing the second time', () => {
  const first = planAssetLayout(project());
  assert.ok(first.moves.length > 0);

  // Rebuild the state as the first run left it, then plan again.
  const swap = (value) => first.mapping.get(value) || value;
  const state = project();
  const cleaned = {
    assetLibrary: state.assetLibrary.map(asset => ({
      ...asset,
      primaryImage: asset.primaryImage ? swap(asset.primaryImage) : undefined,
      images: (asset.images || []).map(swap)
    })),
    referenceImages: state.referenceImages.map(ref => ({ ...ref, path: swap(ref.path) })),
    scenes: state.scenes.map(scene => ({
      ...scene,
      shots: scene.shots.map(shot => ({
        ...shot,
        selectedImage: swap(shot.selectedImage),
        selectedVideo: swap(shot.selectedVideo),
        imagePrompts: shot.imagePrompts.map(group => ({
          ...group,
          outputs: group.outputs.map(output => ({ ...output, path: swap(output.path) }))
        }))
      }))
    })),
    imageGallery: state.imageGallery.map(item => ({ ...item, path: swap(item.path) })),
    videoGallery: []
  };

  const second = planAssetLayout(cleaned);
  assert.deepEqual(second.moves, []);
  assert.equal(second.summary.moving, 0);
});

test('deleting an iteration does not renumber the ones that survived it', () => {
  // v02 keeps its number when v01 is gone. Renumbering would rewrite every
  // checkpoint path that mentioned it to close a gap nobody was troubled by.
  const state = {
    scenes: [{
      name: 'Cold Open', number: 1,
      shots: [{
        id: 's1', name: 'The Dawn',
        imagePrompts: [{ outputs: [{ path: 'assets/shots/01-cold-open/01-the-dawn/images/the-dawn_v02.png' }] }]
      }]
    }]
  };
  assert.deepEqual(planAssetLayout(state).moves, []);
});

test('a newly generated file fills the gap the deleted one left', () => {
  const state = {
    scenes: [{
      name: 'Cold Open', number: 1,
      shots: [{
        id: 's1', name: 'The Dawn',
        imagePrompts: [{ outputs: [
          { path: 'assets/shots/01-cold-open/01-the-dawn/images/the-dawn_v02.png' },
          { path: 'assets/img_new.png' }
        ] }]
      }]
    }]
  };
  assert.equal(planAssetLayout(state).mapping.get('assets/img_new.png'),
    'assets/shots/01-cold-open/01-the-dawn/images/the-dawn_v01.png');
});

test('the summary counts what will actually happen, for the dialog to say', () => {
  const { summary } = planAssetLayout(project(), { existingFiles: ['assets/img_stray.png'] });
  assert.equal(summary.moving, summary.total - summary.alreadyPlaced);
  assert.equal(summary.binned, 2); // the gallery crop and the stray
});

test('two shots with the same name keep separate folders, by position', () => {
  const state = {
    scenes: [{
      name: 'Cold Open', number: 1,
      shots: [
        { id: 's1', name: 'Insert', selectedImage: 'assets/a.png' },
        { id: 's2', name: 'Insert', selectedImage: 'assets/b.png' }
      ]
    }]
  };
  const { mapping } = planAssetLayout(state);
  assert.equal(mapping.get('assets/a.png'), 'assets/shots/01-cold-open/01-insert/images/insert_v01.png');
  assert.equal(mapping.get('assets/b.png'), 'assets/shots/01-cold-open/02-insert/images/insert_v01.png');
});

test('a claim on something outside the media root is not a claim at all', () => {
  // Audio references may be http URLs or asset:// ids. They are not files here.
  const state = {
    scenes: [{
      name: 'S', number: 1,
      shots: [{ id: 's1', name: 'Shot', audioRefs: ['https://example.com/a.mp3', 'asset://xyz'] }]
    }]
  };
  assert.deepEqual(collectClaims(state), []);
});

// --- writing new files in the right place ----------------------------------

test('a generation destined for a shot resolves to that shot folder', () => {
  const state = project();
  assert.equal(destinationDir({ kind: 'shot', shotId: 's1', media: 'video' }, state),
    'assets/shots/01-act-1-cold-open/01-the-dawn/video');
  assert.deepEqual(destinationStem({ kind: 'shot', shotId: 's1' }, state),
    { stem: 'the-dawn', versioned: true });
});

test('a generation destined for an asset resolves to that asset folder', () => {
  assert.equal(destinationDir({ kind: 'asset', assetId: 'a2' }, project()),
    'assets/library/locations/garage');
});

test('a descriptor carrying its own names needs no project state at all', () => {
  // The server's copy of the project is whatever the last autosave wrote. A
  // shot generated seconds after it was created is not in it yet, so an id
  // would resolve to nothing and the file would land in the bin.
  const descriptor = {
    kind: 'shot', media: 'image',
    scene: { index: 0, name: 'Act 1 - Cold Open', number: 1 },
    shot: { index: 0, name: '1.1 - The Dawn' }
  };
  assert.equal(destinationDir(descriptor, {}), 'assets/shots/01-act-1-cold-open/01-the-dawn/images');
  assert.deepEqual(destinationStem(descriptor, {}), { stem: 'the-dawn', versioned: true });
});

test('a descriptor is untrusted input and cannot escape the tree', () => {
  const descriptor = {
    kind: 'shot', media: 'image',
    scene: { index: 0, name: '../../../etc' },
    shot: { index: 0, name: '..' }
  };
  const dir = destinationDir(descriptor, {});
  assert.equal(dir.startsWith('assets/shots/'), true);
  assert.equal(dir.includes('..'), false);
});

test('an asset descriptor works from its own type and tag', () => {
  assert.equal(destinationDir({ kind: 'asset', asset: { type: 'prop', tag: 'Wrench' } }, {}),
    'assets/library/props/wrench');
});

test('a destination the studio cannot resolve falls back to the bin, never the root', () => {
  // Failing a paid generation over an unknown shot id would be worse, and
  // scattering it at the root is what this whole change exists to stop.
  assert.equal(destinationDir({ kind: 'shot', shotId: 'gone' }, project()), BIN_DIR);
  assert.equal(destinationDir({ kind: 'asset', assetId: 'gone' }, project()), BIN_DIR);
  assert.equal(destinationDir(null, project()), BIN_DIR);
  assert.equal(destinationDir({ kind: 'nonsense' }, project()), BIN_DIR);
});

test('a new file takes the next number after the highest already there', () => {
  assert.equal(nextFileName('the-dawn', true, '.png', []), 'the-dawn_v01.png');
  assert.equal(nextFileName('the-dawn', true, '.png', ['the-dawn_v01.png', 'the-dawn_v02.png']), 'the-dawn_v03.png');
  // Continues past a gap rather than filling it: two generations running at
  // once must never be handed the same name.
  assert.equal(nextFileName('the-dawn', true, '.png', ['the-dawn_v03.png']), 'the-dawn_v04.png');
});

test('numbering only counts siblings of the same stem and extension', () => {
  const siblings = ['the-dawn_v07.mp4', 'other_v09.png', 'the-dawn_v02.png'];
  assert.equal(nextFileName('the-dawn', true, '.png', siblings), 'the-dawn_v03.png');
});
