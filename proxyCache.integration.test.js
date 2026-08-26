// End-to-end for the preview proxy cache: a real server, a real ffmpeg, a real
// source file, and the proxy that comes out the other side.
//
// The thing worth proving is not that ffmpeg runs — it is that the proxy is
// actually built for seeking (short GOP, small frame) and that the identity
// rules hold: same source, same proxy; changed source, new proxy.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const { proxyKindFor, proxyNameFor, parseProgress, readSettings, buildArgs } = require('./proxyCache.js');

const PORT = 3988;
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let root;
let projectDir;
let workFolder;
let configPath;
let hasFfmpeg = true;

function post(route, body) {
  return fetch(`${BASE}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  }).then(async res => ({ status: res.status, body: await res.json() }));
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${BASE}/api/config`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server never came up');
}

/** Poll the cache until this source stops being a work in progress. */
async function settle(relative, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    const { body } = await post('/api/cache/status', { paths: [relative] });
    const status = body.results[relative];
    if (status.state !== 'building' && status.state !== 'none') return status;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('proxy never finished');
}

test.before(async () => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    hasFfmpeg = false;
    return;
  }

  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-proxy-'));
  projectDir = path.join(root, 'Reel');
  workFolder = path.join(root, 'work');
  fs.mkdirSync(path.join(projectDir, 'assets'), { recursive: true });

  // Three seconds of moving colour at 720p with a tone under it: enough to have
  // a real GOP structure and a real audio stream.
  execFileSync('ffmpeg', [
    '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=24:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    path.join(projectDir, 'assets', 'take.mp4')
  ], { stdio: 'ignore' });

  fs.writeFileSync(path.join(projectDir, 'Reel.mmproj.json'), JSON.stringify({
    format: 'moviemaker-project', formatVersion: 1, name: 'Reel', state: { scenes: [] }
  }, null, 2));

  configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    activeProjectPath: path.join(projectDir, 'Reel.mmproj.json'),
    previewCache: { enabled: true, folder: workFolder, height: 270 }
  }, null, 2));

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

// --- the pure parts ---------------------------------------------------------

test('only media that needs a proxy gets one', () => {
  assert.strictEqual(proxyKindFor('assets/take.mp4'), 'video');
  assert.strictEqual(proxyKindFor('assets/music.mp3'), 'audio');
  // A still already decodes instantly; transcoding it would be pure cost.
  assert.strictEqual(proxyKindFor('assets/frame.png'), null);
  assert.strictEqual(proxyKindFor('assets/notes.txt'), null);
});

test('the proxy name changes when the source or the settings do', () => {
  const settings = { height: 360 };
  const base = proxyNameFor('C:/p/a.mp4', { mtimeMs: 100, size: 20 }, 'video', settings);

  assert.strictEqual(base, proxyNameFor('C:/p/a.mp4', { mtimeMs: 100, size: 20 }, 'video', settings));
  // A re-generated take written over the same name must not keep the old proxy.
  assert.notStrictEqual(base, proxyNameFor('C:/p/a.mp4', { mtimeMs: 200, size: 20 }, 'video', settings));
  assert.notStrictEqual(base, proxyNameFor('C:/p/a.mp4', { mtimeMs: 100, size: 21 }, 'video', settings));
  assert.notStrictEqual(base, proxyNameFor('C:/p/a.mp4', { mtimeMs: 100, size: 20 }, 'video', { height: 720 }));
  assert.match(base, /\.mp4$/);
  assert.match(proxyNameFor('C:/p/a.mp3', { mtimeMs: 1, size: 2 }, 'audio', settings), /\.m4a$/);
});

test('the encode is built for seeking, not for looking good', () => {
  const args = buildArgs('in.mp4', 'out.mp4', 'video', { height: 360 }).join(' ');
  assert.match(args, /-vf scale=-2:360/);
  // The three flags that make an arbitrary frame cheap to reach.
  assert.match(args, /-g 6/);
  assert.match(args, /-keyint_min 1/);
  assert.match(args, /-sc_threshold 0/);
});

test('progress is read out of ffmpeg own reporting', () => {
  assert.strictEqual(parseProgress('out_time_us=1500000\n', 3), 0.5);
  // Several lines in one chunk: the last one is where it has got to.
  assert.strictEqual(parseProgress('out_time_us=500000\nout_time_us=1500000\n', 3), 0.5);
  assert.strictEqual(parseProgress('frame=12\n', 3), null);
  assert.strictEqual(parseProgress('out_time_us=1000\n', 0), null);
});

test('settings fall back to something sane and clamp what they are given', () => {
  const fallback = readSettings({});
  assert.strictEqual(fallback.enabled, true);
  assert.strictEqual(fallback.height, 360);
  assert.ok(fallback.folder.length > 0);
  // Out of range, and odd heights, would both make ffmpeg unhappy.
  assert.strictEqual(readSettings({ previewCache: { height: 5000 } }).height, 360);
  assert.strictEqual(readSettings({ previewCache: { height: 361 } }).height, 362);
  assert.strictEqual(readSettings({ previewCache: { enabled: false } }).enabled, false);
});

// --- the whole thing --------------------------------------------------------

test('a source gets a proxy, and it is much smaller than the original', async (t) => {
  if (!hasFfmpeg) return t.skip('no ffmpeg on PATH');

  const relative = 'assets/take.mp4';
  const before = await post('/api/cache/status', { paths: [relative] });
  assert.strictEqual(before.body.results[relative].state, 'none');

  await post('/api/cache/build', { paths: [relative] });
  const status = await settle(relative);
  assert.strictEqual(status.state, 'ready', status.error);

  const proxy = path.join(workFolder, status.name);
  assert.ok(fs.existsSync(proxy));
  const source = path.join(projectDir, 'assets', 'take.mp4');
  assert.ok(fs.statSync(proxy).size < fs.statSync(source).size);

  // And it is the size we asked for.
  const probe = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_streams', proxy
  ]).toString());
  const video = probe.streams.find(stream => stream.codec_type === 'video');
  assert.strictEqual(video.height, 270);
  // The sound has to come with it, or every clip goes silent in preview.
  assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));
});

test('the proxy is served over HTTP, ready to play', async (t) => {
  if (!hasFfmpeg) return t.skip('no ffmpeg on PATH');
  const status = await settle('assets/take.mp4');
  const res = await fetch(`${BASE}${status.url}`);
  assert.strictEqual(res.status, 200);
  assert.ok(Number(res.headers.get('content-length')) > 0);
});

test('a second ask for a proxy that exists is free', async (t) => {
  if (!hasFfmpeg) return t.skip('no ffmpeg on PATH');
  const queued = await post('/api/cache/build', { paths: ['assets/take.mp4'] });
  assert.strictEqual(queued.body.queued, 0);
});

test('a path that climbs out of the project is refused', async (t) => {
  if (!hasFfmpeg) return t.skip('no ffmpeg on PATH');
  // Media extension, so it gets past the "does this want a proxy" check and
  // reaches the guard that actually matters.
  const escape = '../../../elsewhere/private.mp4';
  const { body } = await post('/api/cache/status', { paths: [escape] });
  assert.strictEqual(body.results[escape].state, 'missing');

  // And nothing that is not media is transcoded at all.
  const inert = 'assets/notes.txt';
  assert.strictEqual((await post('/api/cache/status', { paths: [inert] })).body.results[inert].state, 'native');
});

test('turning the cache off stops it building anything', async (t) => {
  if (!hasFfmpeg) return t.skip('no ffmpeg on PATH');
  await post('/api/cache/settings', { enabled: false });
  const status = await post('/api/cache/status', { paths: ['assets/take.mp4'] });
  assert.strictEqual(status.body.results['assets/take.mp4'].state, 'off');
  assert.strictEqual((await post('/api/cache/build', { paths: ['assets/take.mp4'] })).body.enabled, false);
  await post('/api/cache/settings', { enabled: true });
});

test('a work folder that cannot be written to is rejected, not adopted', async (t) => {
  if (!hasFfmpeg) return t.skip('no ffmpeg on PATH');
  const before = (await post('/api/cache/settings', {})).body.folder;
  const bad = await post('/api/cache/settings', { folder: 'Z:\\definitely\\not\\a\\drive' });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual((await post('/api/cache/settings', {})).body.folder, before);
});

test('clearing empties the work folder', async (t) => {
  if (!hasFfmpeg) return t.skip('no ffmpeg on PATH');
  await settle('assets/take.mp4');
  assert.ok((await post('/api/cache/settings', {})).body.usage.files > 0);

  await post('/api/cache/clear', {});
  assert.strictEqual((await post('/api/cache/settings', {})).body.usage.files, 0);
  // And the source is offered for rebuilding again rather than reported ready.
  const after = await post('/api/cache/status', { paths: ['assets/take.mp4'] });
  assert.strictEqual(after.body.results['assets/take.mp4'].state, 'none');
});
