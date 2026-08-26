// The preview cache's settings, and the only place its existence is admitted.
//
// It is a work folder full of disposable transcodes, so the controls are the
// three things that actually matter: where it lives (put it on a fast local
// disk, especially if the project is not on one), how small the proxies are,
// and a button to throw them all away.

import React, { useEffect, useState } from 'react';
import { FolderOpen, RefreshCw, Trash2, X, Zap } from 'lucide-react';
import { apiFetch, isStatic } from '../client.js';

/** Proxy heights worth offering. Smaller is faster; 360 is the sweet spot. */
const HEIGHTS = [
  { value: 270, label: '270p — fastest' },
  { value: 360, label: '360p — recommended' },
  { value: 480, label: '480p' },
  { value: 720, label: '720p — sharpest' }
];

function formatBytes(bytes) {
  if (!bytes) return 'nothing';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  // Rounding to whole megabytes made a real cache of a few hundred kilobytes
  // read as "0 MB", which looks like it is not working.
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

export default function CachePanel({ onClose, onChanged, onToast }) {
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false);
  const [folderDraft, setFolderDraft] = useState('');

  const load = async () => {
    try {
      const res = await apiFetch('/api/cache/settings');
      if (!res.ok) throw new Error('could not read the cache settings');
      const data = await res.json();
      setSettings(data);
      setFolderDraft(data.folder);
    } catch (error) {
      onToast?.(error.message, 'error');
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const patch = async (body) => {
    setBusy(true);
    try {
      const res = await apiFetch('/api/cache/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'could not save');
      setSettings(data);
      setFolderDraft(data.folder);
      onChanged?.(data);
    } catch (error) {
      onToast?.(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    try {
      const res = await apiFetch('/api/project/browse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'folder', defaultName: 'Choose a work folder for preview files' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'the picker failed');
      if (data.path) await patch({ folder: data.path });
    } catch (error) {
      onToast?.(error.message, 'error');
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      const res = await apiFetch('/api/cache/clear', { method: 'POST' });
      const data = await res.json();
      onToast?.(`Cleared ${data.removed || 0} preview file${data.removed === 1 ? '' : 's'}.`);
      onChanged?.(settings);
      await load();
    } catch (error) {
      onToast?.(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (isStatic()) {
    return (
      <div className="edit-cache-panel">
        <header>
          <Zap size={13} /> <strong>Preview cache</strong>
          <button className="edit-mini" onClick={onClose}><X size={12} /></button>
        </header>
        <p className="edit-note">
          Preview files are built with FFmpeg, which the hosted build does not have.
          Run the local server build to get fast scrubbing.
        </p>
      </div>
    );
  }

  return (
    <div className="edit-cache-panel">
      <header>
        <Zap size={13} /> <strong>Preview cache</strong>
        <button className="edit-mini" onClick={onClose} title="Close"><X size={12} /></button>
      </header>

      {!settings && <p className="edit-note"><RefreshCw size={11} className="spinner" /> reading…</p>}

      {settings && (
        <>
          <label className="edit-check">
            <input
              type="checkbox"
              checked={settings.enabled}
              disabled={busy}
              onChange={(event) => patch({ enabled: event.target.checked })}
            />
            <span>Use preview files</span>
          </label>
          <p className="edit-note">
            Each source is transcoded once into a small, densely keyframed copy that
            seeks instantly. The render always reads the originals, so nothing about
            the finished film changes.
          </p>

          <label className="edit-field">
            <span>Work folder</span>
            <input
              type="text"
              value={folderDraft}
              disabled={busy}
              spellCheck={false}
              onChange={(event) => setFolderDraft(event.target.value)}
              onBlur={() => folderDraft !== settings.folder && patch({ folder: folderDraft })}
              onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
            />
          </label>
          <div className="edit-inspector-actions">
            <button className="edit-btn" onClick={browse} disabled={busy}>
              <FolderOpen size={13} /> Browse
            </button>
            <button
              className="edit-btn"
              onClick={() => patch({ folder: settings.defaultFolder })}
              disabled={busy || settings.folder === settings.defaultFolder}
              title={settings.defaultFolder}
            >
              Use the default
            </button>
          </div>
          <p className="edit-note">
            Put this on a fast local disk. If the project itself lives on a network or
            removable drive, that is most of the point.
          </p>

          <label className="edit-field">
            <span>Preview size</span>
            <select
              value={settings.height}
              disabled={busy}
              onChange={(event) => patch({ height: Number(event.target.value) })}
            >
              {HEIGHTS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <dl className="edit-facts">
            <dt>Holding</dt>
            <dd>
              {settings.usage?.files || 0} file{settings.usage?.files === 1 ? '' : 's'}
              {' · '}{formatBytes(settings.usage?.bytes)}
            </dd>
          </dl>

          <div className="edit-inspector-actions">
            <button className="edit-btn" onClick={load} disabled={busy}>
              <RefreshCw size={13} /> Recount
            </button>
            <button className="edit-btn" onClick={clear} disabled={busy}>
              <Trash2 size={13} /> Clear the cache
            </button>
          </div>
        </>
      )}
    </div>
  );
}
