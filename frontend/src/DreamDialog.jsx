// The Dream panel: set a dream up, start it, watch it run.
//
// Deliberately a single self-contained dialog rather than another surface bolted
// onto the shot cards — dream mode is its own thing, and nothing outside this
// file and the runner in App.jsx knows it exists.

import React from 'react';
import { Moon, X, StopCircle, Play, RotateCcw, AlertTriangle, Check, RefreshCw } from 'lucide-react';
import {
  IMAGE_MODELS,
  VIDEO_MODELS,
  PROVIDER_LABELS,
  durationOptions,
  sizeOptions,
  getVideoModel,
  groupedModelOptions,
  isKnownImageModel,
  isKnownVideoModel,
  priceLabel
} from './catalog.js';
import { DEFAULT_DREAM_SYSTEM_PROMPT, describeAssetLibrary } from './dream.js';
import CustomModelPath from './CustomModelPath.jsx';

function ModelOptions({ models, unit }) {
  return groupedModelOptions(models).map(group => (
    <optgroup key={group.provider} label={PROVIDER_LABELS[group.provider] || group.provider}>
      {group.models.map(model => {
        const price = priceLabel(model, unit);
        return (
          <option key={model.id} value={model.id}>
            {model.label}{price ? ` — ${price}` : ''}
          </option>
        );
      })}
    </optgroup>
  ));
}

const LOG_COLOURS = {
  error: 'var(--accent)',
  done: 'var(--success)',
  info: 'var(--text-muted)'
};

export default function DreamDialog({
  settings,
  onChange,
  scenes = [],
  assetLibrary = [],
  defaults = {},
  run = null,
  onRun,
  onStop,
  onClose
}) {
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const logRef = React.useRef(null);

  // Follow the log as the dream writes to it — the interesting line is always
  // the newest one, and a run can outlast the panel's height in a few clips.
  React.useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [run?.log?.length]);

  const set = (patch) => onChange({ ...settings, ...patch });

  const allShots = scenes.flatMap(scene => (scene.shots || []).map(shot => shot));
  const startIndex = allShots.findIndex(shot => shot.id === settings.startShotId);
  const startShot = startIndex === -1 ? null : allShots[startIndex];

  const chaining = settings.mode === 'chain';
  // Chaining can only ever reach the end of the timeline.
  const available = startIndex === -1 ? 0 : allShots.length - startIndex;
  const requested = Math.max(1, Number(settings.iterations) || 1);
  const iterations = chaining ? Math.min(requested, Math.max(1, available)) : requested;

  // In chain mode the shots are known up front, which makes a real pre-flight
  // possible: a shot with nothing written on it stops the run when it is
  // reached, so say so before anything is spent.
  const chainShots = chaining && startShot ? allShots.slice(startIndex, startIndex + iterations) : [];
  const chainWithoutPrompt = chainShots
    .slice(1)
    .filter(shot => !String(shot.draftVideoPrompt || shot.description || '').trim());

  // `null` means "whatever the project is set to"; an empty string means the
  // user picked Custom and has not typed the path yet. Collapsing the two with
  // `||` snapped the dropdown straight back to the project default and the
  // custom field never appeared.
  const resolveModel = (chosen, fallback) => (chosen === null || chosen === undefined ? fallback : chosen);
  const videoModelId = resolveModel(settings.videoModel, defaults.videoModel);
  const imageModelId = resolveModel(settings.imageModel, defaults.imageModel);
  const videoModel = getVideoModel(videoModelId);

  // What the run will actually pay for: every clip needs a video, and the first
  // one needs a still too unless the starting shot already has one.
  const videosToMake = iterations - (startShot?.selectedVideo ? 1 : 0);
  const imagesToMake = startShot && !startShot.selectedImage && !startShot.selectedVideo ? 1 : 0;
  const videoUnitPrice = typeof videoModel?.price === 'number' ? videoModel.price : null;

  const cast = describeAssetLibrary(assetLibrary);
  const running = Boolean(run && run.active);

  const startBlocker = (() => {
    if (!startShot) return 'Pick a shot to start from.';
    if (!startShot.selectedImage && !startShot.selectedVideo) {
      const seed = startShot.draftImagePrompt || startShot.description;
      if (!String(seed || '').trim()) {
        return `${startShot.name || 'That shot'} has no image and nothing to generate one from — give it a description first.`;
      }
    }
    if (chaining && available < 2) {
      return 'Chaining needs at least one shot after the starting one.';
    }
    // A half-filled custom path would otherwise fall back to the project's
    // model silently, which is the wrong kind of quiet.
    if (!String(videoModelId || '').trim()) {
      return 'Enter a custom video model path, or pick one from the list.';
    }
    if (imagesToMake > 0 && !String(imageModelId || '').trim()) {
      return 'Enter a custom opening image model path, or pick one from the list.';
    }
    return null;
  })();

  return (
    <div className="modal-overlay" onClick={running ? undefined : onClose}>
      <div className="modal-window" style={{ maxWidth: '680px' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Moon size={20} /> Dream
          </h2>
          <button
            className="btn btn-secondary"
            style={{ padding: '6px', borderRadius: '50%' }}
            onClick={onClose}
            title={running ? 'Close the panel — the dream keeps running' : 'Close'}
          >
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">Mode</label>
            <select
              className="select-field"
              disabled={running}
              value={settings.mode || 'invent'}
              onChange={(e) => onChange({ ...settings, mode: e.target.value })}
            >
              <option value="invent">Invent — the LLM writes each new clip</option>
              <option value="chain">Chain — walk shots I have already written</option>
            </select>
          </div>

          <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: 1.6, marginTop: 0 }}>
            {chaining ? (
              <>
                One continuous shot out of shots you already wrote. Each shot keeps its own prompt — nothing is
                rewritten and no new shots are made — but its opening still is replaced by the last frame of the
                previous clip, so the whole run plays without a cut. The LLM is not called at all, unless the
                starting shot has no prompt of its own yet.
              </>
            ) : (
              <>
                One continuous shot, generated a clip at a time. Each clip is animated from the last frame of the
                one before it, and the LLM looks at that frame before writing what happens next — so where it ends
                up is a surprise, inside the boundaries you set here. Every clip lands in your shot list as an
                ordinary shot.
              </>
            )}
          </p>

          <div className="form-group">
            <label className="form-label">Starting shot</label>
            <select
              className="select-field"
              disabled={running}
              value={settings.startShotId || ''}
              onChange={(e) => set({ startShotId: e.target.value || null })}
            >
              <option value="">— pick a shot —</option>
              {scenes.map(scene => (
                <optgroup key={scene.id} label={scene.name}>
                  {(scene.shots || []).map(shot => (
                    <option key={shot.id} value={shot.id}>
                      {shot.name}
                      {shot.selectedVideo ? ' — has video' : shot.selectedImage ? ' — has image' : ' — empty'}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
              {chaining
                ? 'The chain walks forward from here in timeline order, across scene boundaries.'
                : 'Whatever this shot already has is reused. A missing image is drawn from its description; a missing prompt is written by reading its image.'}
            </span>
          </div>

          <div className="form-group">
            <label className="form-label">
              Standing instructions for the LLM
              {chaining && <span style={{ color: 'var(--text-dim)', fontWeight: 'normal' }}> — only used if the starting shot has no prompt</span>}
            </label>
            <textarea
              className="input-field"
              rows={5}
              disabled={running}
              placeholder={
                'The boundaries every clip has to stay inside. For example:\n\n' +
                'Stay underwater. The camera never cuts and never rises above the surface. ' +
                'Everything is lit by whatever light reaches down from above. Things get stranger and larger the deeper we go.'
              }
              value={settings.instructions || ''}
              onChange={(e) => set({ instructions: e.target.value })}
            />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
              Added on top of the dream system prompt below — it does not replace it.
            </span>
          </div>

          <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
            <div className="form-group" style={{ flex: '0 0 160px' }}>
              <label className="form-label">{chaining ? 'Shots to chain' : 'Clips'}</label>
              <input
                className="input-field"
                type="number"
                min={1}
                max={chaining ? Math.max(1, available) : 60}
                disabled={running}
                value={settings.iterations}
                onChange={(e) => set({ iterations: Math.max(1, Math.min(60, Number(e.target.value) || 1)) })}
              />
              {chaining && startShot && (
                <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                  {available} available from here
                </span>
              )}
            </div>
            <div className="form-group" style={{ flex: '1 1 220px' }}>
              <label className="form-label">Video model</label>
              <select
                className="select-field"
                disabled={running}
                value={isKnownVideoModel(videoModelId) ? videoModelId : 'custom'}
                onChange={(e) => set({ videoModel: e.target.value === 'custom' ? '' : e.target.value })}
              >
                <ModelOptions models={VIDEO_MODELS} unit="video" />
                <option value="custom">Custom model path…</option>
              </select>
            </div>
            {!isKnownVideoModel(videoModelId) && (
              <div style={{ flex: '1 1 100%' }}>
                <CustomModelPath
                  label="Custom video model"
                  value={videoModelId}
                  disabled={running}
                  onChange={(next) => set({ videoModel: next })}
                  placeholder="e.g. bytedance/seedance-2.0/image-to-video"
                />
              </div>
            )}
            <div className="form-group" style={{ flex: '0 0 150px' }}>
              <label className="form-label">Clip length</label>
              <select
                className="select-field"
                disabled={running}
                value={settings.videoDuration || defaults.videoDuration || '5'}
                onChange={(e) => set({ videoDuration: e.target.value })}
              >
                {durationOptions(videoModelId, settings.videoDuration || defaults.videoDuration || '5')
                  .map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ flex: '1 1 200px' }}>
              <label className="form-label">Video resolution</label>
              <select
                className="select-field"
                disabled={running}
                value={settings.videoResolution || defaults.videoResolution || '1280x720'}
                onChange={(e) => set({ videoResolution: e.target.value })}
              >
                {sizeOptions('video', videoModelId, settings.videoResolution || defaults.videoResolution)
                  .map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
          </div>

          <button
            className="btn btn-secondary"
            style={{ marginBottom: '12px' }}
            onClick={() => setShowAdvanced(v => !v)}
          >
            {showAdvanced ? 'Hide' : 'Show'} the dream prompt and opening-image settings
          </button>

          {showAdvanced && (
            <div className="glass-panel" style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '14px' }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>Dream system prompt</span>
                  <button
                    className="btn btn-secondary"
                    style={{ padding: '3px 8px', fontSize: '0.72rem' }}
                    disabled={running}
                    onClick={() => set({ systemPrompt: DEFAULT_DREAM_SYSTEM_PROMPT })}
                  >
                    <RotateCcw size={11} /> Reset
                  </button>
                </label>
                <textarea
                  className="input-field"
                  rows={10}
                  disabled={running}
                  value={settings.systemPrompt || DEFAULT_DREAM_SYSTEM_PROMPT}
                  onChange={(e) => set({ systemPrompt: e.target.value })}
                />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                  Used only by Dream. It must keep asking for the JSON reply, or a clip's description stops
                  being filled in.
                </span>
              </div>

              <div className="form-group" style={{ margin: 0, maxWidth: '220px' }}>
                <label className="form-label">Clips recapped to the LLM</label>
                <select
                  className="select-field"
                  disabled={running}
                  value={settings.historyDepth}
                  onChange={(e) => set({ historyDepth: Number(e.target.value) })}
                >
                  {[0, 1, 2, 3, 5, 8].map(n => (
                    <option key={n} value={n}>{n === 0 ? 'none — only the frame' : `${n} previous`}</option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
                <div className="form-group" style={{ flex: '1 1 220px', margin: 0 }}>
                  <label className="form-label">Opening image model</label>
                  <select
                    className="select-field"
                    disabled={running}
                    value={isKnownImageModel(imageModelId) ? imageModelId : 'custom'}
                    onChange={(e) => set({ imageModel: e.target.value === 'custom' ? '' : e.target.value })}
                  >
                    <ModelOptions models={IMAGE_MODELS} unit="img" />
                    <option value="custom">Custom model path…</option>
                  </select>
                </div>
                <div className="form-group" style={{ flex: '0 0 200px', margin: 0 }}>
                  <label className="form-label">Opening image ratio</label>
                  <select
                    className="select-field"
                    disabled={running}
                    value={settings.imageResolution || defaults.imageResolution}
                    onChange={(e) => set({ imageResolution: e.target.value })}
                  >
                    {sizeOptions('image', imageModelId, settings.imageResolution || defaults.imageResolution)
                      .map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                </div>
              </div>
              {!isKnownImageModel(imageModelId) && (
                <CustomModelPath
                  label="Custom opening image model"
                  value={imageModelId}
                  disabled={running}
                  onChange={(next) => set({ imageModel: next })}
                  placeholder="e.g. black-forest-labs/flux-dev"
                />
              )}
              <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                Only used when the starting shot has no image yet. Every later clip is animated from a captured
                frame, so no other image is ever generated.
              </span>
            </div>
          )}

          {/* --- what this run will do --- */}
          <div className="glass-panel" style={{ padding: '14px', background: 'rgba(139,92,246,0.06)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ fontSize: '0.95rem', fontWeight: 'bold' }}>
              {iterations} {chaining ? 'shot' : 'clip'}{iterations === 1 ? '' : 's'}
              {settings.videoDuration || defaults.videoDuration
                ? ` — about ${iterations * Number(settings.videoDuration || defaults.videoDuration || 5)} seconds of film`
                : ''}
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              {videosToMake} video{videosToMake === 1 ? '' : 's'}
              {imagesToMake > 0 ? ' and 1 opening image' : ''} will be generated
              {startShot?.selectedVideo ? `, reusing ${startShot.name}'s existing clip` : ''}.
            </div>
            {chaining && chainShots.length > 0 && (
              <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)', lineHeight: 1.5 }}>
                Walking: {chainShots.map(s => s.name).join(' → ')}
              </div>
            )}
            {chaining && (
              <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
                Each chained shot keeps its own prompt but is re-rendered on the incoming frame, with this
                dialog's model and length rather than its own. Earlier takes stay in the shot's gallery.
              </div>
            )}
            {chaining && chainWithoutPrompt.length > 0 && (
              <div style={{ fontSize: '0.78rem', color: 'var(--accent)', display: 'flex', alignItems: 'flex-start', gap: '4px' }}>
                <AlertTriangle size={12} style={{ marginTop: '3px', flexShrink: 0 }} />
                <span>
                  {chainWithoutPrompt.length} shot{chainWithoutPrompt.length === 1 ? ' has' : 's have'} no prompt
                  or description — the run stops there. ({chainWithoutPrompt.map(s => s.name).join(', ')})
                </span>
              </div>
            )}
            {videoUnitPrice !== null && (
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Estimated video cost: <strong>${(videoUnitPrice * Math.max(0, videosToMake)).toFixed(2)}</strong>
              </div>
            )}
            {videoModel?.priceNote && videoUnitPrice === null && (
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Pricing: {videoModel.priceNote} — × {Math.max(0, videosToMake)}.
              </div>
            )}
            {!chaining && (
              <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
                {cast
                  ? `${assetLibrary.length} defined asset${assetLibrary.length === 1 ? '' : 's'} will be offered to the LLM, tags and all.`
                  : 'No assets defined — the dream will invent its own world.'}
              </div>
            )}
            {startBlocker && (
              <div style={{ fontSize: '0.78rem', color: 'var(--accent)', display: 'flex', alignItems: 'flex-start', gap: '4px' }}>
                <AlertTriangle size={12} style={{ marginTop: '3px', flexShrink: 0 }} />
                <span>{startBlocker}</span>
              </div>
            )}
          </div>

          {/* --- live run --- */}
          {run && (
            <div className="glass-panel" style={{ padding: '14px', marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.9rem', fontWeight: 'bold' }}>
                {run.active
                  ? <RefreshCw className="spinner" size={14} />
                  : run.failed ? <AlertTriangle size={14} color="var(--accent)" /> : <Check size={14} color="var(--success)" />}
                <span>
                  {run.active ? `Clip ${run.clip} of ${run.total}` : run.stopped ? 'Dream stopped' : run.failed ? 'Dream ended early' : 'Dream complete'}
                  {run.phase && run.active ? ` — ${run.phase}` : ''}
                </span>
              </div>

              <div style={{ height: '5px', borderRadius: '3px', background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: `${Math.min(100, Math.round(((run.completed || 0) / Math.max(1, run.total)) * 100))}%`,
                  background: 'var(--primary-hover, #8b5cf6)',
                  transition: 'width 0.3s ease'
                }} />
              </div>

              <div
                ref={logRef}
                style={{ maxHeight: '160px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '0.78rem', fontFamily: 'monospace' }}
              >
                {(run.log || []).map((entry, i) => (
                  <span key={i} style={{ color: LOG_COLOURS[entry.level] || 'var(--text-muted)' }}>
                    {entry.text}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            {running ? 'Run in the background' : 'Close'}
          </button>
          {running ? (
            <button className="btn btn-secondary" style={{ color: 'var(--accent)' }} onClick={onStop}>
              <StopCircle size={14} /> Stop after this clip
            </button>
          ) : (
            <button className="btn btn-primary" onClick={onRun} disabled={Boolean(startBlocker)}>
              <Play size={14} /> {chaining
                ? `Chain ${iterations} shot${iterations === 1 ? '' : 's'}`
                : `Dream ${iterations} clip${iterations === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
