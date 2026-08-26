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
  GitCompare, FolderOpen, Zap
} from 'lucide-react';

import { apiFetch, resolveAssetUrl } from '../client.js';
import {
  collectSourcePaths,
  createAudioClip,
  createAudioTrack,
  createBinItem,
  createVideoClip,
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
  detachClipAudio, autoLinkClipAudio, companionOf, isCompanion
} from './timing.js';
import { probeMissing } from './durations.js';
import { diffShots, reconcile } from './reconcile.js';
import { buildRenderPlan, missingSources } from './renderPlan.js';
import { PreviewEngine } from './PreviewEngine.js';
import { createTimeStore } from './timeStore.js';
import { createProxyCache, priorityPaths, cacheSpans } from './proxyCache.js';
import Timeline from './Timeline.jsx';
import MediaBin from './MediaBin.jsx';
import CachePanel from './CachePanel.jsx';
import './edit.css';

const ZOOM_STEPS = [2, 4, 8, 16, 32, 64, 128];
const DEFAULT_TRANSITION_SECONDS = 0.5;

export default function EditView({
  scenes, edit, setEdit, videoDuration, onClose, onToast, onJobStart, onJobUpdate, banner
}) {
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const fileInputRef = useRef(null);

  // Continuous time never touches React state: the engine writes this store
  // every frame and the playhead marker / clock subscribe to it directly, so
  // playback and scrubbing cause zero Timeline re-renders.
  const timeStoreRef = useRef(null);
  if (!timeStoreRef.current) timeStoreRef.current = createTimeStore(0);
  const timeStore = timeStoreRef.current;

  const [playing, setPlaying] = useState(false);
  const [selection, setSelection] = useState(null);
  const [zoom, setZoom] = useState(16);
  const [probing, setProbing] = useState(false);
  const [binOpen, setBinOpen] = useState(false);
  const [cacheOpen, setCacheOpen] = useState(false);

  // --- preview files --------------------------------------------------------
  //
  // Every source gets a small, densely keyframed copy built in the background,
  // and the monitor plays that instead. It is the difference between a scrub
  // that follows the pointer and one that decides where to land a second later.
  // Ordering is driven by the playhead, so what you are about to watch is what
  // gets built. See proxyCache.js.

  const [cacheTick, setCacheTick] = useState(0);
  const proxyRef = useRef(null);
  if (!proxyRef.current) {
    proxyRef.current = createProxyCache({
      onReady: (paths) => {
        engineRef.current?.refreshSources(paths);
        setCacheTick(value => value + 1);
      },
      onUpdate: () => setCacheTick(value => value + 1)
    });
  }
  const proxy = proxyRef.current;
  useEffect(() => () => proxy.destroy(), [proxy]);

  /** A proxy if there is one, the original if there is not. */
  const resolvePreviewUrl = useCallback(
    async (assetPath) => proxy.urlFor(assetPath) || await resolveAssetUrl(assetPath),
    [proxy]
  );

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

  // The sound clip belonging to the selected picture clip, if it has one.
  // Level, fades and the link toggle all act on it rather than on the picture.
  const selectedCompanion = useMemo(
    () => (selectedVideo ? companionOf(edit, selectedVideo.clip.id) : null),
    [edit, selectedVideo]
  );

  // The picture clip the selected sound belongs to, for the other direction.
  const selectedAnchor = useMemo(() => {
    const from = selectedAudio?.clip?.detachedFrom;
    return from ? timeline.video.find(entry => entry.clip.id === from) || null : null;
  }, [timeline.video, selectedAudio]);

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

  // Give every picture clip that has a soundtrack that soundtrack, on an audio
  // track below it and pinned to it. Keyed on `ctx` rather than on a drop or an
  // import because whether a source has audio is not known until it has been
  // measured — a clip dropped from the bin gets its sound one probe later, and
  // a project made before any of this existed gets it on open.
  const saidSoRef = useRef(false);
  useEffect(() => {
    setEdit(previous => {
      const next = autoLinkClipAudio(previous, ctx);
      // Worth saying out loud the first time, because it changes the shape of a
      // timeline the user already knows — silently growing an audio track under
      // an edit somebody cut last week would be alarming.
      if (next !== previous && !saidSoRef.current) {
        saidSoRef.current = true;
        onToast?.('Clips with sound now carry it on a linked audio track below the picture. Unlink from the inspector to break a pair.');
      }
      return next;
    });
  }, [ctx, setEdit, onToast]);

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
      resolveUrl: resolvePreviewUrl,
      onTime: (time) => timeStore.set(time),
      onStateChange: ({ playing: next }) => setPlaying(next)
    });
    engineRef.current = engine;
    if (import.meta.env.DEV) window.__mmEngine = engine;
    return () => {
      engineRef.current = null;
      engine.destroy();
    };
    // Exactly once. A MediaElementAudioSourceNode can only be created once per
    // element, so the slot pool cannot be rebuilt — which is why the engine
    // outlives every dependency this closes over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.setTimeline(timeline);
  }, [timeline]);

  /**
   * Keep the build queue pointed at the playhead.
   *
   * Recomputed when the timeline changes and whenever the playhead crosses into
   * a different clip — not every frame. Crossing a boundary is the only moment
   * the *order* can change, and the order is the whole feature.
   */
  useEffect(() => {
    let lastIndex = Number.NaN;
    const update = (time) => {
      lastIndex = timeline.video.findIndex(entry => time >= entry.start && time < entry.end);
      proxy.setWanted(priorityPaths(timeline, time));
    };
    update(timeStore.get());
    return timeStore.subscribe((time) => {
      const index = timeline.video.findIndex(entry => time >= entry.start && time < entry.end);
      if (index === lastIndex) return;
      update(time);
    });
  }, [timeline, proxy, timeStore]);

  // What the cache bar under the ruler draws.
  const spans = useMemo(
    () => cacheSpans(timeline, (assetPath) => proxy.stateFor(assetPath)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeline, proxy, cacheTick]
  );

  // A handle on the live document, for poking at from the console.
  useEffect(() => {
    if (import.meta.env.DEV) window.__mmEdit = { edit, scenes, ctx };
  }, [edit, scenes, ctx]);

  // engine.seek clamps and its onTime callback writes the store.
  const seek = useCallback((time) => {
    engineRef.current?.seek(time);
  }, []);

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
    const at = timeStore.get();
    const entry = timeline.video.find(v => at > v.start && at < v.end);
    if (!entry) return;
    setEdit(previous => splitClipAtTime(previous, entry.clip.id, at, ctx));
  }, [timeline.video, timeStore, ctx, setEdit]);

  const applyReconcile = (options) => {
    setEdit(previous => reconcile(previous, scenes, ctx, options));
    setShowChanges(false);
  };

  const rebuildFromShots = () => {
    // Imported (asset-kind) clips are real cutting work, not derivable from
    // the shot list — keep them, appended after the fresh sequence, and say so.
    const imported = (edit.video || []).filter(clip => clip.source?.kind === 'asset');
    if (imported.length > 0) {
      const ok = window.confirm(
        `Rebuild the running order from the shot list?\n\n`
        + `${imported.length} imported clip${imported.length === 1 ? '' : 's'} (from the bin) will be kept and moved to the end.`
      );
      if (!ok) return;
    }
    setEdit(previous => {
      const kept = (previous.video || []).filter(clip => clip.source?.kind === 'asset');
      return normalize(
        withDerivedAudio({ ...previous, video: [...deriveVideoClips(scenes), ...kept] }, scenes),
        ctx
      );
    });
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

      const at = timeStore.get();
      const track = createAudioTrack(file.name.replace(/\.[^.]+$/, ''));
      const clip = createAudioClip(
        { kind: 'asset', path: data.filePath, name: file.name, stream: 'audio' },
        { start: at }
      );
      setEdit(previous => addAudioClip(
        { ...previous, audio: [...(previous.audio || []), track] },
        track.id,
        clip
      ));
      setSelection({ kind: 'audio', id: clip.id });
      onToast?.(`Added ${file.name} at ${formatTime(at)}.`);
    } catch (error) {
      onToast?.(`Could not import audio: ${error.message}`, 'error');
    }
  };

  // --- the media bin --------------------------------------------------------

  const binTypeFor = (file) => (
    file.type.startsWith('audio/') ? 'audio'
      : file.type.startsWith('image/') ? 'image'
      : 'video'
  );

  /** Upload files one at a time; a failure toasts and the rest continue. */
  const handleImportBinFiles = async (files) => {
    for (const file of files) {
      try {
        const body = new FormData();
        body.append('file', file);
        const res = await apiFetch('/api/upload', { method: 'POST', body });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'upload failed');
        const item = createBinItem({ path: data.filePath, name: file.name, type: binTypeFor(file) });
        setEdit(previous => ({ ...previous, bin: [...(previous.bin || []), item] }));
      } catch (error) {
        onToast?.(`Could not import ${file.name}: ${error.message}`, 'error');
      }
    }
  };

  /** Add files already in the project folder — no copy, they are already assets. */
  const handleAddBinItems = (entries) => {
    setEdit(previous => {
      const inBin = new Set((previous.bin || []).map(item => item.path));
      const additions = entries
        .filter(entry => !inBin.has(entry.path))
        .map(entry => createBinItem({ path: entry.path, name: entry.name, type: entry.type }));
      return additions.length ? { ...previous, bin: [...(previous.bin || []), ...additions] } : previous;
    });
  };

  /** Never deletes the file; clips already on the timeline keep their own path. */
  const handleRemoveBinItem = (itemId) => {
    setEdit(previous => ({ ...previous, bin: (previous.bin || []).filter(item => item.id !== itemId) }));
  };

  /** Smart mode: the slot whose midpoint the drop time falls before. */
  const indexForTime = (time) => {
    const at = timeline.video.findIndex(entry => entry.start + entry.length / 2 > time);
    return at === -1 ? timeline.video.length : at;
  };

  const handleDropAsset = useCallback((item, time, target) => {
    beginEdit();

    // The container-level fallback: route by media type.
    const resolvedTarget = target.kind === 'auto'
      ? (item.type === 'audio' ? { kind: 'audio', trackId: null } : { kind: 'video' })
      : target;

    if (resolvedTarget.kind === 'video') {
      if (item.type === 'audio') {
        onToast?.('Audio belongs on an audio track — drop it lower.', 'warning');
        return;
      }
      const clip = createVideoClip(
        { kind: 'asset', path: item.path, name: item.name, stream: item.type === 'image' ? 'image' : 'video' },
        edit.smart ? {} : { start: time }
      );
      const index = edit.smart ? indexForTime(time) : timeline.video.length;
      setEdit(previous => {
        const video = [...previous.video];
        video.splice(Math.min(index, video.length), 0, clip);
        return normalize({ ...previous, video }, ctx);
      });
      setSelection({ kind: 'video', id: clip.id });
      return;
    }

    // Audio target. Video files are allowed here too — the clip pulls just the
    // file's audio stream.
    const clip = createAudioClip(
      { kind: 'asset', path: item.path, name: item.name, stream: 'audio' },
      { start: Math.max(0, time) }
    );
    if (resolvedTarget.trackId) {
      setEdit(previous => addAudioClip(previous, resolvedTarget.trackId, clip));
    } else {
      const track = createAudioTrack(item.name.replace(/\.[^.]+$/, ''));
      setEdit(previous => addAudioClip(
        { ...previous, audio: [...(previous.audio || []), track] },
        track.id,
        clip
      ));
    }
    setSelection({ kind: 'audio', id: clip.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit.smart, timeline.video, ctx, setEdit, beginEdit, onToast]);

  // --- rendering ------------------------------------------------------------

  const [render, setRender] = useState(null);

  const startRender = async () => {
    if (engineRef.current?.playing) engineRef.current.pause();
    const gaps = missingSources(timeline);

    // The render joins the same queue as everything else the project has running.
    // Handing the queue the encoder's own job id is what lets it follow the
    // render to the end even after this view is gone — the bar below only lives
    // as long as the editor does, but the encode does not. The plan is what
    // actually gets encoded, so it is also what the entry describes.
    const plan = buildRenderPlan(timeline);
    const entryId = onJobStart?.({
      type: 'render',
      shotName: 'Timeline',
      prompt: `Render ${plan.video.length} clip${plan.video.length === 1 ? '' : 's'}`
        + (plan.audio.length ? ` + ${plan.audio.length} audio clip${plan.audio.length === 1 ? '' : 's'}` : '')
    });

    try {
      const res = await apiFetch('/api/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(plan)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'render failed to start');

      setRender({ jobId: data.jobId, state: 'running', progress: 0 });
      if (entryId) onJobUpdate?.(entryId, { renderJobId: data.jobId });
      if (gaps.length > 0) {
        onToast?.(`Rendering. ${gaps.length} clip${gaps.length === 1 ? '' : 's'} with no media will come out black.`, 'warning');
      }
    } catch (error) {
      setRender({ state: 'error', error: error.message });
      if (entryId) onJobUpdate?.(entryId, { status: 'failed', error: error.message });
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

  // Reading the store instead of closing over playhead state is what stops
  // this listener re-registering every frame during playback.
  useEffect(() => {
    const onKey = (event) => {
      if (event.target.matches?.('input, textarea, select')) return;
      if (event.key === ' ') { event.preventDefault(); togglePlay(); }
      else if (event.key === 'ArrowLeft') seek(timeStore.get() - (event.shiftKey ? 1 : 1 / 24));
      else if (event.key === 'ArrowRight') seek(timeStore.get() + (event.shiftKey ? 1 : 1 / 24));
      else if (event.key === 'Home') seek(0);
      else if (event.key === 'Delete' || event.key === 'Backspace') handleDelete();
      else if (event.key === 's' || event.key === 'S') handleSplit();
      else if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [timeStore, seek, togglePlay, handleDelete, handleSplit, onClose]);

  // Selecting either half of an A/V pair lights up the other, which is the
  // only cue that tells you a cut or a drag is about to move two clips.
  const linkedSelection = useMemo(() => {
    if (selectedVideo) return selectedCompanion ? selectedCompanion.clip.id : null;
    if (selectedAudio && isCompanion(selectedAudio.clip)) return selectedAudio.clip.detachedFrom;
    return null;
  }, [selectedVideo, selectedCompanion, selectedAudio]);

  const { width, height, fps } = edit.settings;

  return (
    <div className="edit-view">
      {/* Whatever the app needs to say over the top of everything — today only
          the autosave-has-stopped bar. A row of the view rather than a layer
          above it, so it pushes the editor down instead of hiding its header. */}
      {banner}

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
        <button
          className={`edit-btn ${binOpen ? 'toggle-on' : ''}`}
          onClick={() => setBinOpen(open => !open)}
          title="The media bin: bring any video, audio or image into the edit"
        >
          <FolderOpen size={14} /> Bin{(edit.bin || []).length > 0 ? ` (${edit.bin.length})` : ''}
        </button>
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
        {binOpen && (
          <MediaBin
            bin={edit.bin || []}
            durations={edit.durations}
            onImportFiles={handleImportBinFiles}
            onAddItems={handleAddBinItems}
            onRemove={handleRemoveBinItem}
            onToast={onToast}
          />
        )}

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
              companion={selectedCompanion}
              onTransition={handleTransition}
              onStillSeconds={(value) => setEdit(previous => normalize({
                ...previous,
                video: previous.video.map(clip => (
                  clip.id === selectedVideo.clip.id ? { ...clip, stillSeconds: value } : clip
                ))
              }, ctx))}
              onCompanionField={(patch) => selectedCompanion && setEdit(previous =>
                setAudioClipField(previous, selectedCompanion.clip.id, patch))}
              onUnlink={() => selectedCompanion && setEdit(previous =>
                unlinkAudioClip(previous, selectedCompanion.clip.id, ctx))}
              onRelink={() => selectedCompanion && setEdit(previous =>
                linkAudioClip(previous, selectedCompanion.clip.id, selectedVideo.clip.id, ctx))}
              onRemoveSound={() => selectedCompanion && setEdit(previous =>
                removeAudioClip(previous, selectedCompanion.clip.id))}
              onRestoreSound={() => setEdit(previous => detachClipAudio(
                { ...previous, video: previous.video.map(clip => (
                  clip.id === selectedVideo.clip.id
                    ? { ...clip, audio: { ...clip.audio, detached: false } }
                    : clip
                )) },
                selectedVideo.clip.id,
                ctx
              ))}
              onSelectCompanion={() => selectedCompanion
                && setSelection({ kind: 'audio', id: selectedCompanion.clip.id })}
              onResetTrim={() => setEdit(previous => clearClipTrim(previous, selectedVideo.clip.id, ctx))}
              onDelete={handleDelete}
              onSplit={handleSplit}
            />
          )}

          {selectedAudio && (
            <AudioInspector
              entry={selectedAudio}
              anchor={selectedAnchor}
              nearestVideo={nearestVideoClip(timeline, selectedAudio.start)}
              onField={(patch) => setEdit(previous => setAudioClipField(previous, selectedAudio.clip.id, patch))}
              onUnlink={() => setEdit(previous => unlinkAudioClip(previous, selectedAudio.clip.id, ctx))}
              onLink={(videoClipId) => setEdit(previous => linkAudioClip(previous, selectedAudio.clip.id, videoClipId, ctx))}
              onSelectAnchor={() => selectedAnchor && setSelection({ kind: 'video', id: selectedAnchor.clip.id })}
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
        <TransportClock store={timeStore} duration={timeline.duration} />

        <div className="edit-spacer" />

        <CacheChip spans={spans} duration={timeline.duration} />
        <button
          className={`edit-btn ${cacheOpen ? 'toggle-on' : ''}`}
          onClick={() => setCacheOpen(open => !open)}
          title="Preview files: where they live, how big they are, and a button to bin them"
        >
          <Zap size={14} /> Preview cache
        </button>

        <span className="edit-chip">drag to move · edges to trim · alt disables snapping</span>
        <button className="edit-btn" onClick={() => setZoom(stepZoom(zoom, -1))} title="Zoom out">
          <ZoomOut size={14} />
        </button>
        <button className="edit-btn" onClick={() => setZoom(stepZoom(zoom, 1))} title="Zoom in">
          <ZoomIn size={14} />
        </button>
      </div>

      {cacheOpen && (
        <CachePanel
          onClose={() => setCacheOpen(false)}
          onChanged={() => { proxy.reset(); setCacheTick(value => value + 1); }}
          onToast={onToast}
        />
      )}

      <Timeline
        timeline={timeline}
        cacheSpans={spans}
        pixelsPerSecond={zoom}
        timeStore={timeStore}
        selection={selection}
        linkedSelection={linkedSelection}
        smart={edit.smart}
        onSelect={setSelection}
        onSeek={seek}
        onScrubStart={() => engineRef.current?.pause()}
        onDropAsset={handleDropAsset}
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

/**
 * How much of the timeline is backed by a preview file.
 *
 * Worth a number as well as the bar: the bar tells you where, this tells you
 * whether it is worth waiting before you hit play.
 */
function CacheChip({ spans, duration }) {
  if (!duration || spans.length === 0) return null;
  const covered = spans
    .filter(span => span.state === 'ready' || span.state === 'native')
    .reduce((total, span) => total + (span.end - span.start), 0);
  const building = spans.some(span => span.state === 'building');
  const percent = Math.round((covered / duration) * 100);

  if (spans.every(span => span.state === 'off')) {
    return <span className="edit-chip">preview files off</span>;
  }
  if (percent >= 100 && !building) return <span className="edit-chip">cached</span>;
  return (
    <span className="edit-chip" title="Preview files are built from the playhead forwards">
      {building && <RefreshCw size={10} className="spinner" />} cached {percent}%
    </span>
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
  entry, ctx, companion, onTransition, onStillSeconds, onCompanionField, onUnlink, onRelink,
  onRemoveSound, onRestoreSound, onSelectCompanion, onResetTrim, onDelete, onSplit
}) {
  const limit = maxOut(entry.clip, ctx);
  const transitionType = entry.transition?.type || 'cut';
  const trimmed = entry.clip.out !== null && entry.clip.out !== undefined;
  const isFirst = entry.index === 0;
  const hasSound = entry.resolved.kind === 'video' && entry.hasAudio;
  const sound = companion?.clip || null;
  const linked = Boolean(sound && isCompanion(sound));

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

      {/* Stills hold for an editable length — bin images and shot-stills alike. */}
      {entry.resolved.kind === 'image' && (
        <label className="edit-field">
          <span>Hold for {entry.length.toFixed(1)}s</span>
          <input
            type="number"
            min="0.5"
            max="60"
            step="0.5"
            value={Number(entry.clip.stillSeconds) > 0 ? entry.clip.stillSeconds : ''}
            placeholder={entry.length.toFixed(1)}
            onChange={(event) => {
              const value = Number(event.target.value);
              onStillSeconds(Number.isFinite(value) && value > 0 ? Math.min(60, Math.max(0.5, value)) : null);
            }}
          />
        </label>
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

      {/* Sound lives on its own clip, below the picture. Everything here acts on
          that clip — the picture's own soundtrack is never played directly once
          it has been split out, or you would hear it twice. */}
      {entry.resolved.kind === 'video' && (
        <>
          <h4 className="edit-subhead">Sound</h4>

          {!sound && !hasSound && (
            <p className="edit-note">
              This take has no audio track. Import music or a voiceover to give it sound.
            </p>
          )}

          {!sound && hasSound && (
            <>
              <p className="edit-note">This clip has no sound on the timeline.</p>
              <button className="edit-btn" onClick={onRestoreSound}>
                <Music size={14} /> Put its sound back on a track
              </button>
            </>
          )}

          {sound && (
            <>
              <p className="edit-note">
                {linked
                  ? 'Linked to the picture: trimming, moving, splitting or deleting this clip does the same to its sound.'
                  : 'Unlinked. The sound stays where it is when the picture moves.'}
                {' '}
                <button type="button" className="edit-link" onClick={onSelectCompanion}>
                  Select the sound clip
                </button>
              </p>

              <label className="edit-field">
                <span>Level {Math.round((sound.gain ?? 1) * 100)}%</span>
                <input
                  type="range" min="0" max="1.5" step="0.01"
                  value={sound.gain ?? 1}
                  onChange={(event) => onCompanionField({ gain: Number(event.target.value) })}
                />
              </label>
              <FadeFields audio={sound} onChange={onCompanionField} />

              <div className="edit-inspector-actions">
                <button className="edit-btn" onClick={linked ? onUnlink : onRelink}>
                  {linked
                    ? <><Link2Off size={14} /> Unlink</>
                    : <><Link2 size={14} /> Relink</>}
                </button>
                <button className="edit-btn" onClick={onRemoveSound} title="Take this clip's sound off the timeline">
                  <Trash2 size={14} /> Remove sound
                </button>
              </div>
            </>
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

function AudioInspector({ entry, anchor, nearestVideo, onField, onUnlink, onLink, onSelectAnchor, onDelete }) {
  const linked = Boolean(entry.clip.link);
  const paired = isCompanion(entry.clip);

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
        <dd>
          {linked
            ? `${anchor?.resolved?.name || 'picture'} (${entry.clip.link.offset >= 0 ? '+' : ''}${entry.clip.link.offset.toFixed(2)}s)`
            : 'nothing'}
        </dd>
      </dl>

      {paired && (
        <p className="edit-note">
          This is the sound of a picture clip, and moves and cuts with it.{' '}
          <button type="button" className="edit-link" onClick={onSelectAnchor}>
            Select the picture
          </button>
        </p>
      )}

      {/* Nudging sync is a deliberate act, so it is a field rather than a drag —
          dragging either half of a pair moves both, which is what you want
          ninety-nine times out of a hundred. */}
      {paired && (
        <label className="edit-field">
          <span>Slip sync {entry.clip.link.offset >= 0 ? '+' : ''}{entry.clip.link.offset.toFixed(2)}s</span>
          <input
            type="range" min="-2" max="2" step="0.01"
            value={entry.clip.link.offset}
            onChange={(event) => onField({
              link: { ...entry.clip.link, offset: Number(event.target.value) }
            })}
          />
        </label>
      )}

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

/**
 * The transport clock, off the React render path: subscribes to the time
 * store and writes textContent directly, throttled to ~10Hz — plenty for a
 * hundredths readout, and none of it re-renders anything else.
 */
function TransportClock({ store, duration }) {
  const ref = useRef(null);

  useEffect(() => {
    let last = 0;
    const write = (time) => {
      if (ref.current) ref.current.textContent = formatTime(time);
    };
    write(store.get());
    const unsubscribe = store.subscribe((time) => {
      const now = performance.now();
      if (now - last < 100) return;
      last = now;
      write(time);
    });
    return unsubscribe;
  }, [store]);

  return (
    <span className="edit-clock">
      <strong ref={ref}>{formatTime(store.get())}</strong> / {formatTime(duration)}
    </span>
  );
}

/**
 * Place any lip-sync audio the shots carry, on its own track.
 *
 * Tracks holding imported (asset-kind) audio survive: replacing `edit.audio`
 * wholesale used to destroy a music bed every time the running order was
 * rebuilt. Shot-derived dialogue tracks are dropped and rebuilt fresh; within
 * a kept track, only its asset clips survive (its shot clips would dangle).
 */
function withDerivedAudio(edit, scenes) {
  const keptTracks = (edit.audio || [])
    .filter(track => (track.clips || []).some(clip => clip.source?.kind === 'asset'))
    .map(track => ({ ...track, clips: track.clips.filter(clip => clip.source?.kind === 'asset') }));

  const clips = deriveAudioClipsForShots(scenes, edit.video);
  if (clips.length === 0) return { ...edit, audio: keptTracks };
  const track = createAudioTrack('Dialogue');
  return { ...edit, audio: [...keptTracks, { ...track, clips }] };
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
