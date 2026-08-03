// The timeline strip: a ruler you can click to seek, the picture track, and
// however many audio tracks the edit has.
//
// All the drags — move, trim head, trim tail, on picture or on sound — go
// through one pointer handler. The edit document is updated on every
// pointermove rather than only on release, which is what makes smart mode
// legible: you watch the rest of the sequence close up or push along as you go,
// instead of guessing and finding out on drop.
//
// The one exception is the clip being moved. Committing the move each frame
// reflows it to its snapped-in position, so it would jump out from under the
// cursor; it is drawn at the pointer instead while the others rearrange
// underneath it.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link2, Link2Off, Volume2, VolumeX, Headphones, Trash2 } from 'lucide-react';

const TRACK_PADDING = 12;

/** Grab zone at each end of a clip, in pixels. */
const HANDLE_WIDTH = 9;

/** Edges within this many pixels of another edge snap to it. */
const SNAP_PIXELS = 7;

export default function Timeline({
  timeline,
  pixelsPerSecond,
  timeStore,
  selection,
  smart,
  onSelect,
  onSeek,
  onScrubStart,
  onMoveClip,
  onTrimClip,
  onMoveAudioClip,
  onTrimAudioClip,
  onTrackField,
  onRemoveTrack
}) {
  const trackRef = useRef(null);
  const dragRef = useRef(null);
  const [dragging, setDragging] = useState(null);
  // Scrub coalescing: the latest pointer time, flushed at most once per rAF —
  // genuinely latest-wins, however fast the pointer moves.
  const scrubTimeRef = useRef(0);
  const scrubFrameRef = useRef(null);

  const width = Math.max(320, timeline.duration * pixelsPerSecond + TRACK_PADDING * 2);
  const ticks = useMemo(
    () => buildTicks(timeline.duration, pixelsPerSecond),
    [timeline.duration, pixelsPerSecond]
  );

  const timeAt = useCallback((clientX) => {
    const bounds = trackRef.current?.getBoundingClientRect();
    if (!bounds) return 0;
    return Math.max(0, (clientX - bounds.left - TRACK_PADDING) / pixelsPerSecond);
  }, [pixelsPerSecond]);

  /** Edges worth snapping to: every other clip's boundaries, zero, playhead.
      The playhead is read from the store at call time — closing over it as a
      prop re-registered the drag listeners mid-gesture every frame. */
  const snapTargets = useCallback((exceptId) => {
    const targets = [0, timeStore.get()];
    for (const entry of timeline.video) {
      if (entry.clip.id === exceptId) continue;
      targets.push(entry.start, entry.end);
    }
    for (const trackEntry of timeline.audio) {
      for (const entry of trackEntry.clips) {
        if (entry.clip.id === exceptId) continue;
        targets.push(entry.start, entry.end);
      }
    }
    return targets;
  }, [timeline.video, timeline.audio, timeStore]);

  const snap = useCallback((value, exceptId) => {
    const tolerance = SNAP_PIXELS / pixelsPerSecond;
    let best = value;
    let bestGap = tolerance;
    for (const target of snapTargets(exceptId)) {
      const gap = Math.abs(target - value);
      if (gap < bestGap) { best = target; bestGap = gap; }
    }
    return best;
  }, [snapTargets, pixelsPerSecond]);

  const startDrag = (event, entry, mode, kind) => {
    event.preventDefault();
    event.stopPropagation();
    onSelect({ kind, id: entry.clip.id });

    const pointerTime = timeAt(event.clientX);
    dragRef.current = {
      mode,
      kind,
      clipId: entry.clip.id,
      grabOffset: pointerTime - entry.start,
      originIn: entry.in,
      originOut: entry.out,
      originStart: entry.start,
      originEnd: entry.end
    };
    setDragging({ clipId: entry.clip.id, mode, kind, start: entry.start });
    // Capture is a nicety — the window listeners below are what actually keep
    // the drag alive — so a browser refusing it must not abort the gesture.
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch { /* not capturable; window listeners still cover it */ }
  };

  useEffect(() => {
    if (!dragging) return undefined;

    const onMove = (event) => {
      const drag = dragRef.current;
      if (!drag) return;
      const pointerTime = timeAt(event.clientX);

      if (drag.mode === 'scrub') {
        // Park the latest pointer time and flush once per frame: the rAF
        // callback reads the ref, so a fast drag coalesces to latest-wins
        // rather than queueing a seek per pointermove.
        scrubTimeRef.current = pointerTime;
        if (scrubFrameRef.current === null) {
          scrubFrameRef.current = requestAnimationFrame(() => {
            scrubFrameRef.current = null;
            onSeek(scrubTimeRef.current);
          });
        }
        return;
      }

      const move = drag.kind === 'audio' ? onMoveAudioClip : onMoveClip;
      const trim = drag.kind === 'audio' ? onTrimAudioClip : onTrimClip;

      if (drag.mode === 'move') {
        const raw = pointerTime - drag.grabOffset;
        const start = Math.max(0, event.altKey ? raw : snap(raw, drag.clipId));
        setDragging(previous => (previous ? { ...previous, start } : previous));
        move(drag.clipId, start);
        return;
      }

      const edge = event.altKey ? pointerTime : snap(pointerTime, drag.clipId);
      if (drag.mode === 'trim-in') {
        trim(drag.clipId, 'in', drag.originIn + (edge - drag.originStart));
      } else {
        trim(drag.clipId, 'out', drag.originOut + (edge - drag.originEnd));
      }
    };

    const onUp = () => {
      dragRef.current = null;
      setDragging(null);
      if (scrubFrameRef.current !== null) {
        cancelAnimationFrame(scrubFrameRef.current);
        scrubFrameRef.current = null;
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragging, timeAt, snap, onSeek, onMoveClip, onTrimClip, onMoveAudioClip, onTrimAudioClip]);

  /**
   * Ruler-drag scrubbing — the standard NLE gesture. Down seeks immediately
   * and arms the same window listeners the clip drags use; the picture then
   * follows the pointer until release. Scrubbing pauses playback (arrow-key
   * stepping deliberately does not).
   */
  const startScrub = (event) => {
    if (dragRef.current) return;
    event.preventDefault();
    dragRef.current = { mode: 'scrub' };
    setDragging({ mode: 'scrub' });
    onScrubStart?.();
    onSeek(timeAt(event.clientX));
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch { /* not capturable; window listeners still cover it */ }
  };

  const overrideFor = (clipId) => (
    dragging?.mode === 'move' && dragging.clipId === clipId ? dragging.start : null
  );

  return (
    <div className={`edit-timeline ${dragging ? `is-dragging mode-${dragging.mode}` : ''}`}>
      <div className="edit-scroll" style={{ width }}>
        <div className="edit-ruler" onPointerDown={startScrub}>
          {ticks.map(tick => (
            <span
              key={tick.time}
              className="edit-ruler-tick"
              style={{ left: TRACK_PADDING + tick.time * pixelsPerSecond }}
            >
              {tick.label}
            </span>
          ))}
        </div>

        <div className="edit-track-head">
          <span className="edit-track-label">V1 — picture{smart ? '' : ' · free'}</span>
        </div>

        <div
          className="edit-track"
          ref={trackRef}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) startScrub(event);
          }}
        >
          {timeline.video.map(entry => (
            <Clip
              key={entry.clip.id}
              entry={entry}
              kind="video"
              pixelsPerSecond={pixelsPerSecond}
              selected={selection?.kind === 'video' && selection.id === entry.clip.id}
              overrideStart={overrideFor(entry.clip.id)}
              dragging={dragging?.clipId === entry.clip.id}
              onStartDrag={startDrag}
            />
          ))}

          {timeline.video.map(entry => (
            entry.transition ? (
              <div
                key={`${entry.clip.id}_t`}
                className={`edit-transition ${entry.transition.type}`}
                style={{
                  left: TRACK_PADDING + entry.start * pixelsPerSecond,
                  width: Math.max(3, entry.transition.duration * pixelsPerSecond)
                }}
                title={`${entry.transition.type} ${entry.transition.duration.toFixed(2)}s`}
              />
            ) : null
          ))}
        </div>

        {timeline.audio.map((trackEntry, index) => (
          <React.Fragment key={trackEntry.track.id}>
            <TrackHead
              track={trackEntry.track}
              index={index}
              anySolo={timeline.anySolo}
              onField={onTrackField}
              onRemove={onRemoveTrack}
            />
            <div
              className="edit-track is-audio"
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) startScrub(event);
              }}
            >
              {trackEntry.clips.map(entry => (
                <Clip
                  key={entry.clip.id}
                  entry={entry}
                  kind="audio"
                  pixelsPerSecond={pixelsPerSecond}
                  selected={selection?.kind === 'audio' && selection.id === entry.clip.id}
                  overrideStart={overrideFor(entry.clip.id)}
                  dragging={dragging?.clipId === entry.clip.id}
                  onStartDrag={startDrag}
                />
              ))}
            </div>
          </React.Fragment>
        ))}

        <PlayheadMarker store={timeStore} pixelsPerSecond={pixelsPerSecond} />
      </div>
    </div>
  );
}

/**
 * The playhead line, off the React render path: subscribes to the time store
 * and writes a transform directly, quantized to whole pixels so a sub-pixel
 * time change costs nothing.
 */
function PlayheadMarker({ store, pixelsPerSecond }) {
  const ref = useRef(null);

  useEffect(() => {
    let lastPx = null;
    const write = (time) => {
      const px = Math.round(TRACK_PADDING + time * pixelsPerSecond);
      if (px === lastPx || !ref.current) return;
      lastPx = px;
      ref.current.style.transform = `translateX(${px}px)`;
    };
    write(store.get());
    return store.subscribe(write);
  }, [store, pixelsPerSecond]);

  return <div ref={ref} className="edit-playhead" style={{ left: 0 }} />;
}

function TrackHead({ track, index, anySolo, onField, onRemove }) {
  const dimmed = anySolo && !track.solo;
  return (
    <div className={`edit-track-head ${dimmed ? 'is-dimmed' : ''}`}>
      <span className="edit-track-label">A{index + 1} — {track.name}</span>

      <button
        className={`edit-mini ${track.muted ? 'on' : ''}`}
        onClick={() => onField(track.id, { muted: !track.muted })}
        title={track.muted ? 'Unmute' : 'Mute'}
      >
        {track.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
      </button>
      <button
        className={`edit-mini ${track.solo ? 'on' : ''}`}
        onClick={() => onField(track.id, { solo: !track.solo })}
        title="Solo"
      >
        <Headphones size={12} />
      </button>

      <input
        className="edit-fader"
        type="range"
        min="0"
        max="1.5"
        step="0.01"
        value={track.gain}
        onChange={(event) => onField(track.id, { gain: Number(event.target.value) })}
        title={`Level ${Math.round(track.gain * 100)}%`}
      />
      <span className="edit-track-db">{Math.round(track.gain * 100)}%</span>

      <button className="edit-mini" onClick={() => onRemove(track.id)} title="Delete this track">
        <Trash2 size={12} />
      </button>
    </div>
  );
}

// Memoized: during playback and scrubbing its props are now stable (time
// updates no longer render the Timeline at all), and during a drag only the
// dragged clip's props change.
const Clip = React.memo(function Clip({ entry, kind, pixelsPerSecond, selected, overrideStart, dragging, onStartDrag }) {
  const width = Math.max(4, entry.length * pixelsPerSecond);
  const start = overrideStart === null || overrideStart === undefined ? entry.start : overrideStart;
  const isAudio = kind === 'audio';

  const kindClass = isAudio
    ? 'is-audio'
    : entry.resolved.kind === 'image'
      ? 'is-image'
      : entry.resolved.kind === 'missing' ? 'is-missing' : '';

  const trimmed = entry.clip.out !== null && entry.clip.out !== undefined;
  // Handles need room to sit inside; below that a clip is move-only.
  const roomForHandles = width > HANDLE_WIDTH * 3;
  const linked = isAudio && Boolean(entry.clip.link);

  return (
    <div
      className={`edit-clip ${kindClass} ${selected ? 'selected' : ''} ${dragging ? 'is-dragging' : ''}`}
      style={{ left: TRACK_PADDING + start * pixelsPerSecond, width }}
      onPointerDown={(event) => onStartDrag(event, entry, 'move', kind)}
      title={`${entry.resolved.name}\n${entry.resolved.path || 'no media'}\n${entry.length.toFixed(2)}s`}
    >
      {roomForHandles && (
        <span
          className="edit-handle left"
          onPointerDown={(event) => onStartDrag(event, entry, 'trim-in', kind)}
          title="Trim the head"
        />
      )}

      <span className="edit-clip-name">
        {linked && <Link2 size={9} style={{ verticalAlign: '-1px', marginRight: 3 }} />}
        {entry.resolved.name}
      </span>
      <span className="edit-clip-meta">
        {entry.length.toFixed(2)}s
        {trimmed ? ` · ${entry.in.toFixed(1)}–${entry.out.toFixed(1)}` : ''}
        {!isAudio && entry.resolved.kind === 'image' ? ' · still' : ''}
        {isAudio ? ` · ${Math.round((entry.gain ?? 1) * 100)}%` : ''}
      </span>

      {entry.stale && <span className="edit-clip-badge">source changed</span>}
      {entry.resolved.kind === 'missing' && <span className="edit-clip-badge">no media</span>}
      {!isAudio && entry.clip.audio?.detached && (
        <span className="edit-clip-badge muted"><Link2Off size={9} /> audio out</span>
      )}

      {roomForHandles && (
        <span
          className="edit-handle right"
          onPointerDown={(event) => onStartDrag(event, entry, 'trim-out', kind)}
          title="Trim the tail"
        />
      )}
    </div>
  );
});

/** Round tick spacing to something readable at the current zoom. */
function buildTicks(duration, pixelsPerSecond) {
  if (duration <= 0) return [];
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = candidates.find(value => value * pixelsPerSecond >= 60) || 600;

  const ticks = [];
  for (let time = 0; time <= duration; time += step) {
    ticks.push({ time, label: formatTick(time) });
  }
  return ticks;
}

function formatTick(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  const whole = Number.isInteger(rest) ? String(rest).padStart(2, '0') : rest.toFixed(1).padStart(4, '0');
  return `${minutes}:${whole}`;
}
