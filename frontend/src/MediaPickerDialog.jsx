// Pick a shot's active still or clip from anywhere in the project.
//
// Replaces a button that only appeared when the slot was already empty and
// opened the master gallery — a management screen with no way to assign
// anything to a shot. So a shot that already had an image was stuck with it,
// and the reference board and asset artwork were unreachable either way.

import React from 'react';
import { Check, ImageIcon, Search, X } from 'lucide-react';
import { AssetImage, AssetVideo } from './AssetMedia.jsx';
import { countShotMedia, filterShotMedia } from './imagePicker.js';

export default function MediaPickerDialog({
  kind = 'image',
  groups = [],
  currentPath = null,
  shotName = '',
  onPick,
  onClear,
  onClose
}) {
  const [query, setQuery] = React.useState('');
  const visible = filterShotMedia(groups, query);
  const total = countShotMedia(groups);
  const shown = countShotMedia(visible);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-window gallery-modal-window" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ImageIcon size={20} />
            Choose {kind === 'video' ? 'a clip' : 'an image'}{shotName ? ` for ${shotName}` : ''}
          </h2>
          <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '14px' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }} />
              <input
                autoFocus
                type="text"
                className="input-field"
                style={{ paddingLeft: '30px' }}
                placeholder="Search by name, tag or filename…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
              {query ? `${shown} of ${total}` : `${total} available`}
            </span>
            {currentPath && (
              <button className="btn btn-secondary" onClick={onClear} title="Leave this slot empty">
                Clear slot
              </button>
            )}
          </div>

          {visible.length === 0 && (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-dim)' }}>
              {total === 0
                ? `Nothing in this project yet — generate or upload ${kind === 'video' ? 'a clip' : 'an image'} first.`
                : 'Nothing matches that search.'}
            </div>
          )}

          {visible.map(group => (
            <div key={group.label} style={{ marginBottom: '18px' }}>
              <h4 style={{
                fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em',
                color: 'var(--text-dim)', marginBottom: '8px'
              }}>
                {group.label} <span style={{ opacity: 0.6 }}>({group.items.length})</span>
              </h4>
              <div className="media-grid">
                {group.items.map(item => {
                  const active = item.path === currentPath;
                  return (
                    <div
                      key={item.path}
                      className="media-card"
                      style={{
                        cursor: 'pointer',
                        outline: active ? '2px solid var(--primary-hover, #8b5cf6)' : 'none',
                        outlineOffset: '2px'
                      }}
                      onClick={() => onPick(item.path)}
                      title={item.path}
                    >
                      <div className="media-thumb-container" style={{ position: 'relative' }}>
                        {kind === 'video'
                          ? <AssetVideo path={item.path} muted />
                          : <AssetImage path={item.path} alt={item.name} />}
                        {active && (
                          <div style={{
                            position: 'absolute', top: '6px', right: '6px',
                            background: 'var(--primary-hover, #8b5cf6)', borderRadius: '50%',
                            width: '20px', height: '20px', display: 'flex',
                            alignItems: 'center', justifyContent: 'center'
                          }}>
                            <Check size={12} color="#fff" />
                          </div>
                        )}
                      </div>
                      <div className="media-info" style={{ fontSize: '0.75rem' }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.name}
                        </div>
                        {item.note && (
                          <div style={{ color: 'var(--primary-hover)', fontSize: '0.7rem' }}>{item.note}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
