// Audio-track playback.
//
// Picture audio rides along with its video element and is mixed by the engine;
// this handles everything on a real audio track — music, voiceover, lip-sync,
// and any soundtrack that has been detached from its clip.
//
// Those cannot use media elements. Several of them overlap, they have to start
// at exact times, and a media element's own clock drifts. So each source is
// decoded once into an AudioBuffer and scheduled against the AudioContext
// clock, which is sample-accurate and is the same clock the engine uses as its
// master. Faders stay responsive because track gain nodes outlive any
// individual scheduled source.

import { trackAudible } from './timing.js';

/** Schedule slightly ahead so a slow decode cannot land in the past. */
const LOOKAHEAD = 0.06;

export class AudioScheduler {
  constructor({ audioContext, destination, resolveUrl }) {
    this.audio = audioContext;
    this.destination = destination;
    this.resolveUrl = resolveUrl;

    this.timeline = null;
    this.playing = false;
    // Bumped on every stop so decodes that finish late can tell they are stale.
    this.generation = 0;

    this.trackGains = new Map();
    this.buffers = new Map();
    this.active = [];
  }

  setTimeline(timeline) {
    this.timeline = timeline;
    this.syncTrackGains();
  }

  /** One persistent gain node per track, so moving a fader is instant. */
  syncTrackGains() {
    if (!this.timeline) return;
    const live = new Set();

    for (const entry of this.timeline.audio) {
      live.add(entry.track.id);
      let node = this.trackGains.get(entry.track.id);
      if (!node) {
        node = this.audio.createGain();
        node.connect(this.destination);
        this.trackGains.set(entry.track.id, node);
      }
      const target = trackAudible(entry.track, this.timeline.anySolo)
        ? (Number(entry.track.gain) || 0)
        : 0;
      node.gain.setTargetAtTime(target, this.audio.currentTime, 0.015);
    }

    for (const [id, node] of this.trackGains) {
      if (live.has(id)) continue;
      node.disconnect();
      this.trackGains.delete(id);
    }
  }

  async bufferFor(path) {
    if (this.buffers.has(path)) return this.buffers.get(path);

    const job = (async () => {
      const url = await this.resolveUrl(path);
      if (!url) throw new Error('asset not found');
      const response = await fetch(url);
      const bytes = await response.arrayBuffer();
      return await this.audio.decodeAudioData(bytes);
    })().catch(error => {
      // A clip whose audio will not decode should cost silence, not playback.
      console.warn(`[edit] could not decode audio for ${path}:`, error?.message || error);
      return null;
    });

    this.buffers.set(path, job);
    return job;
  }

  /** Drop a decoded buffer so the next schedule fetches the source again. */
  forget(path) {
    this.buffers.delete(path);
  }

  start(playhead) {
    this.stop();
    if (!this.timeline) return;

    this.playing = true;
    const token = this.generation;
    const origin = this.audio.currentTime + LOOKAHEAD;

    for (const trackEntry of this.timeline.audio) {
      for (const entry of trackEntry.clips) {
        if (entry.end <= playhead + 1e-4) continue;
        if (!entry.resolved.path) continue;
        // Known-silent sources are skipped rather than fetched and decoded into
        // a failure. Generated clips usually have no audio stream at all.
        if (entry.hasAudio === false) continue;
        this.scheduleOne(trackEntry, entry, playhead, origin, token);
      }
    }
  }

  async scheduleOne(trackEntry, entry, playhead, origin, token) {
    const buffer = await this.bufferFor(entry.resolved.path);
    // A seek or a stop happened while this was decoding.
    if (!buffer || token !== this.generation || !this.playing) return;

    const trackGain = this.trackGains.get(trackEntry.track.id);
    if (!trackGain) return;

    // Where the clip sits in context time, and where playback picks it up.
    const clipStartAbs = origin + (entry.start - playhead);
    const clipEndAbs = origin + (entry.end - playhead);
    const when = Math.max(origin, clipStartAbs);

    const offset = entry.in + Math.max(0, playhead - entry.start);
    const duration = Math.min(entry.end, entry.start + entry.length) - Math.max(entry.start, playhead);
    if (duration <= 0 || offset >= buffer.duration) return;

    const source = this.audio.createBufferSource();
    source.buffer = buffer;

    const gain = this.audio.createGain();
    applyEnvelope(gain.gain, entry, clipStartAbs, clipEndAbs, when);

    source.connect(gain);
    gain.connect(trackGain);
    source.start(when, offset, Math.min(duration, buffer.duration - offset));

    const handle = { source, gain };
    this.active.push(handle);
    source.onended = () => {
      const index = this.active.indexOf(handle);
      if (index >= 0) this.active.splice(index, 1);
      try { gain.disconnect(); } catch { /* already torn down */ }
    };
  }

  stop() {
    this.playing = false;
    this.generation += 1;
    for (const { source, gain } of this.active) {
      try { source.onended = null; source.stop(); } catch { /* never started */ }
      try { gain.disconnect(); } catch { /* already torn down */ }
    }
    this.active = [];
  }

  destroy() {
    this.stop();
    for (const node of this.trackGains.values()) node.disconnect();
    this.trackGains.clear();
    this.buffers.clear();
  }
}

/**
 * Write the clip's fades into the gain param in absolute context time.
 *
 * Starting mid-fade is the awkward case: playback can begin part-way up a fade
 * in, so the opening value is computed rather than assumed to be zero.
 */
function applyEnvelope(param, entry, clipStartAbs, clipEndAbs, when) {
  const level = Number(entry.gain) || 0;
  const fadeIn = Math.max(0, entry.fadeIn || 0);
  const fadeOut = Math.max(0, entry.fadeOut || 0);

  param.cancelScheduledValues(0);

  const insideFadeIn = fadeIn > 0 && when < clipStartAbs + fadeIn;
  param.setValueAtTime(
    insideFadeIn ? level * Math.max(0, (when - clipStartAbs) / fadeIn) : level,
    when
  );
  if (insideFadeIn) param.linearRampToValueAtTime(level, clipStartAbs + fadeIn);

  if (fadeOut > 0) {
    const fadeStart = clipEndAbs - fadeOut;
    if (fadeStart > when) param.setValueAtTime(level, fadeStart);
    param.linearRampToValueAtTime(0, clipEndAbs);
  }
}
