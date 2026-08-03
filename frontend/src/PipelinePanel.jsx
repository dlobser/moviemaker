// One panel, one button: idea → script → assets → prompts → images → select →
// videos → timeline. Presentational — the stage list, live counts, cost
// estimate and run snapshots all arrive from App; the run itself is
// frontend/src/pipeline.js.

import React from 'react';
import { X, Play, Pause, StopCircle, RefreshCw, Zap, Sparkles } from 'lucide-react';

const STATUS_LABEL = {
  pending: 'waiting',
  skipped: 'skipped',
  running: 'running',
  done: 'done',
  cancelled: 'stopped'
};

export default function PipelinePanel({
  stages,            // [{ id, label, count }] — count is the live candidate count
  estimate,          // [{ stageId, count, knownCost, creditRuns, skipped }] | null
  skip,              // Set<stageId>
  onToggleSkip,
  runState,          // pipeline snapshot | null
  running,           // boolean: a live controller exists and is not finished
  idea, onIdeaChange, showIdeaBox,
  llmControls,       // rendered LLM/model pickers from App
  onRun, onPause, onResume, onCancel,
  onClose
}) {
  const knownTotal = (estimate || []).reduce((sum, row) => sum + (row.skipped ? 0 : row.knownCost), 0);
  const creditTotal = (estimate || []).reduce((sum, row) => sum + (row.skipped ? 0 : row.creditRuns), 0);
  const paused = runState?.status === 'paused';

  return (
    <div className="modal-overlay" onClick={running ? undefined : onClose}>
      <div className="modal-window" style={{ maxWidth: '640px' }} onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Zap size={20} /> Pipeline — one-button generate
          </h2>
          <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {showIdeaBox && (
            <div className="form-group">
              <label className="form-label">
                Idea
                <span style={{ marginLeft: '8px', fontWeight: 'normal', color: 'var(--text-dim)', fontSize: '0.75rem' }}>
                  the project is empty — describe the film and the script stage writes it
                </span>
              </label>
              <textarea
                className="input-field"
                style={{ minHeight: '90px' }}
                value={idea}
                onChange={(event) => onIdeaChange(event.target.value)}
                placeholder="A retired mechanic discovers his junkyard robot has been rebuilding itself at night…"
                disabled={running}
              />
              {llmControls}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {stages.map(stage => {
              const stageRun = runState?.stageStates?.[stage.id];
              const skipped = skip.has(stage.id);
              const row = (estimate || []).find(r => r.stageId === stage.id);
              return (
                <div
                  key={stage.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 10px',
                    borderRadius: '6px', background: 'rgba(0,0,0,0.18)',
                    opacity: skipped ? 0.45 : 1, fontSize: '0.85rem'
                  }}
                >
                  <input
                    type="checkbox"
                    checked={!skipped}
                    disabled={running}
                    onChange={() => onToggleSkip(stage.id)}
                    title={skipped ? 'Skipped — tick to include' : 'Included — untick to skip'}
                  />
                  <span style={{ flex: 1 }}>{stage.label}</span>

                  {row && !skipped && (
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                      {row.count} candidate{row.count === 1 ? '' : 's'}
                      {row.knownCost > 0 ? ` · ~$${row.knownCost.toFixed(2)}` : ''}
                      {row.creditRuns > 0 ? ` · ${row.creditRuns} credit-priced` : ''}
                    </span>
                  )}

                  {stageRun && stageRun.status !== 'pending' && (
                    <span style={{
                      fontSize: '0.72rem', fontWeight: 600,
                      color: stageRun.status === 'running' ? 'var(--primary)'
                        : stageRun.failed?.length ? 'var(--warning, #f59e0b)'
                        : stageRun.status === 'done' ? 'var(--success)' : 'var(--text-dim)'
                    }}>
                      {stageRun.status === 'running' && <RefreshCw size={10} className="spinner" style={{ marginRight: 4 }} />}
                      {stageRun.status === 'skipped'
                        ? 'skipped'
                        : `${stageRun.done}/${stageRun.total}${stageRun.failed?.length ? ` (${stageRun.failed.length} failed)` : ''} ${STATUS_LABEL[stageRun.status] || ''}`}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {estimate && (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Estimated: {knownTotal > 0 ? `~$${knownTotal.toFixed(2)} at published rates` : 'no flat-priced work'}
              {creditTotal > 0 ? `, plus ${creditTotal} credit-priced run${creditTotal === 1 ? '' : 's'}` : ''}.
              <span style={{ color: 'var(--text-dim)' }}> Candidates re-derive from project state — rerunning after a stop only does what is still missing.</span>
            </div>
          )}

          {runState?.stageStates && Object.values(runState.stageStates).some(s => s.failed?.length) && (
            <div style={{ fontSize: '0.75rem', color: 'var(--warning, #f59e0b)' }}>
              {Object.entries(runState.stageStates)
                .filter(([, s]) => s.failed?.length)
                .map(([id, s]) => `${id}: ${s.failed.map(f => `${f.id} (${f.error})`).join(', ')}`)
                .join(' · ')}
            </div>
          )}
        </div>

        <div className="modal-footer">
          {!running && (
            <button className="btn btn-primary" onClick={onRun}>
              <Sparkles size={14} /> Run pipeline
            </button>
          )}
          {running && !paused && (
            <button className="btn btn-secondary" onClick={onPause}><Pause size={14} /> Pause</button>
          )}
          {running && paused && (
            <button className="btn btn-primary" onClick={onResume}><Play size={14} /> Resume</button>
          )}
          {running && (
            <button className="btn btn-danger" onClick={onCancel}><StopCircle size={14} /> Stop</button>
          )}
        </div>
      </div>
    </div>
  );
}
