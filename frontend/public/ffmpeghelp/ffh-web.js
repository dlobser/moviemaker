'use strict';
/* ffmpeg helper — browser runtime for the web version.
   The local app's command builder and job queue (lib/*.js, bundled into ffh-modules.js) run here unchanged:
   ffmpeg.wasm stands in for the ffmpeg/ffprobe programs, and small stand-ins replace the Node APIs they use.
   Files the visitor picks are mounted read-only into ffmpeg's virtual disk under /in/N/; each job writes
   into /out/wN/, and its results become downloadable blobs. Nothing is uploaded anywhere. */
(function () {
  const PROCESS = { env: {}, platform: 'web', argv: [], cwd: () => '/' };

  // ============================================================ tiny CommonJS loader (for ffh-modules.js)

  const defs = new Map();
  const cache = new Map();
  const builtins = {};

  function resolveId(from, id) {
    if (!id.startsWith('.')) return id;
    const parts = from.split('/').slice(0, -1);
    for (const seg of id.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.') parts.push(seg);
    }
    return parts.join('/').replace(/\.js$/, '');
  }

  function requireModule(name) {
    if (name === 'public/fx') return window.FX;
    if (builtins[name]) return builtins[name];
    if (cache.has(name)) return cache.get(name).exports;
    const fn = defs.get(name);
    if (!fn) throw new Error(`Module not found: ${name}`);
    const module = { exports: {} };
    cache.set(name, module);
    fn(module, module.exports, (id) => requireModule(resolveId(name, id)), PROCESS);
    return module.exports;
  }

  window.FFH = { define: (name, fn) => defs.set(name, fn), require: requireModule };

  // ============================================================ Node API stand-ins

  // ---- path (POSIX: ffmpeg's virtual disk uses forward slashes)
  const path = (() => {
    function normalize(p) {
      const abs = p.startsWith('/');
      const out = [];
      for (const seg of p.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') {
          if (out.length && out[out.length - 1] !== '..') out.pop();
          else if (!abs) out.push('..');
        } else out.push(seg);
      }
      const s = out.join('/');
      return abs ? '/' + s : s || '.';
    }
    const join = (...a) => normalize(a.filter((x) => x !== '').join('/') || '.');
    function resolve(...args) {
      let r = '';
      for (let i = args.length - 1; i >= 0; i--) {
        const s = String(args[i]);
        if (!s) continue;
        r = r ? `${s}/${r}` : s;
        if (s.startsWith('/')) break;
      }
      return normalize(r.startsWith('/') ? r : '/' + r);
    }
    function dirname(p) {
      const s = String(p).replace(/\/+$/, '');
      const i = s.lastIndexOf('/');
      return i < 0 ? '.' : i === 0 ? '/' : s.slice(0, i);
    }
    function basename(p, ext) {
      let b = String(p).replace(/\/+$/, '');
      b = b.slice(b.lastIndexOf('/') + 1);
      return ext && b.endsWith(ext) && b !== ext ? b.slice(0, -ext.length) : b;
    }
    function extname(p) {
      const b = basename(p);
      const i = b.lastIndexOf('.');
      return i > 0 ? b.slice(i) : '';
    }
    function parse(p) {
      const base = basename(p);
      const ext = extname(p);
      return { root: String(p).startsWith('/') ? '/' : '', dir: dirname(p), base, ext, name: ext ? base.slice(0, -ext.length) : base };
    }
    function relative(from, to) {
      const a = resolve(from).split('/').filter(Boolean);
      const b = resolve(to).split('/').filter(Boolean);
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/');
    }
    const isAbsolute = (p) => String(p).startsWith('/');
    return { sep: '/', delimiter: ':', normalize, join, resolve, dirname, basename, extname, parse, relative, isAbsolute };
  })();

  // ---- events
  class EventEmitter {
    constructor() {
      this._listeners = new Map();
    }
    on(e, fn) {
      if (!this._listeners.has(e)) this._listeners.set(e, []);
      this._listeners.get(e).push(fn);
      return this;
    }
    off(e, fn) {
      const l = this._listeners.get(e);
      const i = l ? l.indexOf(fn) : -1;
      if (i >= 0) l.splice(i, 1);
      return this;
    }
    once(e, fn) {
      const w = (...a) => {
        this.off(e, w);
        fn(...a);
      };
      return this.on(e, w);
    }
    emit(e, ...a) {
      const l = this._listeners.get(e);
      if (!l || !l.length) return false;
      for (const fn of l.slice()) fn(...a);
      return true;
    }
  }
  EventEmitter.prototype.addListener = EventEmitter.prototype.on;
  EventEmitter.prototype.removeListener = EventEmitter.prototype.off;
  EventEmitter.EventEmitter = EventEmitter;

  // ---- os / crypto: one ffmpeg runs at a time here, so the image converter does one image at a time.
  const os = { cpus: () => [{}], tmpdir: () => '/tmp', homedir: () => '/' };
  const crypto = {
    randomBytes(n) {
      const b = window.crypto.getRandomValues(new Uint8Array(n));
      return { toString: () => [...b].map((x) => x.toString(16).padStart(2, '0')).join('') };
    },
  };

  // ============================================================ the visitor's files (read-only, under /in/N/)

  const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

  const vfs = {
    groups: [], // [{point, blobs:[{name, data}]}], mounted into every ffmpeg instance
    files: new Map(), // path -> File
    dirs: new Map(), // dir -> Set(child names)
    names: new Map(), // path -> name shown in the form

    add(fileList, { folder = false } = {}) {
      const point = `/in/${this.groups.length + 1}`;
      const blobs = [];
      const paths = [];
      const used = new Set();
      for (const file of fileList) {
        let rel = folder && file.webkitRelativePath ? file.webkitRelativePath : file.name;
        // Dropped files can come from different folders and share a name.
        for (let n = 2; used.has(rel); n++) rel = rel.replace(/(\.[^./]*)?$/, (ext) => ` (${n})${ext || ''}`);
        used.add(rel);
        const p = `${point}/${rel}`;
        this.files.set(p, file);
        this.names.set(p, rel);
        blobs.push({ name: rel, data: file });
        paths.push(p);
        for (let child = p, dir = path.dirname(p); ; child = dir, dir = path.dirname(dir)) {
          if (!this.dirs.has(dir)) this.dirs.set(dir, new Set());
          this.dirs.get(dir).add(path.basename(child));
          if (dir === '/') break;
        }
      }
      const group = { point, blobs };
      this.groups.push(group);
      for (const inst of instances()) inst.mount(group);
      paths.sort(natural);
      const root = folder && paths.length ? `${point}/${paths[0].slice(point.length + 1).split('/')[0]}` : null;
      if (root) this.names.set(root, path.basename(root));
      return { paths, root };
    },
    stat(p) {
      const f = this.files.get(p);
      if (f) return { size: f.size, mtimeMs: f.lastModified || 0, isDir: false };
      return this.dirs.has(p) ? { size: 0, mtimeMs: 0, isDir: true } : null;
    },
    list(p) {
      const kids = this.dirs.get(p);
      return kids ? [...kids].map((name) => ({ name, isDir: this.dirs.has(`${p}/${name}`) })) : null;
    },
  };
  const isInput = (p) => p === '/in' || String(p).startsWith('/in/');

  // ============================================================ ffmpeg.wasm instances

  let compiled = null; // WebAssembly.Module, shared by every instance
  const RECYCLE_HEAP = 1.5 * 1024 * 1024 * 1024; // the build's ceiling is 2 GB

  class Instance {
    constructor(name) {
      this.name = name;
      this.seq = 0;
      this.pending = new Map();
      this.logs = new Map();
      this.queue = Promise.resolve();
      this.active = null;
      this.worker = null;
      this.ready = null;
      this.busy = Promise.resolve();
    }
    start() {
      this.worker = new Worker('ffh-worker.js', { type: 'module' });
      this.worker.onmessage = (e) => this.onMessage(e.data);
      this.worker.onerror = (e) => this.fail(new Error(e.message || 'ffmpeg worker failed to start'));
      this.ready = this.call('load', { module: compiled });
      for (const g of vfs.groups) this.mount(g);
      return this.ready;
    }
    /** Kills a running command the only way ffmpeg.wasm allows: throw the worker away and start a new one. */
    restart() {
      this.worker.terminate();
      this.fail(new Error('Cancelled'));
      return this.start();
    }
    /**
     * A failed command can leave ffmpeg.wasm's memory corrupted ("memory access out of bounds" on every later
     * command), and memory only grows. So after a failure, or once it's big, start a fresh instance, carrying
     * over the files on its virtual disk (the running job's results and temp files).
     */
    recycle() {
      const done = (async () => {
        const keep = [];
        try {
          for (const dir of ['/out', '/tmp']) for (const f of await this.call('walk', { path: dir })) keep.push({ path: f.path, data: await this.call('read', { path: f.path }) });
        } catch {}
        this.worker.terminate();
        this.fail(new Error('ffmpeg was restarted'));
        await this.start();
        for (const f of keep) await this.call('write', f);
      })();
      this.busy = done.catch(() => {});
      return done;
    }
    /** Waits until the instance is loaded, its files are mounted, and no restart is under way. */
    async settle() {
      await this.busy;
      for (let r = null; r !== this.ready; ) await (r = this.ready); // it may be replaced while waiting
    }
    fail(err) {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.logs.clear();
    }
    mount(group) {
      if (!this.ready) return;
      this.ready = this.ready.then(() => this.call('mount', { point: group.point, blobs: group.blobs }).catch((e) => console.warn('ffmpeg helper: mount failed', e)));
    }
    call(type, data = {}, onLog) {
      return new Promise((resolve, reject) => {
        const id = ++this.seq;
        this.pending.set(id, { resolve, reject });
        if (onLog) this.logs.set(id, onLog);
        this.worker.postMessage({ id, type, ...data });
      });
    }
    onMessage(m) {
      if ('log' in m) {
        const fn = this.logs.get(m.log);
        if (fn) fn(m.stream, m.line);
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      this.logs.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error));
    }
    async fs(type, data) {
      await this.settle();
      return this.call(type, data);
    }
    /** Queues one ffmpeg/ffprobe command. Returns {done: Promise<{code}>, kill()}. */
    run(args, { probe = false, onLine } = {}) {
      const entry = { killed: false, started: false };
      const done = this.queue.then(async () => {
        if (entry.killed) return { code: null };
        await this.settle();
        if (entry.killed) return { code: null };
        entry.started = true;
        this.active = entry;
        let res;
        try {
          res = await this.call('exec', { args, probe }, onLine);
        } catch (e) {
          if (!entry.killed) {
            this.active = null;
            await this.recycle().catch(() => {});
          }
          throw e;
        } finally {
          if (this.active === entry) this.active = null;
        }
        // ffprobe.wasm always reports -1, so only ffmpeg's exit code says something went wrong.
        if ((!probe && res.code !== 0) || res.heap > RECYCLE_HEAP) await this.recycle().catch(() => {});
        return res;
      });
      this.queue = done.catch(() => {});
      entry.kill = () => {
        entry.killed = true;
        if (entry.started && this.active === entry) {
          this.active = null;
          this.restart();
        }
      };
      return { done, kill: entry.kill };
    }
  }

  const main = new Instance('jobs'); // conversions run here, one command at a time
  const prober = new Instance('probe'); // reads file info, so the form stays responsive during a long job
  const instances = () => [main, prober].filter((i) => i.worker);

  // ---- child_process.spawn: an ffmpeg.wasm command dressed up as a child process
  // ffmpeg.wasm prints all of ffmpeg's messages on stdout and only "Aborted()" on stderr, so lines are
  // sorted back the way real ffmpeg sends them: -progress key=value lines on stdout, messages on stderr.
  const PROGRESS_LINE = /^[a-z_0-9]+=\S*$/;
  function spawn(cmd, args) {
    const probe = /ffprobe$/i.test(cmd);
    const inst = probe ? prober : main;
    const split = args.includes('-progress');
    const stream = () => Object.assign(new EventEmitter(), { setEncoding() {} });
    const proc = new EventEmitter();
    proc.stdout = stream();
    proc.stderr = stream();
    let killed = false;
    const probeOut = [];
    const onLine = (s, line) => {
      if (s === 'stderr' && /^Aborted\(/.test(line)) return; // how every ffmpeg.wasm command ends
      if (probe) return void probeOut.push(line);
      const toStdout = s === 'stdout' && (!split || PROGRESS_LINE.test(line));
      (toStdout ? proc.stdout : proc.stderr).emit('data', line + '\n');
    };
    const run = inst.run(args, { probe, onLine });
    // A microtask, not a timer: browsers throttle timers in background tabs (to once a minute, eventually),
    // which would stall a batch whenever the visitor switches tabs. All output has arrived by now.
    const close = (code) =>
      queueMicrotask(() => {
        proc.stdout.emit('end');
        proc.stderr.emit('end');
        proc.emit('close', code);
      });
    run.done.then(
      ({ code }) => {
        if (probe && !killed) {
          // ffprobe.wasm always exits with -1: its JSON output is how to tell success from failure.
          const text = probeOut.join('\n');
          const start = text.indexOf('{');
          let ok = start >= 0;
          try {
            if (ok) JSON.parse(text.slice(start));
          } catch {
            ok = false;
          }
          if (ok) proc.stdout.emit('data', text.slice(start));
          else proc.stderr.emit('data', text || 'ffprobe failed');
          code = ok ? 0 : 1;
        }
        close(killed ? null : code);
      },
      (e) => {
        if (!killed) proc.stderr.emit('data', `${e.message}\n`);
        close(killed ? null : 1);
      }
    );
    proc.kill = () => {
      killed = true;
      run.kill();
    };
    return proc;
  }

  // ---- fs: the visitor's files from the registry, everything else from ffmpeg's virtual disk
  const enoent = (p) => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' });
  const statObj = (s) => ({ size: s.size, mtimeMs: s.mtimeMs, isFile: () => !s.isDir, isDirectory: () => s.isDir });
  const fs = {
    existsSync: (p) => (isInput(p) ? !!vfs.stat(p) : false),
    promises: {
      async stat(p) {
        const s = isInput(p) ? vfs.stat(p) : await main.fs('stat', { path: p });
        if (!s) throw enoent(p);
        return statObj(s);
      },
      async readdir(p, opts) {
        const list = isInput(p) ? vfs.list(p) : await main.fs('list', { path: p });
        if (!list) throw enoent(p);
        return opts && opts.withFileTypes ? list.map((e) => ({ name: e.name, isDirectory: () => e.isDir, isFile: () => !e.isDir })) : list.map((e) => e.name);
      },
      mkdir: (p) => main.fs('mkdirp', { path: p }),
      writeFile: (p, data) => main.fs('write', { path: p, data: typeof data === 'string' ? new TextEncoder().encode(data) : data }),
      rm: (p) => main.fs('rm', { path: p }),
    },
  };

  Object.assign(builtins, { path, events: EventEmitter, os, crypto, fs, child_process: { spawn } });

  // ============================================================ loading ffmpeg

  const status = { phase: 'idle', loaded: 0, total: 0, error: null };
  const statusFns = new Set();
  function setStatus(o) {
    Object.assign(status, o);
    for (const fn of statusFns) fn({ ...status });
  }

  async function downloadCore() {
    const res = await fetch('vendor/core.json');
    if (!res.ok) throw new Error(`Couldn't download ffmpeg (core.json: ${res.status})`);
    const meta = await res.json();
    setStatus({ phase: 'downloading', loaded: 0, total: meta.size });
    // The .wasm is split into .bin parts: free hosting plans don't accept .wasm, and smaller files are safer.
    const parts = new Array(meta.parts.length);
    let loaded = 0;
    await Promise.all(
      meta.parts.map(async (name, i) => {
        const r = await fetch(`vendor/${name}`);
        if (!r.ok) throw new Error(`Couldn't download ffmpeg (${name}: ${r.status})`);
        const chunks = [];
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.length;
          setStatus({ loaded });
        }
        parts[i] = new Blob(chunks);
      })
    );
    setStatus({ phase: 'compiling' });
    const bytes = await new Blob(parts).arrayBuffer();
    if (bytes.byteLength !== meta.size) throw new Error('The ffmpeg download was incomplete — reload the page to try again.');
    return WebAssembly.compile(bytes);
  }

  let readyP = null;
  let media = null;
  let ops = null;
  let jobs = null;

  function ready() {
    if (!readyP) {
      readyP = (async () => {
        if (typeof WebAssembly === 'undefined' || typeof Worker === 'undefined') throw new Error('This browser can’t run ffmpeg.wasm (it needs WebAssembly and Web Workers).');
        try {
          compiled = await downloadCore();
        } catch (e) {
          if (/CompileError|Content Security|unsafe-eval|wasm-eval/i.test(String(e))) throw new Error('This page isn’t allowed to run WebAssembly here. Use the desktop version instead.');
          throw e;
        }
        setStatus({ phase: 'starting' });
        await Promise.all([main.start(), prober.start()]);
        media = requireModule('lib/media');
        ops = requireModule('lib/ops');
        const { Jobs } = requireModule('lib/jobs');
        jobs = new Jobs({ concurrency: 1 });
        jobs.on('job', onJobEvent);
        setStatus({ phase: 'ready' });
      })().catch((e) => {
        setStatus({ phase: 'error', error: e.message });
        throw e;
      });
    }
    return readyP;
  }

  // ============================================================ results: blobs the page can show and download

  const MIME = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
    '.gif': 'image/gif', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'image/bmp', '.tif': 'image/tiff',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
    '.json': 'application/json',
  };
  const outputs = new Map(); // virtual path -> {blob, url}
  const inputUrls = new WeakMap(); // File -> object URL
  const previews = []; // effect previews and waveforms pile up while tweaking; keep the newest few

  function keepBlob(p, data) {
    const old = outputs.get(p);
    if (old) URL.revokeObjectURL(old.url);
    const blob = new Blob([data], { type: MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
    outputs.set(p, { blob, url: URL.createObjectURL(blob) });
  }
  function dropBlob(p) {
    const b = outputs.get(p);
    if (b) URL.revokeObjectURL(b.url);
    outputs.delete(p);
  }

  function fileUrl(p) {
    const f = vfs.files.get(p);
    if (f) {
      if (!inputUrls.has(f)) inputUrls.set(f, URL.createObjectURL(f));
      return inputUrls.get(f);
    }
    const b = outputs.get(p);
    return b ? b.url : '';
  }

  /** Moves a finished job's files out of ffmpeg's memory into downloadable blobs. */
  async function harvest(job) {
    const dir = job._webDir;
    if (job.status === 'cancelled') {
      if (dir) await main.fs('rm', { path: dir }).catch(() => {});
      return;
    }
    const files = dir ? (await main.fs('walk', { path: dir }).catch(() => [])) : [];
    files.sort((a, b) => natural(a.path, b.path));
    const downloads = [];
    for (const f of files) {
      keepBlob(f.path, await main.fs('read', { path: f.path }));
      downloads.push({ path: f.path, name: f.path.slice(dir.length + 1), size: f.size });
    }
    if (dir) await main.fs('rm', { path: dir }).catch(() => {});
    // Effect previews and waveforms are named in the job's result.
    for (const v of Object.values(job.result || {})) {
      if (typeof v !== 'string' || !v.startsWith('/tmp/')) continue;
      try {
        keepBlob(v, await main.fs('read', { path: v }));
        await main.fs('rm', { path: v });
        previews.push(v);
      } catch {}
    }
    while (previews.length > 8) dropBlob(previews.shift());
    job.downloads = downloads;
  }

  // ============================================================ the server's API, in the page

  const listeners = new Set();
  function broadcast(event, data) {
    for (const fn of listeners) fn(event, data);
  }

  function onJobEvent(pub) {
    const job = jobs.jobs.get(pub.id);
    const terminal = pub.status !== 'queued' && pub.status !== 'running';
    if (!terminal || !job || job._harvested) return broadcast('job', pub);
    job._harvested = true;
    harvest(job)
      .catch((e) => console.warn('ffmpeg helper: collecting results failed', e))
      .then(() => broadcast('job', { ...pub, downloads: job.downloads || [] }));
  }

  /** Points outputs at this job's own folder: '/out/x' -> '/out/w7/x'. */
  function rewriteOut(params, dir) {
    const out = {};
    for (const [k, v] of Object.entries(params || {})) out[k] = typeof v === 'string' && (v === '/out' || v.startsWith('/out/')) ? dir + v.slice(4) : v;
    return out;
  }

  // Listed by this single-threaded build but unusable: libvpx fails to allocate frame buffers (or hangs),
  // and libx265 waits forever for worker threads it can't start.
  const BROKEN_ENCODERS = new Set(['libvpx-vp9', 'libvpx', 'libx265']);
  let encoders = null;
  async function listEncoders() {
    if (encoders) return encoders;
    const lines = [];
    await prober.run(['-hide_banner', '-encoders'], { onLine: (s, l) => lines.push(l) }).done;
    encoders = lines.map((l) => (l.match(/^\s*[VAS][F.][S.][X.][B.][D.]\s+(\S+)/) || [])[1]).filter((e) => e && !BROKEN_ENCODERS.has(e));
    return encoders;
  }

  let webSeq = 0;
  const clean = (p) => (typeof p === 'string' ? p.trim() : '');
  /** The command notes name folders on ffmpeg's virtual disk; in the browser, results are downloads. */
  const webNote = (n) =>
    String(n)
      .replace(/\bin \/out(?:\/w\d+)?(?=[ ,]|$)/g, 'for download')
      .replace(/ next to the originals?/, ' for download')
      .replace(/\/(?:in\/\d+|out(?:\/w\d+)?)\//g, '');

  async function api(url, body) {
    const route = url.split('?')[0];
    if (route === '/api/pick') return pick(body || {}); // before any await: the file dialog needs the click
    await ready();
    if (body === undefined) {
      if (route === '/api/config') {
        return { version: await media.ffmpegVersion(), platform: 'web', sep: '/', home: '', concurrency: 1, web: true, encoders: await listEncoders() };
      }
      const lm = route.match(/^\/api\/jobs\/(\w+)\/log$/);
      if (lm) {
        const job = jobs.jobs.get(lm[1]);
        if (!job) throw new Error('No such job');
        return { commands: job.commands, log: job.log };
      }
      throw new Error('Not found');
    }
    switch (route) {
      case '/api/probe':
        return media.probe(clean(body.path));
      case '/api/sequence':
        return media.detectSequence(clean(body.path));
      case '/api/command':
        try {
          const plan = await ops.buildPlan(body.op, body.params, { tmpRoot: '/tmp' });
          return { commands: plan.commands, notes: (plan.notes || []).map(webNote), outputs: plan.outputs };
        } catch (e) {
          return { error: e.message };
        }
      case '/api/jobs': {
        const dir = `/out/w${++webSeq}`;
        const plan = await ops.buildPlan(body.op, rewriteOut(body.params, dir), { tmpRoot: '/tmp' });
        const job = jobs.create(plan, body.op);
        job._webDir = dir;
        return { job: jobs.public(job) };
      }
      case '/api/jobs/clear':
        for (const j of jobs.jobs.values()) if (j.status !== 'queued' && j.status !== 'running') for (const d of j.downloads || []) dropBlob(d.path);
        jobs.clearFinished();
        broadcast('snapshot', jobs.list());
        return { ok: true };
    }
    const cm = route.match(/^\/api\/jobs\/(\w+)\/cancel$/);
    if (cm) return { ok: jobs.cancel(cm[1]) };
    throw new Error('That isn’t available in the browser version');
  }

  function subscribe(fn) {
    listeners.add(fn);
    fn('snapshot', jobs ? jobs.list() : []);
    return () => listeners.delete(fn);
  }

  // ============================================================ choosing files

  const EXT = {
    video: 'mp4,mov,mkv,webm,avi,m4v,wmv,flv,mpg,mpeg,ts,mts,m2ts,3gp,gif',
    audio: 'mp3,wav,flac,m4a,aac,ogg,oga,opus,wma,aif,aiff,aifc,caf,alac,ape,wv,tta,mka,ac3,eac3,dts,mp2,amr,au,m4b',
    image: 'png,jpg,jpeg,bmp,tif,tiff,webp,exr,tga,dpx,jxl',
  };
  const accept = (kinds) => kinds.map((k) => EXT[k].split(',').map((e) => '.' + e).join(',')).join(',');
  const ACCEPT = { video: accept(['video']), audio: accept(['audio']), image: accept(['image']), visual: accept(['video', 'image']), media: accept(['audio', 'video']) };

  /** Opens the browser's file chooser. 'open' returns one path (the first, when several frames are chosen). */
  function pick({ mode, filter, multi }) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.hidden = true;
      if (mode === 'folder') input.webkitdirectory = true;
      else {
        input.accept = ACCEPT[filter] || '';
        input.multiple = mode === 'many' || !!multi;
      }
      let settled = false;
      const finish = (paths) => {
        if (settled) return;
        settled = true;
        input.remove();
        resolve({ paths });
      };
      input.addEventListener('change', () => {
        const files = [...input.files];
        if (!files.length) return finish([]);
        const { paths, root } = vfs.add(files, { folder: mode === 'folder' });
        finish(mode === 'folder' ? [root] : mode === 'many' ? paths : [paths[0]]);
      });
      input.addEventListener('cancel', () => finish([]));
      document.body.append(input);
      input.click();
    });
  }

  // ============================================================ zip files (stored, no compression: media is already compressed)

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** entries: [{name, data: Blob | Uint8Array | string}] -> zip Blob */
  async function makeZip(entries) {
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [];
    const central = [];
    let offset = 0;
    if (entries.length > 65535) throw new Error('Too many files for one zip — download them in smaller batches');
    for (const e of entries) {
      const blob = e.data instanceof Blob ? e.data : new Blob([e.data]);
      const crc = crc32(new Uint8Array(await blob.arrayBuffer()));
      const name = new TextEncoder().encode(e.name);
      const size = blob.size;
      if (offset + size > 0xffffffff) throw new Error('That’s more than 4 GB — download the files in smaller batches');
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);
      local.setUint32(22, size, true);
      local.setUint16(26, name.length, true);
      parts.push(local, name, blob);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(12, dosTime, true);
      cen.setUint16(14, dosDate, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, size, true);
      cen.setUint32(24, size, true);
      cen.setUint16(28, name.length, true);
      cen.setUint32(42, offset, true);
      central.push(cen, name);
      offset += 30 + name.length + size;
    }
    const cenSize = central.reduce((a, p) => a + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cenSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  const zipName = (title) => (String(title || 'ffmpeg-helper').replace(/[→]/g, 'to').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'ffmpeg-helper') + '.zip';

  /**
   * Browsers allow a download only within a few seconds of the click that asked for it (strictly so when this
   * page is embedded in another site). If building it took longer, hand back a link for a fresh click instead.
   */
  function deliver(blob, name, started) {
    if (performance.now() - started < 3000) return void saveBlob(blob, name);
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60000);
    return { name, url };
  }

  /** Saves a job's results: the file itself, or a zip when there are several. */
  async function downloadJob(j) {
    const started = performance.now();
    const list = j.downloads || [];
    if (list.length === 1) {
      const b = outputs.get(list[0].path);
      if (b) saveBlob(b.blob, path.basename(list[0].name));
      return;
    }
    const entries = list.map((d) => ({ name: d.name, data: outputs.get(d.path)?.blob })).filter((e) => e.data);
    return deliver(await makeZip(entries), zipName(j.title), started);
  }

  /** Builds ffmpeg-helper.zip (the desktop version) from the copies this site serves under local/. */
  async function downloadLocal() {
    const started = performance.now();
    const res = await fetch('local/files.json');
    if (!res.ok) throw new Error(`Couldn't load the file list (${res.status})`);
    const { root, files } = await res.json();
    const entries = [];
    for (const f of files) {
      const r = await fetch(`local/${f.src}`);
      if (!r.ok) throw new Error(`Couldn't load ${f.src} (${r.status})`);
      // cmd.exe wants CRLF in .bat files, whatever git or the host did to the copy.
      const data = f.path.endsWith('.bat') ? (await r.text()).replace(/\r?\n/g, '\r\n') : await r.blob();
      entries.push({ name: `${root}/${f.path}`, data });
    }
    return deliver(await makeZip(entries), `${root}.zip`, started);
  }

  // ============================================================ exports for app.js

  window.FFH_WEB = {
    api,
    subscribe,
    fileUrl,
    ready,
    /** Name to show in a form field for a virtual path. */
    displayName: (p) => (vfs.names.get(p) ?? (String(p).startsWith('/out/') ? path.basename(p) : p)),
    /** Files dropped on the page: returns their virtual paths (sorted). */
    addFiles: (files) => vfs.add([...files]).paths,
    downloadJob,
    downloadLocal,
    onStatus(fn) {
      statusFns.add(fn);
      fn({ ...status });
    },
    /** For poking at from the browser console. */
    engine: { main, prober, vfs },
  };
})();
