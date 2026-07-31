// node --test renderGraph.test.js
//
// The graph builder is where a mistake is most expensive: it is slow to run,
// the failure mode is a wall of ffmpeg stderr, and a wrong xfade offset makes
// a render that differs from the preview without ever erroring. So the offsets,
// the gap filling and the audio placement are checked here directly.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRenderGraph, withGaps, applyDips } = require('./renderGraph.js');

const settings = { width: 1920, height: 1080, fps: 24 };
const resolvePath = (p) => `/root/${p}`;
const outputPath = '/out/master.mp4';

function clip(overrides = {}) {
  const start = overrides.start ?? 0;
  const length = overrides.length ?? 5;
  return {
    path: 'a.mp4', kind: 'video', in: 0, out: length,
    start, end: start + length, length,
    transition: null, audio: { gain: 1, fadeIn: 0, fadeOut: 0, enabled: false },
    ...overrides
  };
}

const build = (plan) => buildRenderGraph(
  { settings, video: [], audio: [], ...plan },
  { resolvePath, outputPath }
);

// --- structure --------------------------------------------------------------

test('a single clip needs no join at all', () => {
  const { args, filterScript } = build({ video: [clip()] });
  assert.equal(filterScript.split(';').length, 1);
  assert.match(filterScript, /\[0:v\].*\[v0\]/);
  assert.ok(args.includes('-map'));
  assert.ok(args.includes('[v0]'));
  // No audio anywhere, so the output says so explicitly.
  assert.ok(args.includes('-an'));
});

test('trimming happens at the input, not through the trim filter', () => {
  const { args, filterScript } = build({
    video: [clip({ in: 1.5, out: 4, length: 2.5, end: 2.5 })]
  });
  const ss = args.indexOf('-ss');
  assert.equal(args[ss + 1], '1.5');
  assert.equal(args[args.indexOf('-t') + 1], '2.5');
  assert.ok(!filterScript.includes('trim='), 'should not decode from frame zero');
});

test('cuts join with concat and keep every clip', () => {
  const { filterScript } = build({
    video: [clip(), clip({ start: 5 }), clip({ start: 10 })]
  });
  assert.equal((filterScript.match(/concat=n=2/g) || []).length, 2);
  assert.ok(!filterScript.includes('xfade'));
});

// --- the offsets that matter ------------------------------------------------

test("a dissolve's offset is the arriving clip's own start time", () => {
  // a runs 0–5; b is pulled back one second, so it starts at 4 and ends at 8.
  const { filterScript } = build({
    video: [
      clip(),
      clip({ start: 4, transition: { type: 'dissolve', duration: 1 } })
    ]
  });
  assert.match(filterScript, /xfade=transition=fade:duration=1:offset=4/);
});

test('chained dissolves each use their own start, with no accumulator to drift', () => {
  const { filterScript } = build({
    video: [
      clip(),
      clip({ start: 4, transition: { type: 'dissolve', duration: 1 } }),
      clip({ start: 8.5, transition: { type: 'dissolve', duration: 0.5 } })
    ]
  });
  assert.match(filterScript, /duration=1:offset=4/);
  assert.match(filterScript, /duration=0.5:offset=8.5/);
});

test('a dip fades the outgoing clip down and the incoming one up, over a cut', () => {
  const { filterScript } = build({
    video: [
      clip(),
      clip({ start: 5, transition: { type: 'dip', duration: 0.8 } })
    ]
  });
  // Out of the first clip, in on the second, and no overlap between them.
  assert.match(filterScript, /fade=t=out:st=4.2:d=0.8/);
  assert.match(filterScript, /fade=t=in:st=0:d=0.8/);
  assert.match(filterScript, /concat=n=2/);
  assert.ok(!filterScript.includes('xfade'));
});

test('a dip cannot be longer than the clips either side of it', () => {
  const fades = applyDips([
    { length: 5, transition: null },
    { length: 1, transition: { type: 'dip', duration: 4 } }
  ]);
  assert.equal(fades[1].in, 1);
  assert.equal(fades[0].out, 1);
});

// --- gaps -------------------------------------------------------------------

test('a hole in the timeline is filled with black', () => {
  const segments = withGaps([
    { start: 0, end: 5, length: 5 },
    { start: 8, end: 13, length: 5 }
  ]);
  assert.equal(segments.length, 3);
  assert.equal(segments[1].kind, 'black');
  assert.equal(segments[1].length, 3);
});

test('a timeline that does not start at zero gets a black lead-in', () => {
  const segments = withGaps([{ start: 2, end: 7, length: 5 }]);
  assert.equal(segments[0].kind, 'black');
  assert.equal(segments[0].length, 2);
});

test('black is generated rather than read from a file', () => {
  const { args, filterScript } = build({
    video: [clip(), clip({ start: 8 })]
  });
  assert.ok(args.includes('-f'));
  assert.ok(args.some(a => String(a).startsWith('color=c=black:s=1920x1080:r=24')));
  assert.equal((filterScript.match(/concat=n=2/g) || []).length, 2);
});

// --- sound ------------------------------------------------------------------

test('silent takes contribute no audio input', () => {
  const { args, filterScript } = build({
    video: [clip({ audio: { gain: 1, fadeIn: 0, fadeOut: 0, enabled: false } })]
  });
  assert.ok(!filterScript.includes(':a]'));
  assert.ok(args.includes('-an'));
});

test('a clip with sound is delayed to its place in the output', () => {
  const { filterScript, hasAudio } = build({
    video: [
      clip({ audio: { gain: 1, fadeIn: 0, fadeOut: 0, enabled: false } }),
      clip({ start: 5, path: 'b.mp4', audio: { gain: 0.5, fadeIn: 0, fadeOut: 0, enabled: true } })
    ]
  });
  assert.equal(hasAudio, true);
  assert.match(filterScript, /volume=0.5/);
  assert.match(filterScript, /adelay=5000:all=1/);
});

test('the mix never normalises, so adding a track cannot duck the others', () => {
  const { filterScript } = build({
    video: [clip()],
    audio: [
      { path: 'm.mp3', start: 0, in: 0, out: 30, length: 30, gain: 0.8, fadeIn: 0, fadeOut: 0 },
      { path: 'v.mp3', start: 2, in: 0, out: 5, length: 5, gain: 1, fadeIn: 0, fadeOut: 0 }
    ]
  });
  assert.match(filterScript, /amix=inputs=2:normalize=0/);
});

test('a lone audio source skips the mixer entirely', () => {
  const { args, filterScript } = build({
    video: [clip()],
    audio: [{ path: 'm.mp3', start: 0, in: 0, out: 30, length: 30, gain: 1, fadeIn: 0, fadeOut: 0 }]
  });
  assert.ok(!filterScript.includes('amix'));
  assert.ok(args.includes('[a0]'));
});

test('fades are applied before the delay, so they sit on the clip not the timeline', () => {
  const { filterScript } = build({
    video: [clip()],
    audio: [{ path: 'm.mp3', start: 10, in: 0, out: 30, length: 30, gain: 1, fadeIn: 2, fadeOut: 3 }]
  });
  const chain = filterScript.split('\n').find(line => line.includes('adelay'));
  assert.ok(chain.indexOf('afade=t=in') < chain.indexOf('adelay'));
  assert.ok(chain.indexOf('afade=t=out') < chain.indexOf('adelay'));
  assert.match(chain, /afade=t=out:st=27:d=3/);
});

// --- output -----------------------------------------------------------------

test('the graph goes in a script file, not on the command line', () => {
  // A long edit blows past the 8191-character command limit on Windows.
  const video = [];
  for (let i = 0; i < 60; i += 1) video.push(clip({ start: i * 5, path: `clip${i}.mp4` }));
  const { args, filterScript } = build({ video });

  assert.ok(args.includes('-filter_complex_script'));
  assert.ok(!args.some(a => String(a).includes('concat=n=2')));
  assert.ok(filterScript.length > 8191, 'fixture should be big enough to matter');
});

test('an empty timeline is refused rather than handed to ffmpeg', () => {
  assert.throws(() => build({ video: [] }), /empty/i);
});

test('the encoder can be swapped without touching the graph', () => {
  const { args } = buildRenderGraph(
    { settings, video: [clip()], audio: [] },
    { resolvePath, outputPath, encoder: 'h264_nvenc' }
  );
  assert.ok(args.includes('h264_nvenc'));
  assert.ok(!args.includes('-crf'));
});
