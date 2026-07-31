// The editor. Takes over the window so it cannot crowd the creation UI, and
// owns nothing permanent — the edit document lives in App state and autosaves
// with the rest of the project.
//
// Everything it draws derives from `buildTimeline`, so the picture, the strip
// and the render all describe the same cut.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Play, Pause, SkipBack, ZoomIn, ZoomOut, RefreshCw, Wand2, Plus,
  Scissors, Trash2, RotateCcw, Music, Link2, Link2Off, Download, AlertTriangle,
  GitCompare
} from 'lucide-react';

import { apiFetch, resolveAssetUrl } from '../client.js';
import {
  collectSourcePaths,
  createAudioClip,
  createAudioTrack,
  deriveAudioClipsForShots,
  deriveVideoClips,
  pickDefaultSettings
} from './model.js';
import {
  makeContext, normalize, buildTimeline, setSmart,
  setClipTrim, clearClipTrim, moveClipToTime, setTransition,
  removeVideoClip, splitClipAtTime, maxOut,
  removeAudioTrack, addAudioClip, removeAudioClip, setTrackField,
  setAudioClipField, setAudioClipTrim, moveAudioClip, unlinkAudioClip, linkAudioClip,
  detachClipAudio, reattachClipAudio
} from './timing.js';
import { probeMissing } from './durations.js';
import { diffShots, reconcile } from './reconcile.js';
import { buildRenderPlan, missingSources } from './renderPlan.js';
import { PreviewEngine } from './PreviewEngine.js';
import Timeline from './Timeline.jsx';
import './edit.css';

const ZOOM_STEPS = [2, 4, 8, 16, 32, 64, 128];
const DEFAULT_TRANSITION_SECONDS = 0.5;

export default function EditView({ scenes, edit, setEdit, videoDuration, onClose, onToast }) {
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const fileInputRef = useRef(null);

  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selection, setSelection] = useState(null);
  const [zoom, setZoom] = useState(16);
  const [probing, setProbing] = useState(false);

  const ctx = useMemo(
    () => makeContext(scenes, edit.durations, Number(videoDuration) || 5),
    [scenes, edit.durations, videoDuration]
  );
  const timeline = useMemo(() => buildTimeline(edit, ctx), [edit, ctx]);

  const selectedVideo = useMemo(
    () => (selection?.kind === 'video'
      ? timeline.video.find(entry => entry.clip.id === selection.id) || null
      : null),
    [timeline.video, selection]
  );
  const selectedAudio = useMemo(() => {
    if (selection?.kind !== 'audio') return null;
    for (const trackEntry of timeline.audio) {
      const entry = trackEntry.clips.find(candidate => candidate.clip.id === selection.id);
      if (entry) return entry;
    }
    return null;
  }, [timeline.audio, selection]);

  // How the shot list has drifted from the timeline. Offered rather than
  // applied: re-generating a take is picked up for free, but reordering or
  // deleting behind the user's back would throw away real cutting work.
  const diff = useMemo(() => diffShots(edit, scenes), [edit, scenes]);
  const [showChanges, setShowChanges] = useState(false);

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
  // show up, fills an empty timeline once, then stays out of the way so a
  // deliberately emptied edit is not repopulated behind the user's back.
  const autoPopulated = useRef(false);
  useEffect(() => {
    if (autoPopulated.current) return;
    if (edit.video.length > 0) { autoPopulated.current = true; return; }
    const clips = deriveVideoClips(scenes);
    if (clips.length === 0) return;
    autoPopulated.current = true;
    setEdit(previous => normalize(withDerivedAudio({ ...previous, video: clips }, scenes), ctx));
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

  // A handle on the live document, for poking at from the console.
  useEffect(() => {
    if (import.meta.env.DEV) window.__mmEdit = { edit, scenes, ctx };
  }, [edit, scenes, ctx]);

  const seek = useCallback((time) => {
    engineRef.current?.seek(time);
    setPlayhead(Math.max(0, Math.min(time, timeline.duration)));
  }, [timeline.duration]);

  const togglePlay = useCallback(() => { engineRef.current?.toggle(); }, []);

  // --- editing --------------------------------------------------------------

  // Dragging commits on every pointermove so the ripple is visible as it
  // happens. Pausing first keeps the playhead from fighting a timeline that is
  // changing length underneath it.
  const beginEdit = useCallback(() => {
    if (engineRef.current?.playing) engineRef.current.pause();
  }, []);

  const handleMoveClip = useCallback((clipId, start) => {
    beginEdit();
    setEdit(previous => moveClipToTime(previous, clipId, start, ctx));
  }, [ctx, setEdit, beginEdit]);

  const handleTrimClip = useCallback((clipId, edge, value) => {
    beginEdit();
    setEdit(previous => setClipTrim(previous, clipId, edge, value, ctx));
  }, [ctx, setEdit, beginEdit]);

  const handleMoveAudioClip = useCallback((clipId, start) => {
    beginEdit();
    setEdit(previous => moveAudioClip(previous, clipId, start, ctx));
  }, [ctx, setEdit, beginEdit]);

  const handleTrimAudioClip = useCallback((clipId, edge, value) => {
    beginEdit();
    setEdit(previous => setAudioClipTrim(previous, clipId, edge, value, ctx));
  }, [ctx, setEdit, beginEdit]);

  const handleTrackField = useCallback((trackId, patch) => {
    setEdit(previous => setTrackField(previous, trackId, patch));
  }, [setEdit]);

  const handleRemoveTrack = useCallback((trackId) => {
    setEdit(previous => removeAudioTrack(previous, trackId));
    setSelection(null);
  }, [setEdit]);

  const handleTransition = (type, duration) => {
    if (!selectedVideo) return;
    setEdit(previous => setTransition(
      previous,
      selectedVideo.clip.id,
      type === 'cut' ? null : { type, duration: duration ?? DEFAULT_TRANSITION_SECONDS },
      ctx
    ));
  };

  const handleDelete = useCallback(() => {
    if (!selection) return;
    setEdit(previous => (selection.kind === 'audio'
      ? removeAudioClip(previous, selection.id)
      : removeVideoClip(previous, selection.id, ctx)));
    setSelection(null);
  }, [selection, ctx, setEdit]);

  const handleSplit = useCallback(() => {
    const entry = timeline.video.find(v => playhead > v.start && playhead < v.end);
    if (!entry) return;
    setEdit(previous => splitClipAtTime(previous, entry.clip.id, playhead, ctx));
  }, [timeline.video, playhead, ctx, setEdit]);

  const applyReconcile = (options) => {
    setEdit(previous => reconcile(previous, scenes, ctx, options));
    setShowChanges(false);
  };

  const rebuildFromShots = () => {
    setEdit(previous => normalize(
      withDerivedAudio({ ...previous, video: deriveVideoClips(scenes) }, scenes),
      ctx
    ));
    setSelection(null);
    seek(0);
  };

  const toggleSmart = () => setEdit(previous => setSmart(previous, !previous.smart, ctx));

  // --- importing sound ------------------------------------------------------

  const handleImportAudio = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      const body = new FormData();
      body.append('file', file);
      const res = await apiFetch('/api/upload', { method: 'POST', body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'upload failed');

      const track = createAudioTrack(file.name.replace(/\.[^.]+$/, ''));
      const clip = createAudioClip(
        { kind: 'asset', path: data.filePath, name: file.name, stream: 'audio' },
        { start: playhead }
      );
      setEdit(previous => addAudioClip(
        { ...previous, audio: [...(previous.audio || []), track] },
        track.id,
        clip
      ));
      setSelection({ kind: 'audio', id: clip.id });
      onToast?.(`Added ${file.name} at ${formatTime(playhead)}.`);
    } catch (error) {
      onToast?.(`Could not import audio: ${error.message}`, 'error');
    }
  };

  // --- rendering ------------------------------------------------------------

  const [render, setRender] = useState(null);

  const startRender = async () => {
    if (engineRef.current?.playing) engineRef.current.pause();
    const gaps = missingSources(timeline);

    try {
      const res = await apiFetch('/api/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildRenderPlan(timeline))
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'render failed to start');

      setRender({ jobId: data.jobId, state: 'running', progress: 0 });
      if (gaps.length > 0) {
        onToast?.(`Rendering. ${gaps.length} clip${gaps.length === 1 ? '' : 's'} with no media will come out black.`, 'warning');
      }
    } catch (error) {
      setRender({ state: 'error', error: error.message });
      onToast?.(`Could not start the render: ${error.message}`, 'error');
    }
  };

  // Poll while a render is in flight. ffmpeg reports its own position, so the
  // bar reflects real encoder progress rather than a guess.
  useEffect(() => {
    if (render?.state !== 'running' || !render.jobId) return undefined;
    let cancelled = false;

    const timer = setInterval(async () => {
      try {
        const res = await apiFetch(`/api/render/${render.jobId}`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(data.error || 'lost track of the render');

        setRender(previous => ({ ...previous, ...data }));
        if (data.state === 'done') {
          onToast?.('Render finished.', 'success');
        } else if (data.state === 'error') {
          onToast?.(`Render failed: ${data.error}`, 'error');
        }
      } catch (error) {
        if (!cancelled) setRender(previous => ({ ...previous, state: 'error', error: error.message }));
      }
    }, 500);

    return () => { cancelled = true; clearInterval(timer); };
  }, [render?.state, render?.jobId, onToast]);

  const openRender = async () => {
    if (!render?.filePath) return;
    const url = await resolveAssetUrl(render.filePath);
    if (url) window.open(url, '_blank');
  };

  // --- keyboard -------------------------------------------------------------

  useEffect(() => {
    const onKey = (event) => {
      if (event.target.matches?.('input, textarea, select')) return;
      if (event.key === ' ') { event.preventDefault(); togglePlay(); }
      else if (event.key === 'ArrowLeft') seek(playhead - (event.shiftKey ? 1 : 1 / 24));
      else if (event.key === 'ArrowRight') seek(playhead + (event.shiftKey ? 1 : 1 / 24));
      else if (event.key === 'Home') seek(0);
      else if (event.key === 'Delete' || event.key === 'Backspace') handleDelete();
      else if (event.key === 's' || event.key === 'S') handleSplit();
      else if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playhead, seek, togglePlay, handleDelete, handleSplit, onClose]);

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

        {diff.total > 0 && (
          <div className="edit-changes">
            <button
              className="edit-btn toggle-on"
              onClick={() => setShowChanges(value => !value)}
              title="The shot list has changed since this edit was cut"
            >
              <GitCompare size={14} /> {describeDiff(diff)}
            </button>

            {showChanges && (
              <div className="edit-changes-menu">
                {diff.added.length > 0 && (
                  <button className="edit-btn" onClick={() => applyReconcile({ add: true })}>
                    <Plus size={14} /> Add {diff.added.length} new shot{diff.added.length === 1 ? '' : 's'} in story order
                  </button>
                )}
                {diff.orphaned.length > 0 && (
                  <button className="edit-btn" onClick={() => applyReconcile({ prune: true })}>
                    <Trash2 size={14} /> Remove {diff.orphaned.length} deleted shot{diff.orphaned.length === 1 ? '' : 's'}
                  </button>
                )}
                {diff.reordered && (
                  <button className="edit-btn" onClick={() => applyReconcile({ reorder: true })}>
                    <RefreshCw size={14} /> Match story order, keeping trims
                  </button>
                )}
                <button
                  className="edit-btn primary"
                  onClick={() => applyReconcile({ add: true, prune: true, reorder: true })}
                >
                  Apply everything
                </button>
                <p className="edit-note">
                  Trims, transitions and linked audio are kept. Only the running
                  order changes.
                </p>
              </div>
            )}
          </div>
        )}
        <button className="edit-btn" onClick={() => fileInputRef.current?.click()} title="Import music or voiceover onto a new track">
          <Music size={14} /> Add audio
        </button>
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

        <RenderButton
          render={render}
          disabled={timeline.video.length === 0}
          onStart={startRender}
          onOpen={openRender}
        />

        <button className="edit-btn" onClick={onClose}><X size={14} /> Close</button>

        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          style={{ display: 'none' }}
          onChange={handleImportAudio}
        />
      </header>

      <div className="edit-body">
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

        <aside className="edit-inspector">
          {selectedVideo && (
            <VideoInspector
              entry={selectedVideo}
              ctx={ctx}
              onTransition={handleTransition}
              onClipAudio={(patch) => setEdit(previous => ({
                ...previous,
                video: previous.video.map(clip => (
                  clip.id === selectedVideo.clip.id
                    ? { ...clip, audio: { ...clip.audio, ...patch } }
                    : clip
                ))
              }))}
              onDetach={() => setEdit(previous => detachClipAudio(previous, selectedVideo.clip.id, ctx))}
              onReattach={() => setEdit(previous => reattachClipAudio(previous, selectedVideo.clip.id, ctx))}
              onResetTrim={() => setEdit(previous => clearClipTrim(previous, selectedVideo.clip.id, ctx))}
              onDelete={handleDelete}
              onSplit={handleSplit}
            />
          )}

          {selectedAudio && (
            <AudioInspector
              entry={selectedAudio}
              nearestVideo={nearestVideoClip(timeline, selectedAudio.start)}
              onField={(patch) => setEdit(previous => setAudioClipField(previous, selectedAudio.clip.id, patch))}
              onUnlink={() => setEdit(previous => unlinkAudioClip(previous, selectedAudio.clip.id, ctx))}
              onLink={(videoClipId) => setEdit(previous => linkAudioClip(previous, selectedAudio.clip.id, videoClipId, ctx))}
              onDelete={handleDelete}
            />
          )}

          {!selectedVideo && !selectedAudio && (
            <p className="edit-empty" style={{ fontSize: '0.78rem' }}>
              Select a clip to trim it, change how it arrives, or take it out.
            </p>
          )}
        </aside>
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

        <span className="edit-chip">drag to move · edges to trim · alt disables snapping</span>
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
        selection={selection}
        smart={edit.smart}
        onSelect={setSelection}
        onSeek={seek}
        onMoveClip={handleMoveClip}
        onTrimClip={handleTrimClip}
        onMoveAudioClip={handleMoveAudioClip}
        onTrimAudioClip={handleTrimAudioClip}
        onTrackField={handleTrackField}
        onRemoveTrack={handleRemoveTrack}
      />
    </div>
  );
}

function RenderButton({ render, disabled, onStart, onOpen }) {
  if (render?.state === 'running') {
    const percent = Math.round((render.progress || 0) * 100);
    return (
      <span className="edit-render-progress" title="Encoding your edit">
        <span className="edit-render-bar" style={{ width: `${percent}%` }} />
        <span className="edit-render-label">
          <RefreshCw size={12} className="spinner" /> Rendering {percent}%
        </span>
      </span>
    );
  }

  if (render?.state === 'done') {
    return (
      <button className="edit-btn primary" onClick={onOpen} title={render.filePath}>
        <Download size={14} /> Open render
      </button>
    );
  }

  return (
    <button className="edit-btn" onClick={onStart} disabled={disabled} title="Encode this edit to a single file">
      {render?.state === 'error' ? <AlertTriangle size={14} /> : <Download size={14} />}
      {render?.state === 'error' ? 'Retry render' : 'Render'}
    </button>
  );
}

// --- inspectors -------------------------------------------------------------

function VideoInspector({
  entry, ctx, onTransition, onClipAudio, onDetach, onReattach, onResetTrim, onDelete, onSplit
}) {
  const limit = maxOut(entry.clip, ctx);
  const transitionType = entry.transition?.type || 'cut';
  const trimmed = entry.clip.out !== null && entry.clip.out !== undefined;
  const isFirst = entry.index === 0;
  const hasSound = entry.resolved.kind === 'video' && entry.hasAudio;
  const detached = Boolean(entry.clip.audio?.detached);

  return (
    <>
      <h3>{entry.resolved.name}</h3>
      <p className="edit-inspector-path">{entry.resolved.path || 'no media'}</p>

      <dl className="edit-facts">
        <dt>On timeline</dt>
        <dd>{formatTime(entry.start)} → {formatTime(entry.end)}</dd>
        <dt>Length</dt>
        <dd>{entry.length.toFixed(2)}s</dd>
        <dt>Source</dt>
        <dd>
          {trimmed ? `${entry.in.toFixed(2)}–${entry.out.toFixed(2)}` : 'whole clip'}
          {Number.isFinite(limit) ? ` of ${limit.toFixed(2)}s` : ''}
        </dd>
      </dl>

      {entry.stale && (
        <p className="edit-warning">
          Trimmed against a different take. The in and out points were kept and
          clamped to the new source — worth a look.
        </p>
      )}

      <label className="edit-field">
        <span>Arrives as</span>
        <select
          value={transitionType}
          disabled={isFirst}
          onChange={(event) => onTransition(event.target.value, entry.transition?.duration)}
        >
          <option value="cut">Cut</option>
          <option value="dissolve">Cross dissolve</option>
          <option value="dip">Dip to black</option>
        </select>
      </label>

      {transitionType !== 'cut' && (
        <label className="edit-field">
          <span>Over {entry.transition.duration.toFixed(2)}s</span>
          <input
            type="range" min="0.1" max="3" step="0.05"
            value={entry.transition.duration}
            onChange={(event) => onTransition(transitionType, Number(event.target.value))}
          />
        </label>
      )}

      {/* A detached clip always keeps its relink button, even if the take turns
          out to be silent — otherwise there would be no way back. */}
      {entry.resolved.kind === 'video' && (
        <>
          <h4 className="edit-subhead">Sound</h4>

          {detached && (
            <p className="edit-note">
              This clip's audio is on an audio track and no longer follows the picture.
            </p>
          )}

          {!detached && !entry.hasAudio && (
            <p className="edit-note">
              This take has no audio track. Import music or a voiceover to give it sound.
            </p>
          )}

          {!detached && entry.hasAudio && (
            <>
              <label className="edit-field">
                <span>Level {Math.round((entry.clip.audio?.gain ?? 1) * 100)}%</span>
                <input
                  type="range" min="0" max="1.5" step="0.01"
                  value={entry.clip.audio?.gain ?? 1}
                  onChange={(event) => onClipAudio({ gain: Number(event.target.value) })}
                />
              </label>
              <FadeFields audio={entry.clip.audio} onChange={onClipAudio} />
            </>
          )}

          {(detached || hasSound) && (
            <button className="edit-btn" onClick={detached ? onReattach : onDetach}>
              {detached ? <><Link2 size={14} /> Relink audio</> : <><Link2Off size={14} /> Unlink audio</>}
            </button>
          )}
        </>
      )}

      <div className="edit-inspector-actions">
        <button className="edit-btn" onClick={onSplit} title="Split at the playhead (S)">
          <Scissors size={14} /> Split
        </button>
        <button className="edit-btn" onClick={onResetTrim} disabled={!trimmed} title="Follow the whole source again">
          <RotateCcw size={14} /> Untrim
        </button>
        <button className="edit-btn" onClick={onDelete} title="Remove from the timeline (Delete)">
          <Trash2 size={14} /> Remove
        </button>
      </div>
    </>
  );
}

function AudioInspector({ entry, nearestVideo, onField, onUnlink, onLink, onDelete }) {
  const linked = Boolean(entry.clip.link);

  return (
    <>
      <h3>{entry.resolved.name}</h3>
      <p className="edit-inspector-path">{entry.resolved.path || 'no media'}</p>

      <dl className="edit-facts">
        <dt>On timeline</dt>
        <dd>{formatTime(entry.start)} → {formatTime(entry.end)}</dd>
        <dt>Length</dt>
        <dd>{entry.length.toFixed(2)}s</dd>
        <dt>Follows</dt>
        <dd>{linked ? `picture (${entry.clip.link.offset >= 0 ? '+' : ''}${entry.clip.link.offset.toFixed(2)}s)` : 'nothing'}</dd>
      </dl>

      <label className="edit-field">
        <span>Level {Math.round((entry.gain ?? 1) * 100)}%</span>
        <input
          type="range" min="0" max="1.5" step="0.01"
          value={entry.gain ?? 1}
          onChange={(event) => onField({ gain: Number(event.target.value) })}
        />
      </label>

      <FadeFields audio={entry.clip} onChange={onField} />

      <button
        className="edit-btn"
        onClick={() => (linked ? onUnlink() : nearestVideo && onLink(nearestVideo.clip.id))}
        disabled={!linked && !nearestVideo}
        title={linked
          ? 'Cut this loose so it stays put when the picture moves'
          : 'Pin this to the picture clip underneath it'}
      >
        {linked ? <><Link2Off size={14} /> Unlink from picture</> : <><Link2 size={14} /> Link to picture</>}
      </button>

      <div className="edit-inspector-actions">
        <button className="edit-btn" onClick={onDelete}><Trash2 size={14} /> Remove</button>
      </div>
    </>
  );
}

function FadeFields({ audio, onChange }) {
  return (
    <>
      <label className="edit-field">
        <span>Fade in {(audio?.fadeIn ?? 0).toFixed(2)}s</span>
        <input
          type="range" min="0" max="5" step="0.05"
          value={audio?.fadeIn ?? 0}
          onChange={(event) => onChange({ fadeIn: Number(event.target.value) })}
        />
      </label>
      <label className="edit-field">
        <span>Fade out {(audio?.fadeOut ?? 0).toFixed(2)}s</span>
        <input
          type="range" min="0" max="5" step="0.05"
          value={audio?.fadeOut ?? 0}
          onChange={(event) => onChange({ fadeOut: Number(event.target.value) })}
        />
      </label>
    </>
  );
}

// --- helpers ----------------------------------------------------------------

/** Place any lip-sync audio the shots carry, on its own track. */
function withDerivedAudio(edit, scenes) {
  const clips = deriveAudioClipsForShots(scenes, edit.video);
  if (clips.length === 0) return { ...edit, audio: [] };
  const track = createAudioTrack('Dialogue');
  return { ...edit, audio: [{ ...track, clips }] };
}

/** The picture clip sitting under a given time, for linking against. */
function nearestVideoClip(timeline, time) {
  return timeline.video.find(entry => time >= entry.start && time < entry.end)
    || timeline.video[0]
    || null;
}

/** A short summary of how far the shot list has drifted. */
function describeDiff(diff) {
  const parts = [];
  if (diff.added.length) parts.push(`${diff.added.length} new`);
  if (diff.orphaned.length) parts.push(`${diff.orphaned.length} deleted`);
  if (diff.reordered) parts.push('reordered');
  return parts.join(' · ');
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
