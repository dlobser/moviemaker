// The timeline strip: a ruler you can click to seek, and the video track.
//
// Read-only for now beyond selection and seeking — dragging and trimming
// arrive in the next pass. Clip geometry comes straight from the resolved
// timeline, so what is drawn here is exactly what the preview plays.

import React, { useMemo } from 'react';

const TRACK_PADDING = 12;

export default function Timeline({
  timeline,
  pixelsPerSecond,
  playhead,
  selectedId,
  onSelect,
  onSeek
}) {
  const width = Math.max(320, timeline.duration * pixelsPerSecond + TRACK_PADDING * 2);
  const ticks = useMemo(
    () => buildTicks(timeline.duration, pixelsPerSecond),
    [timeline.duration, pixelsPerSecond]
  );

  const seekFromEvent = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - bounds.left - TRACK_PADDING;
    onSeek(Math.max(0, x / pixelsPerSecond));
  };

  return (
    <div className="edit-timeline">
      <div className="edit-scroll" style={{ width }}>
        <div className="edit-ruler" onMouseDown={seekFromEvent}>
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

        <span className="edit-track-label">V1 — picture</span>
        <div className="edit-track" onMouseDown={(event) => {
          if (event.target === event.currentTarget) seekFromEvent(event);
        }}>
          {timeline.video.map(entry => (
            <Clip
              key={entry.clip.id}
              entry={entry}
              pixelsPerSecond={pixelsPerSecond}
              selected={entry.clip.id === selectedId}
              onSelect={onSelect}
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

        <div
          className="edit-playhead"
          style={{ left: TRACK_PADDING + playhead * pixelsPerSecond }}
        />
      </div>
    </div>
  );
}

function Clip({ entry, pixelsPerSecond, selected, onSelect }) {
  const width = Math.max(4, entry.length * pixelsPerSecond);
  const kindClass = entry.resolved.kind === 'image'
    ? 'is-image'
    : entry.resolved.kind === 'missing' ? 'is-missing' : '';

  const trimmed = entry.clip.out !== null && entry.clip.out !== undefined;

  return (
    <div
      className={`edit-clip ${kindClass} ${selected ? 'selected' : ''}`}
      style={{ left: TRACK_PADDING + entry.start * pixelsPerSecond, width }}
      onMouseDown={(event) => { event.stopPropagation(); onSelect(entry.clip.id); }}
      title={`${entry.resolved.name}\n${entry.resolved.path || 'no media'}\n${entry.length.toFixed(2)}s`}
    >
      <span className="edit-clip-name">{entry.resolved.name}</span>
      <span className="edit-clip-meta">
        {entry.length.toFixed(2)}s
        {trimmed ? ` · ${entry.in.toFixed(1)}–${entry.out.toFixed(1)}` : ''}
        {entry.resolved.kind === 'image' ? ' · still' : ''}
      </span>
      {entry.stale && <span className="edit-clip-badge">source changed</span>}
      {entry.resolved.kind === 'missing' && <span className="edit-clip-badge">no media</span>}
    </div>
  );
}

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
