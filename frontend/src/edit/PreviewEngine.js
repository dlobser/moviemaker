// Timeline playback.
//
// A pool of video elements takes turns. The one under the playhead is drawn to
// a canvas every frame; neighbouring clips are loaded and seeked on spare
// elements well before they are needed, so a cut costs nothing at the boundary
// and a dissolve has both halves already running.
//
// Two rules keep the picture up, and both exist because breaking either one
// looks exactly like "the preview is broken":
//
//   * Never clear the canvas unless there is something to put on it. Pointing a
//     video element at a file costs about 100ms before there is a frame to
//     draw, and clearing first turned every one of those into a black flash —
//     over half the frames of a fast scrub. Holding the previous frame until
//     the next one decodes is what every NLE does, and it is not a compromise.
//   * Never make the clip under the playhead wait for a slot. Slots are claimed
//     by preferring one that already holds the same *file* (free), then an idle
//     one, then whatever the playhead is furthest from. The old "protect these
//     four clips" rule could, with a pool of three, refuse a slot to the very
//     clip being drawn — and then the picture was gone until you moved again.
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
import { AudioScheduler } from './AudioScheduler.js';

/**
 * How many video elements to keep.
 *
 * Sized so the clip under the playhead, one dissolving into it, and two
 * neighbours either side can all be loaded at once with room to spare. Three
 * was fewer than the draw loop wanted warm, so scrubbing spent its time
 * evicting and reloading the same handful of files.
 */
const SLOT_COUNT = 8;

/** Past this much drift, seek. Below it, nudge the rate instead. */
const HARD_CORRECT = 0.25;
const SOFT_CORRECT = 0.08;

/** A seek that has produced no `seeked` event after this long is wedged. */
const SEEK_WATCHDOG_MS = 1500;

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

    // Audio tracks cannot use media elements: several overlap, they need exact
    // start times, and element clocks drift. They get decoded buffers scheduled
    // against the same clock instead.
    this.scheduler = new AudioScheduler({
      audioContext: this.audio,
      destination: this.master,
      resolveUrl: this.resolveUrl
    });

    this.slots = Array.from({ length: SLOT_COUNT }, () => this.createSlot());
    // False until anything has ever been drawn, which is the only moment a
    // black canvas is the honest answer rather than a dropped frame.
    this.hasPainted = false;
    this.images = new Map();   // asset path -> HTMLImageElement
    this.urls = new Map();     // asset path -> object/http url
    // Sources whose URL changed under us — a preview proxy finished building.
    // Swapping one mid-play would drop a frame at a moment nobody asked for it,
    // so they are held until the transport next stops.
    this.pendingRefresh = new Set();
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

    const slot = {
      element,
      gain,
      path: null,
      clipId: null,
      ready: false,
      // Coalesced seeking: at most one currentTime assignment in flight per
      // element, latest requested target wins. Raw assignments every rAF tick
      // piled up aborted seeks and froze the picture during a scrub.
      seekTarget: null,
      seeking: false,
      seekIssuedAt: 0,
      // Whether this element has ever decoded a frame. Once it has, it can be
      // drawn at any time — including mid-seek, when `readyState` briefly
      // reports HAVE_METADATA but the previous frame is still perfectly good.
      hasFrame: false,
      // Generation token: a superseded loadInto must never mark the slot
      // ready with stale content (the AudioScheduler pattern).
      loadToken: 0
    };
    // One persistent listener; seekElement's own temporary listeners coexist.
    element.addEventListener('seeked', () => this.onSlotSeeked(slot));
    return slot;
  }

  /**
   * Latest-target-wins seek. Never more than one in-flight seek per element:
   * if one is already running, the target is parked and the `seeked` handler
   * chases it.
   */
  requestSeek(slot, mediaTime) {
    slot.seekTarget = mediaTime;
    if (slot.seeking) return;                 // seeked handler re-issues
    if (slot.element.readyState < 1) return;  // no metadata yet; loadInto path handles it
    slot.seeking = true;
    const target = slot.seekTarget;
    slot.seekTarget = null;
    slot.seekIssuedAt = performance.now();
    try {
      slot.element.currentTime = target;
    } catch {
      slot.seeking = false;
    }
  }

  onSlotSeeked(slot) {
    slot.seeking = false;
    if (slot.seekTarget !== null) {
      const next = slot.seekTarget;
      slot.seekTarget = null;
      this.requestSeek(slot, next);           // pointer moved on; chase it
    }
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
    this.scheduler.setTimeline(timeline);
    // Edits pause playback first, so this is the rare case of the document
    // changing mid-play; rebuilding the schedule is cheaper than reasoning
    // about which scheduled sources are still correct.
    if (this.playing) this.scheduler.start(this.now());
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

  /**
   * A source now resolves to something better than what we loaded.
   *
   * The one caller is the proxy cache: a full-resolution clip has finished
   * transcoding into something that actually seeks, and the slot holding the
   * original should pick it up. Deferred while playing — a reload is a black
   * frame, and one arriving unbidden mid-take is worse than waiting.
   */
  refreshSources(paths) {
    for (const path of paths || []) this.pendingRefresh.add(path);
    if (!this.playing) this.flushRefresh();
  }

  flushRefresh() {
    if (this.pendingRefresh.size === 0) return;
    for (const path of this.pendingRefresh) {
      const url = this.urls.get(path);
      if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
      this.urls.delete(path);
      this.images.delete(path);
      for (const slot of this.slots) {
        if (slot.path !== path) continue;
        // Forcing the slot cold is what makes the next draw reload it; the
        // token bump stops an in-flight load marking the old media ready.
        slot.loadToken += 1;
        slot.path = null;
        slot.clipId = null;
        slot.ready = false;
      }
      this.scheduler.forget(path);
    }
    this.pendingRefresh.clear();
    if (!this.playing) this.drawAt(this.playhead);
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

  /**
   * A slot to put this clip's media in.
   *
   * The order of preference is the whole performance story. Reusing a slot that
   * already holds the same *file* costs nothing — no `src` assignment, none of
   * the ~100ms before there is a frame — and it is a common case: the two
   * halves of a split clip, or one take used twice, are one file. Everything
   * below that costs a reload, so the last resort gives up whatever the
   * playhead is furthest from.
   *
   * `onScreen` is only ever the one or two clips actually being drawn. Anything
   * broader risks refusing a slot to the clip you are looking at.
   */
  claimSlot(entry, onScreen = []) {
    const sameClip = this.slots.find(slot => slot.clipId === entry.clip.id);
    if (sameClip) return sameClip;

    const path = entry.resolved.path;
    const samePath = path && this.slots.find(slot => (
      slot.path === path && !onScreen.includes(slot.clipId)
    ));
    if (samePath) return samePath;

    const idle = this.slots.find(slot => !slot.clipId);
    if (idle) return idle;

    let worst = null;
    let worstDistance = -1;
    for (const slot of this.slots) {
      if (onScreen.includes(slot.clipId)) continue;
      const distance = this.slotDistance(slot);
      if (distance > worstDistance) {
        worstDistance = distance;
        worst = slot;
      }
    }
    return worst;
  }

  /** How far the playhead is from a clip, in seconds; 0 while it is inside it. */
  distanceOf(entry) {
    if (!entry) return Infinity;
    const time = this.playing ? this.now() : this.playhead;
    if (time >= entry.start && time < entry.end) return 0;
    return time < entry.start ? entry.start - time : time - entry.end;
  }

  /** The same, for whatever a slot is currently holding. */
  slotDistance(slot) {
    if (!slot.clipId) return Infinity;
    return this.distanceOf(this.timeline?.video.find(entry => entry.clip.id === slot.clipId));
  }

  async loadInto(slot, entry) {
    const path = entry.resolved.path;
    if (slot.clipId === entry.clip.id && slot.path === path) return slot;

    // Overlapping loads race on the shared slots; the token makes sure only
    // the newest load can mark the slot ready (a stale seekElement resolve —
    // its 4s timeout included — becomes harmless).
    const token = ++slot.loadToken;
    slot.clipId = entry.clip.id;
    slot.ready = false;
    // Only a new file invalidates the decoded frame; retargeting a slot to
    // another clip of the same source keeps it, which is the point of doing so.
    if (slot.path !== entry.resolved.path) slot.hasFrame = false;
    slot.seekTarget = null;
    slot.seeking = false;

    if (slot.path !== path) {
      const url = await this.urlFor(path);
      if (token !== slot.loadToken) return slot;
      if (!url) return slot;
      slot.path = path;
      slot.element.src = url;
    }

    try {
      await seekElement(slot.element, entry.in);
      if (token === slot.loadToken) slot.ready = true;
    } catch {
      if (token === slot.loadToken) slot.ready = false;
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
    this.scheduler.start(this.playhead);
    this.onStateChange({ playing: true });
  }

  pause() {
    if (!this.playing) return;
    this.playhead = this.now();
    this.playing = false;
    this.scheduler.stop();
    for (const slot of this.slots) slot.element.pause();
    this.onStateChange({ playing: false });
    // Proxies that landed while the film was running get picked up now.
    this.flushRefresh();
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
      // Scheduled buffers are pinned to absolute times, so a seek has to throw
      // them away and lay the whole schedule down again from the new position.
      this.scheduler.start(this.playhead);
    } else {
      this.scheduler.stop();
      for (const slot of this.slots) slot.element.pause();
      // No explicit draw: the always-on rAF loop lands the frame, and
      // syncSlot's paused drift rule issues the coalesced seek.
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

    // Genuinely nothing here — past the end, or an empty timeline.
    if (!current) {
      this.clearToBlack();
      this.idleSlots();
      return;
    }

    // A clip pointing at nothing renders black, so it has to preview black too.
    // Holding the previous clip's frame over it is the one case where holding
    // would lie about what the export is going to contain.
    if (current.resolved.kind === 'missing' && !incoming) {
      this.clearToBlack();
      this.mixAudio(current, 1, null, 0);
      this.preload(current, [current.clip.id]);
      return;
    }

    // Only what is being drawn is untouchable. Neighbours are warmed on a
    // best-effort basis and can always give their slot up.
    const onScreen = [current.clip.id, incoming?.clip.id].filter(Boolean);

    this.syncSlot(current, time, onScreen);
    if (incoming) this.syncSlot(incoming, time, onScreen);

    const currentFrame = this.frameFor(current);
    const incomingFrame = incoming ? this.frameFor(incoming) : null;

    if (currentFrame || incomingFrame) {
      const paint = this.context2d;
      paint.globalAlpha = 1;
      paint.fillStyle = '#000';
      paint.fillRect(0, 0, this.canvas.width, this.canvas.height);

      if (currentFrame) {
        paint.globalAlpha = 1;
        drawFitted(paint, currentFrame.source, currentFrame.width, currentFrame.height, this.canvas);
      }
      if (incomingFrame) {
        paint.globalAlpha = Math.max(0, Math.min(1, mix));
        drawFitted(paint, incomingFrame.source, incomingFrame.width, incomingFrame.height, this.canvas);
      }

      this.paintDip(current, incoming, time);
      paint.globalAlpha = 1;
      this.hasPainted = true;
    } else if (!this.hasPainted) {
      // Nothing has ever been drawable, so there is no previous frame to hold.
      this.clearToBlack();
    }
    // Otherwise the last good frame stays up while the next one loads.

    if (incoming) this.mixAudio(current, 1 - mix, incoming, mix);
    else this.mixAudio(current, 1, null, 0);

    this.preload(current, onScreen);
  }

  clearToBlack() {
    const paint = this.context2d;
    paint.globalAlpha = 1;
    paint.fillStyle = '#000';
    paint.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.hasPainted = false;
  }

  /** Get the right media onto a slot and keep it in step with the clock. */
  syncSlot(entry, time, onScreen = []) {
    if (entry.resolved.kind === 'image' || entry.resolved.kind === 'missing') return;

    const slot = this.claimSlot(entry, onScreen);
    if (!slot) return;
    if (slot.clipId !== entry.clip.id || slot.path !== entry.resolved.path) {
      this.loadInto(slot, entry);
      return;
    }
    // Nothing decoded yet — no frame to show and no point steering. Note this
    // is `hasFrame`, not `readyState`: an element mid-seek reports
    // HAVE_METADATA, and refusing to steer it then is how a scrub used to fight
    // itself.
    if (!slot.hasFrame && slot.element.readyState < 2) return;
    if (slot.element.readyState >= 2) slot.hasFrame = true;

    // A wedged seek (seeking to exactly `duration` never fires `seeked` in
    // most browsers) must not freeze the slot forever.
    if (slot.seeking && performance.now() - slot.seekIssuedAt > SEEK_WATCHDOG_MS) {
      console.warn('[preview] seek watchdog fired; retrying');
      slot.seeking = false;
    }

    // Correcting drift against a seek that has not landed just fights it, but
    // transport still applies: gating playback on the seek promise is what
    // strands a clip paused on its first frame when the event never arrives.
    if (slot.ready) {
      const expected = entry.in + (time - entry.start);
      const drift = expected - slot.element.currentTime;

      if (!this.playing) {
        // Paused: land on the exact frame. Half a frame of tolerance stops
        // re-seek churn once we are there.
        const frame = 1 / (this.timeline?.settings?.fps || 24);
        if (!slot.seeking && Math.abs(drift) > frame / 2) this.requestSeek(slot, expected);
        slot.element.playbackRate = 1;
      } else if (Math.abs(drift) > HARD_CORRECT) {
        this.requestSeek(slot, expected);
        slot.element.playbackRate = 1;
      } else if (Math.abs(drift) > SOFT_CORRECT) {
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

  /**
   * What there is to draw for this entry right now, or null.
   *
   * Asking is the same act as starting: a still that has not been fetched yet
   * kicks off its own load on the way past. Separating "is there a frame" from
   * "paint it" is what lets the caller decide to hold the last one instead of
   * clearing to black.
   */
  frameFor(entry) {
    if (entry.resolved.kind === 'missing') return null;

    if (entry.resolved.kind === 'image') {
      const image = this.images.get(entry.resolved.path);
      if (image?.complete && image.naturalWidth) {
        return { source: image, width: image.naturalWidth, height: image.naturalHeight };
      }
      this.imageFor(entry.resolved.path);
      return null;
    }

    const slot = this.slots.find(candidate => candidate.clipId === entry.clip.id);
    const element = slot?.element;
    if (!element) return null;

    // `readyState >= 2` is the wrong question, and asking it was the single
    // biggest cause of a black preview. Assigning `currentTime` drops an
    // element to HAVE_METADATA for a few milliseconds while it decodes the new
    // frame -- so during a scrub, which seeks on every tick, the answer was
    // "not ready" almost every frame even though the element was sitting there
    // holding a perfectly good picture. What matters is whether it has ever
    // decoded a frame; after that `drawImage` always produces one.
    if (element.readyState >= 2) slot.hasFrame = true;
    if (slot.hasFrame && element.videoWidth) {
      return { source: element, width: element.videoWidth, height: element.videoHeight };
    }
    return null;
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

  /**
   * Level the picture clips' own soundtracks.
   *
   * A clip whose audio has been detached is silent here — the copy on the audio
   * track is the one you hear. Soloing any audio track also drops picture
   * audio, since a solo you can still hear other things over is not a solo.
   */
  mixAudio(current, currentGain, incoming, incomingGain) {
    const when = this.audio.currentTime;
    const soloed = Boolean(this.timeline?.anySolo);

    for (const slot of this.slots) {
      let gain = 0;
      if (current && slot.clipId === current.clip.id) {
        gain = current.clip.audio?.detached ? 0 : currentGain * (current.clip.audio?.gain ?? 1);
      } else if (incoming && slot.clipId === incoming.clip.id) {
        gain = incoming.clip.audio?.detached ? 0 : incomingGain * (incoming.clip.audio?.gain ?? 1);
      }
      if (soloed) gain = 0;
      slot.gain.gain.setTargetAtTime(this.playing ? gain : 0, when, 0.02);
    }
  }

  /**
   * Keep the spare slots holding the neighbours — the next clip AND the
   * previous one, so scrubbing backwards across a cut is as warm as playing
   * forwards through it. Next wins the slot tiebreak (it is warmed first).
   *
   * There is no lead-time window: a spare slot has nothing else to do, so
   * loading the moment the current clip starts gives a full clip's worth of
   * head start. A fixed window was too tight — a clip that had not finished
   * fetching by its own cut point started late and then had to be yanked into
   * place by drift correction.
   */
  preload(current, onScreen = []) {
    const warm = (entry) => {
      if (!entry || entry.resolved.kind === 'missing') return;
      if (entry.resolved.kind === 'image') {
        this.imageFor(entry.resolved.path);
        return;
      }
      const slot = this.claimSlot(entry, onScreen);
      if (!slot || slot.clipId === entry.clip.id) return;
      // Never evict something nearer the playhead than the thing being warmed.
      // Two neighbours taking turns to throw each other out is worse than
      // neither of them being warm.
      if (slot.clipId && this.slotDistance(slot) <= this.distanceOf(entry)) return;
      this.loadInto(slot, entry);
    };
    // Nearest first, so it wins the slot when only one is going spare.
    warm(this.timeline.video[current.index + 1]);
    warm(this.timeline.video[current.index - 1]);
    warm(this.timeline.video[current.index + 2]);
    warm(this.timeline.video[current.index - 2]);
  }

  idleSlots() {
    for (const slot of this.slots) {
      if (!slot.element.paused) slot.element.pause();
      slot.gain.gain.setTargetAtTime(0, this.audio.currentTime, 0.02);
    }
  }

  destroy() {
    this.destroyed = true;
    this.scheduler.destroy();
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
