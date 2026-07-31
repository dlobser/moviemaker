// Turning a render plan into an ffmpeg invocation.
//
// The plan is the resolved timeline the editor already draws and plays — same
// absolute times, same trims, same transitions — so what you watched is what
// gets encoded. Nothing here knows about shots, selects or the EDL; the client
// resolves all that before sending.
//
// Two things make the arithmetic simpler than it looks:
//
// A clip's absolute start IS its xfade offset. Because a dissolve is stored by
// pulling the arriving clip back over its neighbour, the transition spans
// [start, start + duration], and the chain built so far ends at exactly
// start + duration. So there is no running accumulator to get wrong — the
// numbers the preview uses drop straight into the filter graph.
//
// Trimming happens at the input with -ss/-t rather than through the trim
// filter. Modern ffmpeg seeks accurately there, and it avoids decoding every
// clip from its first frame.
//
// This module is pure: it returns argument arrays and a filter script for the
// caller to run, which is what makes it testable without touching ffmpeg.

const EPSILON = 1e-3;

/** Everything downstream of the mix runs at one layout so amix cannot object. */
const AUDIO_FORMAT = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

/**
 * Insert explicit black for any hole in the picture.
 *
 * Free mode lets clips sit wherever they are dropped, so the timeline can have
 * gaps — including one before the first clip. Encoding has to fill them; the
 * preview already shows black there.
 */
function withGaps(video) {
  const segments = [];
  let cursor = 0;

  for (const clip of video) {
    if (clip.start > cursor + EPSILON) {
      segments.push({ kind: 'black', length: clip.start - cursor, start: cursor, end: clip.start });
    }
    segments.push({ ...clip, kind: clip.kind === 'image' ? 'image' : 'video' });
    cursor = Math.max(cursor, clip.end);
  }
  return segments;
}

/**
 * A dip to black is not an overlap: it is a fade down on the outgoing clip and
 * a fade up on the incoming one, joined by a straight cut. Resolve those into
 * per-segment fades before the graph is built.
 */
function applyDips(segments) {
  const fades = segments.map(() => ({ in: 0, out: 0 }));

  segments.forEach((segment, index) => {
    if (segment.transition?.type !== 'dip' || index === 0) return;
    const span = Math.min(
      segment.transition.duration,
      segment.length,
      segments[index - 1].length
    );
    if (span <= EPSILON) return;
    fades[index].in = span;
    fades[index - 1].out = span;
  });

  return fades;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * Build the ffmpeg invocation for a plan.
 *
 * Returns `{ args, filterScript, hasAudio }`. The filter graph goes in a file
 * rather than on the command line: a long edit produces a graph far past the
 * 8191-character limit Windows imposes on a command, and writing it out sides
 * steps the whole question.
 */
function buildRenderGraph(plan, { resolvePath, outputPath, encoder = 'libx264' } = {}) {
  const width = Math.round(plan.settings?.width) || 1920;
  const height = Math.round(plan.settings?.height) || 1080;
  const fps = Math.round(plan.settings?.fps) || 24;

  const segments = withGaps(plan.video || []);
  if (segments.length === 0) throw new Error('The timeline is empty.');

  const dipFades = applyDips(segments);

  const args = [];
  const chains = [];
  const videoLabels = [];
  const audioLabels = [];
  let inputIndex = 0;

  // --- picture --------------------------------------------------------------

  segments.forEach((segment, index) => {
    const label = `v${index}`;
    const filters = [];

    if (segment.kind === 'black') {
      args.push('-f', 'lavfi', '-t', String(round(segment.length)),
        '-i', `color=c=black:s=${width}x${height}:r=${fps}`);
    } else if (segment.kind === 'image') {
      args.push('-loop', '1', '-t', String(round(segment.length)), '-i', resolvePath(segment.path));
    } else {
      // Accurate input seek: cheaper than the trim filter and frame-exact.
      args.push('-ss', String(round(segment.in)), '-t', String(round(segment.length)),
        '-i', resolvePath(segment.path));
    }

    filters.push('setpts=PTS-STARTPTS');
    if (segment.kind !== 'black') {
      filters.push(
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
        'setsar=1'
      );
    }
    filters.push(`fps=${fps}`, 'format=yuv420p');

    const fade = dipFades[index];
    if (fade.in > EPSILON) filters.push(`fade=t=in:st=0:d=${round(fade.in)}`);
    if (fade.out > EPSILON) {
      filters.push(`fade=t=out:st=${round(segment.length - fade.out)}:d=${round(fade.out)}`);
    }

    chains.push(`[${inputIndex}:v]${filters.join(',')}[${label}]`);
    videoLabels.push({ label, segment, inputIndex });
    inputIndex += 1;
  });

  // --- joining --------------------------------------------------------------

  let current = `[${videoLabels[0].label}]`;
  for (let index = 1; index < videoLabels.length; index += 1) {
    const { label, segment } = videoLabels[index];
    const output = `[j${index}]`;

    if (segment.transition?.type === 'dissolve' && segment.transition.duration > EPSILON) {
      // The clip's own start is where the transition begins in the output.
      chains.push(
        `${current}[${label}]xfade=transition=fade:` +
        `duration=${round(segment.transition.duration)}:offset=${round(segment.start)}${output}`
      );
    } else {
      chains.push(`${current}[${label}]concat=n=2:v=1:a=0${output}`);
    }
    current = output;
  }
  const videoOut = current;

  // --- sound ----------------------------------------------------------------

  // A picture clip's own soundtrack, unless it has been detached or the source
  // has none — which most generated clips do not.
  videoLabels.forEach(({ segment }) => {
    if (segment.kind !== 'video') return;
    const audio = segment.audio;
    if (!audio || audio.enabled === false) return;

    const label = `a${audioLabels.length}`;
    args.push('-ss', String(round(segment.in)), '-t', String(round(segment.length)),
      '-i', resolvePath(segment.path));
    chains.push(buildAudioChain(inputIndex, label, {
      start: segment.start,
      length: segment.length,
      gain: audio.gain,
      fadeIn: audio.fadeIn,
      fadeOut: audio.fadeOut
    }));
    audioLabels.push(label);
    inputIndex += 1;
  });

  for (const clip of plan.audio || []) {
    const label = `a${audioLabels.length}`;
    args.push('-ss', String(round(clip.in)), '-t', String(round(clip.length)),
      '-i', resolvePath(clip.path));
    chains.push(buildAudioChain(inputIndex, label, clip));
    audioLabels.push(label);
    inputIndex += 1;
  }

  let audioOut = null;
  if (audioLabels.length === 1) {
    audioOut = `[${audioLabels[0]}]`;
  } else if (audioLabels.length > 1) {
    // normalize=0 matters: left on, amix quietly divides every input by the
    // number of them, so adding a track would duck the whole mix.
    chains.push(
      `${audioLabels.map(label => `[${label}]`).join('')}` +
      `amix=inputs=${audioLabels.length}:normalize=0:dropout_transition=0[amix]`
    );
    audioOut = '[amix]';
  }

  // --- output ---------------------------------------------------------------

  const filterScript = chains.join(';\n');

  args.push('-filter_complex_script', '__FILTER_SCRIPT__');
  args.push('-map', videoOut);
  if (audioOut) {
    args.push('-map', audioOut, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
  } else {
    args.push('-an');
  }
  args.push('-c:v', encoder);
  if (encoder === 'libx264') args.push('-preset', 'veryfast', '-crf', '20');
  args.push('-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath);

  return { args, filterScript, hasAudio: Boolean(audioOut), inputCount: inputIndex };
}

/** Trim, level, fade and position one audio source in the output timeline. */
function buildAudioChain(inputIndex, label, clip) {
  const filters = ['asetpts=PTS-STARTPTS', AUDIO_FORMAT];

  const gain = Number.isFinite(clip.gain) ? clip.gain : 1;
  if (Math.abs(gain - 1) > EPSILON) filters.push(`volume=${round(gain)}`);

  // Fades are relative to the trimmed stream, so they go on before the delay
  // that moves it into place.
  if (clip.fadeIn > EPSILON) filters.push(`afade=t=in:st=0:d=${round(clip.fadeIn)}`);
  if (clip.fadeOut > EPSILON) {
    filters.push(`afade=t=out:st=${round(clip.length - clip.fadeOut)}:d=${round(clip.fadeOut)}`);
  }

  if (clip.start > EPSILON) {
    filters.push(`adelay=${Math.round(clip.start * 1000)}:all=1`);
  }

  return `[${inputIndex}:a]${filters.join(',')}[${label}]`;
}

module.exports = { buildRenderGraph, withGaps, applyDips };
