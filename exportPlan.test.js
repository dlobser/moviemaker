// node --test exportPlan.test.js
//
// The export exists to be read by a human months later, so the failures that
// matter are the quiet ones: two shots that collapse onto the same filename and
// silently lose a take, a name Windows refuses, a metadata file pointing at a
// path that only means something inside the project.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildExportPlan, sanitizeName, uniqueDestination, extensionOf } = require('./exportPlan');

// --- names ------------------------------------------------------------------

test('illegal characters go, meaningful ones stay', () => {
  assert.equal(sanitizeName('Act 1 - The Doors'), 'Act 1 - The Doors');
  assert.equal(sanitizeName('a/b:c*d'), 'a b c d');
  assert.equal(sanitizeName('SceneOne'), 'Scene One');
});

test('a name that is nothing but punctuation falls back', () => {
  assert.equal(sanitizeName('   '), 'untitled');
  assert.equal(sanitizeName('..'), 'untitled');
  assert.equal(sanitizeName(null, 'Shot'), 'Shot');
});

// Windows refuses these outright, whatever extension you give them.
test('device names are escaped', () => {
  assert.equal(sanitizeName('CON'), 'CON_');
  assert.equal(sanitizeName('lpt3'), 'lpt3_');
  assert.equal(sanitizeName('CONTROL'), 'CONTROL');
});

test('trailing dots and spaces are trimmed, because Windows drops them anyway', () => {
  assert.equal(sanitizeName('Scene One...'), 'Scene One');
  assert.equal(sanitizeName('  padded  '), 'padded');
});

test('extensions are read off the source and lowercased', () => {
  assert.equal(extensionOf('assets/img_1.PNG'), '.png');
  assert.equal(extensionOf('assets/vid_1.mp4'), '.mp4');
  assert.equal(extensionOf('assets/nameless'), '.png');
  assert.equal(extensionOf('assets/nameless', '.mp4'), '.mp4');
});

// --- collisions -------------------------------------------------------------

test('a repeated destination is suffixed rather than overwritten', () => {
  const taken = new Set();
  assert.equal(uniqueDestination(taken, 'a/b.png'), 'a/b.png');
  assert.equal(uniqueDestination(taken, 'a/b.png'), 'a/b (2).png');
  assert.equal(uniqueDestination(taken, 'a/b.png'), 'a/b (3).png');
});

test('collisions are case-insensitive, because two of three filesystems are', () => {
  const taken = new Set();
  uniqueDestination(taken, 'Scene/Shot.png');
  assert.equal(uniqueDestination(taken, 'scene/shot.png'), 'scene/shot (2).png');
});

test('two shots with the same name keep both takes', () => {
  const scenes = [{
    name: 'One',
    shots: [
      { name: 'Untitled', imagePrompts: [{ prompt: 'a', outputs: [{ path: 'assets/1.png' }] }] },
      { name: 'Untitled', imagePrompts: [{ prompt: 'b', outputs: [{ path: 'assets/2.png' }] }] }
    ]
  }];
  const { copies } = buildExportPlan({ scenes });
  assert.equal(copies.length, 2);
  assert.notEqual(copies[0].to, copies[1].to);
});

// --- layout -----------------------------------------------------------------

const project = {
  scenes: [{
    name: 'Act 1 - The Doors',
    shots: [{
      name: 'Henry Mops',
      setup: 'low angle',
      selectedImage: 'assets/img_b.png',
      selectedVideo: 'assets/vid_a.mp4',
      imagePrompts: [{
        id: 'g1',
        model: 'fal-ai/flux/schnell',
        prompt: 'a man mopping',
        inputImagePaths: ['assets/ref_henry.png'],
        outputs: [{ path: 'assets/img_a.png' }, { path: 'assets/img_b.png' }]
      }],
      videoPrompts: [{
        id: 'g2',
        model: 'atlas:bytedance/seedance-2.0/image-to-video',
        prompt: 'he mops slowly',
        outputs: [{ path: 'assets/vid_a.mp4' }]
      }]
    }]
  }],
  assetLibrary: [{ id: 'a1', tag: 'Henry', name: 'Henry', primaryImage: 'assets/henry_1.png', images: ['assets/henry_1.png', 'assets/henry_2.png'] }],
  referenceImages: [{ id: 'r1', path: 'assets/ref_henry.png', name: 'henry closeup.png', kind: 'character', assetId: 'a1' }],
  checkpoints: [{ id: 'cp1', name: 'before the rewrite', state: {} }]
};

test('scenes become folders and shots become readable filenames', () => {
  const { copies } = buildExportPlan(project);
  const scene = copies.filter(c => c.to.startsWith('Scene 01 - Act 1 - The Doors/'));
  assert.equal(scene.length, 3); // two images, one video
  assert.ok(scene.some(c => c.to.endsWith('Shot 01 - Henry Mops - image 01.png')));
  assert.ok(scene.some(c => c.to.endsWith('Shot 01 - Henry Mops - video 01 (selected).mp4')));
});

test('the selected take says so in its name', () => {
  const { copies } = buildExportPlan(project);
  const selected = copies.find(c => c.from === 'assets/img_b.png');
  assert.match(selected.to, /\(selected\)\.png$/);
  const other = copies.find(c => c.from === 'assets/img_a.png');
  assert.doesNotMatch(other.to, /selected/);
});

test('assets and references get their own folders, named by tag and kind', () => {
  const { copies } = buildExportPlan(project);
  assert.ok(copies.some(c => c.to === 'assets/Henry - 01 (primary).png'));
  assert.ok(copies.some(c => c.to === 'assets/Henry - 02.png'));
  assert.ok(copies.some(c => c.to === 'reference/character - henry closeup.png'));
});

test('every copied file is claimed exactly once', () => {
  const { copies } = buildExportPlan(project);
  const sources = copies.map(c => c.from);
  assert.equal(new Set(sources).size, sources.length, 'a source was copied twice');
  const destinations = copies.map(c => c.to.toLowerCase());
  assert.equal(new Set(destinations).size, destinations.length, 'two files share a destination');
});

// --- metadata ---------------------------------------------------------------

test('the shot metadata carries prompts, models and where the references went', () => {
  const { writes } = buildExportPlan(project);
  const sheet = writes.find(w => w.to === 'Scene 01 - Act 1 - The Doors/Shot 01 - Henry Mops.txt');
  assert.ok(sheet, 'no metadata file for the shot');
  assert.match(sheet.contents, /a man mopping/);
  assert.match(sheet.contents, /he mops slowly/);
  assert.match(sheet.contents, /fal-ai\/flux\/schnell/);
  assert.match(sheet.contents, /seedance-2\.0/);
  assert.match(sheet.contents, /low angle/);
});

// A path like `assets/ref_henry.png` means nothing once the export is zipped
// and mailed; it has to point at the copy that travelled with it.
test('references are linked where they landed, not where they came from', () => {
  const { writes } = buildExportPlan(project);
  const sheet = writes.find(w => w.to.endsWith('Shot 01 - Henry Mops.txt'));
  assert.match(sheet.contents, /\.\.\/reference\/character - henry closeup\.png/);
  assert.doesNotMatch(sheet.contents, /REFERENCES SENT[\s\S]*assets\/ref_henry\.png/);
});

test('a reference that was sent but never boarded is flagged, not hidden', () => {
  const orphan = {
    scenes: [{ name: 'S', shots: [{ name: 'A', imagePrompts: [{ prompt: 'p', inputImagePaths: ['assets/gone.png'], outputs: [{ path: 'assets/o.png' }] }] }] }]
  };
  const { writes } = buildExportPlan(orphan);
  assert.match(writes[0].contents, /\(not exported\) assets\/gone\.png/);
});

test('checkpoints are written out under their names', () => {
  const { writes } = buildExportPlan(project);
  const checkpoint = writes.find(w => w.to === 'checkpoints/before the rewrite.json');
  assert.ok(checkpoint);
  assert.equal(JSON.parse(checkpoint.contents).id, 'cp1');
});

test('an empty project produces an empty plan rather than throwing', () => {
  const plan = buildExportPlan({});
  assert.deepEqual(plan.copies, []);
  assert.deepEqual(plan.writes, []);
});
