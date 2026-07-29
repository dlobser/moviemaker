// The editor. Takes over the window so it cannot crowd the creation UI, and
// owns nothing permanent — the edit document lives in App state and autosaves
// with the rest of the project.
//
// Everything it draws derives from `buildTimeline`, so the picture, the strip
// and (later) the render all describe the same cut.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Play, Pause, SkipBack, ZoomIn, ZoomOut, RefreshCw, Wand2, Plus
} from 'lucide-react';

import { resolveAssetUrl } from '../client.js';
import {
  collectSourcePaths,
  createVideoClip,
  deriveVideoClips,
  pickDefaultSettings
} from './model.js';
import { makeContext, normalize, buildTimeline, setSmart } from './timing.js';
import { probeMissing } from './durations.js';
import { PreviewEngine } from './PreviewEngine.js';
import Timeline from './Timeline.jsx';
import './edit.css';

const ZOOM_STEPS = [2, 4, 8, 16, 32, 64, 128];

export default function EditView({ scenes, edit, setEdit, videoDuration, onClose }) {
  const canvasRef = useRef(null);
  const engineRef = useRef(null);

  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [zoom, setZoom] = useState(16);
  const [probing, setProbing] = useState(false);

  const ctx = useMemo(
    () => makeContext(scenes, edit.durations, Number(videoDuration) || 5),
    [scenes, edit.durations, videoDuration]
  );
  const timeline = useMemo(() => buildTimeline(edit, ctx), [edit, ctx]);

  // Shots that have something to show but are not in the edit yet. Surfaced as
  // a count rather than appended silently — a clip you deleted on purpose
  // should stay deleted.
  const unplaced = useMemo(() => {
    const placed = new Set(
      edit.video.map(clip => clip.source?.shotId).filter(Boolean)
    );
    return (scenes || []).flatMap(scene => (scene.shots || []).filter(shot =>
      (shot.selectedVideo || shot.selectedImage) && !placed.has(shot.id)
    ));
  }, [scenes, edit.video]);

  // --- measurement ----------------------------------------------------------

  const sourcePaths = useMemo(() => collectSourcePaths(edit, scenes), [edit, scenes]);
  const pathKey = sourcePaths.join('|');

  useEffect(() => {
    let cancelled = false;
    const unmeasured = sourcePaths.filter(path => !edit.durations[path]);
    if (unmeasured.length === 0) return undefined;

    setProbing(true);
    probeMissing(unmeasured, edit.durations)
      .then(fresh => {
        if (cancelled || Object.keys(fresh).length === 0) return;
        setEdit(previous => {
          const durations = { ...previous.durations, ...fresh };
          const settings = previous.settings.resolutionAuto
            ? pickDefaultSettings(collectSourcePaths(previous, scenes), durations, previous.settings)
            : previous.settings;
          return normalize(
            { ...previous, durations, settings },
            makeContext(scenes, durations, Number(videoDuration) || 5)
          );
        });
      })
      .finally(() => { if (!cancelled) setProbing(false); });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathKey]);

  // --- first run ------------------------------------------------------------

  // The project state arrives asynchronously, so this cannot be a mount-only
  // effect — on the first pass `scenes` is still empty. It waits for shots to
  // show up, fills an empty timeline once, and then stays out of the way so a
  // deliberately emptied edit is not repopulated behind the user's back.
  const autoPopulated = useRef(false);
  useEffect(() => {
    if (autoPopulated.current) return;
    if (edit.video.length > 0) { autoPopulated.current = true; return; }
    const clips = deriveVideoClips(scenes);
    if (clips.length === 0) return;
    autoPopulated.current = true;
    setEdit(previous => normalize({ ...previous, video: clips }, ctx));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenes]);

  // --- the engine -----------------------------------------------------------

  useEffect(() => {
    if (!canvasRef.current) return undefined;
    const engine = new PreviewEngine({
      canvas: canvasRef.current,
      resolveUrl: resolveAssetUrl,
      onTime: setPlayhead,
      onStateChange: ({ playing: next }) => setPlaying(next)
    });
    engineRef.current = engine;
    if (import.meta.env.DEV) window.__mmEngine = engine;
    return () => {
      engineRef.current = null;
      engine.destroy();
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setTimeline(timeline);
  }, [timeline]);

  const seek = useCallback((time) => {
    engineRef.current?.seek(time);
    setPlayhead(Math.max(0, Math.min(time, timeline.duration)));
  }, [timeline.duration]);

  const togglePlay = useCallback(() => { engineRef.current?.toggle(); }, []);

  // --- keyboard -------------------------------------------------------------

  useEffect(() => {
    const onKey = (event) => {
      if (event.target.matches?.('input, textarea, select')) return;
      if (event.key === ' ') { event.preventDefault(); togglePlay(); }
      else if (event.key === 'ArrowLeft') seek(playhead - (event.shiftKey ? 1 : 1 / 24));
      else if (event.key === 'ArrowRight') seek(playhead + (event.shiftKey ? 1 : 1 / 24));
      else if (event.key === 'Home') seek(0);
      else if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playhead, seek, togglePlay, onClose]);

  // --- actions --------------------------------------------------------------

  const appendUnplaced = () => {
    if (unplaced.length === 0) return;
    setEdit(previous => normalize({
      ...previous,
      video: [
        ...previous.video,
        ...unplaced.map(shot => createVideoClip({ kind: 'shot', shotId: shot.id }))
      ]
    }, ctx));
  };

  const rebuildFromShots = () => {
    setEdit(previous => normalize({ ...previous, video: deriveVideoClips(scenes) }, ctx));
    setSelectedId(null);
    seek(0);
  };

  const toggleSmart = () => setEdit(previous => setSmart(previous, !previous.smart, ctx));

  const { width, height, fps } = edit.settings;

  return (
    <div className="edit-view">
      <header className="edit-header">
        <h2>Edit</h2>
        <span className="edit-chip">{width}×{height} · {fps}fps</span>
        <span className="edit-chip">
          {timeline.video.length} clip{timeline.video.length === 1 ? '' : 's'} · {formatTime(timeline.duration)}
        </span>
        {probing && <span className="edit-chip"><RefreshCw size={10} className="spinner" /> measuring…</span>}

        <div className="edit-spacer" />

        {unplaced.length > 0 && (
          <button className="edit-btn" onClick={appendUnplaced} title="Append shots that are not on the timeline yet">
            <Plus size={14} /> {unplaced.length} new shot{unplaced.length === 1 ? '' : 's'}
          </button>
        )}
        <button
          className={`edit-btn ${edit.smart ? 'toggle-on' : ''}`}
          onClick={toggleSmart}
          title="Smart mode: trims and moves ripple through the rest of the timeline, so there are never any gaps"
        >
          <Wand2 size={14} /> Smart
        </button>
        <button className="edit-btn" onClick={rebuildFromShots} title="Discard the running order and rebuild it from the shot list">
          <RefreshCw size={14} /> Match story order
        </button>
        <button className="edit-btn" onClick={onClose}><X size={14} /> Close</button>
      </header>

      {/* The canvas is always mounted: the engine binds to it once, and a
          conditional render would leave it with nothing to draw on. */}
      <div className="edit-stage">
        <canvas
          ref={canvasRef}
          className="edit-canvas"
          width={width}
          height={height}
          style={timeline.video.length === 0 ? { display: 'none' } : undefined}
        />
        {timeline.video.length === 0 && (
          <p className="edit-empty">
            Nothing on the timeline yet. Give a shot a selected image or video in the
            Create view and it will appear here.
          </p>
        )}
      </div>

      <div className="edit-transport">
        <button className="edit-btn" onClick={() => seek(0)} title="Back to start (Home)">
          <SkipBack size={14} />
        </button>
        <button className="edit-btn primary" onClick={togglePlay} disabled={timeline.duration <= 0} title="Play / pause (Space)">
          {playing ? <Pause size={14} /> : <Play size={14} />}
          {playing ? 'Pause' : 'Play'}
        </button>
        <span className="edit-clock">
          <strong>{formatTime(playhead)}</strong> / {formatTime(timeline.duration)}
        </span>

        <div className="edit-spacer" />

        <button className="edit-btn" onClick={() => setZoom(stepZoom(zoom, -1))} title="Zoom out">
          <ZoomOut size={14} />
        </button>
        <button className="edit-btn" onClick={() => setZoom(stepZoom(zoom, 1))} title="Zoom in">
          <ZoomIn size={14} />
        </button>
      </div>

      <Timeline
        timeline={timeline}
        pixelsPerSecond={zoom}
        playhead={playhead}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onSeek={seek}
      />
    </div>
  );
}

function stepZoom(current, direction) {
  const index = ZOOM_STEPS.indexOf(current);
  const next = (index < 0 ? 3 : index) + direction;
  return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, next))];
}

function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, '0')}`;
}
