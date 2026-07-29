// Timeline playback.
//
// Two video elements take turns. The one under the playhead is drawn to a
// canvas every frame; the next clip is loaded and seeked on the spare element
// well before it is needed, so a cut costs nothing at the boundary and a
// dissolve has both halves already running.
//
// The AudioContext clock is the master. Video chases it, never the other way
// round: media elements drift by tens of milliseconds over a few seconds and
// there is no way to make several of them agree with each other, whereas the
// audio clock is monotonic and sample-accurate. Each element's audio is routed
// through the same graph via a MediaElementAudioSourceNode, which can only be
// created once per element — hence the fixed pool built up front.
//
// Nothing here reads the edit document directly. It consumes the resolved
// timeline from timing.js, which is the same structure the renderer will
// consume, so what you watch and what you export come from one description.

import { clipsAtTime } from './timing.js';

/** Past this much drift, seek. Below it, nudge the rate instead. */
const HARD_CORRECT = 0.25;
const SOFT_CORRECT = 0.08;

export class PreviewEngine {
  constructor({ canvas, resolveUrl, onTime, onStateChange }) {
    this.canvas = canvas;
    this.context2d = canvas.getContext('2d', { alpha: false });
    this.resolveUrl = resolveUrl;
    this.onTime = onTime || (() => {});
    this.onStateChange = onStateChange || (() => {});

    this.timeline = null;
    this.playhead = 0;
    this.playing = false;
    this.destroyed = false;

    // Suspended until a user gesture; constructing it early is what lets the
    // element sources be wired once and left alone.
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.audio = new AudioContextClass();
    this.master = this.audio.createGain();
    this.master.connect(this.audio.destination);

    this.host = document.createElement('div');
    // Off-screen rather than display:none — a hidden element gets its rendering
    // throttled, and we need real frames to draw.
    this.host.setAttribute('aria-hidden', 'true');
    this.host.style.cssText =
      'position:fixed;left:-10000px;top:0;width:640px;height:360px;opacity:0;pointer-events:none;';
    document.body.appendChild(this.host);

    this.slots = [this.createSlot(), this.createSlot()];
    this.images = new Map();   // asset path -> HTMLImageElement
    this.urls = new Map();     // asset path -> object/http url
    this.frame = null;

    // The loop runs from construction, not from play(). Loading a clip is
    // asynchronous, so a one-shot draw would leave the monitor black until
    // playback started; a always-on loop simply picks the frame up whenever it
    // becomes available. Idle cost is one drawImage per frame.
    this.tick = this.tick.bind(this);
    this.frame = requestAnimationFrame(this.tick);
  }

  createSlot() {
    const element = document.createElement('video');
    element.preload = 'auto';
    element.playsInline = true;
    element.crossOrigin = 'anonymous';
    this.host.appendChild(element);

    const gain = this.audio.createGain();
    const source = this.audio.createMediaElementSource(element);
    source.connect(gain);
    gain.connect(this.master);

    return { element, gain, path: null, clipId: null, ready: false };
  }

  // --- content ---------------------------------------------------------------

  /**
   * Point the engine at a new resolved timeline. Slots holding a clip that is
   * still present keep their loaded media, so routine edits do not cause a
   * reload flash.
   */
  setTimeline(timeline) {
    this.timeline = timeline;
    const live = new Set(timeline.video.map(entry => entry.clip.id));
    for (const slot of this.slots) {
      if (slot.clipId && !live.has(slot.clipId)) {
        slot.clipId = null;
      }
    }
    this.resizeCanvas();
    if (!this.playing) this.drawAt(this.playhead);
  }

  resizeCanvas() {
    const { width, height } = this.timeline?.settings || {};
    if (width && height && (this.canvas.width !== width || this.canvas.height !== height)) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  async urlFor(path) {
    if (!path) return null;
    if (this.urls.has(path)) return this.urls.get(path);
    const url = await this.resolveUrl(path);
    if (url) this.urls.set(path, url);
    return url;
  }

  async imageFor(path) {
    if (this.images.has(path)) return this.images.get(path);
    const url = await this.urlFor(path);
    if (!url) return null;
    const image = new Image();
    image.src = url;
    this.images.set(path, image);
    try {
      await image.decode();
    } catch {
      // A decode failure still leaves a usable element in most browsers; the
      // draw path checks completeness anyway.
    }
    return image;
  }

  /** The slot already showing this clip, or the one least likely to be missed. */
  claimSlot(entry, keepClipId) {
    const existing = this.slots.find(slot => slot.clipId === entry.clip.id);
    if (existing) return existing;
    const free = this.slots.find(slot => slot.clipId !== keepClipId && slot.clipId !== entry.clip.id);
    return free || this.slots[0];
  }

  async loadInto(slot, entry) {
    const path = entry.resolved.path;
    if (slot.clipId === entry.clip.id && slot.path === path) return slot;

    slot.clipId = entry.clip.id;
    slot.ready = false;

    if (slot.path !== path) {
      const url = await this.urlFor(path);
      if (!url) return slot;
      slot.path = path;
      slot.element.src = url;
    }

    try {
      await seekElement(slot.element, entry.in);
      slot.ready = true;
    } catch {
      slot.ready = false;
    }
    return slot;
  }

  // --- transport -------------------------------------------------------------

  async play() {
    if (this.playing || !this.timeline || this.timeline.duration <= 0) return;
    if (this.playhead >= this.timeline.duration - 0.01) this.playhead = 0;

    await this.audio.resume();
    this.playing = true;
    this.clockOrigin = this.audio.currentTime;
    this.clockOffset = this.playhead;
    this.onStateChange({ playing: true });
  }

  pause() {
    if (!this.playing) return;
    this.playhead = this.now();
    this.playing = false;
    for (const slot of this.slots) slot.element.pause();
    this.onStateChange({ playing: false });
  }

  toggle() {
    return this.playing ? this.pause() : this.play();
  }

  seek(time) {
    const limit = this.timeline?.duration || 0;
    this.playhead = Math.min(Math.max(0, time), limit);
    if (this.playing) {
      this.clockOrigin = this.audio.currentTime;
      this.clockOffset = this.playhead;
      // Force every slot to re-align on the next frame.
      for (const slot of this.slots) slot.ready = false;
    } else {
      for (const slot of this.slots) slot.element.pause();
      this.drawAt(this.playhead);
    }
    this.onTime(this.playhead);
  }

  now() {
    if (!this.playing) return this.playhead;
    return this.clockOffset + (this.audio.currentTime - this.clockOrigin);
  }

  setMasterGain(value) {
    this.master.gain.setTargetAtTime(value, this.audio.currentTime, 0.01);
  }

  // --- the loop --------------------------------------------------------------

  tick() {
    if (this.destroyed) return;
    this.frame = requestAnimationFrame(this.tick);
    if (!this.timeline) return;

    const time = this.now();

    if (this.playing && time >= this.timeline.duration) {
      this.playhead = this.timeline.duration;
      this.pause();
      this.drawAt(this.playhead);
      this.onTime(this.playhead);
      return;
    }

    this.drawAt(time);
    if (this.playing) this.onTime(time);
  }

  drawAt(time) {
    if (!this.timeline) return;
    const { current, incoming, mix } = clipsAtTime(this.timeline, time);
    const paint = this.context2d;

    paint.globalAlpha = 1;
    paint.fillStyle = '#000';
    paint.fillRect(0, 0, this.canvas.width, this.canvas.height);

    if (!current) {
      this.idleSlots(null, null);
      return;
    }

    this.syncSlot(current, time, incoming?.clip.id);
    this.paintEntry(current, 1);

    if (incoming) {
      this.syncSlot(incoming, time, current.clip.id);
      this.paintEntry(incoming, mix);
      this.mixAudio(current, 1 - mix, incoming, mix);
    } else {
      this.mixAudio(current, 1, null, 0);
      // Only safe while nothing is dissolving: during a transition both slots
      // are spoken for.
      this.preload(current);
    }

    this.paintDip(current, incoming, time);
    paint.globalAlpha = 1;
  }

  /** Get the right media onto a slot and keep it in step with the clock. */
  syncSlot(entry, time, keepClipId) {
    if (entry.resolved.kind === 'image' || entry.resolved.kind === 'missing') return;

    const slot = this.claimSlot(entry, keepClipId);
    if (slot.clipId !== entry.clip.id || slot.path !== entry.resolved.path) {
      this.loadInto(slot, entry);
      return;
    }
    // Nothing decodable yet — there is no frame to show and no point steering.
    if (slot.element.readyState < 2) return;

    // Correcting drift against a seek that has not landed just fights it, but
    // transport still applies: gating playback on the seek promise is what
    // strands a clip paused on its first frame when the event never arrives.
    if (slot.ready) {
      const expected = entry.in + (time - entry.start);
      const drift = expected - slot.element.currentTime;

      if (Math.abs(drift) > HARD_CORRECT) {
        slot.element.currentTime = expected;
        slot.element.playbackRate = 1;
      } else if (this.playing && Math.abs(drift) > SOFT_CORRECT) {
        slot.element.playbackRate = 1 + Math.max(-0.05, Math.min(0.05, drift));
      } else {
        slot.element.playbackRate = 1;
      }
    }

    if (this.playing && slot.element.paused) {
      slot.element.play().catch(() => { /* interrupted by a seek; next frame retries */ });
    } else if (!this.playing && !slot.element.paused) {
      slot.element.pause();
    }
  }

  paintEntry(entry, alpha) {
    const paint = this.context2d;
    paint.globalAlpha = Math.max(0, Math.min(1, alpha));

    if (entry.resolved.kind === 'image') {
      const image = this.images.get(entry.resolved.path);
      if (image?.complete && image.naturalWidth) {
        drawFitted(paint, image, image.naturalWidth, image.naturalHeight, this.canvas);
      } else {
        this.imageFor(entry.resolved.path);
      }
      return;
    }

    if (entry.resolved.kind === 'missing') return;

    const slot = this.slots.find(candidate => candidate.clipId === entry.clip.id);
    const element = slot?.element;
    if (element && element.readyState >= 2 && element.videoWidth) {
      drawFitted(paint, element, element.videoWidth, element.videoHeight, this.canvas);
    }
  }

  /** A dip to black is a fade out and a fade in either side of a hard cut. */
  paintDip(current, incoming, time) {
    if (incoming) return;
    const span = current.clip.transition?.type === 'dip' ? current.clip.transition.duration : 0;
    const next = this.timeline.video[current.index + 1];
    const outSpan = next?.clip.transition?.type === 'dip' ? next.clip.transition.duration : 0;

    let darkness = 0;
    if (span > 0 && time < current.start + span) {
      darkness = 1 - (time - current.start) / span;
    }
    if (outSpan > 0 && time > current.end - outSpan) {
      darkness = Math.max(darkness, (time - (current.end - outSpan)) / outSpan);
    }
    if (darkness <= 0) return;

    const paint = this.context2d;
    paint.globalAlpha = Math.min(1, darkness);
    paint.fillStyle = '#000';
    paint.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  mixAudio(current, currentGain, incoming, incomingGain) {
    const when = this.audio.currentTime;
    for (const slot of this.slots) {
      let gain = 0;
      if (current && slot.clipId === current.clip.id) gain = currentGain * (current.clip.audio?.gain ?? 1);
      else if (incoming && slot.clipId === incoming.clip.id) gain = incomingGain * (incoming.clip.audio?.gain ?? 1);
      slot.gain.gain.setTargetAtTime(this.playing ? gain : 0, when, 0.02);
    }
  }

  /**
   * Keep the spare slot holding whatever comes next.
   *
   * There is no lead-time window: with two slots the spare has nothing else to
   * do, so loading the next clip the moment the current one starts gives a full
   * clip's worth of head start. A fixed window was too tight — a clip that had
   * not finished fetching by its own cut point started late and then had to be
   * yanked into place by drift correction.
   */
  preload(current) {
    const next = this.timeline.video[current.index + 1];
    if (!next || next.resolved.kind === 'missing') return;

    if (next.resolved.kind === 'image') {
      this.imageFor(next.resolved.path);
      return;
    }
    const slot = this.claimSlot(next, current.clip.id);
    if (slot.clipId !== next.clip.id) this.loadInto(slot, next);
  }

  idleSlots() {
    for (const slot of this.slots) {
      if (!slot.element.paused) slot.element.pause();
      slot.gain.gain.setTargetAtTime(0, this.audio.currentTime, 0.02);
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    for (const slot of this.slots) {
      slot.element.pause();
      slot.element.removeAttribute('src');
      slot.element.load();
    }
    for (const url of this.urls.values()) {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    }
    this.urls.clear();
    this.images.clear();
    this.host.remove();
    this.audio.close().catch(() => {});
  }
}

/** Letterbox rather than stretch — the project frame is rarely every clip's. */
function drawFitted(paint, source, sourceWidth, sourceHeight, canvas) {
  const scale = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  paint.drawImage(source, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
}

/** Resolve once the element has actually landed on the requested frame. */
function seekElement(element, time) {
  return new Promise((resolve, reject) => {
    // Assigning the currentTime an element already holds fires no `seeked`
    // event, so waiting for one would stall the slot until the timeout below
    // and leave the clip sitting paused on its first frame. An untrimmed clip
    // seeks to zero, which is the common case, so this is the fast path rather
    // than an edge case.
    if (element.readyState >= 2 && Math.abs(element.currentTime - time) < 0.01) {
      resolve();
      return;
    }

    const cleanup = () => {
      element.removeEventListener('seeked', onSeeked);
      element.removeEventListener('error', onError);
      clearTimeout(timer);
    };
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('media failed to load')); };
    // A seek that never completes must not wedge the slot forever.
    const timer = setTimeout(() => { cleanup(); resolve(); }, 4000);

    element.addEventListener('seeked', onSeeked);
    element.addEventListener('error', onError);
    try {
      element.currentTime = time;
    } catch {
      cleanup();
      reject(new Error('seek rejected'));
    }
  });
}
