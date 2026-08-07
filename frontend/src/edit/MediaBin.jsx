// The media bin: external video, audio and stills brought into the edit.
//
// A curated list on the edit document, not a folder scan — assets/ holds
// hundreds of generated iterations that would drown one. Rows drag onto the
// timeline via native HTML5 DnD (the bin lives outside Timeline's
// pointer-event world, and native DnD leaves its drag state machine alone).

import React, { useRef, useState } from 'react';
import { Film, Music, Image as ImageIcon, FolderOpen, Upload, X } from 'lucide-react';
import { apiFetch } from '../client.js';

export const BIN_DRAG_TYPE = 'application/x-mm-bin-item';

const TYPE_ICON = { video: Film, audio: Music, image: ImageIcon };

export default function MediaBin({ bin, durations, onImportFiles, onAddItems, onRemove, onToast }) {
  const inputRef = useRef(null);
  const [picker, setPicker] = useState(null); // null | { entries: [...] | null }
  const [dropActive, setDropActive] = useState(false);

  const openProjectPicker = async () => {
    setPicker({ entries: null });
    try {
      const res = await apiFetch('/api/project-media');
      const entries = await res.json();
      if (!res.ok) throw new Error(entries.error || 'listing failed');
      const inBin = new Set(bin.map(item => item.path));
      setPicker({ entries: entries.filter(entry => !inBin.has(entry.path)) });
    } catch (error) {
      onToast?.(`Could not list project media: ${error.message}`, 'error');
      setPicker(null);
    }
  };

  const durationLabel = (path) => {
    const probe = durations?.[path];
    if (!probe) return '';
    if (probe.isImage) return 'still';
    const seconds = Number(probe.duration);
    return Number.isFinite(seconds) && seconds > 0 ? `${seconds.toFixed(1)}s` : '';
  };

  return (
    <div
      className={`edit-bin ${dropActive ? 'is-drop' : ''}`}
      onDragOver={(event) => {
        if ([...event.dataTransfer.types].includes('Files')) {
          event.preventDefault();
          setDropActive(true);
        }
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(event) => {
        setDropActive(false);
        const files = [...(event.dataTransfer.files || [])];
        if (files.length === 0) return;
        event.preventDefault();
        onImportFiles(files);
      }}
    >
      <div className="edit-bin-head">
        <strong>Bin</strong>
        <button className="edit-mini" onClick={() => inputRef.current?.click()} title="Import files from disk">
          <Upload size={12} />
        </button>
        <button className="edit-mini" onClick={openProjectPicker} title="Add media already in the project folder">
          <FolderOpen size={12} />
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="video/*,audio/*,image/*"
          style={{ display: 'none' }}
          onChange={(event) => {
            const files = [...(event.target.files || [])];
            event.target.value = '';
            if (files.length > 0) onImportFiles(files);
          }}
        />
      </div>

      {bin.length === 0 ? (
        <p className="edit-bin-empty">
          Drop video, audio or images here — or pull them from the project folder — then drag them onto the timeline.
        </p>
      ) : (
        <div className="edit-bin-list">
          {bin.map(item => {
            const Icon = TYPE_ICON[item.type] || Film;
            return (
              <div
                key={item.id}
                className="edit-bin-row"
                title={item.path}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(BIN_DRAG_TYPE, JSON.stringify(item));
                  event.dataTransfer.effectAllowed = 'copy';
                }}
              >
                <Icon size={12} />
                <span className="edit-bin-name">{item.name}</span>
                <span className="edit-bin-length">{durationLabel(item.path)}</span>
                <button
                  className="edit-mini"
                  title="Remove from the bin (the file and any clips already on the timeline stay)"
                  onClick={() => onRemove(item.id)}
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {picker && (
        <div className="modal-overlay" onClick={() => setPicker(null)}>
          <div className="modal-window" style={{ maxWidth: '520px' }} onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ fontSize: '1rem' }}><FolderOpen size={16} /> Add from project folder</h2>
              <button className="edit-mini" onClick={() => setPicker(null)}><X size={13} /></button>
            </div>
            <div className="modal-body" style={{ maxHeight: '50vh', overflowY: 'auto' }}>
              {picker.entries === null ? (
                <p className="edit-empty">Reading the project folder…</p>
              ) : picker.entries.length === 0 ? (
                <p className="edit-empty">Everything usable is already in the bin.</p>
              ) : (
                <div className="edit-bin-list">
                  {picker.entries.map(entry => {
                    const Icon = TYPE_ICON[entry.type] || Film;
                    return (
                      <button
                        key={entry.path}
                        className="edit-bin-row as-button"
                        onClick={() => {
                          onAddItems([entry]);
                          setPicker(prev => (prev ? { entries: prev.entries.filter(e => e.path !== entry.path) } : prev));
                        }}
                        title={`Add ${entry.name} to the bin`}
                      >
                        <Icon size={12} />
                        <span className="edit-bin-name">{entry.name}</span>
                        <span className="edit-bin-length">{entry.type}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
