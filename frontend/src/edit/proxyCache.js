// The editor's half of the preview proxy cache. See ../../../proxyCache.js.
//
// Three jobs, none of them clever:
//
//   * Tell the server what to build and in what order. The order is the point —
//     it is "start where the playhead is and work forwards", which is why the
//     next ten seconds are ready before the rest of the film has been touched.
//   * Poll for what is ready, and say so, so the monitor can swap a source out
//     from under itself and the strip can draw the cached bar.
//   * Do nothing at all in the hosted build, which has no ffmpeg to do it with.
//
// Everything is keyed by project-relative asset path, the same key the probe
// cache and the edit document use.

import { apiFetch, isStatic, SERVER_BASE } from '../client.js';

/** How often to ask while anything is still being built. */
const POLL_MS = 700;

/** And how often when everything the timeline needs is already there. */
const IDLE_POLL_MS = 4000;

// The states a source can be in, each with its own class on the cached bar:
//
//   ready     a preview file exists; this stretch plays and scrubs instantly
//   building  ffmpeg is on it, and the bar crawls
//   none      wanted, not started
//   error     ffmpeg refused; the original is played instead
//   native    needs no preview file (a still)
//   missing   the source is not where the project says it is
//   off       preview files are switched off
//
export function createProxyCache({ onReady, onUpdate, onSettings } = {}) {
  let wanted = [];
  let statuses = new Map();
  let settings = { enabled: !isStatic(), folder: '', height: 360 };
  let timer = null;
  let inFlight = false;
  let stopped = false;
  // Bumped whenever the queue order changes, so a poll that is already out
  // cannot re-post a stale order when it lands.
  let generation = 0;
  let lastSignature = '';

  /** What the cache bar draws, flattened, so a redraw can be skipped. */
  const summarise = (map) => [...map.entries()]
    .map(([assetPath, status]) => `${assetPath}:${status.state}:${Math.round((status.progress || 0) * 20)}`)
    .join('|');

  const schedule = (delay) => {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = null; tick(); }, delay);
  };

  async function tick() {
    if (stopped || inFlight || wanted.length === 0) return;
    if (isStatic()) return;
    inFlight = true;
    const token = generation;

    try {
      const res = await apiFetch('/api/cache/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: wanted })
      });
      if (!res.ok) throw new Error('status failed');
      const data = await res.json();

      if (data.settings) {
        const changed = data.settings.enabled !== settings.enabled
          || data.settings.folder !== settings.folder
          || data.settings.height !== settings.height;
        settings = data.settings;
        if (changed) onSettings?.(settings);
      }

      const landed = [];
      const next = new Map();
      for (const [assetPath, status] of Object.entries(data.results || {})) {
        next.set(assetPath, status);
        if (status.state === 'ready' && statuses.get(assetPath)?.state !== 'ready') {
          landed.push(assetPath);
        }
      }

      // Re-rendering the strip on every poll would be a render a second for
      // nothing; the signature is what the bar actually draws from, so it only
      // fires when the bar would look different.
      const signature = summarise(next);
      const moved = signature !== lastSignature;
      lastSignature = signature;
      // Sources no longer on the timeline drop out of the map rather than
      // lingering as a phantom "ready" for a clip that was deleted.
      statuses = next;
      if (landed.length > 0) onReady?.(landed);
      if (moved) onUpdate?.();

      const missing = wanted.filter(assetPath => statuses.get(assetPath)?.state === 'none');
      const building = wanted.some(assetPath => statuses.get(assetPath)?.state === 'building');

      if (missing.length > 0 && token === generation) {
        // Re-posted every round on purpose: the order changes as the playhead
        // moves, and the server treats each request as a fresh priority list.
        await apiFetch('/api/cache/build', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: missing })
        });
      }

      schedule(missing.length > 0 || building ? POLL_MS : IDLE_POLL_MS);
    } catch {
      // The server going away is not worth a retry storm.
      schedule(IDLE_POLL_MS);
    } finally {
      inFlight = false;
    }
  }

  return {
    /**
     * The sources the timeline needs, nearest the playhead first.
     *
     * Cheap to call often — an unchanged list is ignored, so the caller can
     * hand it the whole ordering every time the playhead crosses a clip
     * boundary without thinking about it.
     */
    setWanted(paths) {
      // Asking for something is what revives a stopped cache. React 19 mounts,
      // unmounts and remounts every component in development, so tying the
      // poller permanently to the first cleanup meant it never polled at all in
      // dev and worked in production — the worst possible split.
      stopped = false;
      const list = [...new Set((paths || []).filter(Boolean))];
      if (list.length === wanted.length && list.every((value, index) => value === wanted[index])) {
        schedule(POLL_MS);
        return;
      }
      wanted = list;
      generation += 1;
      if (timer) { clearTimeout(timer); timer = null; }
      tick();
    },

    stateFor(assetPath) {
      if (!settings.enabled) return 'off';
      return statuses.get(assetPath)?.state || 'none';
    },

    /** The proxy's URL, or null to mean "play the original". */
    urlFor(assetPath) {
      const status = statuses.get(assetPath);
      if (!status || status.state !== 'ready' || !status.url) return null;
      return `${SERVER_BASE}${status.url}`;
    },

    /** After the settings change or the folder is emptied, start over. */
    reset() {
      stopped = false;
      statuses = new Map();
      lastSignature = '';
      generation += 1;
      if (timer) { clearTimeout(timer); timer = null; }
      tick();
    },

    /** Stop polling. Revived by the next setWanted, which is how a remount works. */
    destroy() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}

/**
 * The order to build things in: what is under the playhead, then forwards,
 * then everything behind it.
 *
 * Premiere's rule, and it is the right one — you are about to watch forwards
 * from where you are, so that is what has to exist. What is behind the playhead
 * still gets built, just last, so scrubbing back is warm too by the time you
 * get there.
 */
export function priorityPaths(timeline, playhead) {
  const entries = [];
  for (const entry of timeline.video) {
    if (entry.resolved.path) entries.push({ path: entry.resolved.path, start: entry.start, end: entry.end });
  }
  for (const trackEntry of timeline.audio) {
    for (const entry of trackEntry.clips) {
      if (entry.resolved.path) entries.push({ path: entry.resolved.path, start: entry.start, end: entry.end });
    }
  }

  const rank = (entry) => {
    if (playhead >= entry.start && playhead < entry.end) return -1;  // under the playhead
    if (entry.start >= playhead) return entry.start - playhead;      // ahead, nearest first
    return 1e6 + (playhead - entry.start);                           // behind, nearest first
  };

  return [...new Set(
    entries.sort((a, b) => rank(a) - rank(b)).map(entry => entry.path)
  )];
}

/**
 * The cached bar: one span per stretch of timeline, with the state of the
 * source under it.
 *
 * Runs of the same state are merged so the strip is a few wide bars rather than
 * one per clip — which is what makes it readable at a glance, and what makes it
 * look like the render bar it is imitating.
 */
export function cacheSpans(timeline, stateFor) {
  const spans = [];
  for (const entry of timeline.video) {
    const state = entry.resolved.path ? stateFor(entry.resolved.path) : 'missing';
    const previous = spans[spans.length - 1];
    if (previous && previous.state === state && Math.abs(previous.end - entry.start) < 1e-3) {
      previous.end = entry.end;
      continue;
    }
    spans.push({ start: entry.start, end: entry.end, state });
  }
  return spans;
}
