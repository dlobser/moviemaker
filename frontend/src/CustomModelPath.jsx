// The custom model path field: a path, plus which host to send it to.
//
// The host used to be inferred from the path's prefix, which stopped working
// once the same vendor namespaces appeared on both services —
// `bytedance/seedance-2.0/image-to-video` is a Fal model and
// `bytedance/seedance/v1/pro/image-to-video` is a Higgsfield one, and no rule
// separates them. "Auto" keeps the old guess for everything already saved;
// picking a host stores it in the id as `fal:…` / `higgsfield:…`.

import React from 'react';
import { MODEL_FAMILIES, formatModelId, parseModelId } from './catalog.js';

const HINTS = {
  'fal-ai': 'fal.ai/models/<this is the path> — the id is whatever follows /models/ in the URL.',
  higgsfield: 'The model id from the Higgsfield gallery, e.g. higgsfield-ai/dop/standard.',
  atlas: 'atlascloud.ai/models/<this is the path> — the id is whatever follows /models/ in the URL.',
  auto: 'Guessed from the path: known vendor prefixes go to Higgsfield, anything else to Fal.ai. Pick a host if that guess is wrong.'
};

export default function CustomModelPath({ label, value, onChange, placeholder, disabled, refImagesOverride, onRefImagesOverride }) {
  const { family, path } = parseModelId(value);

  /**
   * Take a host typed into the path box as a host, not as part of the path.
   *
   * The field shows the path alone while the dropdown beside it holds the
   * host, so pasting a whole `higgsfield:higgsfield-ai/soul/standard` used to
   * store the prefix twice — and `platform.higgsfield.ai/higgsfield:higgsfield-ai/…`
   * answers `model_not_found`, which reads exactly like a wrong model name.
   */
  const handlePathChange = (typed) => {
    const parsed = parseModelId(typed);
    onChange(formatModelId(parsed.family || family, parsed.path));
  };

  return (
    <div className="form-group">
      <label className="form-label">{label}</label>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <input
          type="text"
          className="input-field"
          style={{ flex: '1 1 260px', minWidth: 0 }}
          value={path}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => handlePathChange(e.target.value)}
        />
        <select
          className="select-field"
          style={{ flex: '0 0 150px' }}
          value={family || 'auto'}
          disabled={disabled}
          onChange={(e) => onChange(formatModelId(e.target.value === 'auto' ? null : e.target.value, path))}
          title="Which service this path is served by"
        >
          <option value="auto">Auto-detect</option>
          {MODEL_FAMILIES.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </div>
      <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
        {HINTS[family || 'auto']}
      </span>
      {onRefImagesOverride && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
          <label className="form-label" style={{ margin: 0 }}>Reference images it accepts</label>
          <input
            type="number"
            className="input-field"
            style={{ width: '80px' }}
            min={0}
            max={16}
            value={Number.isFinite(refImagesOverride) ? refImagesOverride : ''}
            placeholder="1"
            disabled={disabled}
            onChange={(e) => {
              const n = e.target.value === '' ? null : Math.max(0, Math.min(16, Number(e.target.value)));
              onRefImagesOverride(Number.isFinite(n) ? n : null);
            }}
            title="The catalog cannot know a custom path's input-image ceiling; without this it assumes 1 and a multi-reference model silently loses the rest."
          />
          <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>blank = assume 1</span>
        </div>
      )}
    </div>
  );
}
