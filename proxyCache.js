// Preview proxies: the reason the editor can play and scrub at all.
//
// The problem is not the app, it is the footage. A generated 1080p take is a
// long-GOP H.264 file, often on a network drive; asking a <video> element to
// land on an exact frame in one means decoding from the last keyframe, which at
// a two-second GOP is dozens of frames of work per scrub tick. Do that for two
// or three clips at once and the picture simply stops following the pointer.
//
// So every source gets transcoded once, in the background, into a small file
// built for exactly this: quarter-ish resolution, a keyframe every few frames,
// and a bitrate that fits in the OS cache. Seeking one is close to free. The
// preview plays proxies and the render still reads the originals, so nothing
// about the finished film changes.
//
// The proxies live in a work folder, not in the project. That is deliberate:
// the whole point is to get the bytes onto a fast local disk when the project
// itself is on something slow, and none of it is precious — every file here can
// be deleted and rebuilt from the source.
//
// A proxy is keyed by the source's path, size and mtime, so a re-generated take
// written to the same name invalidates its proxy for free and there is nothing
// to expire by hand.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

/** How tall a proxy is, unless the project says otherwise. */
const DEFAULT_HEIGHT = 360;

/**
 * Keyframe interval, in frames.
 *
 * The one number that decides whether scrubbing feels connected to the pointer.
 * Six frames is a quarter of a second at 24fps: the decoder never has more than
 * five frames to chew through to reach an arbitrary one, and the file is still
 * a fraction of the size all-intra would be.
 */
const GOP = 6;

/** Two at a time. More just makes every one of them finish later. */
const MAX_CONCURRENT = 2;

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|wmv|mpg|mpeg|ts)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|opus|flac|wma)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

/** What kind of proxy, if any, a path wants. */
function proxyKindFor(assetPath) {
  const name = String(assetPath || '');
  if (IMAGE_EXT.test(name)) return null;   // a still decodes instantly already
  if (AUDIO_EXT.test(name)) return 'audio';
  if (VIDEO_EXT.test(name)) return 'video';
  return null;
}

/**
 * The proxy's filename for a given source.
 *
 * Size and mtime are in the hash, so overwriting a source with a new take
 * silently orphans the old proxy and asks for a new one — no invalidation pass,
 * no staleness bugs. The settings are in it too, so turning the height up
 * rebuilds rather than quietly serving the old size.
 */
function proxyNameFor(absolutePath, stat, kind, settings) {
  const hash = crypto.createHash('sha1')
    .update(path.resolve(absolutePath).toLowerCase())
    .update('|').update(String(Math.round(stat.mtimeMs)))
    .update('|').update(String(stat.size))
    .update('|').update(String(settings.height))
    .update('|').update(kind)
    .digest('hex')
    .slice(0, 20);
  return `${hash}${kind === 'audio' ? '.m4a' : '.mp4'}`;
}

/**
 * ffmpeg arguments for one proxy.
 *
 * The explicit `-f mp4` matters: proxies are written to a `.part` name and
 * renamed on success, and ffmpeg picks its muxer from the extension, so without
 * it every encode dies on "Invalid argument" before it starts.
 */
function buildArgs(source, target, kind, settings) {
  if (kind === 'audio') {
    return [
      '-nostdin', '-y', '-i', source,
      '-vn', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', '-f', 'mp4',
      '-progress', 'pipe:1', '-nostats', '-loglevel', 'error',
      target
    ];
  }
  return [
    '-nostdin', '-y', '-i', source,
    // -2 keeps the width even, which yuv420p requires.
    '-vf', `scale=-2:${settings.height}`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'fastdecode',
    '-crf', '26',
    // The three flags that actually make it seekable: a short GOP, permission
    // to use it, and no scene-cut keyframes lengthening it unpredictably.
    '-g', String(GOP), '-keyint_min', '1', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', '-f', 'mp4',
    '-progress', 'pipe:1', '-nostats', '-loglevel', 'error',
    target
  ];
}

/** ffmpeg's -progress stream, as a fraction of the source duration. */
function parseProgress(chunk, duration) {
  if (!duration || duration <= 0) return null;
  const match = /out_time_us=(\d+)/g;
  let last = null;
  let hit;
  while ((hit = match.exec(chunk)) !== null) last = Number(hit[1]);
  if (last === null) return null;
  return Math.min(0.999, (last / 1e6) / duration);
}

/**
 * The cache itself.
 *
 * One instance per server. It owns the queue, the work folder and the record of
 * what is where; everything else asks it questions.
 */
class ProxyCache {
  constructor({ resolveSettings, resolveSource, probeDuration }) {
    // Read fresh each time rather than captured: the work folder is a setting
    // the user can change while the server is running, and a stale copy would
    // write proxies somewhere nobody is looking for them.
    this.resolveSettings = resolveSettings;
    // Project-relative path -> absolute path on disk.
    this.resolveSource = resolveSource;
    this.probeDuration = probeDuration;

    /** Relative path -> { state, name, progress, error }. */
    this.entries = new Map();
    /** Relative paths waiting to be built, most wanted first. */
    this.queue = [];
    this.running = new Map();
  }

  folder() {
    const settings = this.resolveSettings();
    const dir = settings.folder;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * What we know about a source, refreshed against the disk.
   *
   * Deliberately stat-based rather than trusting the in-memory record: the work
   * folder is an ordinary directory the user can empty from Explorer, and a
   * cache that insists a deleted file is still there is worse than no cache.
   */
  statusOf(relative) {
    const settings = this.resolveSettings();
    if (!settings.enabled) return { state: 'off' };

    const kind = proxyKindFor(relative);
    if (!kind) return { state: 'native' };

    const absolute = this.resolveSource(relative);
    if (!absolute || !fs.existsSync(absolute)) return { state: 'missing' };

    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch {
      return { state: 'missing' };
    }

    const name = proxyNameFor(absolute, stat, kind, settings);
    const target = path.join(settings.folder, name);
    if (fs.existsSync(target)) {
      // A part-written file from a killed encode would play as a truncated
      // clip, so the finished size is the proof, not the existence.
      try {
        if (fs.statSync(target).size > 0) return { state: 'ready', name, url: `/cache/${name}` };
      } catch { /* fall through and rebuild */ }
    }

    const running = this.running.get(relative);
    if (running && running.name === name) {
      return { state: 'building', name, progress: running.progress };
    }

    const record = this.entries.get(relative);
    if (record?.name === name && record.state === 'error') {
      return { state: 'error', error: record.error };
    }

    return { state: 'none', name };
  }

  /**
   * Ask for these sources, in this order.
   *
   * The order is the whole feature. The editor sends what is under the playhead
   * first and works outwards, so the ten seconds you are about to watch are
   * built before the ten minutes you are not.
   */
  request(paths) {
    const wanted = [];
    for (const relative of paths || []) {
      if (typeof relative !== 'string' || !relative) continue;
      const status = this.statusOf(relative);
      if (status.state !== 'none') continue;
      if (wanted.includes(relative)) continue;
      wanted.push(relative);
    }
    // Replace rather than append: a stale queue from three seeks ago is not
    // work worth protecting, and re-requesting is free.
    this.queue = wanted;
    this.pump();
    return this.queue.length;
  }

  pump() {
    while (this.running.size < MAX_CONCURRENT && this.queue.length > 0) {
      const relative = this.queue.shift();
      if (this.running.has(relative)) continue;
      if (this.statusOf(relative).state !== 'none') continue;
      this.build(relative);
    }
  }

  async build(relative) {
    const settings = this.resolveSettings();
    const kind = proxyKindFor(relative);
    const absolute = this.resolveSource(relative);
    if (!kind || !absolute || !fs.existsSync(absolute)) return;

    const stat = fs.statSync(absolute);
    const name = proxyNameFor(absolute, stat, kind, settings);
    const folder = this.folder();
    // Written under a temporary name and renamed, so a half-encoded file can
    // never be picked up as ready — the same reason the project file is.
    const partial = path.join(folder, `${name}.part`);
    const target = path.join(folder, name);

    const job = { name, progress: 0, child: null };
    this.running.set(relative, job);

    let duration = 0;
    try {
      duration = (await this.probeDuration(absolute)) || 0;
    } catch { /* no duration means no progress bar, not no proxy */ }

    const child = spawn('ffmpeg', buildArgs(absolute, partial, kind, settings), { windowsHide: true });
    job.child = child;

    let stderr = '';
    child.stdout.on('data', chunk => {
      const fraction = parseProgress(String(chunk), duration);
      if (fraction !== null) job.progress = fraction;
    });
    child.stderr.on('data', chunk => { stderr += String(chunk); });

    const finish = (state, error) => {
      this.running.delete(relative);
      this.entries.set(relative, { state, name, error });
      this.pump();
    };

    child.on('error', (error) => {
      try { fs.unlinkSync(partial); } catch { /* never created */ }
      finish('error', /ENOENT/.test(error.message)
        ? 'FFmpeg is not installed or not on PATH.'
        : error.message);
    });

    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(partial)) {
        try {
          fs.renameSync(partial, target);
          finish('ready');
          return;
        } catch (error) {
          finish('error', error.message);
          return;
        }
      }
      try { fs.unlinkSync(partial); } catch { /* nothing to clean */ }
      finish('error', stderr.trim().split('\n').slice(-2).join(' ') || `ffmpeg exited ${code}`);
    });
  }

  /** Stop everything in flight and forget what was queued. */
  cancelAll() {
    this.queue = [];
    for (const job of this.running.values()) {
      try { job.child?.kill(); } catch { /* already gone */ }
    }
  }

  /** How much disk the work folder is using, and over how many files. */
  usage() {
    const settings = this.resolveSettings();
    const dir = settings.folder;
    if (!fs.existsSync(dir)) return { files: 0, bytes: 0 };
    let files = 0;
    let bytes = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        bytes += fs.statSync(path.join(dir, entry.name)).size;
        files += 1;
      } catch { /* vanished mid-scan */ }
    }
    return { files, bytes };
  }

  /** Empty the work folder. Nothing here is precious; it all rebuilds. */
  clear() {
    this.cancelAll();
    this.entries.clear();
    const dir = this.resolveSettings().folder;
    if (!fs.existsSync(dir)) return { removed: 0 };
    let removed = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        fs.unlinkSync(path.join(dir, entry.name));
        removed += 1;
      } catch { /* locked by a player; it will go next time */ }
    }
    return { removed };
  }
}

/** Somewhere local and disposable, which is the whole idea. */
function defaultWorkFolder() {
  return path.join(os.tmpdir(), 'moviemaker-cache');
}

/** Coerce whatever is in config.json into usable proxy settings. */
function readSettings(config) {
  const raw = (config && config.previewCache) || {};
  const height = Number(raw.height);
  return {
    enabled: raw.enabled !== false,
    folder: typeof raw.folder === 'string' && raw.folder.trim()
      ? raw.folder.trim()
      : defaultWorkFolder(),
    height: Number.isFinite(height) && height >= 180 && height <= 1080
      ? Math.round(height / 2) * 2
      : DEFAULT_HEIGHT
  };
}

module.exports = {
  ProxyCache,
  proxyKindFor,
  proxyNameFor,
  buildArgs,
  parseProgress,
  readSettings,
  defaultWorkFolder,
  DEFAULT_HEIGHT,
  GOP
};
