// Turning the resolved timeline into something the renderer can encode.
//
// This is deliberately a flat translation rather than a second interpretation
// of the edit: the same `buildTimeline` output that drives the monitor and the
// strip becomes the render plan, so a clip cannot end up in a different place
// on disk than it sits on screen. The server knows nothing about shots,
// selects, tracks or links — all of that is resolved here.

import { trackAudible } from './timing.js';

/**
 * @param {object} timeline the result of buildTimeline
 * @returns a plan for POST /api/render
 */
export function buildRenderPlan(timeline) {
  // Picture audio follows the same rules the preview mixes by: nothing from a
  // silent source, nothing from a clip whose sound has been detached, and
  // nothing at all while an audio track is soloed.
  const video = timeline.video
    .filter(entry => entry.resolved.path)
    .map(entry => ({
      path: entry.resolved.path,
      kind: entry.resolved.kind === 'image' ? 'image' : 'video',
      in: entry.in,
      out: entry.out,
      start: entry.start,
      end: entry.end,
      length: entry.length,
      transition: entry.transition,
      audio: {
        gain: entry.clip.audio?.gain ?? 1,
        fadeIn: entry.clip.audio?.fadeIn ?? 0,
        fadeOut: entry.clip.audio?.fadeOut ?? 0,
        enabled: Boolean(entry.hasAudio)
          && !entry.clip.audio?.detached
          && !timeline.anySolo
      }
    }));

  // A track's fader is folded into its clips: the renderer mixes a flat list
  // and has no notion of tracks to apply it at.
  const audio = timeline.audio.flatMap(trackEntry => {
    if (!trackAudible(trackEntry.track, timeline.anySolo)) return [];
    const trackGain = Number(trackEntry.track.gain);
    return trackEntry.clips
      .filter(entry => entry.resolved.path && entry.hasAudio !== false)
      .map(entry => ({
        path: entry.resolved.path,
        start: entry.start,
        in: entry.in,
        out: entry.out,
        length: entry.length,
        gain: (Number(entry.gain) || 0) * (Number.isFinite(trackGain) ? trackGain : 1),
        fadeIn: entry.fadeIn,
        fadeOut: entry.fadeOut
      }));
  });

  return { settings: timeline.settings, video, audio };
}

/** A clip that points at nothing renders as black, and is worth warning about. */
export function missingSources(timeline) {
  const gaps = timeline.video.filter(entry => !entry.resolved.path);
  return gaps.map(entry => entry.resolved.name);
}
