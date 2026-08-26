// End-to-end for the autosave guard: a real server, a real project file on
// disk, and the four ways a save gets refused.
//
// The unit tests in projectGuard.test.js cover the decisions; this covers the
// wiring, which is where the original bug actually lived — the rules were never
// wrong, they simply were not consulted.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3987;
const BASE = `http://127.0.0.1:${PORT}`;

const placeholderShot = {
  id: 'shot_1',
  setup: 'Wide establishing shot of a futuristic cyberpunk city skyline, neon lights reflecting in the rain.',
  dialogue: 'A voiceover says: "Welcome to New Eden, where dreams are manufactured."'
};
const defaultProject = { scenes: [{ id: 'sc1', shots: [placeholderShot] }] };

function realProject(count) {
  return {
    scenes: [{
      id: 'sc1',
      shots: Array.from({ length: count }, (_, i) => ({ id: `shot_${i}`, setup: `Take ${i}` }))
    }]
  };
}

let child;
let root;
let projectPath;
let configPath;

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

/** GET the state and hand back the baseline it was read at. */
async function load() {
  const res = await fetch(`${BASE}/api/state`);
  return {
    status: res.status,
    revision: res.headers.get('X-MM-Revision'),
    target: res.headers.get('X-MM-Target'),
    body: await res.json()
  };
}

async function save(state, { revision, target, force } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (revision !== undefined) headers['X-MM-Base-Revision'] = revision;
  if (target) headers['X-MM-Target'] = target;
  if (force) headers['X-MM-Force'] = '1';
  const res = await fetch(`${BASE}/api/state`, {
    method: 'POST', headers, body: JSON.stringify(state)
  });
  return { status: res.status, body: await res.json() };
}

/** What is actually on disk, which is the only thing that matters here. */
function onDisk() {
  return JSON.parse(fs.readFileSync(projectPath, 'utf8')).state;
}

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-guard-'));
  const projectDir = path.join(root, 'Hawaii');
  fs.mkdirSync(projectDir, { recursive: true });
  projectPath = path.join(projectDir, 'Hawaii.mmproj.json');
  fs.writeFileSync(projectPath, JSON.stringify({
    format: 'moviemaker-project', formatVersion: 1, name: 'Hawaii',
    workingFolder: projectDir, state: realProject(45)
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

test('a read hands back the revision it read', async () => {
  const loaded = await load();
  assert.strictEqual(loaded.status, 200);
  assert.strictEqual(loaded.body.scenes[0].shots.length, 45);
  assert.match(loaded.revision, /^\d+:\d+$/);
  assert.strictEqual(path.resolve(loaded.target), path.resolve(projectPath));
});

test('an ordinary save based on the current revision goes through', async () => {
  const loaded = await load();
  const result = await save(realProject(46), { revision: loaded.revision, target: loaded.target });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(onDisk().scenes[0].shots.length, 46);
  // The reply carries the new baseline so the window can keep saving.
  assert.notStrictEqual(result.body.revision, loaded.revision);
});

test('a save with no baseline at all is refused', async () => {
  const result = await save(realProject(2));
  assert.strictEqual(result.status, 409);
  assert.strictEqual(result.body.reason, 'no-baseline');
  assert.strictEqual(onDisk().scenes[0].shots.length, 46);
});

test('a stale window cannot revert a project another window moved on', async () => {
  const stale = await load();
  // Another window writes in the meantime.
  await save(realProject(50), { revision: stale.revision, target: stale.target });

  const result = await save(realProject(47), { revision: stale.revision, target: stale.target });
  assert.strictEqual(result.status, 409);
  assert.strictEqual(result.body.reason, 'stale');
  assert.strictEqual(onDisk().scenes[0].shots.length, 50);
});

test('the placeholder project cannot land on a real one, even at the right revision', async () => {
  const loaded = await load();
  const result = await save(defaultProject, { revision: loaded.revision, target: loaded.target });
  assert.strictEqual(result.status, 409);
  assert.strictEqual(result.body.reason, 'placeholder');
  assert.strictEqual(result.body.before.shots, 50);
  assert.strictEqual(onDisk().scenes[0].shots.length, 50);
});

test('an empty save cannot wipe a real project', async () => {
  const loaded = await load();
  const result = await save({ scenes: [] }, { revision: loaded.revision, target: loaded.target });
  assert.strictEqual(result.status, 409);
  assert.strictEqual(result.body.reason, 'empty');
  assert.strictEqual(onDisk().scenes[0].shots.length, 50);
});

test('a forced save is allowed and keeps a copy of what it replaced', async () => {
  const loaded = await load();
  const result = await save(defaultProject, { revision: loaded.revision, target: loaded.target, force: true });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(onDisk().scenes[0].shots.length, 1);

  const backups = fs.readdirSync(path.join(path.dirname(projectPath), 'checkpoints', 'auto-backups'));
  assert.strictEqual(backups.length, 1);
  const kept = JSON.parse(fs.readFileSync(
    path.join(path.dirname(projectPath), 'checkpoints', 'auto-backups', backups[0]), 'utf8'
  ));
  assert.strictEqual(kept.state.scenes[0].shots.length, 50);
});

test('an unreachable project is an error, never a fresh placeholder', async () => {
  // Exactly what a dropped drive looks like from here.
  fs.writeFileSync(configPath, JSON.stringify({
    activeProjectPath: path.join(root, 'Q-drive-gone', 'project.mmproj.json')
  }, null, 2));

  const loaded = await load();
  assert.strictEqual(loaded.status, 503);
  assert.strictEqual(loaded.body.reason, 'project-unreachable');
  // The old behaviour returned the built-in starter project here, which is what
  // the app then autosaved over the real file when the drive came back.
  assert.ok(!loaded.body.scenes && !loaded.body.shots);

  const result = await save(realProject(3), { revision: 'anything' });
  assert.strictEqual(result.status, 503);
  assert.strictEqual(result.body.reason, 'project-unreachable');
  // Nothing was written to the loose legacy file either.
  assert.ok(!fs.existsSync(path.join(__dirname, 'project_state.json.tmp')));
});
