// End-to-end for Clean Files: a real server, a real project folder full of
// flat timestamped files, and the tree that should exist afterwards.
//
// The unit tests prove the plan and the moves separately. This proves the
// wiring — that the endpoint plans against the state it was handed, that a dry
// run really is dry, that the mapping describes what happened rather than what
// was intended, and that a path recorded before the move still serves.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3986;
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let root;
let projectDir;
let projectPath;
let configPath;

// A project with one scene, one shot, one character and a stray on disk.
const state = () => ({
  scenes: [{
    id: 'sc1', name: 'Act 1 - Cold Open', number: 1,
    shots: [{
      id: 'shot_1', name: '1.1 - The Dawn',
      selectedImage: 'assets/img_200.png',
      selectedVideo: 'assets/vid_300.mp4',
      imagePrompts: [{ outputs: [{ path: 'assets/img_100.png' }, { path: 'assets/img_200.png' }] }]
    }]
  }],
  assetLibrary: [{
    id: 'a1', tag: 'Ralph', type: 'character',
    primaryImage: 'assets/ref_1.png', images: ['assets/ref_1.png']
  }],
  referenceImages: [{ id: 'r1', path: 'assets/ref_9.png', name: 'Rain lighting' }],
  imageGallery: [{ path: 'assets/img_100.png' }],
  videoGallery: []
});

const FILES = [
  'assets/img_100.png', 'assets/img_200.png', 'assets/vid_300.mp4',
  'assets/ref_1.png', 'assets/ref_9.png', 'assets/stray_500.png'
];

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const res = await fetch(`${BASE}/api/config`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server never came up');
}

function organize(body) {
  return fetch(`${BASE}/api/assets/organize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(async res => ({ status: res.status, body: await res.json() }));
}

const onDisk = (relative) => fs.existsSync(path.join(projectDir, relative));

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-organize-'));
  projectDir = path.join(root, 'Hawaii');
  fs.mkdirSync(path.join(projectDir, 'assets'), { recursive: true });
  FILES.forEach(relative => fs.writeFileSync(path.join(projectDir, relative), relative));

  projectPath = path.join(projectDir, 'Hawaii.mmproj.json');
  fs.writeFileSync(projectPath, JSON.stringify({
    format: 'moviemaker-project', formatVersion: 1, name: 'Hawaii',
    workingFolder: projectDir, state: state()
  }, null, 2));

  configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ activeProjectPath: projectPath }, null, 2));

  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, MM_CONFIG: configPath, PORT: String(PORT) },
    stdio: 'ignore'
  });
  await waitForServer();
});

test.after(() => {
  if (child) child.kill();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows lock */ }
});

test('a dry run reports the work and touches nothing at all', async () => {
  const { status, body } = await organize({ state: state(), apply: false });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.applied, false);
  assert.strictEqual(body.moves, 6);
  assert.strictEqual(body.summary.binned, 1); // the stray
  assert.ok(body.preview.length > 0);
  FILES.forEach(relative => assert.strictEqual(onDisk(relative), true, `${relative} should be untouched`));
});

test('applying it files every kind of asset where it belongs', async () => {
  const { status, body } = await organize({ state: state(), apply: true });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.applied, true);
  assert.deepStrictEqual(body.failed, []);

  const mapping = new Map(body.mapping);
  assert.strictEqual(mapping.get('assets/ref_1.png'), 'assets/library/characters/ralph/ralph_01.png');
  assert.strictEqual(mapping.get('assets/ref_9.png'), 'assets/reference/rain-lighting_01.png');
  assert.strictEqual(mapping.get('assets/img_100.png'),
    'assets/shots/01-act-1-cold-open/01-the-dawn/images/the-dawn_v01.png');
  assert.strictEqual(mapping.get('assets/vid_300.mp4'),
    'assets/shots/01-act-1-cold-open/01-the-dawn/video/the-dawn_v01.mp4');
  assert.strictEqual(mapping.get('assets/stray_500.png'), 'assets/bin/stray_500.png');

  // And the files really are there, with their own contents.
  for (const [from, to] of body.mapping) {
    assert.strictEqual(onDisk(from), false, `${from} should have moved`);
    assert.strictEqual(fs.readFileSync(path.join(projectDir, to), 'utf8'), from);
  }
});

test('a path recorded before the move still serves, so old checkpoints render', async () => {
  const res = await fetch(`${BASE}/assets/img_100.png`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.text(), 'assets/img_100.png');
});

test('a file that never existed is still a 404', async () => {
  const res = await fetch(`${BASE}/assets/never_here.png`);
  assert.strictEqual(res.status, 404);
});

test('the media listing walks the whole tree, not just the root', async () => {
  const media = await fetch(`${BASE}/api/project-media`).then(r => r.json());
  const paths = media.map(item => item.path);
  assert.ok(paths.includes('assets/library/characters/ralph/ralph_01.png'));
  assert.ok(paths.includes('assets/shots/01-act-1-cold-open/01-the-dawn/video/the-dawn_v01.mp4'));
  assert.strictEqual(media.find(item => item.path.endsWith('.mp4')).type, 'video');
});

test('running it again on the cleaned state is a no-op', async () => {
  // The state the client would hold after remapping through the first run.
  const cleaned = {
    scenes: [{
      id: 'sc1', name: 'Act 1 - Cold Open', number: 1,
      shots: [{
        id: 'shot_1', name: '1.1 - The Dawn',
        selectedImage: 'assets/shots/01-act-1-cold-open/01-the-dawn/images/the-dawn_v02.png',
        selectedVideo: 'assets/shots/01-act-1-cold-open/01-the-dawn/video/the-dawn_v01.mp4',
        imagePrompts: [{ outputs: [
          { path: 'assets/shots/01-act-1-cold-open/01-the-dawn/images/the-dawn_v01.png' },
          { path: 'assets/shots/01-act-1-cold-open/01-the-dawn/images/the-dawn_v02.png' }
        ] }]
      }]
    }],
    assetLibrary: [{
      id: 'a1', tag: 'Ralph', type: 'character',
      primaryImage: 'assets/library/characters/ralph/ralph_01.png',
      images: ['assets/library/characters/ralph/ralph_01.png']
    }],
    referenceImages: [{ id: 'r1', path: 'assets/reference/rain-lighting_01.png', name: 'Rain lighting' }],
    imageGallery: [{ path: 'assets/shots/01-act-1-cold-open/01-the-dawn/images/the-dawn_v01.png' }],
    videoGallery: []
  };
  const { body } = await organize({ state: cleaned, apply: false });
  assert.strictEqual(body.moves, 0);
  assert.strictEqual(body.summary.moving, 0);
});
