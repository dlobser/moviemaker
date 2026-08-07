// node --test watermarkGraph.test.js
//
// The watermark pass is one filter graph and a lot of arithmetic hiding in
// string expressions, which is exactly the shape that breaks quietly: a wrong
// blend mode tints the whole film, a wrong colour space does it invisibly, and
// a motion expression that evaluates once leaves the mark nailed to a corner.
// None of that shows up until an encode finishes.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildWatermarkGraph, driftExpressions, jumpExpressions, seededRandom, markPixelWidth } = require('./watermarkGraph');

test('the blend is additive and happens in RGB, never in YUV', () => {
  const graph = buildWatermarkGraph();
  assert.match(graph, /blend=all_mode=addition/);
  // In YUV, black carries chroma at 128 — adding it would tint every frame.
  assert.match(graph, /\[0:v\]format=gbrp/);
  assert.match(graph, /\[1:v\]format=gbrp/);
  // And back, or nothing downstream can encode it.
  assert.match(graph, /format=yuv420p\[v\]/);
});

test('there is no multiply anywhere', () => {
  assert.doesNotMatch(buildWatermarkGraph(), /multiply/);
});

test('the overlay re-evaluates per frame, or the mark never moves', () => {
  assert.match(buildWatermarkGraph(), /eval=frame/);
});

test('drift is two sines whose periods do not divide into each other', () => {
  const { x, y } = driftExpressions({ seed: 7, periodX: 13, periodY: 17 });
  assert.match(x, /sin\(2\*PI\*t\/13/);
  assert.match(y, /sin\(2\*PI\*t\/17/);
  // Bounded by the frame: the sine spans -1..1, halved and offset to 0..(W-w).
  assert.match(x, /\(W-w\)\/2\*\(1\+sin/);
  assert.match(y, /\(H-h\)\/2\*\(1\+sin/);
});

test('the same seed lays the mark down on the same path', () => {
  assert.deepEqual(driftExpressions({ seed: 42, periodX: 13, periodY: 17 }),
    driftExpressions({ seed: 42, periodX: 13, periodY: 17 }));
  assert.notDeepEqual(driftExpressions({ seed: 42, periodX: 13, periodY: 17 }),
    driftExpressions({ seed: 43, periodX: 13, periodY: 17 }));
});

test('jump holds a position for its interval rather than per frame', () => {
  // ffmpeg's own random() is evaluated per frame; using it would scatter the
  // mark across the screen every frame instead of resting somewhere.
  const { x } = jumpExpressions({ seed: 3, duration: 12, hold: 4 });
  assert.match(x, /if\(lt\(t,4\)/);
  assert.match(x, /if\(lt\(t,8\)/);
  assert.doesNotMatch(x, /random/);
});

test('jump covers the whole duration, and a short film still gets one position', () => {
  const long = jumpExpressions({ seed: 1, duration: 20, hold: 4 });
  assert.equal((long.x.match(/if\(/g) || []).length, 4); // 5 steps, 4 branches
  const short = jumpExpressions({ seed: 1, duration: 2, hold: 4 });
  assert.doesNotMatch(short.x, /if\(/); // one position, no ladder
});

test('positions stay inside the frame', () => {
  const { x, y } = jumpExpressions({ seed: 9, duration: 40, hold: 4 });
  // Every position is a fraction of the free space, so the mark cannot be
  // placed partly outside the picture however the seed falls.
  [...x.matchAll(/\(W-w\)\*([\d.]+)/g)].forEach(m => {
    assert.ok(Number(m[1]) >= 0 && Number(m[1]) <= 1, `x fraction ${m[1]} out of range`);
  });
  [...y.matchAll(/\(H-h\)\*([\d.]+)/g)].forEach(m => {
    assert.ok(Number(m[1]) >= 0 && Number(m[1]) <= 1, `y fraction ${m[1]} out of range`);
  });
});

// Inside the mark's own scale filter, `iw`/`ih` are the *mark's* dimensions —
// so an expression like min(iw,ih)*0.15 sizes a 256px image against itself and
// lands at 38px whatever the video is. The pixels have to be worked out from
// the frame before the graph is written.
test('the mark is sized in pixels off the frame, not off itself', () => {
  assert.equal(markPixelWidth({ frameWidth: 1280, frameHeight: 720, scale: 0.15 }), 108);
  assert.equal(markPixelWidth({ frameWidth: 3840, frameHeight: 2160, scale: 0.15 }), 324);
  // Portrait measures against the short side too, so the mark never dominates.
  assert.equal(markPixelWidth({ frameWidth: 720, frameHeight: 1280, scale: 0.15 }), 108);
  assert.match(buildWatermarkGraph({ frameWidth: 1280, frameHeight: 720, scale: 0.15 }), /scale=108:-1/);
});

test('mark widths stay even, because yuv420p rejects odd ones', () => {
  for (const width of [641, 643, 999, 1001]) {
    assert.equal(markPixelWidth({ frameWidth: width, frameHeight: width, scale: 0.15 }) % 2, 0);
  }
});

test('an unknown frame size leaves the mark at its native dimensions', () => {
  const graph = buildWatermarkGraph();
  assert.match(graph, /\[1:v\]format=gbrp\[mark\]/);
  assert.doesNotMatch(graph, /scale=/);
});

test('the seeded generator is deterministic and stays in range', () => {
  const a = seededRandom(5);
  const b = seededRandom(5);
  for (let i = 0; i < 100; i++) {
    const value = a();
    assert.equal(value, b());
    assert.ok(value >= 0 && value < 1);
  }
});
