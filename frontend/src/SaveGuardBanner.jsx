// The bar that appears when autosave has stopped.
//
// Deliberately loud and deliberately not dismissable: the whole failure mode it
// exists for is work quietly not being written. It renders in the editor as
// well as the creation view, because losing an afternoon's cutting is exactly
// as bad as losing an afternoon's writing.

import React from 'react';
import { AlertTriangle, RefreshCw, Save } from 'lucide-react';
import { describeBlock } from './saveGuard.js';

export default function SaveGuardBanner({ block, onReload, onForce, busy }) {
  const copy = describeBlock(block);
  if (!copy) return null;

  return (
    <div className="save-guard-banner" role="alert">
      <AlertTriangle size={18} className="save-guard-icon" />
      <div className="save-guard-text">
        <strong>{copy.title}</strong>
        <span>{copy.body}</span>
      </div>
      <div className="save-guard-actions">
        {copy.canReload && (
          <button className="save-guard-btn" onClick={onReload} disabled={busy}>
            <RefreshCw size={13} /> {copy.reloadLabel || 'Reload from disk'}
          </button>
        )}
        {copy.canForce && (
          <button className="save-guard-btn danger" onClick={onForce} disabled={busy}>
            <Save size={13} /> Overwrite the file
          </button>
        )}
      </div>
    </div>
  );
}
