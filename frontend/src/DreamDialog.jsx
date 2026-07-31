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
  IMAGE_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
  PROVIDER_LABELS,
  getVideoModel,
  groupedModelOptions,
  priceLabel
} from './catalog.js';
import { DEFAULT_DREAM_SYSTEM_PROMPT, describeAssetLibrary } from './dream.js';

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

  const allShots = scenes.flatMap(scene => (scene.shots || []).map(shot => ({ shot, scene })));
  const startShot = allShots.find(entry => entry.shot.id === settings.startShotId)?.shot || null;

  const videoModelId = settings.videoModel || defaults.videoModel;
  const videoModel = getVideoModel(videoModelId);
  const iterations = Math.max(1, Number(settings.iterations) || 1);

  // What the run will actually pay for: every clip needs a video, and the first
  // one needs a still too unless the starting shot already has one.
  const videosToMake = iterations - (startShot?.selectedVideo ? 1 : 0);
  const imagesToMake = startShot && !startShot.selectedImage ? 1 : 0;
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
          <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: 1.6, marginTop: 0 }}>
            One continuous shot, generated a clip at a time. Each clip is animated from the last frame of the
            one before it, and the LLM looks at that frame before writing what happens next — so where it ends
            up is a surprise, inside the boundaries you set here. Every clip lands in your shot list as an
            ordinary shot.
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
              Whatever this shot already has is reused. Missing image or video gets generated first, then the
              dream starts from it.
            </span>
          </div>

          <div className="form-group">
            <label className="form-label">Standing instructions for the LLM</label>
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
            <div className="form-group" style={{ flex: '0 0 140px' }}>
              <label className="form-label">Clips</label>
              <input
                className="input-field"
                type="number"
                min={1}
                max={60}
                disabled={running}
                value={settings.iterations}
                onChange={(e) => set({ iterations: Math.max(1, Math.min(60, Number(e.target.value) || 1)) })}
              />
            </div>
            <div className="form-group" style={{ flex: '1 1 220px' }}>
              <label className="form-label">Video model</label>
              <select
                className="select-field"
                disabled={running}
                value={videoModelId}
                onChange={(e) => set({ videoModel: e.target.value })}
              >
                <ModelOptions models={VIDEO_MODELS} unit="video" />
              </select>
            </div>
            <div className="form-group" style={{ flex: '0 0 150px' }}>
              <label className="form-label">Clip length</label>
              <select
                className="select-field"
                disabled={running}
                value={settings.videoDuration || defaults.videoDuration || '5'}
                onChange={(e) => set({ videoDuration: e.target.value })}
              >
                <option value="5">5 seconds</option>
                <option value="10">10 seconds</option>
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
                {VIDEO_RESOLUTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
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
                    value={settings.imageModel || defaults.imageModel}
                    onChange={(e) => set({ imageModel: e.target.value })}
                  >
                    <ModelOptions models={IMAGE_MODELS} unit="img" />
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
                    {IMAGE_ASPECT_RATIOS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                </div>
              </div>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                Only used when the starting shot has no image yet. Every later clip is animated from a captured
                frame, so no other image is ever generated.
              </span>
            </div>
          )}

          {/* --- what this run will do --- */}
          <div className="glass-panel" style={{ padding: '14px', background: 'rgba(139,92,246,0.06)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ fontSize: '0.95rem', fontWeight: 'bold' }}>
              {iterations} clip{iterations === 1 ? '' : 's'}
              {videoModel?.priceNote && !videoUnitPrice ? '' : ''}
              {settings.videoDuration || defaults.videoDuration
                ? ` — about ${iterations * Number(settings.videoDuration || defaults.videoDuration || 5)} seconds of film`
                : ''}
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              {videosToMake} video{videosToMake === 1 ? '' : 's'}
              {imagesToMake > 0 ? ' and 1 opening image' : ''} will be generated
              {startShot?.selectedVideo ? `, reusing ${startShot.name}'s existing clip` : ''}.
            </div>
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
            <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
              {cast
                ? `${assetLibrary.length} defined asset${assetLibrary.length === 1 ? '' : 's'} will be offered to the LLM, tags and all.`
                : 'No assets defined — the dream will invent its own world.'}
            </div>
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
              <Play size={14} /> Dream {iterations} clip{iterations === 1 ? '' : 's'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
