// Turning a watermark request into an ffmpeg filter graph.
//
// A second pass over an already-finished master: the concatenate endpoint
// produces the film, this stamps a moving mark onto it. Deliberately separate
// so re-marking never means re-encoding every shot again, and so a master can
// be exported clean or marked from the same source.
//
// THE BLEND IS ADDITIVE, AND IT HAS TO HAPPEN IN RGB.
//
// The mark is a black-and-white image where black means "leave the picture
// alone" and white means "add light here". That is exactly what an addition
// blend does — in RGB, where black is 0,0,0. In YUV black is (0,128,128),
// because chroma is stored around a midpoint, so adding it would shove every
// pixel's colour sideways and tint the whole frame. Hence the conversion to
// gbrp before blending and back to yuv420p after.
//
// Grey is the opacity control: a 50% grey mark adds half as much light as a
// white one. There is nothing to configure because the image already says it.
//
// This module is pure — it returns a filter string for the caller to run,
// which is what makes the motion arithmetic testable without ffmpeg.

/**
 * A small deterministic generator, so a given seed always lays the mark down
 * on the same path. Without it "render watermark" twice would produce two
 * different files from identical inputs, and a re-render after a tweak could
 * not be compared against the last one.
 */
function seededRandom(seed) {
  let state = (Number(seed) || 1) >>> 0;
  return () => {
    // Numerical Recipes' LCG constants; the top bits are the usable ones.
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * Continuous wander, as two sine waves at periods that do not divide into each
 * other. The mark crosses the frame on a Lissajous path and takes minutes to
 * come near a previous position, which reads as aimless drifting rather than
 * as a loop.
 */
function driftExpressions({ seed, periodX, periodY }) {
  const random = seededRandom(seed);
  const phaseX = round(random() * Math.PI * 2);
  const phaseY = round(random() * Math.PI * 2);
  return {
    x: `(W-w)/2*(1+sin(2*PI*t/${round(periodX)}+${phaseX}))`,
    y: `(H-h)/2*(1+sin(2*PI*t/${round(periodY)}+${phaseY}))`
  };
}

/**
 * Discrete hops: a new random position every `hold` seconds, held still in
 * between. Built as a nested if-ladder because ffmpeg's own `random()` is
 * evaluated per frame — using it directly would make the mark flicker across
 * the screen every frame instead of resting somewhere.
 */
function jumpExpressions({ seed, duration, hold }) {
  const random = seededRandom(seed);
  const steps = Math.max(1, Math.ceil(duration / hold));
  const xs = [];
  const ys = [];
  for (let step = 0; step < steps; step++) {
    xs.push(round(random()));
    ys.push(round(random()));
  }

  // Fold from the last step back, so each `if` only has to test its own edge.
  const ladder = (fractions, span) => fractions.reduceRight((rest, fraction, index) => {
    const position = `${span}*${fraction}`;
    return index === fractions.length - 1
      ? position
      : `if(lt(t,${round((index + 1) * hold)}),${position},${rest})`;
  }, '');

  return { x: ladder(xs, '(W-w)'), y: ladder(ys, '(H-h)') };
}

/**
 * How many pixels wide to draw the mark.
 *
 * `scale` is a fraction of the frame's smaller side, so one source image reads
 * the same on a 720p cut and a 4K one. It has to be worked out here, in pixels,
 * rather than left as an expression: inside the mark's own scale filter `iw`
 * and `ih` are the *mark's* dimensions, not the picture's, so `min(iw,ih)*0.15`
 * silently sizes a 256px image against itself and lands at 38px on any video.
 *
 * Without the frame size the mark keeps its native dimensions, which is at
 * least honest about not knowing.
 */
function markPixelWidth({ frameWidth, frameHeight, scale }) {
  if (!(frameWidth > 0 && frameHeight > 0)) return null;
  // Even widths only: yuv420p subsamples chroma and odd sizes get rejected.
  const pixels = Math.round(Math.min(frameWidth, frameHeight) * scale);
  return Math.max(16, pixels - (pixels % 2));
}

/** The filter_complex for stamping `[1:v]` onto `[0:v]`. */
function buildWatermarkGraph({
  motion = 'drift',
  seed = 1,
  duration = 60,
  hold = 4,
  periodX = 13,
  periodY = 17,
  scale = 0.15,
  frameWidth = null,
  frameHeight = null
} = {}) {
  const { x, y } = motion === 'jump'
    ? jumpExpressions({ seed, duration, hold })
    : driftExpressions({ seed, periodX, periodY });

  const pixels = markPixelWidth({ frameWidth, frameHeight, scale });
  // -1 keeps the mark's own aspect ratio whatever it is.
  const markChain = pixels ? `format=gbrp,scale=${pixels}:-1` : 'format=gbrp';

  return [
    // A black canvas the size of the picture, so the overlay can move the mark
    // anywhere and the blend still sees two frames of equal size.
    `[0:v]format=gbrp,split=2[base][sizer]`,
    `[sizer]drawbox=c=black:t=fill[canvas]`,
    `[1:v]${markChain}[mark]`,
    `[canvas][mark]overlay=x='${x}':y='${y}':eval=frame[moving]`,
    `[base][moving]blend=all_mode=addition:shortest=1,format=yuv420p[v]`
  ].join(';');
}

module.exports = { buildWatermarkGraph, driftExpressions, jumpExpressions, seededRandom, markPixelWidth };
