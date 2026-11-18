'use strict';
/* ffmpeg helper — browser UI. Vanilla JS, no build step. */

// ================================================================ helpers

const $ = (s, el = document) => el.querySelector(s);
/** Set in the web version (web/ffh-web.js): ffmpeg.wasm in the page instead of the local server. */
const WEB = window.FFH_WEB || null;

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'disabled' || k === 'value') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const ICONS = {
  images: '<rect x="7" y="7" width="14" height="14" rx="2"/><path d="M3 16V5a2 2 0 0 1 2-2h11"/><path d="m7 17 4-4 3 3 2-2 5 5"/>',
  convert: '<path d="M4 7h14l-3-3"/><path d="M20 17H6l3 3"/>',
  audioConvert: '<path d="M3 10v4M6 7v10M9 9v6"/><path d="M13 12h8M18 9l3 3-3 3"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
  musicPlus: '<path d="M9 18V5l10-2v8"/><circle cx="6" cy="18" r="3"/><path d="M19 15v6M16 18h6"/>',
  play: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  frames: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.5-3.5L8 21"/>',
  imageConvert: '<rect x="2" y="5" width="12" height="14" rx="1.5"/><circle cx="6" cy="9" r="1.2"/><path d="m2 16 3.5-3 3 2.5L14 11"/><path d="M16 12h6M19 9l3 3-3 3"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  fade: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  wave: '<path d="M2 10v3M6 6v11M10 3v18M14 8v7M18 5v13M22 10v3"/>',
  concat: '<rect x="2" y="7" width="8" height="10" rx="1.5"/><rect x="14" y="7" width="8" height="10" rx="1.5"/><path d="M10 12h4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  triangle: '<path d="M7 4v16l13-8z" fill="currentColor" stroke="none"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  grip: '<g fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></g>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
};
const icon = (name) =>
  h('span', { class: 'ico', html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>` });

async function api(url, body) {
  if (WEB) return WEB.api(url, body);
  const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(url, opts);
  let data = {};
  try {
    data = await r.json();
  } catch {}
  if (!r.ok) {
    const e = new Error(data.error || `${r.status} ${r.statusText}`);
    e.status = r.status;
    e.data = data;
    throw e;
  }
  return data;
}

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp', '.exr', '.tga', '.dpx', '.jxl'];
const VIDEO_PREVIEW = ['.mp4', '.m4v', '.webm', '.mov', '.mkv'];
const AUDIO_PREVIEW = ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus'];
const IMAGE_PREVIEW = ['.gif', '.webp', '.png', '.jpg', '.jpeg', '.bmp'];

const cleanPath = (p) => (p == null ? '' : String(p).trim().replace(/^"(.*)"$/, '$1'));
const sepOf = (p) => (p.includes('\\') || /^[a-z]:/i.test(p) ? '\\' : '/');
const lastSep = (p) => Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
const dirname = (p) => (lastSep(p) > 0 ? p.slice(0, lastSep(p)) : '');
const basename = (p) => p.slice(lastSep(p) + 1);
const extname = (p) => {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i).toLowerCase() : '';
};
const stem = (p) => {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(0, i) : b;
};
const joinPath = (dir, name) => (dir ? dir.replace(/[\\/]+$/, '') + sepOf(dir) + name : name);
const withExt = (p, ext) => joinPath(dirname(p), stem(p) + ext);
const isImage = (p) => IMAGE_EXT.includes(extname(p));
const fileUrl = (p, bust) => (WEB ? WEB.fileUrl(p) : `/api/file?path=${encodeURIComponent(p)}${bust ? `&v=${bust}` : ''}`);
/** What a path field shows: the path itself, or in the web version just the chosen file's name. */
const shownPath = (f, val) => (WEB && ['file', 'save', 'folder'].includes(f.type) ? (cleanPath(val) ? WEB.displayName(cleanPath(val)) : '') : val ?? '');

function fmtClock(s) {
  if (s == null || !Number.isFinite(s)) return '—';
  s = Math.round(Math.max(0, s) * 100) / 100;
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const sec = +(s - hh * 3600 - mm * 60).toFixed(2);
  const ss = Number.isInteger(sec) ? String(sec).padStart(2, '0') : sec.toFixed(2).padStart(5, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}
function fmtBytes(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
}
function fmtSpan(s) {
  if (s == null || !Number.isFinite(s)) return '';
  s = Math.max(0, Math.round(s));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}
const fmtRate = (b) => (b ? (b >= 1e6 ? `${(b / 1e6).toFixed(1)} Mb/s` : `${Math.round(b / 1000)} kb/s`) : '');
const chLabel = (n) => (n === 1 ? 'mono' : n === 2 ? 'stereo' : n ? `${n}ch` : '');

function toast(msg, kind = '', ms = kind === 'err' ? 9000 : 4500) {
  const el = h('div', { class: `toast ${kind}`, onclick: () => el.remove() }, msg);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

/** Web version: a download that took too long to prepare needs one more click (browsers require it). */
function offerSave(r) {
  if (r && r.url) toast(h('span', {}, `${r.name} is ready — `, h('a', { href: r.url, download: r.name }, 'click to save')), 'ok', 60000);
}

// ================================================================ field + tool definitions

const VCODECS = [['h264', 'H.264 · MP4'], ['h265', 'H.265 / HEVC · MP4'], ['vp9', 'VP9 · WebM'], ['av1', 'AV1 · MP4'], ['prores', 'ProRes · MOV']];
const VEXT = { h264: '.mp4', h265: '.mp4', vp9: '.webm', av1: '.mp4', prores: '.mov' };
const CRF_DEF = { h264: 20, h265: 24, vp9: 32, av1: 35 };
const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'].map((p) => [p, p]);
const PRORES = [['0', 'Proxy'], ['1', 'LT'], ['2', '422'], ['3', '422 HQ'], ['4', '4444'], ['5', '4444 XQ']];
const AFORMATS = [['mp3', 'MP3'], ['wav', 'WAV 16-bit'], ['wav24', 'WAV 24-bit'], ['flac', 'FLAC'], ['m4a', 'AAC (.m4a)'], ['opus', 'Opus (.ogg)']];
const AEXT = { mp3: '.mp3', wav: '.wav', wav24: '.wav', flac: '.flac', m4a: '.m4a', opus: '.ogg' };
const LOSSY = new Set(['mp3', 'm4a', 'opus']);
const BITRATES = ['96k', '128k', '160k', '192k', '256k', '320k'].map((b) => [b, b.replace('k', ' kbps')]);
const ACONV = [
  ['mp3', 'MP3'], ['wav', 'WAV'], ['flac', 'FLAC (lossless)'], ['m4a', 'AAC (.m4a)'], ['opus', 'Opus'], ['ogg', 'Ogg Vorbis'],
  ['aiff', 'AIFF'], ['alac', 'Apple Lossless (.m4a)'], ['wma', 'WMA'], ['ac3', 'AC3 (Dolby Digital)'], ['other', 'Other (type an extension)'],
];
const MP3Q = [...['320k', '256k', '192k', '160k', '128k', '96k'].map((b) => [b, b.replace('k', ' kbps')]), ['v0', 'VBR V0 (≈245 kbps)'], ['v2', 'VBR V2 (≈190 kbps)'], ['v4', 'VBR V4 (≈165 kbps)']];
const DEPTHS = [['', 'Same as source'], ['16', '16-bit'], ['24', '24-bit'], ['32f', '32-bit float']];
const RATES = [['', 'Same as source'], ...[8000, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 192000].map((r) => [String(r), `${r / 1000} kHz`])];
const CURVES = [['tri', 'Linear'], ['qsin', 'Smooth (sine)'], ['esin', 'S-curve'], ['exp', 'Exponential'], ['log', 'Logarithmic']];
const COPY_EXT = { aac: '.m4a', alac: '.m4a', mp3: '.mp3', opus: '.opus', vorbis: '.ogg', flac: '.flac', ac3: '.ac3', eac3: '.eac3' };
const IMG_FORMATS = [['jpg', 'JPG'], ['png', 'PNG (lossless)'], ['webp', 'WebP'], ['tiff', 'TIFF'], ['bmp', 'BMP']];
const IMG_ALPHA = new Set(['png', 'webp', 'tiff']); // formats that can keep transparency
const IMG_TYPES = [['png', 'PNG'], ['jpg', 'JPG / JPEG'], ['webp', 'WebP'], ['tif', 'TIFF'], ['bmp', 'BMP'], ['tga', 'TGA'], ['exr', 'EXR'], ['all', 'All images']];
const imgOpaque = (v) => !IMG_ALPHA.has(v.format) || !v.keepAlpha;
const copyExt = (codec) => (codec ? COPY_EXT[codec] || (codec.startsWith('pcm_') ? '.wav' : '.mka') : '.m4a');

const file = (key, label, o = {}) => ({ type: 'file', key, label, ...o });
const save = (key, label, o = {}) => ({ type: 'save', key, label, ...o });
const folder = (key, label, o = {}) => ({ type: 'folder', key, label, ...o });
const num = (key, label, o = {}) => ({ type: 'number', key, label, ...o });
const text = (key, label, o = {}) => ({ type: 'text', key, label, ...o });
const time = (key, label, o = {}) => ({ type: 'text', key, label, placeholder: 'e.g. 1:23.5', ...o });
const select = (key, label, opts, o = {}) => ({ type: 'select', key, label, opts, def: opts[0][0], ...o });
const check = (key, label, o = {}) => ({ type: 'check', key, label, ...o });
const color = (key, label, o = {}) => ({ type: 'color', key, label, ...o });
const row = (...fields) => ({ type: 'row', fields });
const rowIf = (when, ...fields) => ({ type: 'row', when, fields });
const section = (label, o = {}) => ({ type: 'section', label, ...o });

const codecOf = (v) => v.vcodec || 'h264';
const isSeq = (t) => t.kind() === 'seq';
const and = (a, b) => (v, t) => (!a || a(v, t)) && (!b || b(v, t));

function VIDEO_ENC(when, { scale = true } = {}) {
  return [
    section('Encoding', { when }),
    rowIf(
      when,
      select('vcodec', 'Codec', VCODECS, { affectsExt: true }),
      num('crf', 'Quality (CRF)', { placeholder: (v) => CRF_DEF[codecOf(v)] ?? '', hint: 'Lower = better quality, bigger file', when: (v) => codecOf(v) !== 'prores' && v.qmode !== 'size' }),
      select('preset', 'Encode speed', PRESETS, { def: 'medium', when: (v) => ['h264', 'h265'].includes(codecOf(v)) }),
      select('proresProfile', 'ProRes profile', PRORES, { def: '3', when: (v) => codecOf(v) === 'prores' })
    ),
    check('alpha', 'Keep transparency (alpha channel)', { when: and(when, (v) => codecOf(v) === 'vp9' || (codecOf(v) === 'prores' && +v.proresProfile >= 4)) }),
    scale && rowIf(when, num('width', 'Width', { placeholder: 'auto' }), num('height', 'Height', { placeholder: 'auto', hint: 'Leave one blank to keep the aspect ratio' })),
  ].filter(Boolean);
}

const AUDIO_FORMAT = (def = 'mp3', when) =>
  rowIf(when, select('format', 'Format', AFORMATS, { def, affectsExt: true }), select('abitrate', 'Bitrate', BITRATES, { def: '192k', when: (v) => LOSSY.has(v.format) }));

const VISUAL_RANGE = [
  rowIf(
    (v, t) => isSeq(t),
    num('startFrame', 'Start frame', { placeholder: (v, t) => t.seq()?.first ?? '' }),
    num('endFrame', 'End frame', { placeholder: (v, t) => t.seq()?.runEnd ?? '' }),
    num('inFps', 'Sequence frame rate', { def: '24' })
  ),
  rowIf((v, t) => !isSeq(t), time('start', 'Start', { placeholder: '0:00' }), time('end', 'End', { placeholder: (v, t) => (t.probe() ? fmtClock(t.probe().duration) : 'end') })),
];

const autoName = (suffix) => (v, t, tool) => {
  const src = cleanPath(v.input);
  return src ? joinPath(dirname(src), baseNameFor('input', src, t) + suffix) : null;
};
const autoPrefix = (v, t) => (cleanPath(v.input) ? baseNameFor('input', cleanPath(v.input), t) + '_' : null);

const TOOLS = [
  {
    id: 'seq2video',
    group: 'Video',
    name: 'Images → Video',
    icon: 'images',
    desc: 'Turn a numbered image sequence (render_0001.png, render_0002.png …) into a video. Pick any one frame and the rest are found automatically.',
    run: 'Encode video',
    fields: [
      file('input', 'Image sequence', { pick: 'image', detect: 'seq', placeholder: 'Pick any frame, e.g. render_0001.png' }),
      row(
        num('startFrame', 'Start frame', { placeholder: (v, t) => t.seq()?.first ?? '' }),
        num('endFrame', 'End frame', { placeholder: (v, t) => t.seq()?.runEnd ?? '' }),
        num('fps', 'Frame rate', { def: '24' })
      ),
      ...VIDEO_ENC(),
      save('output', 'Output video'),
    ],
    reset: ['startFrame', 'endFrame'],
    ext: (v) => VEXT[codecOf(v)],
    suffix: '',
  },
  {
    id: 'convert',
    group: 'Video',
    name: 'Convert / Compress',
    icon: 'convert',
    desc: 'Re-encode a video: change codec, shrink it to a target file size, resize, change frame rate or speed, or drop the audio.',
    run: 'Convert',
    fields: [
      file('input', 'Video', { pick: 'video' }),
      ...VIDEO_ENC(),
      rowIf(
        (v) => codecOf(v) === 'h264',
        select('qmode', 'Rate control', [['crf', 'Constant quality (CRF)'], ['size', 'Target file size (2-pass)']]),
        num('targetMB', 'Target size (MB)', { def: '10', when: (v) => v.qmode === 'size' })
      ),
      section('Timing & audio'),
      row(num('fps', 'Frame rate', { placeholder: 'same as source' }), num('speed', 'Speed', { placeholder: '1', hint: '0.5 = half speed, 2 = double speed' })),
      row(check('mute', 'Remove audio'), select('abitrate', 'Audio bitrate', BITRATES, { def: '192k', when: (v) => !v.mute })),
      save('output', 'Output file'),
    ],
    ext: (v) => VEXT[codecOf(v)],
    suffix: '_converted',
  },
  {
    id: 'addaudio',
    group: 'Video',
    name: 'Add Audio to Video',
    icon: 'musicPlus',
    desc: 'Put a soundtrack on a video — replace its audio or mix with it, offset it, loop it to fill. The video is copied untouched unless you choose to re-encode.',
    run: 'Add audio',
    fields: [
      file('video', 'Video', { pick: 'video' }),
      file('audio', 'Audio', { pick: 'media' }),
      select('mode', 'Audio', [['replace', "Replace the video's audio"], ['mix', "Mix with the video's audio"]]),
      row(
        num('offset', 'Start audio at (s)', { placeholder: '0', hint: 'Negative skips into the audio' }),
        num('gain', 'New audio volume (dB)', { placeholder: '0' }),
        num('origGain', 'Original volume (dB)', { placeholder: '0', when: (v) => v.mode === 'mix' })
      ),
      row(
        select('endMode', 'Output length', [['video', 'Match the video'], ['shortest', 'Stop at whichever is shorter'], ['longest', 'Keep whichever is longer']], { when: (v) => !v.loop }),
        select('abitrate', 'Audio bitrate', BITRATES, { def: '192k' })
      ),
      check('loop', 'Loop the audio to fill the whole video'),
      check('reencode', 'Re-encode the video (otherwise it is copied as-is)', { affectsExt: true }),
      ...VIDEO_ENC((v) => !!v.reencode),
      save('output', 'Output video', { from: 'video' }),
    ],
    ext: (v, t) => (v.reencode ? VEXT[codecOf(v)] : extname(cleanPath(v.video)) || '.mp4'),
    suffix: '_with_audio',
  },
  {
    id: 'anim',
    group: 'Animation & images',
    name: 'GIF / Animated WebP',
    icon: 'play',
    desc: 'Make a GIF or animated WebP from a video clip or an image sequence. GIFs use a generated palette for clean colors; WebP keeps transparency.',
    run: 'Create animation',
    fields: [
      file('input', 'Video or image sequence', { pick: 'visual', detect: 'auto' }),
      ...VISUAL_RANGE,
      row(
        select('animFormat', 'Format', [['gif', 'GIF'], ['webp', 'Animated WebP']], { affectsExt: true }),
        num('fps', 'Frame rate', { def: '15' }),
        num('width', 'Width (px)', { def: '480', placeholder: 'original' }),
        select('loop', 'Looping', [['forever', 'Loop forever'], ['once', 'Play once']])
      ),
      check('pingpong', 'Ping-pong (play forward, then backward)'),
      rowIf(
        (v) => v.animFormat !== 'webp',
        num('colors', 'Colors', { placeholder: '256' }),
        select('dither', 'Dithering', [['sierra', 'Sierra (smooth)'], ['bayer', 'Bayer (patterned, smaller)'], ['floyd', 'Floyd–Steinberg'], ['none', 'None (banding)']]),
        select('statsMode', 'Palette from', [['full', 'Whole frames'], ['diff', 'Moving parts only']])
      ),
      rowIf(
        (v) => v.animFormat === 'webp',
        num('quality', 'Quality (0–100)', { def: '80' }),
        check('lossless', 'Lossless'),
        check('alpha', 'Keep transparency', { def: true })
      ),
      save('output', 'Output file'),
    ],
    reset: ['startFrame', 'endFrame', 'start', 'end'],
    ext: (v) => (v.animFormat === 'webp' ? '.webp' : '.gif'),
    suffix: '',
  },
  {
    id: 'sprite',
    group: 'Animation & images',
    name: 'Sprite Sheet',
    icon: 'grid',
    desc: 'Lay frames from a video or image sequence out on a grid in one PNG. Transparency is kept (or key out a green screen), and you choose the grid and final resolution.',
    run: 'Build sprite sheet',
    fields: [
      file('input', 'Video or image sequence', { pick: 'visual', detect: 'auto' }),
      ...VISUAL_RANGE,
      section('Grid'),
      row(
        num('cols', 'Columns', { def: '8' }),
        num('rows', 'Rows', { def: '8' }),
        select('pick', 'Which frames', [['spread', 'Spread evenly over the range'], ['consecutive', 'Consecutive from the start']])
      ),
      row(
        num('sheetWidth', 'Sheet width (px)', { def: '2048', placeholder: 'auto' }),
        num('sheetHeight', 'Sheet height (px)', { placeholder: 'auto', hint: 'Blank = keep frame aspect' }),
        num('padding', 'Spacing (px)', { placeholder: '0' })
      ),
      select('fit', 'Frame fit', [['fit', 'Fit inside cell (transparent bars)'], ['fill', 'Fill cell (crop)'], ['stretch', 'Stretch to cell']]),
      section('Background'),
      row(check('transparent', 'Transparent background', { def: true }), color('bgColor', 'Background color', { def: '#000000', when: (v) => !v.transparent })),
      row(
        check('chroma', 'Key out a color (green screen)'),
        color('keyColor', 'Key color', { def: '#00ff00', when: (v) => v.chroma }),
        num('keySimilarity', 'Similarity (0–1)', { def: '0.3', when: (v) => v.chroma })
      ),
      check('json', 'Also write a .json file with frame positions'),
      save('output', 'Output PNG'),
    ],
    reset: ['startFrame', 'endFrame', 'start', 'end'],
    ext: () => '.png',
    suffix: '_sheet',
  },
  {
    id: 'frames',
    group: 'Animation & images',
    name: 'Video → Frames',
    icon: 'frames',
    desc: 'Export every frame (or a few per second) of a video as numbered PNG, JPG or WebP images.',
    run: 'Export frames',
    fields: [
      file('input', 'Video', { pick: 'video' }),
      row(time('start', 'Start', { placeholder: '0:00' }), time('end', 'End', { placeholder: (v, t) => (t.probe() ? fmtClock(t.probe().duration) : 'end') })),
      row(num('fps', 'Frames per second', { placeholder: 'every frame' }), num('width', 'Width (px)', { placeholder: 'original' })),
      row(select('format', 'Image format', [['png', 'PNG (lossless, keeps alpha)'], ['jpg', 'JPG'], ['webp', 'WebP']]), num('quality', 'Quality (1–100)', { def: '92', when: (v) => v.format !== 'png' })),
      row(folder('folder', 'Output folder', { auto: autoName('_frames') }), text('prefix', 'File name prefix', { auto: autoPrefix })),
    ],
    reset: ['start', 'end'],
  },
  {
    id: 'imageconvert',
    group: 'Animation & images',
    name: 'Convert Images',
    icon: 'imageConvert',
    desc: 'Batch-convert a folder of images (PNG → JPG, WebP, …) with compression settings. Optionally resize them: fit inside a size keeping the aspect ratio, stretch to it, or fill it and crop.',
    run: 'Convert images',
    fields: [
      select('source', 'Convert', [['folder', 'Every image in a folder'], ['files', 'Images I pick']]),
      folder('inFolder', 'Source folder', { input: true, placeholder: 'Folder with your images', when: (v) => v.source !== 'files' }),
      rowIf((v) => v.source !== 'files', select('inTypes', 'Which files', IMG_TYPES), check('recursive', 'Include subfolders')),
      { type: 'files', key: 'files', label: 'Images', pick: 'image', ordered: false, when: (v) => v.source === 'files' },
      section('Format & compression'),
      row(
        select('format', 'Convert to', IMG_FORMATS),
        num('quality', 'Quality (1–100)', { def: '90', hint: 'Lower = smaller file', when: (v) => v.format === 'jpg' || (v.format === 'webp' && !v.lossless) }),
        select('chroma', 'Color detail', [['420', 'Standard (4:2:0)'], ['444', 'Full (4:4:4, bigger file)']], { when: (v) => v.format === 'jpg' }),
        select('pngLevel', 'Compression', [['small', 'Smallest file'], ['balanced', 'Balanced'], ['fast', 'Fastest']], { when: (v) => v.format === 'png' }),
        select('tiffComp', 'Compression', [['lzw', 'LZW'], ['deflate', 'Deflate (ZIP)'], ['packbits', 'PackBits'], ['raw', 'None']], { when: (v) => v.format === 'tiff' })
      ),
      row(
        check('lossless', 'Lossless', { when: (v) => v.format === 'webp' }),
        check('keepAlpha', 'Keep transparency', { def: true, when: (v) => IMG_ALPHA.has(v.format) }),
        color('bg', 'Background color', { def: '#ffffff', hint: 'Fills transparent areas and padding', when: imgOpaque })
      ),
      section('Resize'),
      row(
        select('resize', 'Resize', [['none', "Don't resize"], ['fit', 'Fit inside — keep aspect ratio'], ['stretch', 'Stretch to exact size'], ['crop', 'Fill & crop to exact size']]),
        num('width', 'Width (px)', { placeholder: (v) => (v.resize === 'fit' ? 'auto' : ''), when: (v) => v.resize !== 'none' }),
        num('height', 'Height (px)', { placeholder: (v) => (v.resize === 'fit' ? 'auto' : ''), when: (v) => v.resize !== 'none' })
      ),
      rowIf((v) => v.resize === 'fit', check('noUpscale', "Don't enlarge smaller images", { def: true }), check('pad', 'Pad to the exact size (letterbox)')),
      rowIf((v) => v.resize === 'crop', select('anchor', 'Keep which part', [['center', 'Center'], ['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left side'], ['right', 'Right side']])),
      section('Output'),
      row(folder('folder', 'Output folder', { placeholder: 'Same folder as the originals' }), text('suffix', 'Add to file names', { placeholder: 'e.g. _small' })),
    ],
  },
  {
    id: 'audioconvert',
    group: 'Audio',
    name: 'Convert Audio',
    icon: 'audioConvert',
    desc: 'Convert audio to another format: WAV ↔ MP3, FLAC, AAC, Opus, AIFF and more. Add one file or a whole batch; tags and cover art come along.',
    run: 'Convert',
    fields: [
      { type: 'files', key: 'files', label: 'Audio files', pick: 'audio', ordered: false },
      row(
        select('format', 'Convert to', ACONV),
        select('mp3q', 'Quality', MP3Q, { def: '192k', when: (v) => v.format === 'mp3' }),
        select('abitrate', 'Bitrate', [['64k', '64 kbps'], ...BITRATES], { def: '192k', when: (v) => ['m4a', 'opus', 'ogg', 'wma', 'ac3'].includes(v.format) }),
        select('depth', 'Bit depth', DEPTHS, { when: (v) => ['wav', 'aiff', 'flac', 'alac'].includes(v.format) }),
        text('otherExt', 'File extension', { placeholder: 'e.g. wv, caf, mka', when: (v) => v.format === 'other' })
      ),
      row(select('rate', 'Sample rate', RATES), select('channels', 'Channels', [['', 'Same as source'], ['1', 'Mono'], ['2', 'Stereo']])),
      check('meta', 'Keep tags and cover art', { def: true }),
      folder('folder', 'Output folder', { placeholder: 'Same folder as each file' }),
    ],
  },
  {
    id: 'audiofx',
    group: 'Audio',
    name: 'Audio Effects',
    icon: 'sliders',
    desc: 'Stack effects in any order — filters, EQ, compression, distortion, bit-crushing, static, reverb, echo, modulation, pitch. Start from a preset (like the airport-tower radio sound), tweak, and preview before saving.',
    run: 'Apply effects',
    fields: [
      file('input', 'Audio or video file', { pick: 'media' }),
      row(time('start', 'Start (optional)', { placeholder: '0:00' }), time('end', 'End (optional)', { placeholder: (v, t) => (t.probe() ? fmtClock(t.probe().duration) : 'end') })),
      section('Effects'),
      { type: 'custom', key: 'chain', def: FX.fromPreset(FX.PRESETS[0]), render: fxPanel },
      section('Output'),
      rowIf((v, t) => !!t.probe()?.video, select('target', 'Save as', [['audio', 'Audio file'], ['video', 'Video with the new audio (video copied as-is)']], { affectsExt: true })),
      AUDIO_FORMAT('wav', (v, t) => !fxVideoOut(v, t)),
      rowIf(fxVideoOut, select('vabitrate', 'Audio bitrate', BITRATES, { def: '192k' })),
      row(
        check('tails', 'Let reverb & echo tails ring out past the end', { def: true, when: (v, t) => !fxVideoOut(v, t) }),
        check('limiter', 'Safety limiter (prevents clipping)', { def: true })
      ),
      save('output', 'Output file'),
    ],
    reset: ['start', 'end'],
    ext: (v, t) => (fxVideoOut(v, t) ? extname(cleanPath(v.input)) || '.mp4' : AEXT[v.format]),
    suffix: '_fx',
    onChange: (key, tool) => fxOnChange(key, tool),
  },
  {
    id: 'extract',
    group: 'Audio',
    name: 'Extract Audio',
    icon: 'music',
    desc: "Pull the audio track out of a video, optionally just a time range. 'Original' copies the stream without re-encoding.",
    run: 'Extract audio',
    fields: [
      file('input', 'Video or audio file', { pick: 'media' }),
      row(
        select('format', 'Format', [['copy', 'Original (no re-encode)'], ...AFORMATS], { def: 'mp3', affectsExt: true }),
        select('abitrate', 'Bitrate', BITRATES, { def: '192k', when: (v) => LOSSY.has(v.format) })
      ),
      check('mono', 'Mix down to mono', { when: (v) => v.format !== 'copy' }),
      row(time('start', 'Start (optional)', { placeholder: '0:00' }), time('end', 'End (optional)', { placeholder: (v, t) => (t.probe() ? fmtClock(t.probe().duration) : 'end') })),
      save('output', 'Output audio'),
    ],
    reset: ['start', 'end'],
    ext: (v, t) => (v.format === 'copy' ? copyExt(t.probe()?.audio?.codec) : AEXT[v.format]),
    suffix: '',
  },
  {
    id: 'audiofade',
    group: 'Audio',
    name: 'Fade & Trim Audio',
    icon: 'fade',
    desc: 'Cut a section out of an audio file and fade it in and out. Optionally adjust the volume or normalize loudness.',
    run: 'Save audio',
    fields: [
      file('input', 'Audio file', { pick: 'media' }),
      row(time('start', 'Start', { placeholder: '0:00' }), time('end', 'End', { placeholder: (v, t) => (t.probe() ? fmtClock(t.probe().duration) : 'end') })),
      row(num('fadeIn', 'Fade in (s)', { def: '0.5' }), num('fadeOut', 'Fade out (s)', { def: '1' }), select('curve', 'Fade shape', CURVES)),
      row(num('gain', 'Volume change (dB)', { placeholder: '0' }), check('normalize', 'Normalize loudness (−16 LUFS)')),
      AUDIO_FORMAT('mp3'),
      save('output', 'Output audio'),
    ],
    reset: ['start', 'end'],
    ext: (v) => AEXT[v.format],
    suffix: '_edit',
  },
  {
    id: 'loopaudio',
    group: 'Audio',
    name: 'Loop Audio',
    icon: 'repeat',
    desc: 'Crossfade an audio clip into itself. Make a seamless loop file (its end blends into its start), or repeat it with smooth joins to a count or length.',
    run: 'Make loop',
    fields: [
      file('input', 'Audio clip', { pick: 'media' }),
      select('mode', 'Mode', [['seamless', 'Seamless loop — blend the end into the start'], ['count', 'Repeat N times with crossfades'], ['duration', 'Repeat to fill a length']], { affectsExt: true }),
      row(
        num('crossfade', 'Crossfade (s)', { def: '1' }),
        select('curve', 'Crossfade shape', [['qsin', 'Equal power (smooth)'], ['tri', 'Linear']]),
        num('count', 'Repeat count', { def: '4', when: (v) => v.mode === 'count' }),
        time('duration', 'Target length', { placeholder: 'e.g. 3:00', when: (v) => v.mode === 'duration' })
      ),
      rowIf((v) => v.mode !== 'seamless', num('fadeIn', 'Fade in (s)', { placeholder: '0' }), num('fadeOut', 'Fade out at end (s)', { placeholder: (v) => (v.mode === 'duration' ? '2' : '0') })),
      AUDIO_FORMAT('wav'),
      save('output', 'Output audio'),
    ],
    ext: (v) => AEXT[v.format],
    suffix: '_loop',
  },
  {
    id: 'silence',
    group: 'Audio',
    name: 'Split on Silence',
    icon: 'wave',
    desc: 'Find the individual sounds in a recording (separated by silence) and export each one as its own file. Preview, deselect, and tweak padding before exporting.',
    run: 'Export sounds',
    op: 'silenceExport',
    fields: [
      file('input', 'Recording', { pick: 'media' }),
      row(num('threshold', 'Silence threshold (dB)', { def: '-40', hint: 'Anything quieter counts as silence' }), num('minSilence', 'Min silence length (s)', { def: '0.3', hint: 'Shorter pauses stay inside a sound' })),
      { type: 'custom', key: '_silence', render: silencePanel },
      section('Clips'),
      row(
        num('preRoll', 'Pad before (ms)', { def: '50' }),
        num('postRoll', 'Pad after (ms)', { def: '120' }),
        num('minSound', 'Ignore sounds shorter than (ms)', { def: '80' }),
        num('fadeMs', 'Edge fade (ms)', { def: '5' })
      ),
      AUDIO_FORMAT('wav'),
      row(folder('folder', 'Output folder', { auto: autoName('_clips') }), text('prefix', 'File name prefix', { auto: autoPrefix })),
    ],
    params: (v, tool) => ({ ...v, segments: selectedSegments(tool) }),
    onChange(key, tool) {
      if (['preRoll', 'postRoll', 'minSound', 'threshold', 'minSilence'].includes(key)) refreshCustom(tool);
    },
  },
  {
    id: 'trim',
    group: 'Any media',
    name: 'Trim / Cut',
    icon: 'scissors',
    desc: "Keep just part of a video or audio file. Fast mode doesn't re-encode (instant, but cuts land on keyframes); accurate mode re-encodes and can fade in/out.",
    run: 'Trim',
    fields: [
      file('input', 'Video or audio file', { pick: 'media' }),
      row(time('start', 'Start', { placeholder: '0:00' }), time('end', 'End', { placeholder: (v, t) => (t.probe() ? fmtClock(t.probe().duration) : 'end') })),
      select('mode', 'Mode', [['copy', 'Fast — no re-encode (cuts on keyframes)'], ['reencode', 'Accurate — re-encode']], { affectsExt: true }),
      rowIf((v) => v.mode === 'reencode', num('fadeIn', 'Fade in (s)', { placeholder: '0' }), num('fadeOut', 'Fade out (s)', { placeholder: '0' })),
      ...VIDEO_ENC((v, t) => v.mode === 'reencode' && !!t.probe()?.video),
      rowIf((v) => v.mode === 'reencode', select('abitrate', 'Audio bitrate', BITRATES, { def: '192k' })),
      save('output', 'Output file'),
    ],
    reset: ['start', 'end'],
    ext: (v, t) => (v.mode === 'reencode' && t.probe()?.video ? VEXT[codecOf(v)] : extname(cleanPath(v.input)) || null),
    suffix: '_trim',
  },
  {
    id: 'concat',
    group: 'Any media',
    name: 'Concat / Join',
    icon: 'concat',
    desc: 'Join videos or audio files (e.g. MP3s) end to end. Fast mode needs files in the same format; re-encode handles mixed sizes, codecs, and adds audio crossfades.',
    run: 'Join files',
    fields: [
      { type: 'files', key: 'files', label: 'Files, in order', pick: 'media' },
      select('mode', 'Mode', [['copy', 'Fast — stream copy (files must share a format)'], ['reencode', 'Re-encode (mixed formats / sizes)']], { affectsExt: true }),
      rowIf((v, t) => v.mode === 'reencode' && t.audioOnly(), num('crossfade', 'Crossfade between files (s)', { placeholder: '0' })),
      AUDIO_FORMAT('mp3', (v, t) => v.mode === 'reencode' && t.audioOnly()),
      ...VIDEO_ENC((v, t) => v.mode === 'reencode' && !t.audioOnly()),
      rowIf((v, t) => v.mode === 'reencode' && !t.audioOnly(), num('fps', 'Frame rate', { placeholder: 'same as first file' }), select('abitrate', 'Audio bitrate', BITRATES, { def: '192k' })),
      save('output', 'Output file', { from: 'files' }),
    ],
    ext: (v, t) => {
      const first = cleanPath((v.files || [])[0]);
      if (v.mode !== 'reencode') return extname(first) || null;
      return t.audioOnly() ? AEXT[v.format] : VEXT[codecOf(v)];
    },
    suffix: '_joined',
  },
  {
    id: 'info',
    group: 'Any media',
    name: 'Media Info',
    icon: 'info',
    desc: 'Inspect any media file: container, duration, streams, codecs, resolution, frame rate, sample rate (via ffprobe).',
    noRun: true,
    fields: [file('input', 'File', { pick: 'any' }), { type: 'custom', key: '_info', render: infoPanel }],
  },
];

// ================================================================ state

const S = {
  cfg: null,
  toolId: null,
  values: {}, // toolId -> { key: value }
  info: {}, // toolId -> { key: {kind, data, error, loading, path} }, plus .files Map for concat
  auto: {}, // toolId -> { key: false } once the user sets an output by hand
  sil: {}, // toolId -> { jobId, result, excluded:Set }
  jobs: new Map(),
};
const TOOL = (id) => TOOLS.find((t) => t.id === id);

function walkFields(fields, fn) {
  for (const f of fields) {
    if (f.type === 'row') walkFields(f.fields, fn);
    else fn(f);
  }
}
function fieldOf(tool, key) {
  let found = null;
  walkFields(tool.fields, (f) => {
    if (f.key === key) found = f;
  });
  return found;
}

function tctx(tool) {
  const info = S.info[tool.id] || {};
  const files = () => (S.values[tool.id]?.files || []).map((p) => info.files?.get(cleanPath(p))).filter(Boolean);
  return {
    kind: (k = 'input') => info[k]?.kind,
    probe: (k = 'input') => (info[k]?.kind === 'probe' ? info[k].data : null),
    seq: (k = 'input') => (info[k]?.kind === 'seq' ? info[k].data : null),
    files,
    audioOnly: () => {
      const list = files();
      return list.length > 0 && list.every((x) => x.data && !x.data.video);
    },
  };
}

function baseNameFor(key, src, t) {
  const seq = t.seq(key);
  if (seq && !seq.single) return (seq.prefix || '').replace(/[\s._-]+$/, '') || basename(dirname(src)) || 'sequence';
  return stem(src);
}

function loadValues(tool) {
  if (S.values[tool.id]) return S.values[tool.id];
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem('ffh:v:' + tool.id) || '{}');
  } catch {}
  const v = {};
  walkFields(tool.fields, (f) => {
    if (!f.key || f.key.startsWith('_')) return;
    const def = f.def !== undefined ? f.def : f.type === 'check' ? false : f.type === 'files' ? [] : '';
    // Files chosen in the web version only exist until the page is closed.
    const gone = WEB && ['file', 'files', 'save', 'folder'].includes(f.type);
    v[f.key] = stored[f.key] !== undefined && !gone ? stored[f.key] : def;
  });
  S.values[tool.id] = v;
  S.auto[tool.id] = WEB ? {} : stored.__auto || {};
  return v;
}
function saveValues(tool) {
  try {
    localStorage.setItem('ffh:v:' + tool.id, JSON.stringify({ ...S.values[tool.id], __auto: S.auto[tool.id] }));
  } catch {}
}
function rememberDir(p) {
  const d = dirname(cleanPath(p));
  if (!d) return;
  try {
    localStorage.setItem('ffh:lastDir', d);
  } catch {}
}
function lastDir() {
  try {
    return localStorage.getItem('ffh:lastDir') || '';
  } catch {
    return '';
  }
}

// ================================================================ rendering the form

function renderNav() {
  const nav = $('#nav');
  const sel = $('#navSelect');
  nav.replaceChildren();
  sel.replaceChildren();
  let group = null;
  let og = null;
  for (const t of TOOLS) {
    if (t.group !== group) {
      group = t.group;
      nav.append(h('div', { class: 'nav-group' }, group));
      og = h('optgroup', { label: group });
      sel.append(og);
    }
    nav.append(h('button', { type: 'button', class: 'nav-item', 'data-id': t.id, onclick: () => showTool(t.id) }, icon(t.icon), h('span', {}, t.name)));
    og.append(h('option', { value: t.id }, t.name));
  }
  sel.onchange = () => showTool(sel.value);
}

function showTool(id) {
  const tool = TOOL(id) || TOOLS[0];
  S.toolId = tool.id;
  try {
    localStorage.setItem('ffh:tool', tool.id);
  } catch {}
  for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('active', b.dataset.id === tool.id);
  $('#navSelect').value = tool.id;
  $('#toolName').textContent = tool.name;
  $('#toolDesc').textContent = tool.desc;
  const v = loadValues(tool);
  tool._els = [];
  tool._inputs = {};
  tool._infoEls = {};
  tool._customs = [];
  const form = $('#form');
  form.replaceChildren(...tool.fields.map((f) => renderField(tool, f)));
  $('#cmdBox').hidden = !!tool.noRun;
  $('#actions').hidden = !!tool.noRun;
  renderPreview({});
  $('#runBtn').textContent = tool.run || 'Run';
  for (const k of Object.keys(tool._infoEls)) renderInfo(tool, k);
  refresh(tool);
  // Re-read info for remembered inputs.
  walkFields(tool.fields, (f) => {
    if (f.type === 'file' && cleanPath(v[f.key]) && !S.info[tool.id]?.[f.key]) detect(tool, f);
    if (f.type === 'files') detectFiles(tool, f);
  });
  $('.main').scrollTop = 0;
  schedulePreview();
}

function reg(tool, f, el, input) {
  tool._els.push({ f, el, input });
  if (input && f.key) tool._inputs[f.key] = input;
}

function renderField(tool, f) {
  const v = S.values[tool.id];
  if (f.type === 'section') {
    const el = h('div', { class: 'section' }, f.label);
    reg(tool, f, el);
    return el;
  }
  if (f.type === 'row') {
    const el = h('div', { class: 'row' }, f.fields.map((sf) => renderField(tool, sf)));
    reg(tool, f, el);
    return el;
  }
  if (f.type === 'custom') {
    const el = h('div', { class: 'custom' });
    reg(tool, f, el);
    tool._customs.push({ f, el });
    f.render(el, tool);
    return el;
  }
  if (f.type === 'check') {
    const input = h('input', { type: 'checkbox', checked: !!v[f.key], onchange: (e) => setValue(tool, f.key, e.target.checked, 'input') });
    const el = h('label', { class: 'field check' }, input, h('span', {}, f.label));
    reg(tool, f, el, input);
    return el;
  }

  const id = `f-${tool.id}-${f.key}`;
  const isPath = ['file', 'save', 'folder'].includes(f.type);
  const wrap = h('div', { class: 'field' + (isPath || f.type === 'files' ? ' wide' : '') });
  let input;
  let labelEl = h('label', { for: id }, f.label);

  if (f.type === 'files') {
    renderFilesField(tool, f, wrap, id);
    reg(tool, f, wrap);
    return wrap;
  }
  if (f.type === 'select') {
    input = h('select', { id, onchange: (e) => setValue(tool, f.key, e.target.value, 'input') }, f.opts.map(([val, lab]) => h('option', { value: val }, lab)));
    input.value = v[f.key];
    if (input.value !== v[f.key]) {
      // remembered value isn't an option any more
      input.value = f.def;
      v[f.key] = f.def;
    }
  } else if (f.type === 'color') {
    input = h('input', { id, type: 'color', value: v[f.key] || '#000000', oninput: (e) => setValue(tool, f.key, e.target.value, 'input') });
  } else {
    // In the web version a save field holds just a file name; results are downloaded.
    const webName = WEB && f.type === 'save';
    input = h('input', {
      id,
      type: 'text',
      spellcheck: 'false',
      inputmode: f.type === 'number' ? 'decimal' : null,
      value: shownPath(f, v[f.key]),
      readOnly: WEB && isPath && !webName,
      oninput: (e) => {
        const name = e.target.value.trim().replace(/[\\/]/g, '_');
        setValue(tool, f.key, webName ? (name ? `/out/${name}` : '') : e.target.value, 'input');
      },
    });
  }

  if (f.type === 'save' || f.auto) {
    // "Suggested name" reset appears once the user has typed their own.
    const reset = h('button', { type: 'button', class: 'linkish', title: 'Go back to the automatic name', onclick: () => resetAuto(tool, f) }, 'use suggested');
    labelEl = h('div', { class: 'label-row' }, labelEl, reset);
    tool._els.push({ f: { when: () => S.auto[tool.id]?.[f.key] === false }, el: reset });
  }
  wrap.append(labelEl);
  if (WEB && f.type === 'save') {
    input.placeholder = 'File name';
    wrap.append(input, h('div', { class: 'hint' }, 'You’ll get a download link when it’s done.'));
  } else if (isPath) {
    input.placeholder = typeof f.placeholder === 'string' ? f.placeholder : f.type === 'folder' ? 'Folder path' : 'Full path to a file';
    if (WEB) {
      input.placeholder = f.type === 'folder' ? 'No folder chosen' : f.detect ? 'No file chosen — for a sequence, select all its frames' : 'No file chosen';
      input.addEventListener('click', () => browse(tool, f));
    }
    input.addEventListener('dragover', (e) => e.preventDefault());
    input.addEventListener('drop', (e) => {
      e.preventDefault();
      if (WEB && e.dataTransfer.files.length && f.type === 'file') return void setValue(tool, f.key, WEB.addFiles(e.dataTransfer.files)[0], 'pick');
      // Browsers hide real paths of dropped files; accept dropped text paths only.
      const txt = e.dataTransfer.getData('text/plain');
      if (txt && !WEB) setValue(tool, f.key, cleanPath(txt), 'pick');
      else toast(WEB ? 'Use Choose… to pick the folder.' : 'Browsers don’t reveal the location of dropped files — use Browse… or paste the path.');
    });
    wrap.append(h('div', { class: 'pathrow' }, input, h('button', { type: 'button', class: 'btn', onclick: () => browse(tool, f) }, WEB ? 'Choose…' : 'Browse…')));
    if (f.type === 'file') {
      const infoEl = h('div', { class: 'finfo' });
      tool._infoEls[f.key] = infoEl;
      wrap.append(infoEl);
    }
  } else {
    wrap.append(input);
  }
  if (f.hint) wrap.append(h('div', { class: 'hint' }, f.hint));
  reg(tool, f, wrap, input);
  return wrap;
}

function refresh(tool) {
  if (S.toolId !== tool.id || !tool._els) return;
  const v = S.values[tool.id];
  const t = tctx(tool);
  for (const { f, el, input } of tool._els) {
    el.hidden = f.when ? !f.when(v, t) : false;
    if (input && f.placeholder !== undefined && f.type !== 'file') {
      const ph = typeof f.placeholder === 'function' ? f.placeholder(v, t) : f.placeholder;
      input.placeholder = ph == null ? '' : String(ph);
    }
  }
}

function refreshCustom(tool) {
  if (S.toolId !== tool.id || !tool._customs) return;
  for (const { f, el } of tool._customs) f.render(el, tool);
}

function syncInput(tool, key) {
  if (S.toolId !== tool.id) return;
  const f = fieldOf(tool, key);
  if (f && f.type === 'files') return renderFileList(tool, f);
  const input = tool._inputs?.[key];
  if (!input) return;
  const val = S.values[tool.id][key];
  if (input.type === 'checkbox') input.checked = !!val;
  else input.value = f ? shownPath(f, val) : val ?? '';
}

function setValue(tool, key, val, from = 'code') {
  const v = S.values[tool.id];
  if (JSON.stringify(v[key]) === JSON.stringify(val)) return;
  v[key] = val;
  const f = fieldOf(tool, key);
  if (from !== 'input') syncInput(tool, key);
  if (f && (from === 'input' || from === 'pick') && (f.type === 'save' || f.auto)) S.auto[tool.id][key] = cleanPath(val) ? false : undefined;
  if (f && f.type === 'file') inputChanged(tool, f);
  if (f && f.type === 'files') {
    detectFiles(tool, f);
    syncOutputs(tool);
  }
  if (f && f.affectsExt) syncOutputs(tool);
  if (tool.onChange) tool.onChange(key, tool);
  saveValues(tool);
  refresh(tool);
  schedulePreview();
}

function resetAuto(tool, f) {
  delete S.auto[tool.id][f.key];
  S.values[tool.id][f.key] = '';
  syncOutputs(tool);
  saveValues(tool);
  refresh(tool);
  schedulePreview();
}

/** Fill in output names that haven't been set by hand; keep manual ones but fix their extension. */
function syncOutputs(tool) {
  const v = S.values[tool.id];
  const t = tctx(tool);
  const auto = S.auto[tool.id];
  walkFields(tool.fields, (f) => {
    const manual = auto[f.key] === false && cleanPath(v[f.key]);
    let next = null;
    if (f.type === 'save') {
      if (!manual) next = suggestSave(tool, f, v, t);
      else if (tool.ext) {
        const e = tool.ext(v, t);
        if (e && extname(v[f.key]) !== e) next = withExt(cleanPath(v[f.key]), e);
      }
    } else if (f.auto && !manual) {
      next = f.auto(v, t, tool);
    }
    if (next != null && next !== v[f.key]) {
      v[f.key] = next;
      syncInput(tool, f.key);
    }
  });
  saveValues(tool);
}

function suggestSave(tool, f, v, t) {
  const key = f.from || 'input';
  let src = v[key];
  if (Array.isArray(src)) src = src[0];
  src = cleanPath(src);
  if (!src) return null;
  const ext = (tool.ext && tool.ext(v, t)) || extname(src) || '.mp4';
  const name = baseNameFor(key, src, t) + (tool.suffix ?? '') + ext;
  return WEB ? `/out/${name}` : joinPath(dirname(src), name);
}

// ---------------------------------------------------------------- input detection (ffprobe / sequence)

function inputChanged(tool, f) {
  const info = (S.info[tool.id] ||= {});
  delete info[f.key];
  const v = S.values[tool.id];
  for (const k of tool.reset || []) {
    if (v[k] !== '') {
      v[k] = '';
      syncInput(tool, k);
    }
  }
  renderInfo(tool, f.key);
  clearTimeout(f._timer);
  f._timer = setTimeout(() => detect(tool, f), 300);
  refreshCustom(tool);
}

async function detect(tool, f) {
  const info = (S.info[tool.id] ||= {});
  const p = cleanPath(S.values[tool.id][f.key]);
  if (!p) {
    delete info[f.key];
    renderInfo(tool, f.key);
    syncOutputs(tool);
    refresh(tool);
    return;
  }
  const mode = f.detect === 'seq' || (f.detect === 'auto' && isImage(p)) ? 'seq' : 'probe';
  const token = {};
  info[f.key] = { loading: true, path: p, token };
  renderInfo(tool, f.key);
  let next;
  try {
    const data = await api(mode === 'seq' ? '/api/sequence' : '/api/probe', { path: p });
    next = { kind: mode, data, path: p };
    rememberDir(p);
  } catch (e) {
    next = { error: e.message, path: p };
  }
  if (info[f.key]?.token !== token) return; // a newer pick superseded this one
  info[f.key] = next;
  renderInfo(tool, f.key);
  syncOutputs(tool);
  refresh(tool);
  refreshCustom(tool);
  schedulePreview();
}

function probeChips(d) {
  const chips = [];
  if (d.duration != null && !d.isImage) chips.push(fmtClock(d.duration));
  if (d.video) {
    chips.push(`${d.video.width}×${d.video.height}`);
    if (d.video.fps && !d.isImage) chips.push(`${+d.video.fps.toFixed(3)} fps`);
    chips.push(d.video.codec);
    if (d.video.hasAlpha) chips.push(['alpha', 'accent']);
  }
  if (d.audio) chips.push(`${d.audio.codec} · ${d.audio.sampleRate ? d.audio.sampleRate / 1000 + ' kHz' : ''} ${chLabel(d.audio.channels)}`.trim());
  if (!d.video && !d.audio) chips.push(['no audio/video streams', 'warn']);
  chips.push(fmtBytes(d.size));
  return chips;
}

function renderInfo(tool, key) {
  const el = tool._infoEls?.[key];
  if (!el || S.toolId !== tool.id) return;
  const i = S.info[tool.id]?.[key];
  el.className = 'finfo';
  el.replaceChildren();
  if (!i) return;
  if (i.loading) return el.append(h('span', { class: 'spin' }), ' Reading file…');
  if (i.error) {
    el.classList.add('err');
    return el.append(i.error);
  }
  let chips;
  if (i.kind === 'seq') {
    const s = i.data;
    chips = s.single
      ? [['single image (no frame number in the name)', 'warn'], `${s.width}×${s.height}`]
      : [[`${s.count} frames`, 'accent'], `#${s.first} – #${s.last}`, `${s.width}×${s.height}`, basename(s.pattern)];
    if (s.hasAlpha) chips.push(['alpha', 'accent']);
    if (s.firstMissing != null) chips.push([`gap at #${s.firstMissing} — ffmpeg stops there`, 'warn']);
  } else {
    chips = probeChips(i.data);
  }
  for (const c of chips) {
    const [label, cls] = Array.isArray(c) ? c : [c, ''];
    el.append(h('span', { class: `chip ${cls}` }, label));
  }
}

// ---------------------------------------------------------------- file list field (concat)

function renderFilesField(tool, f, wrap, id) {
  const list = h('div', { class: 'filelist' });
  const pathIn = h('input', {
    id,
    type: 'text',
    spellcheck: 'false',
    placeholder: 'Paste paths and press Enter, or use Add files…',
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      // Explorer's "Copy as path" quotes each file, so several can be pasted at once.
      const quoted = [...pathIn.value.matchAll(/"([^"]+)"/g)].map((m) => m[1].trim()).filter(Boolean);
      const paths = quoted.length ? quoted : [cleanPath(pathIn.value)].filter(Boolean);
      if (!paths.length) return;
      pathIn.value = '';
      setValue(tool, f.key, [...S.values[tool.id][f.key], ...paths], 'pick');
    },
  });
  const add = h('button', { type: 'button', class: 'btn', onclick: () => browse(tool, f) }, 'Add files…');
  const clear = h('button', { type: 'button', class: 'btn ghost', onclick: () => setValue(tool, f.key, [], 'pick') }, 'Clear');
  if (WEB) {
    // No paths to paste in a browser; drop files onto the list instead.
    pathIn.hidden = true;
    wrap.addEventListener('dragover', (e) => e.preventDefault());
    wrap.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer.files.length) setValue(tool, f.key, [...S.values[tool.id][f.key], ...WEB.addFiles(e.dataTransfer.files)], 'pick');
    });
  }
  wrap.append(h('label', { for: id }, f.label), list, h('div', { class: 'pathrow' }, pathIn, add, clear, WEB && h('span', { class: 'hint' }, 'or drop files here')));
  tool._lists = { ...(tool._lists || {}), [f.key]: list };
  renderFileList(tool, f);
}

function renderFileList(tool, f) {
  const list = tool._lists?.[f.key];
  if (!list || S.toolId !== tool.id) return;
  const arr = S.values[tool.id][f.key] || [];
  const infos = S.info[tool.id]?.files;
  const move = (i, d) => {
    const next = arr.slice();
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setValue(tool, f.key, next, 'pick');
  };
  list.replaceChildren(
    ...arr.map((p, i) => {
      const inf = infos?.get(cleanPath(p));
      let sub;
      if (!inf || inf.loading) sub = h('small', {}, WEB ? 'Reading…' : dirname(p));
      else if (inf.error) sub = h('small', { class: 'err' }, inf.error);
      else sub = h('small', {}, probeChips(inf.data).map((c) => (Array.isArray(c) ? c[0] : c)).join(' · '));
      return h(
        'div',
        { class: 'fitem' },
        h('span', { class: 'n' }, i + 1),
        h('div', { class: 'name' }, h('b', { title: p }, basename(p)), sub),
        f.ordered !== false && h('button', { type: 'button', class: 'icon-btn', title: 'Move up', disabled: i === 0, onclick: () => move(i, -1) }, icon('up')),
        f.ordered !== false && h('button', { type: 'button', class: 'icon-btn', title: 'Move down', disabled: i === arr.length - 1, onclick: () => move(i, 1) }, icon('down')),
        h('button', { type: 'button', class: 'icon-btn', title: 'Remove', onclick: () => setValue(tool, f.key, arr.filter((_, j) => j !== i), 'pick') }, icon('x'))
      );
    })
  );
}

async function detectFiles(tool, f) {
  const info = (S.info[tool.id] ||= {});
  const map = (info.files ||= new Map());
  const todo = (S.values[tool.id][f.key] || []).map(cleanPath).filter((p) => p && !map.has(p));
  for (const p of todo) map.set(p, { loading: true });
  if (todo.length) renderFileList(tool, f);
  // A few at a time: picking hundreds of files shouldn't start hundreds of ffprobes at once.
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const p = todo[next++];
      try {
        map.set(p, { data: await api('/api/probe', { path: p }) });
        rememberDir(p);
      } catch (e) {
        map.set(p, { error: e.message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, todo.length) }, worker));
  if (todo.length) {
    renderFileList(tool, f);
    syncOutputs(tool);
    refresh(tool);
    schedulePreview();
  }
}

// ---------------------------------------------------------------- native pickers

async function browse(tool, f) {
  const v = S.values[tool.id];
  const mode = f.type === 'save' ? 'save' : f.type === 'folder' ? 'folder' : f.type === 'files' ? 'many' : 'open';
  let initial = f.type === 'files' ? cleanPath((v.files || []).slice(-1)[0]) : cleanPath(v[f.key]);
  if (!initial) initial = cleanPath(v.input || v.video || v.inFolder) || lastDir();
  try {
    // multi: in a browser the rest of an image sequence can only be reached by selecting all its frames.
    const { paths } = await api('/api/pick', { mode, filter: f.pick || 'any', initial, title: f.label, multi: !!f.detect });
    if (!paths || !paths.length) return;
    if (f.type === 'files') setValue(tool, f.key, [...(v[f.key] || []), ...paths], 'pick');
    else setValue(tool, f.key, paths[0], 'pick');
    rememberDir(paths[0]);
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ================================================================ command preview + run

let previewTimer = null;
let previewSeq = 0;
let lastCommands = [];

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(preview, 220);
}

function jobRequest(tool) {
  const v = S.values[tool.id];
  const params = tool.params ? tool.params(v, tool) : { ...v };
  // Web version: output folders aren't chosen; every result goes to the job's download folder.
  for (const k of tool._outDirs || []) params[k] = '/out';
  return { op: tool.op || tool.id, params };
}

async function preview() {
  const tool = TOOL(S.toolId);
  if (!tool || tool.noRun) return;
  const my = ++previewSeq;
  let res;
  try {
    res = await api('/api/command', jobRequest(tool));
  } catch (e) {
    res = { error: e.message };
  }
  if (my !== previewSeq || tool.id !== S.toolId) return;
  renderPreview(res);
}

function highlight(cmd) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return cmd
    .split(/("(?:[^"\\]|\\.)*"|\s+)/)
    .map((tok, i) => {
      if (!tok) return '';
      if (i === 0 && tok === 'ffmpeg') return '<span class="k">ffmpeg</span>';
      if (tok.startsWith('"')) return `<span class="q">${esc(tok)}</span>`;
      if (/^-[a-z]/i.test(tok)) return `<span class="fl">${esc(tok)}</span>`;
      return esc(tok);
    })
    .join('');
}

function renderPreview(res) {
  const notes = $('#notes');
  const cmd = $('#cmd');
  const err = $('#cmdErr');
  notes.replaceChildren(...(res.notes || []).map((n) => h('div', { class: n.startsWith('⚠') ? 'warn' : '' }, n)));
  err.hidden = !res.error;
  err.textContent = res.error ? `⚠ ${res.error}` : '';
  $('#runBtn').classList.toggle('dim', !!res.error);
  lastCommands = res.commands || [];
  const shown = lastCommands.slice(0, 4).map(highlight);
  if (lastCommands.length > 4) shown.push(`<span class="more">… and ${lastCommands.length - 4} more similar commands</span>`);
  cmd.innerHTML = shown.join('\n\n');
}

async function runTool(tool) {
  const job = await submitJob(jobRequest(tool));
  if (job) flashJob(job.id);
}

async function submitJob(req, overwrite = false) {
  try {
    const r = await api('/api/jobs', { ...req, overwrite });
    upsertJob(r.job);
    return r.job;
  } catch (e) {
    if (e.status === 409 && e.data?.exists) {
      const ex = e.data.exists;
      const list = ex.slice(0, 8).map(basename).join('\n') + (ex.length > 8 ? `\n… and ${ex.length - 8} more` : '');
      if (confirm(`Overwrite existing file${ex.length > 1 ? 's' : ''}?\n\n${list}`)) return submitJob(req, true);
      return null;
    }
    toast(e.message, 'err');
    return null;
  }
}

// ================================================================ jobs panel

const jobCards = new Map();
/** Background jobs that report into their tool's panel instead of the jobs list. */
const HIDDEN_OPS = new Set(['audiofxPreview']);

function connectEvents() {
  const snapshot = (list) => {
    S.jobs.clear();
    for (const j of list) S.jobs.set(j.id, j);
    renderJobs();
  };
  if (WEB) return void WEB.subscribe((event, data) => (event === 'snapshot' ? snapshot(data) : upsertJob(data)));
  const es = new EventSource('/api/events');
  es.addEventListener('snapshot', (e) => snapshot(JSON.parse(e.data)));
  es.addEventListener('job', (e) => upsertJob(JSON.parse(e.data)));
  es.onopen = () => ($('#conn').hidden = true);
  es.onerror = () => ($('#conn').hidden = false);
}

function renderJobs() {
  const list = $('#jobList');
  list.replaceChildren();
  jobCards.clear();
  for (const j of [...S.jobs.values()].sort((a, b) => b.createdAt - a.createdAt)) {
    if (HIDDEN_OPS.has(j.op)) continue;
    const c = makeJobCard(j);
    list.append(c.el);
    updateJobCard(c, j, null);
  }
  updateGlobal();
}

function upsertJob(j) {
  const prev = S.jobs.get(j.id);
  if (prev && (j.rev || 0) < (prev.rev || 0)) return; // stale (e.g. POST reply after a newer event)
  S.jobs.set(j.id, j);
  if (HIDDEN_OPS.has(j.op)) {
    if (j.op === 'audiofxPreview') onFxPreviewJob(j, prev);
    return;
  }
  let c = jobCards.get(j.id);
  if (!c) {
    c = makeJobCard(j);
    $('#jobList').prepend(c.el);
  }
  updateJobCard(c, j, prev);
  if (prev && prev.status !== j.status) {
    if (j.status === 'done' && j.op !== 'silenceAnalyze') toast(`✓ ${j.title}`, 'ok');
    if (j.status === 'error') toast(`✗ ${j.title}\n${(j.error || '').split('\n').slice(-2).join('\n')}`, 'err');
  }
  if (j.op === 'silenceAnalyze') onSilenceJob(j, prev);
  updateGlobal();
}

function makeJobCard(j) {
  const c = {
    el: h('div', { class: 'job' }),
    title: h('div', { class: 'job-title' }),
    fill: h('div', { class: 'fill' }),
    pct: h('span', { class: 'pct' }),
    meta: h('span', { class: 'meta' }),
    err: h('div', { class: 'job-err' }),
    actions: h('div', { class: 'job-actions' }),
    extra: h('div', { class: 'job-extra' }),
    status: null,
    view: null,
  };
  c.bar = h('div', { class: 'bar' }, c.fill);
  c.cancel = h('button', { type: 'button', class: 'icon-btn', title: 'Cancel', onclick: () => api(`/api/jobs/${j.id}/cancel`, {}).catch((e) => toast(e.message, 'err')) }, icon('x'));
  c.el.append(h('div', { class: 'job-top' }, h('span', { class: 'job-dot' }), c.title, c.cancel), c.bar, h('div', { class: 'job-meta' }, c.pct, c.meta), c.err, c.actions, c.extra);
  jobCards.set(j.id, c);
  return c;
}

function updateJobCard(c, j, prev) {
  c.el.className = `job ${j.status}` + (c.el.classList.contains('flash') ? ' flash' : '');
  c.title.textContent = j.title;
  c.title.title = j.title;
  const active = j.status === 'running' || j.status === 'queued';
  const pct = Math.floor(j.progress * 100);
  c.fill.style.width = `${j.status === 'done' ? 100 : j.status === 'queued' ? 0 : pct}%`;
  c.bar.classList.toggle('indeterminate', j.status === 'running' && j.indeterminate);
  c.cancel.hidden = !active;
  c.pct.textContent =
    j.status === 'queued' ? 'Queued' : j.status === 'running' ? (j.indeterminate ? 'Working…' : `${pct}%`) : j.status === 'done' ? 'Done' : j.status === 'error' ? 'Failed' : 'Cancelled';
  let meta = '';
  if (j.status === 'running') {
    meta = [
      j.steps > 1 ? `step ${j.step}/${j.steps}` : '',
      j.speed ? `${j.speed.toFixed(j.speed < 10 ? 1 : 0)}×` : '',
      j.eta != null ? `${fmtSpan(j.eta)} left` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  } else if (j.finishedAt && j.startedAt) {
    const took = (j.finishedAt - j.startedAt) / 1000;
    meta = `${took < 1 ? '<1s' : fmtSpan(took)} · ${new Date(j.finishedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  c.meta.textContent = meta;
  c.err.hidden = !j.error;
  c.err.textContent = j.error || '';
  if (c.status !== j.status) {
    c.status = j.status;
    buildJobActions(c, j);
    // Show finished images right away; videos/audio on request.
    const media = previewable(j);
    if (prev && j.status === 'done' && media && IMAGE_PREVIEW.includes(extname(media))) toggleView(c, j, 'preview');
  }
}

function previewable(j) {
  const outs = j.outputs || [];
  if (!outs.length || outs.length > 2) return null;
  return outs.find((p) => [...VIDEO_PREVIEW, ...AUDIO_PREVIEW, ...IMAGE_PREVIEW].includes(extname(p))) || null;
}

function buildJobActions(c, j) {
  const btn = (label, ic, fn) => h('button', { type: 'button', class: 'btn ghost mini', onclick: fn }, icon(ic), label);
  const acts = [];
  if (j.status === 'done') {
    if (j.op === 'silenceAnalyze') acts.push(btn('View sounds', 'wave', () => showTool('silence')));
    const media = previewable(j);
    if (media) acts.push(btn('Preview', 'eye', () => toggleView(c, j, 'preview')));
    if (!WEB && j.reveal) acts.push(btn('Show in folder', 'folder', () => api('/api/reveal', { path: j.reveal }).catch((e) => toast(e.message, 'err'))));
    if (!WEB && media) acts.push(btn('Open', 'external', () => api('/api/open', { path: media }).catch((e) => toast(e.message, 'err'))));
  }
  // Web version: results live in the page until downloaded (a failed batch can still have some).
  const n = WEB ? (j.downloads || []).length : 0;
  if (n) acts.unshift(btn(n === 1 ? 'Download' : `Download all ${n} (.zip)`, 'download', () => WEB.downloadJob(j).then(offerSave, (e) => toast(e.message, 'err'))));
  acts.push(btn('Log', 'terminal', () => toggleView(c, j, 'log')));
  c.actions.replaceChildren(...acts);
}

async function toggleView(c, j, view) {
  if (c.view === view) {
    c.view = null;
    c.extra.replaceChildren();
    return;
  }
  c.view = view;
  if (view === 'preview') {
    const p = previewable(j);
    const url = fileUrl(p, j.finishedAt);
    const e = extname(p);
    let el;
    if (VIDEO_PREVIEW.includes(e)) el = h('video', { src: url, controls: true, preload: 'metadata' });
    else if (AUDIO_PREVIEW.includes(e)) el = h('audio', { src: url, controls: true, preload: 'metadata' });
    else el = h('div', { class: 'checker' }, h('img', { src: url, alt: basename(p) }));
    c.extra.replaceChildren(el);
  } else {
    c.extra.replaceChildren(h('pre', { class: 'log' }, 'Loading…'));
    try {
      const { commands, log } = await api(`/api/jobs/${j.id}/log`);
      if (c.view !== 'log') return;
      const pre = h('pre', { class: 'log' });
      for (const cmd of commands.slice(0, 20)) pre.append(h('b', {}, cmd), '\n\n');
      if (commands.length > 20) pre.append(`… ${commands.length - 20} more commands\n\n`);
      pre.append(log.length ? log.join('\n') : '(no output yet)');
      c.extra.replaceChildren(pre);
      pre.scrollTop = pre.scrollHeight;
    } catch (e) {
      c.extra.replaceChildren(h('pre', { class: 'log' }, e.message));
    }
  }
}

function flashJob(id) {
  const c = jobCards.get(id);
  if (!c) return;
  c.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  c.el.classList.add('flash');
  setTimeout(() => c.el.classList.remove('flash'), 1200);
}

function updateGlobal() {
  const all = [...S.jobs.values()].filter((j) => !HIDDEN_OPS.has(j.op));
  const running = all.filter((j) => j.status === 'running');
  const queued = all.filter((j) => j.status === 'queued');
  const active = running.length + queued.length;
  $('#jobCount').hidden = !active;
  $('#jobCount').textContent = active;
  $('#jobsEmpty').hidden = all.length > 0;
  if (running.length) {
    const p = running.reduce((a, j) => a + j.progress, 0) / running.length;
    document.title = `${Math.floor(p * 100)}% · ffmpeg helper`;
    drawFavicon(p);
  } else {
    document.title = queued.length ? 'Queued · ffmpeg helper' : 'ffmpeg helper';
    drawFavicon(null);
  }
}

const favCanvas = document.createElement('canvas');
favCanvas.width = favCanvas.height = 64;
let favKey = '';
function drawFavicon(p) {
  const key = p == null ? 'idle' : String(Math.round(p * 40));
  if (key === favKey) return;
  favKey = key;
  const g = favCanvas.getContext('2d');
  g.clearRect(0, 0, 64, 64);
  const grad = g.createLinearGradient(0, 0, 64, 64);
  grad.addColorStop(0, '#5b7cfa');
  grad.addColorStop(1, '#a17bf6');
  if (p == null) {
    g.fillStyle = grad;
    g.beginPath();
    g.roundRect(4, 4, 56, 56, 14);
    g.fill();
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(26, 19);
    g.lineTo(46, 32);
    g.lineTo(26, 45);
    g.closePath();
    g.fill();
  } else {
    g.lineWidth = 9;
    g.strokeStyle = 'rgba(128,128,128,.35)';
    g.beginPath();
    g.arc(32, 32, 25, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = grad;
    g.lineCap = 'round';
    g.beginPath();
    g.arc(32, 32, 25, -Math.PI / 2, -Math.PI / 2 + Math.max(0.05, p) * Math.PI * 2);
    g.stroke();
  }
  $('#favicon').href = favCanvas.toDataURL('image/png');
}

// ================================================================ split on silence

const player = new Audio();
let playStop = null;
let playheadEl = null;

player.addEventListener('timeupdate', () => {
  if (playStop != null && player.currentTime >= playStop) {
    player.pause();
    playStop = null;
  }
});
// Animate the playhead only while audio is playing.
function tickPlayhead() {
  const res = S.sil.silence?.result;
  const playing = !player.paused && !player.ended;
  if (playheadEl) {
    playheadEl.hidden = !(playing && res);
    if (playing && res) playheadEl.style.left = `${(player.currentTime / res.duration) * 100}%`;
  }
  if (playing) requestAnimationFrame(tickPlayhead);
}
player.addEventListener('play', () => requestAnimationFrame(tickPlayhead));
player.addEventListener('pause', tickPlayhead);

function playRange(src, start, end) {
  const url = fileUrl(src);
  if (player.dataset.src !== url) {
    player.src = url;
    player.dataset.src = url;
  }
  player.currentTime = start;
  playStop = end;
  player.play().catch(() => toast('This format can’t be previewed in the browser — export to listen.', 'err'));
}

function msVal(v, def) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

function computeSegments(tool) {
  const v = S.values[tool.id];
  const res = S.sil[tool.id]?.result;
  if (!res) return [];
  const D = res.duration;
  const pre = Math.max(0, msVal(v.preRoll, 50)) / 1000;
  const post = Math.max(0, msVal(v.postRoll, 120)) / 1000;
  const minLen = Math.max(0, msVal(v.minSound, 80)) / 1000;
  const sounds = [];
  let t = 0;
  for (const s of res.silences) {
    if (s.start > t) sounds.push({ start: t, end: s.start });
    t = Math.max(t, s.end);
  }
  if (t < D) sounds.push({ start: t, end: D });
  const out = [];
  for (const s of sounds) {
    if (s.end - s.start < minLen) continue;
    const seg = { core: s.start, start: Math.max(0, s.start - pre), end: Math.min(D, s.end + post) };
    const last = out[out.length - 1];
    if (last && seg.start <= last.end) last.end = Math.max(last.end, seg.end);
    else out.push(seg);
  }
  return out.map((s, i) => ({ ...s, key: Math.round(s.core * 1000), n: i + 1 }));
}

function selectedSegments(tool) {
  const st = S.sil[tool.id];
  if (!st?.result || st.result.file !== cleanPath(S.values[tool.id].input)) return [];
  return computeSegments(tool)
    .filter((s) => !st.excluded.has(s.key))
    .map((s) => ({ start: +s.start.toFixed(4), end: +s.end.toFixed(4) }));
}

async function analyzeSilence(tool) {
  const v = S.values[tool.id];
  const st = (S.sil[tool.id] ||= { excluded: new Set() });
  const job = await submitJob({ op: 'silenceAnalyze', params: { input: v.input, threshold: v.threshold, minSilence: v.minSilence } }, true);
  if (job) {
    st.jobId = job.id;
    refreshCustom(tool);
    // A short file can finish before this reply arrives.
    const cur = S.jobs.get(job.id);
    if (cur && cur.status === 'done') onSilenceJob(cur, null);
  }
}

function onSilenceJob(j, prev) {
  const tool = TOOL('silence');
  const st = S.sil[tool.id];
  if (!st || st.jobId !== j.id) return;
  if (j.status === 'done' && j.result && (!prev || prev.status !== 'done')) {
    st.result = j.result;
    st.excluded = new Set();
    refreshCustom(tool);
    schedulePreview();
    const n = computeSegments(tool).length;
    toast(`Found ${n} sound${n === 1 ? '' : 's'} in ${basename(j.result.file)}`, 'ok');
  } else if (prev && prev.status !== j.status) {
    refreshCustom(tool);
  } else if (st.progressEl) {
    st.progressEl.style.width = `${Math.round(j.progress * 100)}%`;
  }
}

function silencePanel(el, tool) {
  const v = S.values[tool.id];
  const st = (S.sil[tool.id] ||= { excluded: new Set() });
  const job = st.jobId ? S.jobs.get(st.jobId) : null;
  const busy = job && (job.status === 'queued' || job.status === 'running');
  const input = cleanPath(v.input);
  const res = st.result && st.result.file === input ? st.result : null;
  st.progressEl = null;
  playheadEl = null;

  const btn = h('button', { type: 'button', class: 'btn soft', disabled: busy || !input, onclick: () => analyzeSilence(tool) }, icon('wave'), busy ? 'Finding sounds…' : res ? 'Find sounds again' : 'Find sounds');
  const head = h('div', { class: 'sil-head' }, btn);
  const box = h('div', { class: 'sil' }, head);
  el.replaceChildren(box);

  if (busy) {
    const bar = h('div', {});
    st.progressEl = bar;
    bar.style.width = `${Math.round(job.progress * 100)}%`;
    box.append(h('div', { class: 'progress-line' }, bar));
  }
  if (job && job.status === 'error' && st.jobId === job.id && !res) box.append(h('div', { class: 'finfo err' }, job.error));
  if (!res) {
    if (!busy) head.append(h('span', { class: 'sil-empty' }, input ? 'Detects the sounds between silences and draws the waveform.' : 'Choose a recording first.'));
    return;
  }

  const segs = computeSegments(tool);
  const selCount = segs.filter((s) => !st.excluded.has(s.key)).length;
  const stale = String(res.threshold) !== String(parseFloat(v.threshold)) || String(res.minSilence) !== String(parseFloat(v.minSilence));
  head.append(
    h('span', { class: 'muted grow' }, `${segs.length} sound${segs.length === 1 ? '' : 's'} · ${selCount} selected`, stale ? h('span', { class: 'chip warn', style: { marginLeft: '8px' } }, 'settings changed — find again') : null),
    h('button', { type: 'button', class: 'btn ghost mini', onclick: () => { st.excluded.clear(); refreshCustom(tool); schedulePreview(); } }, 'All'),
    h('button', { type: 'button', class: 'btn ghost mini', onclick: () => { segs.forEach((s) => st.excluded.add(s.key)); refreshCustom(tool); schedulePreview(); } }, 'None')
  );

  const D = res.duration;
  const toggle = (s) => {
    if (st.excluded.has(s.key)) st.excluded.delete(s.key);
    else st.excluded.add(s.key);
    refreshCustom(tool);
    schedulePreview();
  };
  const wave = h('div', { class: 'wave', title: 'Click a sound to play it · click elsewhere to play from there' });
  if (!st.img || st.imgSrc !== res.waveform) {
    st.img = h('img', { src: fileUrl(res.waveform), alt: '' });
    st.imgSrc = res.waveform;
  }
  wave.append(st.img);
  // Threshold lines; the waveform is drawn on a square-root amplitude scale.
  const amp = Math.sqrt(Math.pow(10, res.threshold / 20));
  for (const sign of [-1, 1]) wave.append(h('div', { class: 'thr', style: { top: `${50 - sign * amp * 50}%` } }));
  for (const s of segs) {
    const seg = h(
      'div',
      {
        class: 'seg' + (st.excluded.has(s.key) ? ' off' : ''),
        style: { left: `${(s.start / D) * 100}%`, width: `${Math.max(0.15, ((s.end - s.start) / D) * 100)}%` },
        title: `#${s.n}  ${fmtClock(s.start)} – ${fmtClock(s.end)}`,
        onclick: (e) => {
          e.stopPropagation();
          playRange(res.file, s.start, s.end);
        },
      },
      h('span', {}, s.n)
    );
    wave.append(seg);
  }
  playheadEl = h('div', { class: 'playhead', hidden: true });
  wave.append(playheadEl);
  wave.addEventListener('click', (e) => {
    const r = wave.getBoundingClientRect();
    playRange(res.file, ((e.clientX - r.left) / r.width) * D, null);
  });
  box.append(wave, h('div', { class: 'wave-axis' }, h('span', {}, '0:00'), h('span', {}, fmtClock(D / 2)), h('span', {}, fmtClock(D))));

  if (segs.length) {
    const rows = segs.map((s) => {
      const off = st.excluded.has(s.key);
      return h(
        'tr',
        { class: off ? 'off' : '' },
        h('td', {}, h('input', { type: 'checkbox', checked: !off, onchange: () => toggle(s), 'aria-label': `Export sound ${s.n}` })),
        h('td', {}, s.n),
        h('td', {}, fmtClock(s.start)),
        h('td', {}, fmtClock(s.end)),
        h('td', {}, `${(s.end - s.start).toFixed(2)}s`),
        h('td', {}, h('button', { type: 'button', class: 'icon-btn', title: 'Play', onclick: () => playRange(res.file, s.start, s.end) }, icon('triangle')))
      );
    });
    box.append(
      h(
        'div',
        { class: 'segwrap' },
        h('table', { class: 'segtable' }, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, '#'), h('th', {}, 'Start'), h('th', {}, 'End'), h('th', {}, 'Length'), h('th', {}, ''))), h('tbody', {}, rows))
      )
    );
  } else {
    box.append(h('div', { class: 'sil-empty' }, 'No sounds found — try a lower (more negative) threshold or a shorter minimum silence.'));
  }
}

// ================================================================ audio effects chain

function fxVideoOut(v, t) {
  return !!t.probe()?.video && v.target === 'video';
}

function loadJson(key, def) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v == null ? def : v;
  } catch {
    return def;
  }
}
function storeJson(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {}
}

const FXUI = {
  undo: [], // earlier chains
  sel: '', // preset last loaded
  drag: null,
  jobId: null,
  result: null,
  resultAt: 0,
  err: null,
  stale: false,
  listen: 'fx', // 'fx' | 'orig'
  timer: null,
  barEl: null,
  progressEl: null,
  audio: null,
  prefs: { len: '10', at: '', auto: true, ...loadJson('ffh:fxui', {}) },
};
const fxUserPresets = () => loadJson('ffh:fxPresets', []);
const fxChain = (tool) => S.values[tool.id].chain || [];

// ---------------------------------------------------------------- value formatting / slider mapping

function fxDecimals(pd, v) {
  if (pd.log) return Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
  const s = String(pd.step);
  return s.includes('.') ? s.split('.')[1].length : 0;
}
function fxRound(pd, v) {
  const d = fxDecimals(pd, v);
  let r = +v.toFixed(d);
  if (!pd.log && pd.step) r = +(Math.round(r / pd.step) * pd.step).toFixed(d);
  return Math.min(pd.max, Math.max(pd.min, r));
}
const fxNum = (pd, v) => String(+(+v).toFixed(fxDecimals(pd, v)));
function fxPos(pd, v) {
  if (pd.log && pd.min > 0) return Math.round((Math.log(v / pd.min) / Math.log(pd.max / pd.min)) * 1000);
  return Math.round(((v - pd.min) / (pd.max - pd.min)) * 1000);
}
function fxFromPos(pd, pos) {
  const t = pos / 1000;
  return fxRound(pd, pd.log && pd.min > 0 ? pd.min * Math.pow(pd.max / pd.min, t) : pd.min + (pd.max - pd.min) * t);
}
function fxLabel(pd, v) {
  if (pd.type === 'select') return (pd.opts.find(([k]) => k === String(v)) || [, v])[1].replace(/\s*\(.*\)$/, '');
  if (pd.type === 'check') return v ? pd.label : null;
  if (pd.unit === 'Hz' && v >= 1000) return `${+(v / 1000).toFixed(v >= 10000 ? 0 : 1)} kHz`;
  const sign = pd.unit === 'dB' && v > 0 ? '+' : '';
  return `${sign}${fxNum(pd, v)}${pd.unit ? (pd.unit === '%' || pd.unit === '×' || pd.unit === ':1' ? '' : ' ') + pd.unit : ''}`;
}
function fxSummary(def, p) {
  return def.params
    .filter((pd) => !pd.when || pd.when(p))
    .map((pd) => fxLabel(pd, p[pd.key]))
    .filter(Boolean)
    .slice(0, 4)
    .join(' · ');
}

// ---------------------------------------------------------------- chain edits

function fxSetChain(tool, next, { undo = false, rerender = true } = {}) {
  if (undo) {
    FXUI.undo.push(fxChain(tool));
    if (FXUI.undo.length > 40) FXUI.undo.shift();
  }
  setValue(tool, 'chain', next);
  if (rerender) refreshCustom(tool);
}
function fxPatch(tool, id, patch, opts) {
  fxSetChain(tool, fxChain(tool).map((it) => (it.id === id ? { ...it, ...patch } : it)), opts);
}
function fxSetParam(tool, id, key, val, rerender = false) {
  fxSetChain(tool, fxChain(tool).map((it) => (it.id === id ? { ...it, p: { ...it.p, [key]: val } } : it)), { rerender });
}
/** Moves an effect so it ends up at position `to` (0-based). */
function fxMove(tool, id, to) {
  const arr = fxChain(tool).slice();
  const from = arr.findIndex((it) => it.id === id);
  if (from < 0 || from === to) return;
  const [it] = arr.splice(from, 1);
  arr.splice(Math.max(0, Math.min(arr.length, to)), 0, it);
  fxSetChain(tool, arr, { undo: true });
}

/** Pointer-driven reordering: the card follows the pointer and a line shows where it will land. */
function fxDrag(tool, e, grip, card, id, index) {
  if (e.button !== 0) return;
  e.preventDefault();
  const cards = [...card.parentElement.querySelectorAll('.fx-card')];
  const mids = cards.map((c) => {
    const r = c.getBoundingClientRect();
    return r.top + r.height / 2;
  });
  const y0 = e.clientY;
  const scroller = $('.main');
  const s0 = scroller.scrollTop;
  let target = index;
  grip.setPointerCapture(e.pointerId);
  card.classList.add('dragging');
  const clear = () => cards.forEach((c) => c.classList.remove('drop-before', 'drop-after'));
  const move = (ev) => {
    const ds = scroller.scrollTop - s0;
    card.style.transform = `translateY(${ev.clientY - y0 + ds}px)`;
    // Final position = how many of the other cards sit above the pointer.
    const y = ev.clientY + ds;
    target = cards.reduce((n, c, j) => n + (j !== index && mids[j] < y ? 1 : 0), 0);
    clear();
    if (target < index) cards[target].classList.add('drop-before');
    else if (target > index) cards[target].classList.add('drop-after');
  };
  const up = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    grip.removeEventListener('pointercancel', up);
    card.classList.remove('dragging');
    card.style.transform = '';
    clear();
    if (target !== index) fxMove(tool, id, target);
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', up);
}
function fxLoadPreset(tool, val) {
  if (!val) return;
  let preset;
  if (val.startsWith('b:')) preset = FX.PRESETS.find((p) => p.id === val.slice(2));
  else preset = fxUserPresets().find((p) => 'u:' + p.name === val);
  if (!preset) return;
  FXUI.sel = val;
  fxSetChain(tool, FX.fromPreset(preset), { undo: true });
}
function fxSavePreset(tool) {
  const chain = fxChain(tool);
  if (!chain.length) return toast('Add some effects first.');
  const cur = FXUI.sel.startsWith('u:') ? FXUI.sel.slice(2) : '';
  const name = (prompt('Save this effect chain as a preset named:', cur) || '').trim();
  if (!name) return;
  const list = fxUserPresets();
  const i = list.findIndex((p) => p.name === name);
  if (i >= 0 && name !== cur && !confirm(`Replace your preset "${name}"?`)) return;
  const entry = { name, chain: chain.map((it) => [it.type, it.p, it.on]) };
  if (i >= 0) list[i] = entry;
  else list.push(entry);
  storeJson('ffh:fxPresets', list);
  FXUI.sel = 'u:' + name;
  refreshCustom(tool);
  toast(`Saved preset "${name}"`, 'ok');
}
function fxDeletePreset(tool) {
  const name = FXUI.sel.slice(2);
  if (!confirm(`Delete your preset "${name}"?`)) return;
  storeJson('ffh:fxPresets', fxUserPresets().filter((p) => p.name !== name));
  FXUI.sel = '';
  refreshCustom(tool);
}

function fxOnChange(key, tool) {
  if (key === 'input') {
    FXUI.result = null;
    FXUI.err = null;
    if (FXUI.audio) {
      FXUI.audio.pause();
      FXUI.audio.removeAttribute('src');
    }
    fxRenderBar(tool);
  }
  if (key === 'chain') {
    // Expanding/collapsing a card isn't a change to the sound.
    const sig = JSON.stringify(fxChain(tool).map((it) => [it.type, it.on, it.p]));
    if (sig === FXUI.sig) return;
    FXUI.sig = sig;
  }
  if (['chain', 'limiter', 'input', 'start'].includes(key) && FXUI.result) {
    if (!FXUI.stale) {
      FXUI.stale = true;
      fxRenderBar(tool);
    }
    if (FXUI.prefs.auto) {
      clearTimeout(FXUI.timer);
      FXUI.timer = setTimeout(() => fxPreview(tool, false), 650);
    }
  }
}

// ---------------------------------------------------------------- panel

function fxPanel(el, tool) {
  const chain = fxChain(tool);
  const user = fxUserPresets();
  const groups = [];
  for (const p of FX.PRESETS) {
    let g = groups.find((x) => x.name === p.group);
    if (!g) groups.push((g = { name: p.group, items: [] }));
    g.items.push(p);
  }
  const sel = h(
    'select',
    { class: 'fx-preset', 'aria-label': 'Effect chain preset', onchange: () => fxLoadPreset(tool, sel.value) },
    h('option', { value: '' }, 'Load a preset…'),
    user.length ? h('optgroup', { label: 'My presets' }, user.map((p) => h('option', { value: 'u:' + p.name }, p.name))) : null,
    groups.map((g) => h('optgroup', { label: g.name }, g.items.map((p) => h('option', { value: 'b:' + p.id }, p.name))))
  );
  sel.value = FXUI.sel;
  if (sel.value !== FXUI.sel) sel.value = '';
  const builtin = FXUI.sel.startsWith('b:') ? FX.PRESETS.find((p) => 'b:' + p.id === FXUI.sel) : null;
  const anyOpen = chain.some((it) => it.open);

  const toolbar = h(
    'div',
    { class: 'fx-toolbar' },
    sel,
    h('button', { type: 'button', class: 'btn mini ghost', title: 'Save the current chain as your own preset', onclick: () => fxSavePreset(tool) }, icon('save'), 'Save'),
    FXUI.sel.startsWith('u:') && h('button', { type: 'button', class: 'btn mini ghost', title: 'Delete this preset', onclick: () => fxDeletePreset(tool) }, icon('trash'), 'Delete'),
    h('span', { class: 'grow' }),
    h('button', { type: 'button', class: 'btn mini ghost', disabled: !FXUI.undo.length, title: 'Undo the last change to the chain', onclick: () => fxSetChain(tool, FXUI.undo.pop()) }, icon('undo'), 'Undo'),
    chain.length > 0 && h('button', { type: 'button', class: 'btn mini ghost', onclick: () => fxSetChain(tool, chain.map((it) => ({ ...it, open: !anyOpen }))) }, anyOpen ? 'Collapse all' : 'Expand all'),
    chain.length > 0 && h('button', { type: 'button', class: 'btn mini ghost', onclick: () => fxSetChain(tool, [], { undo: true }) }, 'Clear')
  );

  const list = h('div', { class: 'fx-list' });
  chain.forEach((it, i) => {
    const card = fxCard(tool, it, i, chain.length);
    if (card) list.append(card);
  });
  if (!chain.length) list.append(h('div', { class: 'fx-empty' }, 'No effects yet — load a preset above, or add effects below. They run top to bottom.'));

  const add = h(
    'select',
    {
      class: 'fx-add',
      'aria-label': 'Add an effect',
      onchange: () => {
        if (!add.value) return;
        fxSetChain(tool, [...fxChain(tool), FX.item(add.value)], { undo: true });
      },
    },
    h('option', { value: '' }, '+ Add effect…'),
    FX.CATEGORIES.map(([cat, label]) =>
      h('optgroup', { label }, Object.entries(FX.EFFECTS).filter(([, d]) => d.cat === cat).map(([k, d]) => h('option', { value: k }, d.name)))
    )
  );

  FXUI.barEl = h('div', { class: 'fx-bar' });
  el.replaceChildren(
    h(
      'div',
      { class: 'fx' },
      toolbar,
      builtin && h('div', { class: 'fx-desc' }, builtin.desc),
      list,
      h('div', { class: 'fx-addrow' }, add, h('span', { class: 'hint' }, 'Drag ⠿ to reorder · double-click a slider to reset it')),
      FXUI.barEl
    )
  );
  fxRenderBar(tool);
}

function fxCard(tool, it, i, n) {
  const def = FX.EFFECTS[it.type];
  if (!def) return null;
  const card = h('div', { class: 'fx-card' + (it.on ? '' : ' off') + (it.open ? ' open' : '') });
  const grip = h('span', { class: 'fx-grip', title: 'Drag to reorder' }, icon('grip'));
  grip.addEventListener('pointerdown', (e) => fxDrag(tool, e, grip, card, it.id, i));

  const sw = h(
    'label',
    { class: 'switch', title: it.on ? 'On — click to bypass' : 'Bypassed — click to turn on' },
    h('input', { type: 'checkbox', checked: it.on, onchange: (e) => fxPatch(tool, it.id, { on: e.target.checked }) }),
    h('span', { class: 'knob' })
  );
  const title = h(
    'button',
    { type: 'button', class: 'fx-title', 'aria-expanded': it.open ? 'true' : 'false', onclick: () => fxPatch(tool, it.id, { open: !it.open }) },
    h('span', { class: 'fx-n' }, i + 1),
    h('b', {}, def.name),
    h('span', { class: 'fx-sum' }, it.open ? '' : fxSummary(def, it.p)),
    icon(it.open ? 'up' : 'down')
  );
  let presetSel = null;
  if (def.presets) {
    presetSel = h(
      'select',
      {
        class: 'fx-mini',
        title: `${def.name} presets`,
        onchange: () => {
          const pr = def.presets.find(([name]) => name === presetSel.value);
          if (pr) fxSetChain(tool, fxChain(tool).map((x) => (x.id === it.id ? { ...x, open: true, p: { ...FX.defaults(it.type), ...pr[1] } } : x)), { undo: true });
        },
      },
      h('option', { value: '' }, 'Presets'),
      def.presets.map(([name]) => h('option', { value: name }, name))
    );
  }
  const head = h(
    'div',
    { class: 'fx-head' },
    grip,
    sw,
    title,
    presetSel,
    h('button', { type: 'button', class: 'icon-btn', title: 'Move up', disabled: i === 0, onclick: () => fxMove(tool, it.id, i - 1) }, icon('up')),
    h('button', { type: 'button', class: 'icon-btn', title: 'Move down', disabled: i === n - 1, onclick: () => fxMove(tool, it.id, i + 1) }, icon('down')),
    h('button', { type: 'button', class: 'icon-btn', title: 'Remove', onclick: () => fxSetChain(tool, fxChain(tool).filter((x) => x.id !== it.id), { undo: true }) }, icon('x'))
  );
  card.append(head);
  if (it.open) {
    const body = h('div', { class: 'fx-body' }, h('div', { class: 'fx-help' }, def.desc));
    for (const pd of def.params) {
      const row = fxParam(tool, it, pd);
      if (row) body.append(row);
    }
    if (!def.params.length) body.append(h('div', { class: 'hint' }, 'No settings.'));
    card.append(body);
  }
  return card;
}

function fxParam(tool, it, pd) {
  if (pd.when && !pd.when(it.p)) return null;
  const val = it.p[pd.key] ?? pd.def;
  const id = `fx-${it.id}-${pd.key}`;
  if (pd.type === 'check') {
    return h(
      'div',
      { class: 'fx-param' },
      h('span', {}),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!val, onchange: (e) => fxSetParam(tool, it.id, pd.key, e.target.checked, true) }), h('span', {}, pd.label))
    );
  }
  if (pd.type === 'select') {
    const s = h('select', { id, onchange: () => fxSetParam(tool, it.id, pd.key, s.value, true) }, pd.opts.map(([k, l]) => h('option', { value: k }, l)));
    s.value = String(val);
    return h('div', { class: 'fx-param' }, h('label', { for: id }, pd.label), h('div', { class: 'fx-wide' }, s));
  }
  const slider = h('input', { id, type: 'range', min: 0, max: 1000, step: 1, value: fxPos(pd, val), title: pd.hint || '' });
  const num = h('input', { type: 'text', class: 'fx-num', inputmode: 'decimal', spellcheck: 'false', value: fxNum(pd, val), 'aria-label': `${pd.label} value` });
  const set = (v) => {
    slider.value = fxPos(pd, v);
    num.value = fxNum(pd, v);
    fxSetParam(tool, it.id, pd.key, v);
  };
  slider.addEventListener('input', () => set(fxFromPos(pd, +slider.value)));
  slider.addEventListener('dblclick', () => set(pd.def));
  num.addEventListener('change', () => {
    const n = parseFloat(num.value);
    set(Number.isFinite(n) ? Math.min(pd.max, Math.max(pd.min, n)) : val);
  });
  num.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const cur = parseFloat(num.value) || 0;
    const step = pd.log ? Math.max(pd.step, Math.abs(cur) * 0.05) : pd.step * (e.shiftKey ? 10 : 1);
    set(fxRound(pd, Math.min(pd.max, Math.max(pd.min, cur + (e.key === 'ArrowUp' ? step : -step)))));
  });
  return h(
    'div',
    { class: 'fx-param' },
    h('label', { for: id, title: pd.hint || '' }, pd.label),
    slider,
    h('div', { class: 'fx-val' }, num, h('span', { class: 'fx-unit' }, pd.unit))
  );
}

// ---------------------------------------------------------------- preview (render a snippet, A/B it)

function fxAudio() {
  if (!FXUI.audio) {
    FXUI.audio = h('audio', { controls: true, preload: 'auto' });
    FXUI.audio.addEventListener('error', () => {
      if (FXUI.audio.getAttribute('src')) toast('The preview could not be played.', 'err');
    });
  }
  return FXUI.audio;
}

function fxListen(which, keepPos = true, play = null) {
  const a = fxAudio();
  const r = FXUI.result;
  FXUI.listen = which;
  if (!r) return;
  const t = a.currentTime;
  const playing = play ?? (!a.paused && !a.ended);
  a.src = fileUrl(which === 'orig' ? r.orig : r.fx, FXUI.resultAt);
  a.addEventListener(
    'loadedmetadata',
    () => {
      if (keepPos && t && t < a.duration - 0.05) a.currentTime = t;
      if (playing) a.play().catch(() => {});
    },
    { once: true }
  );
  for (const b of FXUI.barEl?.querySelectorAll('.seg-btn') || []) b.classList.toggle('on', b.dataset.k === which);
}

async function fxPreview(tool, manual) {
  clearTimeout(FXUI.timer);
  const v = S.values[tool.id];
  if (!cleanPath(v.input)) return;
  const old = FXUI.jobId && S.jobs.get(FXUI.jobId);
  if (old && (old.status === 'queued' || old.status === 'running')) api(`/api/jobs/${old.id}/cancel`, {}).catch(() => {});
  FXUI.manualPlay = manual;
  FXUI.err = null;
  FXUI.stale = false;
  const params = { input: v.input, start: v.start, chain: v.chain, limiter: v.limiter, previewAt: FXUI.prefs.at, previewLen: FXUI.prefs.len };
  try {
    const r = await api('/api/jobs', { op: 'audiofxPreview', params, overwrite: true });
    FXUI.jobId = r.job.id;
    upsertJob(r.job);
    const cur = S.jobs.get(r.job.id);
    if (cur && cur.status === 'done') onFxPreviewJob(cur, null);
  } catch (e) {
    FXUI.err = e.message;
  }
  fxRenderBar(tool);
}

function onFxPreviewJob(j, prev) {
  if (j.id !== FXUI.jobId) return;
  const tool = TOOL('audiofx');
  if (j.status === 'done' && j.result && (!prev || prev.status !== 'done')) {
    const fresh = !FXUI.result || FXUI.result.at !== j.result.at || FXUI.result.len !== j.result.len;
    FXUI.result = j.result;
    FXUI.resultAt = j.finishedAt;
    // A live update keeps playing from the same spot if it was playing; a manual preview starts playing.
    fxListen(FXUI.listen, !fresh && !FXUI.manualPlay, FXUI.manualPlay ? true : null);
    fxRenderBar(tool);
  } else if (j.status === 'error' && (!prev || prev.status !== 'error')) {
    FXUI.err = j.error;
    fxRenderBar(tool);
  } else if (!prev || prev.status !== j.status) {
    fxRenderBar(tool);
  } else if (FXUI.progressEl) {
    FXUI.progressEl.style.width = `${Math.round(j.progress * 100)}%`;
  }
}

function fxRenderBar(tool) {
  const bar = FXUI.barEl;
  if (!bar || S.toolId !== tool.id || !bar.isConnected) return;
  const v = S.values[tool.id];
  const input = cleanPath(v.input);
  const job = FXUI.jobId ? S.jobs.get(FXUI.jobId) : null;
  const busy = job && (job.status === 'queued' || job.status === 'running');
  const prefs = FXUI.prefs;
  const savePrefs = () => storeJson('ffh:fxui', prefs);
  FXUI.progressEl = null;

  const len = h(
    'select',
    {
      'aria-label': 'Preview length',
      onchange: () => {
        prefs.len = len.value;
        savePrefs();
      },
    },
    [['5', '5 seconds'], ['10', '10 seconds'], ['20', '20 seconds'], ['30', '30 seconds'], ['60', '1 minute'], ['0', 'Whole file']].map(([k, l]) => h('option', { value: k }, l))
  );
  len.value = prefs.len;
  const at = h('input', {
    type: 'text',
    class: 'fx-at',
    spellcheck: 'false',
    value: prefs.at,
    placeholder: cleanPath(v.start) || '0:00',
    'aria-label': 'Preview from',
    oninput: () => {
      prefs.at = at.value;
      savePrefs();
    },
    onkeydown: (e) => e.key === 'Enter' && (e.preventDefault(), fxPreview(tool, true)),
  });
  const auto = h('label', { class: 'check', title: 'After a preview, re-render it automatically whenever you change a setting' }, h('input', { type: 'checkbox', checked: prefs.auto, onchange: (e) => ((prefs.auto = e.target.checked), savePrefs()) }), h('span', {}, 'Live update'));

  const controls = h(
    'div',
    { class: 'fx-bar-row' },
    h('button', { type: 'button', class: 'btn soft', disabled: !input, onclick: () => fxPreview(tool, true) }, busy ? h('span', { class: 'spin' }) : icon('triangle'), busy ? 'Rendering…' : FXUI.result ? 'Preview again' : 'Preview'),
    h('span', { class: 'muted' }, 'listen to'),
    len,
    h('span', { class: 'muted' }, 'from'),
    at,
    auto
  );
  const parts = [controls];
  if (!input) parts.push(h('div', { class: 'sil-empty' }, 'Choose a file to preview the effects on it.'));
  if (busy) {
    const p = h('div', {});
    p.style.width = `${Math.round(job.progress * 100)}%`;
    FXUI.progressEl = p;
    parts.push(h('div', { class: 'progress-line' }, p));
  }
  if (FXUI.err) parts.push(h('div', { class: 'finfo err' }, FXUI.err));
  if (FXUI.result) {
    const seg = (k, label) =>
      h('button', { type: 'button', class: 'seg-btn' + (FXUI.listen === k ? ' on' : ''), 'data-k': k, onclick: () => fxListen(k) }, label);
    parts.push(
      h(
        'div',
        { class: 'fx-bar-row' },
        h('div', { class: 'seg-ctl', role: 'group', 'aria-label': 'Listen to' }, seg('fx', 'With effects'), seg('orig', 'Original')),
        fxAudio(),
        FXUI.stale && !busy ? h('span', { class: 'chip warn' }, 'settings changed') : null
      )
    );
  }
  bar.replaceChildren(...parts);
}

// ================================================================ media info

function infoPanel(el, tool) {
  const i = S.info[tool.id]?.input;
  el.replaceChildren();
  if (!i || !i.data) return;
  const d = i.data;
  const kv = (pairs) => h('dl', { class: 'kv' }, pairs.filter(([, val]) => val != null && val !== '').flatMap(([k, val]) => [h('dt', {}, k), h('dd', {}, val)]));
  const general = h(
    'div',
    { class: 'info-card' },
    h('h3', {}, 'File'),
    kv([
      ['Name', WEB ? WEB.displayName(d.path) : basename(d.path)],
      ['Folder', WEB ? null : dirname(d.path)],
      ['Container', d.formatLong ? `${d.formatLong} (${d.format})` : d.format],
      ['Duration', d.duration != null ? `${fmtClock(d.duration)}  (${d.duration.toFixed(3)} s)` : null],
      ['Size', `${fmtBytes(d.size)}  (${d.size.toLocaleString()} bytes)`],
      ['Bitrate', fmtRate(d.bitrate)],
    ]),
    !WEB &&
      h(
        'div',
        { style: { marginTop: '12px' } },
        h('button', { type: 'button', class: 'btn mini', onclick: () => api('/api/reveal', { path: d.path }).catch((e) => toast(e.message, 'err')) }, icon('folder'), 'Show in folder')
      )
  );
  const streams = h(
    'div',
    { class: 'info-card', style: { marginTop: '14px' } },
    h('h3', {}, `Streams (${d.streams.length})`),
    d.streams.map((s) => {
      const parts =
        s.type === 'video'
          ? [s.codec + (s.profile ? ` (${s.profile})` : ''), s.width && `${s.width}×${s.height}`, s.fps && `${+s.fps.toFixed(3)} fps`, s.pixFmt, fmtRate(s.bitrate), s.coverArt && 'cover art']
          : s.type === 'audio'
            ? [s.codec + (s.profile ? ` (${s.profile})` : ''), s.sampleRate && `${s.sampleRate} Hz`, s.layout || chLabel(s.channels), fmtRate(s.bitrate), s.language]
            : [s.codec, s.language];
      const cls = s.type === 'video' || s.type === 'audio' ? s.type : 'other';
      return h('div', { class: 'stream' }, h('span', { class: `tag ${cls}` }, `#${s.index} ${s.type}`), h('span', {}, parts.filter(Boolean).join(' · ')));
    })
  );
  el.append(general, streams);
}

// ================================================================ web version (ffmpeg.wasm)

/** Adapts the tool list to the browser: results are downloaded, so output-folder fields go away. */
function webifyTools() {
  const strip = (fields, tool) =>
    fields.filter((f) => {
      if (f.type === 'row') return (f.fields = strip(f.fields, tool)).length > 0;
      if (f.type === 'folder' && !f.input) return void (tool._outDirs ||= []).push(f.key);
      return true;
    });
  for (const t of TOOLS) t.fields = strip(t.fields, t);
  TOOLS.push({
    id: 'local',
    group: 'Desktop version',
    name: 'Run it on your computer',
    icon: 'laptop',
    desc: 'This page runs ffmpeg inside your browser. The desktop version is the same app, but it uses the real ffmpeg installed on your computer.',
    noRun: true,
    fields: [{ type: 'custom', key: '_local', render: localPanel }],
  });
}

/** Select options that need an encoder this ffmpeg build doesn't have (the browser build has no AV1, for one). */
const NEEDS = {
  'vcodec:h264': 'libx264', 'vcodec:h265': 'libx265', 'vcodec:vp9': 'libvpx-vp9', 'vcodec:av1': 'libsvtav1',
  'format:mp3': 'libmp3lame', 'format:opus': 'libopus', 'format:ogg': 'libvorbis', 'format:webp': 'libwebp', 'animFormat:webp': 'libwebp_anim',
};
function dropMissingEncoders(have) {
  const set = new Set(have);
  for (const t of TOOLS) {
    walkFields(t.fields, (f) => {
      if (f.type !== 'select') return;
      const opts = f.opts.filter(([val]) => !NEEDS[`${f.key}:${val}`] || set.has(NEEDS[`${f.key}:${val}`]));
      if (!opts.length || opts.length === f.opts.length) return;
      f.opts = opts;
      if (!opts.some(([val]) => val === f.def)) f.def = opts[0][0];
    });
  }
}

function showLoad(s) {
  const el = $('#webLoad');
  const mb = (n) => (n / 1048576).toFixed(0);
  const text = {
    idle: 'ffmpeg.wasm',
    downloading: `loading ffmpeg… ${s.total ? Math.floor((s.loaded / s.total) * 100) : 0}%`,
    compiling: 'preparing ffmpeg…',
    starting: 'starting ffmpeg…',
    error: 'ffmpeg failed to load',
  }[s.phase];
  if (text) $('#ffver').textContent = text;
  if (!el) return;
  el.hidden = s.phase === 'ready' || s.phase === 'idle';
  el.classList.toggle('err', s.phase === 'error');
  if (s.phase === 'error') return void el.replaceChildren(h('b', {}, 'ffmpeg couldn’t be loaded. '), s.error || '', ' ', h('button', { type: 'button', class: 'linkish', onclick: () => location.reload() }, 'Reload'));
  const pct = s.phase === 'downloading' && s.total ? (s.loaded / s.total) * 100 : 100;
  el.replaceChildren(
    h('div', { class: 'web-load-text' }, s.phase === 'downloading' ? `Loading ffmpeg into your browser — ${mb(s.loaded)} of ${mb(s.total)} MB (your browser keeps it for next time)` : 'Getting ffmpeg ready…'),
    h('div', { class: 'progress-line' }, h('div', { style: { width: `${pct}%` } }))
  );
}

function localPanel(el) {
  const btn = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
    btn.disabled = true;
    btn.lastChild.textContent = 'Packing…';
    try {
      offerSave(await WEB.downloadLocal());
    } catch (e) {
      toast(e.message, 'err');
    }
    btn.disabled = false;
    btn.lastChild.textContent = 'Download ffmpeg-helper.zip';
  } }, icon('download'), h('span', {}, 'Download ffmpeg-helper.zip'));
  const li = (title, text) => h('li', {}, h('b', {}, title), ' ', text);
  const code = (s) => h('code', {}, s);
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
  el.replaceChildren(
    h('div', { class: 'local' },
      h('div', { class: 'local-get' }, btn, h('span', { class: 'muted' }, 'About 300 KB. You also need Node.js and ffmpeg — see below.')),
      h('h3', {}, 'Why run it on your computer?'),
      h('ul', { class: 'local-why' },
        li('It’s much faster.', 'Here, ffmpeg runs as WebAssembly on a single processor core. The desktop version runs the real ffmpeg, which uses every core and its hand-tuned code. In one test, re-encoding a 5-second HD clip took 18 seconds on this page and half a second with the desktop version.'),
        li('Big files work.', 'A browser tab gives ffmpeg at most 2 GB of memory, and your files and results have to fit beside it, so long or high-resolution videos can fail here. The desktop version handles files of any size.'),
        li('It works on your folders directly.', 'Results are saved next to the originals, or in a folder you choose with its subfolders kept, instead of downloading a zip. That matters when you convert hundreds of images at a time.'),
        li('Every format your ffmpeg has.', 'The browser build can only make H.264 and ProRes video: no H.265, VP9 (WebM) or AV1. A full ffmpeg install has them all.'),
        li('It works offline,', 'and doesn’t have to load 32 MB of ffmpeg first.')
      ),
      h('p', { class: 'muted' }, 'Either way your files stay private: this page doesn’t upload them anywhere, and the desktop version only talks to your own computer.'),
      h('h3', {}, 'Setting it up'),
      h('ol', { class: 'local-steps' },
        h('li', {}, 'Install ', link('https://nodejs.org/', 'Node.js'), ' (version 18 or newer).'),
        h('li', {}, 'Install ', link('https://ffmpeg.org/download.html', 'ffmpeg'), ': on Windows run ', code('winget install ffmpeg'), ' in a terminal; on a Mac, ', code('brew install ffmpeg'), '; on Linux, use your package manager.'),
        h('li', {}, 'Unzip ', code('ffmpeg-helper.zip'), ' anywhere. On Windows double-click ', code('start.bat'), '; on a Mac or Linux run ', code('npm start'), ' in that folder.'),
        h('li', {}, 'It opens in your browser at ', code('http://127.0.0.1:8642'), ', with the same tools as this page. Close the window (or press Ctrl+C) to stop it.')
      )
    )
  );
}

// ================================================================ boot

async function boot() {
  if (WEB) {
    document.body.classList.add('web');
    webifyTools();
    $('.main-inner').prepend(h('div', { id: 'webLoad', class: 'web-load', hidden: true }));
    $('.brand').after(h('button', { type: 'button', class: 'web-get', onclick: () => showTool('local') }, icon('laptop'), h('span', {}, 'Get the desktop version')));
    WEB.onStatus(showLoad);
  }
  renderNav();
  let start = 'seq2video';
  try {
    start = localStorage.getItem('ffh:tool') || start;
  } catch {}
  showTool(start);
  connectEvents();

  $('#runBtn').addEventListener('click', () => runTool(TOOL(S.toolId)));
  $('#copyCmd').addEventListener('click', async () => {
    if (!lastCommands.length) return toast('Nothing to copy yet — fill in the form first.');
    try {
      await navigator.clipboard.writeText(lastCommands.join('\n'));
      toast('Command copied');
    } catch {
      toast('Could not access the clipboard', 'err');
    }
  });
  $('#clearJobs').addEventListener('click', () => api('/api/jobs/clear', {}).catch((e) => toast(e.message, 'err')));
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !TOOL(S.toolId).noRun) {
      e.preventDefault();
      runTool(TOOL(S.toolId));
    }
  });

  try {
    S.cfg = await api('/api/config');
    $('#ffver').textContent = S.cfg.version ? S.cfg.version.replace(/^ffmpeg version /, 'ffmpeg ').replace(/ Copyright.*$/, '') + (WEB ? ' · in your browser' : '') : 'ffmpeg not found';
    if (WEB && S.cfg.encoders) {
      dropMissingEncoders(S.cfg.encoders);
      showTool(S.toolId);
    }
    if (!S.cfg.version && !WEB) {
      const b = $('#banner');
      b.hidden = false;
      b.innerHTML = '<b>ffmpeg wasn’t found.</b> Install it and make sure <code>ffmpeg</code> and <code>ffprobe</code> are on your PATH, or start the server with <code>FFMPEG_PATH</code> / <code>FFPROBE_PATH</code> set.';
    }
  } catch (e) {
    if (!WEB) $('#ffver').textContent = 'server unreachable';
  }
}

boot();
