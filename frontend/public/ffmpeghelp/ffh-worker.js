// One ffmpeg.wasm instance. The page talks to it with {id, type, ...} messages and gets {id, ok, result|error}
// back; ffmpeg's console output arrives as {log, stream, line} while a command runs.
import createFFmpegCore from './vendor/ffmpeg-core.js';

let core = null;
let runId = null;

async function load({ module }) {
  core = await createFFmpegCore({
    // The page compiles the .wasm once and hands every worker the compiled module, so restarts are quick.
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(module, imports).then((instance) => done(instance, module));
      return {};
    },
  });
  core.setLogger(({ type, message }) => self.postMessage({ log: runId, stream: type, line: message }));
  return true;
}

function exec({ id, args, probe }) {
  runId = id;
  try {
    core.setTimeout(-1);
    const code = probe ? core.ffprobe(...args) : core.exec(...args);
    core.reset();
    return { code, heap: core.HEAPU8.length };
  } finally {
    runId = null;
  }
}

const FS = () => core.FS;
const exists = (p) => {
  try {
    FS().stat(p);
    return true;
  } catch {
    return false;
  }
};

function mkdirp(path) {
  let cur = '';
  for (const part of path.split('/').filter(Boolean)) {
    cur += '/' + part;
    if (!exists(cur)) FS().mkdir(cur);
  }
}

function stat(path) {
  try {
    const s = FS().stat(path);
    return { size: s.size, mtimeMs: +s.mtime, isDir: FS().isDir(s.mode) };
  } catch {
    return null;
  }
}

/** Every file below a directory: [{path, size}]. */
function walk(dir, out = []) {
  if (!exists(dir)) return out;
  for (const name of FS().readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const p = `${dir}/${name}`;
    const s = FS().stat(p);
    if (FS().isDir(s.mode)) walk(p, out);
    else out.push({ path: p, size: s.size });
  }
  return out;
}

function list(dir) {
  if (!exists(dir)) return null;
  return FS()
    .readdir(dir)
    .filter((n) => n !== '.' && n !== '..')
    .map((name) => ({ name, isDir: FS().isDir(FS().stat(`${dir}/${name}`).mode) }));
}

function rm(path) {
  const s = stat(path);
  if (!s) return false;
  if (s.isDir) {
    for (const name of FS().readdir(path)) if (name !== '.' && name !== '..') rm(`${path}/${name}`);
    FS().rmdir(path);
  } else {
    FS().unlink(path);
  }
  return true;
}

const mounted = new Set();
function mount({ point, blobs }) {
  if (mounted.has(point)) return true;
  mkdirp(point);
  FS().mount(FS().filesystems.WORKERFS, { blobs }, point);
  mounted.add(point);
  return true;
}

self.onmessage = async ({ data: msg }) => {
  const { id, type } = msg;
  try {
    if (type !== 'load' && !core) throw new Error('ffmpeg is not loaded');
    let result;
    const transfer = [];
    switch (type) {
      case 'load':
        result = await load(msg);
        break;
      case 'exec':
        result = exec(msg);
        break;
      case 'mount':
        result = mount(msg);
        break;
      case 'unmount':
        FS().unmount(msg.point);
        result = true;
        break;
      case 'mkdirp':
        mkdirp(msg.path);
        result = true;
        break;
      case 'write':
        mkdirp(msg.path.slice(0, msg.path.lastIndexOf('/')));
        FS().writeFile(msg.path, msg.data);
        result = true;
        break;
      case 'read': {
        const data = FS().readFile(msg.path);
        transfer.push(data.buffer);
        result = data;
        break;
      }
      case 'stat':
        result = stat(msg.path);
        break;
      case 'list':
        result = list(msg.path);
        break;
      case 'walk':
        result = walk(msg.path);
        break;
      case 'rm':
        result = rm(msg.path);
        break;
      default:
        throw new Error(`Unknown message ${type}`);
    }
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (e) {
    self.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
};
