import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Image as ImageIcon,
  Link2,
  Maximize2,
  Minimize2,
  Plus,
  Search,
  Tag as TagIcon,
  Trash2,
  Upload,
  X
} from 'lucide-react';

import { AssetImage } from './AssetMedia.jsx';
import { useSelection } from './useSelection.js';
import {
  GROUP_MODES,
  REFERENCE_KINDS,
  REFERENCE_ROLES,
  SORT_MODES,
  allReferenceTags,
  assignmentStateFor,
  filterReferences,
  groupReferences,
  kindColor,
  kindLabel,
  sortReferences,
  targetKey,
  usageOf
} from './references.js';

/**
 * The reference board.
 *
 * Lives as a docked side panel by default rather than a modal, because
 * assigning an image to a shot means looking at the shot — the old full-screen
 * overlay hid the timeline and forced a close/click/reopen cycle for every
 * single assignment. Full-screen is still one click away for the times you are
 * sorting the board itself rather than working against the timeline.
 */
export default function ReferencePanel({
  references,
  assignments,
  scenes,
  assetLibrary,
  activeSceneId,
  activeShotId,
  onClose,
  onApplyAssignments,
  onUnassign,
  onUpdateReferences,
  onDeleteReferences,
  onLinkToAsset,
  onCreateAssetFrom,
  onUpload,
  onAddFromProject,
  onPreview,
  busy
}) {
  const [fullscreen, setFullscreen] = useState(false);
  const [search, setSearch] = useState('');
  const [kinds, setKinds] = useState([]);
  const [tags, setTags] = useState([]);
  const [onlyUnused, setOnlyUnused] = useState(false);
  const [groupBy, setGroupBy] = useState('kind');
  const [sortBy, setSortBy] = useState('added');
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const [assignTarget, setAssignTarget] = useState(null); // null | { mode: 'add'|'replace' }
  const [tagDraft, setTagDraft] = useState('');
  const [inspectId, setInspectId] = useState(null);
  const [dragOver, setDragOver] = useState(false);

  const selection = useSelection();
  const availableTags = useMemo(() => allReferenceTags(references), [references]);

  const visible = useMemo(() => sortReferences(
    filterReferences(references, { search, kinds, tags, onlyUnused, assignments }),
    sortBy,
    assignments
  ), [references, search, kinds, tags, onlyUnused, assignments, sortBy]);

  const groups = useMemo(
    () => groupReferences(visible, groupBy, { assignments, scenes, assetLibrary }),
    [visible, groupBy, assignments, scenes, assetLibrary]
  );

  // The flat on-screen order, so shift-click ranges follow what you can see
  // rather than the underlying library order.
  const orderedIds = useMemo(
    () => groups.flatMap(group => group.refs.map(ref => ref.id)),
    [groups]
  );

  // A deleted or filtered-out reference must not linger in the selection and
  // silently receive the next bulk action.
  useEffect(() => {
    selection.retain(references.map(ref => ref.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [references]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (assignTarget) setAssignTarget(null);
        else if (selection.count > 0) selection.clear();
        else if (fullscreen) setFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [assignTarget, selection, fullscreen]);

  const toggleFrom = (list, setList, value) => setList(
    list.includes(value) ? list.filter(v => v !== value) : [...list, value]
  );

  const selectedRefs = references.filter(ref => selection.selected.has(ref.id));
  const inspected = references.find(ref => ref.id === inspectId) || null;

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const files = [...(e.dataTransfer?.files || [])].filter(file => file.type.startsWith('image/'));
    if (files.length > 0) onUpload(files);
  };

  const patchSelected = (patch) => {
    onUpdateReferences(selection.selectedIds, patch);
  };

  const addTagToSelected = () => {
    const tag = tagDraft.trim();
    if (!tag) return;
    onUpdateReferences(selection.selectedIds, ref => ({
      tags: [...new Set([...(ref.tags || []), tag])]
    }));
    setTagDraft('');
  };

  return (
    <aside
      className={`reference-panel ${fullscreen ? 'fullscreen' : 'docked'} ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <header className="reference-panel-header">
        <h2><ImageIcon size={17} /> Reference</h2>
        <span className="reference-count">{visible.length} of {references.length}</span>
        <div className="reference-header-actions">
          <button className="btn btn-secondary icon-btn" onClick={() => setFullscreen(f => !f)} title={fullscreen ? 'Dock to the side' : 'Full screen'}>
            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button className="btn btn-secondary icon-btn" onClick={onClose} title="Close (the board stays)">
            <X size={15} />
          </button>
        </div>
      </header>

      <div className="reference-toolbar">
        <label className="reference-search">
          <Search size={13} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, note, tag…"
          />
          {search && <button onClick={() => setSearch('')} title="Clear"><X size={12} /></button>}
        </label>

        <div className="reference-toolbar-row">
          <label className="mini-field">
            <span>Group</span>
            <select className="select-field" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
              {GROUP_MODES.map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
            </select>
          </label>
          <label className="mini-field">
            <span>Sort</span>
            <select className="select-field" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              {SORT_MODES.map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
            </select>
          </label>
        </div>

        <div className="reference-chips">
          {REFERENCE_KINDS.map(kind => {
            const on = kinds.includes(kind.id);
            const count = references.filter(ref => ref.kind === kind.id).length;
            if (count === 0 && !on) return null;
            return (
              <button
                key={kind.id}
                className={`reference-chip ${on ? 'on' : ''}`}
                style={on ? { borderColor: kind.color, background: `${kind.color}22`, color: kind.color } : undefined}
                onClick={() => toggleFrom(kinds, setKinds, kind.id)}
              >
                {kind.label} <em>{count}</em>
              </button>
            );
          })}
          <button
            className={`reference-chip ${onlyUnused ? 'on' : ''}`}
            onClick={() => setOnlyUnused(v => !v)}
            title="Only references that are not attached to anything"
          >
            Unused
          </button>
        </div>

        {availableTags.length > 0 && (
          <div className="reference-chips">
            {availableTags.map(tag => (
              <button
                key={tag}
                className={`reference-chip tag ${tags.includes(tag) ? 'on' : ''}`}
                onClick={() => toggleFrom(tags, setTags, tag)}
              >
                <TagIcon size={10} /> {tag}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="reference-body">
        {references.length === 0 ? (
          <div className="reference-empty">
            <ImageIcon size={28} />
            <p>No reference imagery yet.</p>
            <span>Drop images anywhere in this panel, or use the buttons below.</span>
          </div>
        ) : visible.length === 0 ? (
          <div className="reference-empty">
            <p>Nothing matches those filters.</p>
            <button className="btn btn-secondary" onClick={() => { setSearch(''); setKinds([]); setTags([]); setOnlyUnused(false); }}>
              Clear filters
            </button>
          </div>
        ) : groups.map(group => {
          const groupIds = group.refs.map(ref => ref.id);
          const allSelected = groupIds.length > 0 && groupIds.every(id => selection.selected.has(id));
          const collapsed = collapsedGroups[group.id];

          return (
            <section key={group.id} className="reference-group">
              <header className="reference-group-header">
                <button
                  className="reference-group-title"
                  onClick={() => setCollapsedGroups(prev => ({ ...prev, [group.id]: !prev[group.id] }))}
                >
                  {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  {group.label}
                  <em>{group.refs.length}</em>
                </button>
                <button
                  className="reference-group-select"
                  onClick={() => selection.toggleAll(groupIds)}
                  title={allSelected ? 'Deselect these' : 'Select these'}
                >
                  {allSelected ? 'Deselect all' : 'Select all'}
                </button>
              </header>

              {!collapsed && (
                <div className="reference-grid">
                  {group.refs.map(ref => (
                    <ReferenceCard
                      key={`${group.id}:${ref.id}`}
                      reference={ref}
                      selected={selection.selected.has(ref.id)}
                      usage={usageOf(assignments, ref.id)}
                      scenes={scenes}
                      assetLibrary={assetLibrary}
                      onClick={(e) => selection.handleClick(ref.id, orderedIds, e)}
                      onToggle={() => selection.toggle(ref.id)}
                      onInspect={() => setInspectId(id => (id === ref.id ? null : ref.id))}
                      onPreview={() => onPreview(ref)}
                      isInspected={inspectId === ref.id}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {inspected && (
        <ReferenceInspector
          reference={inspected}
          assetLibrary={assetLibrary}
          scenes={scenes}
          assignments={assignments}
          onChange={(patch) => onUpdateReferences([inspected.id], patch)}
          onUnassignFrom={(target) => onUnassign([inspected.id], [target])}
          onClose={() => setInspectId(null)}
        />
      )}

      {selection.count > 0 && (
        <div className="reference-actionbar">
          <div className="reference-actionbar-count">
            <strong>{selection.count}</strong> selected
            <button onClick={selection.clear} title="Clear selection"><X size={12} /></button>
          </div>

          <div className="reference-actionbar-controls">
            <button className="btn btn-primary" onClick={() => setAssignTarget({ mode: 'add' })}>
              <Plus size={13} /> Assign to…
            </button>

            <label className="mini-field">
              <span>Type</span>
              <select
                className="select-field"
                value=""
                onChange={(e) => { if (e.target.value) patchSelected({ kind: e.target.value }); e.target.value = ''; }}
              >
                <option value="">Set…</option>
                {REFERENCE_KINDS.map(kind => <option key={kind.id} value={kind.id}>{kind.label}</option>)}
              </select>
            </label>

            <div className="reference-tag-add">
              <input
                type="text"
                className="input-field"
                value={tagDraft}
                placeholder="Add tag"
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addTagToSelected(); }}
              />
              <button className="btn btn-secondary" onClick={addTagToSelected} disabled={!tagDraft.trim()}>
                <TagIcon size={12} />
              </button>
            </div>

            <label className="mini-field">
              <span>Asset</span>
              <select
                className="select-field"
                value=""
                onChange={(e) => {
                  if (e.target.value === '__new') onCreateAssetFrom(selectedRefs);
                  else if (e.target.value) onLinkToAsset(selection.selectedIds, e.target.value === '__none' ? null : e.target.value);
                  e.target.value = '';
                }}
              >
                <option value="">Link…</option>
                <option value="__new">New asset from these…</option>
                <option value="__none">Unlink</option>
                {assetLibrary.map(asset => <option key={asset.id} value={asset.id}>&lt;{asset.tag}&gt;</option>)}
              </select>
            </label>

            <button
              className="btn btn-secondary"
              onClick={() => onUnassign(selection.selectedIds, null)}
              title="Detach from every scene and shot, keep the images"
            >
              <Link2 size={13} /> Unassign
            </button>

            <button className="btn btn-danger" onClick={() => onDeleteReferences(selection.selectedIds)}>
              <Trash2 size={13} /> Delete
            </button>
          </div>
        </div>
      )}

      <footer className="reference-panel-footer">
        <label className="btn btn-secondary">
          <Upload size={13} /> Upload
          <input
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            disabled={busy}
            onChange={(e) => { onUpload([...e.target.files]); e.target.value = ''; }}
          />
        </label>
        <button className="btn btn-secondary" onClick={onAddFromProject} disabled={busy}>
          <FolderOpen size={13} /> From project folder
        </button>
        <span className="reference-hint">or drop images here</span>
      </footer>

      {assignTarget && (
        <AssignDialog
          scenes={scenes}
          assetLibrary={assetLibrary}
          assignments={assignments}
          selectedIds={selection.selectedIds}
          activeSceneId={activeSceneId}
          activeShotId={activeShotId}
          count={selection.count}
          onCancel={() => setAssignTarget(null)}
          onConfirm={(toAssign, toUnassign, options) => {
            onApplyAssignments(selection.selectedIds, toAssign, toUnassign, options);
            setAssignTarget(null);
          }}
        />
      )}
    </aside>
  );
}

/** One image on the board, with its type, where it is used, and a checkbox. */
function ReferenceCard({ reference, selected, usage, scenes, assetLibrary, onClick, onToggle, onInspect, onPreview, isInspected }) {
  const asset = assetLibrary.find(a => a.id === reference.assetId);
  const scopeBits = [];
  if (usage.project) scopeBits.push('All shots');
  usage.sceneIds.forEach(id => {
    const scene = scenes.find(s => s.id === id);
    if (scene) scopeBits.push(scene.name);
  });
  if (usage.shotIds.length > 0) scopeBits.push(`${usage.shotIds.length} shot${usage.shotIds.length === 1 ? '' : 's'}`);
  if (usage.allAssets) scopeBits.push('all assets');
  else if (usage.assetIds.length > 0) scopeBits.push(`${usage.assetIds.length} asset${usage.assetIds.length === 1 ? '' : 's'}`);

  return (
    <div
      className={`reference-card ${selected ? 'selected' : ''} ${isInspected ? 'inspected' : ''}`}
      onClick={onClick}
      onDoubleClick={onPreview}
      title={reference.notes || reference.name}
    >
      {/* Always visible, not hover-revealed: multi-select is the primary verb
          here, and a control you have to hover to find is one people never use. */}
      <button
        className="reference-checkbox"
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        aria-label={selected ? 'Deselect' : 'Select'}
      >
        {selected && <Check size={11} />}
      </button>

      <span className="reference-kind-dot" style={{ background: kindColor(reference.kind) }} title={kindLabel(reference.kind)} />

      <div className="reference-thumb">
        <AssetImage path={reference.path} alt={reference.name} />
      </div>

      <div className="reference-meta">
        <span className="reference-name">{reference.name}</span>
        <span className={`reference-usage ${scopeBits.length ? '' : 'unused'}`}>
          {scopeBits.length ? scopeBits.join(' · ') : 'unused'}
        </span>
      </div>

      {asset && <span className="reference-asset-badge">&lt;{asset.tag}&gt;</span>}

      <button
        className="reference-inspect"
        onClick={(e) => { e.stopPropagation(); onInspect(); }}
        title="Details"
      >
        …
      </button>
    </div>
  );
}

/** Rename, retype, note and unassign one reference. */
function ReferenceInspector({ reference, assetLibrary, scenes, assignments, onChange, onUnassignFrom, onClose }) {
  const usage = usageOf(assignments, reference.id);
  const shotLookup = useMemo(() => {
    const map = new Map();
    scenes.forEach(scene => (scene.shots || []).forEach(shot => map.set(shot.id, { scene, shot })));
    return map;
  }, [scenes]);

  return (
    <div className="reference-inspector">
      <header>
        <strong>Details</strong>
        <button onClick={onClose}><X size={13} /></button>
      </header>

      <label className="mini-field block">
        <span>Name</span>
        <input className="input-field" value={reference.name} onChange={(e) => onChange({ name: e.target.value })} />
      </label>

      <div className="reference-inspector-row">
        <label className="mini-field">
          <span>Type</span>
          <select className="select-field" value={reference.kind} onChange={(e) => onChange({ kind: e.target.value })}>
            {REFERENCE_KINDS.map(kind => <option key={kind.id} value={kind.id}>{kind.label}</option>)}
          </select>
        </label>
        <label className="mini-field">
          <span>Asset</span>
          <select className="select-field" value={reference.assetId || ''} onChange={(e) => onChange({ assetId: e.target.value || null })}>
            <option value="">— none —</option>
            {assetLibrary.map(asset => <option key={asset.id} value={asset.id}>&lt;{asset.tag}&gt;</option>)}
          </select>
        </label>
      </div>

      <label className="mini-field block">
        <span>Note — what this image is for</span>
        <textarea
          className="input-field"
          rows={2}
          value={reference.notes}
          placeholder="the collar, not the colour"
          onChange={(e) => onChange({ notes: e.target.value })}
        />
      </label>

      <label className="mini-field block">
        <span>Tags — comma separated</span>
        <input
          className="input-field"
          value={(reference.tags || []).join(', ')}
          onChange={(e) => onChange({ tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean) })}
        />
      </label>

      <div className="reference-inspector-usage">
        <span>Used in</span>
        {usage.total === 0 && <em>nothing yet</em>}
        {usage.project && (
          <button onClick={() => onUnassignFrom({ scope: 'project' })}>Whole project <X size={10} /></button>
        )}
        {usage.sceneIds.map(id => {
          const scene = scenes.find(s => s.id === id);
          return scene ? (
            <button key={id} onClick={() => onUnassignFrom({ scope: 'scene', targetId: id })}>
              {scene.name} <X size={10} />
            </button>
          ) : null;
        })}
        {usage.shotIds.map(id => {
          const found = shotLookup.get(id);
          return found ? (
            <button key={id} onClick={() => onUnassignFrom({ scope: 'shot', targetId: id })}>
              {found.shot.name} <X size={10} />
            </button>
          ) : null;
        })}
        {usage.allAssets && (
          <button onClick={() => onUnassignFrom({ scope: 'asset', targetId: null })}>Every asset <X size={10} /></button>
        )}
        {usage.assetIds.map(id => {
          const asset = assetLibrary.find(a => a.id === id);
          return asset ? (
            <button key={id} onClick={() => onUnassignFrom({ scope: 'asset', targetId: id })}>
              &lt;{asset.tag}&gt; <X size={10} />
            </button>
          ) : null;
        })}
      </div>
    </div>
  );
}

/**
 * The checkbox tree that makes bulk assignment one interaction: pick any mix of
 * project, scenes and shots, then commit once.
 */
function AssignDialog({
  scenes, assetLibrary = [], assignments, selectedIds,
  activeSceneId, activeShotId, count, onCancel, onConfirm
}) {
  // Open showing what is already true. A write-only form looked identical
  // whether a reference was attached everywhere or nowhere, which made it
  // impossible to see an assignment, let alone take one back.
  const initial = useMemo(() => assignmentStateFor(assignments, selectedIds), [assignments, selectedIds]);
  const [state, setState] = useState(initial);
  const [role, setRole] = useState('style');
  const [mode, setMode] = useState('add');
  const [live, setLive] = useState(true);
  const [expanded, setExpanded] = useState(() => (activeSceneId ? { [activeSceneId]: true } : {}));
  const [assetsOpen, setAssetsOpen] = useState(false);

  const every = [
    { scope: 'project', targetId: null },
    ...scenes.map(scene => ({ scope: 'scene', targetId: scene.id })),
    ...scenes.flatMap(scene => (scene.shots || []).map(shot => ({ scope: 'shot', targetId: shot.id }))),
    { scope: 'asset', targetId: null },
    ...assetLibrary.map(asset => ({ scope: 'asset', targetId: asset.id }))
  ];

  const stateOf = (scope, targetId) => state[targetKey(scope, targetId)] || 'none';

  // Partly-attached cycles to fully attached first, then to detached — the same
  // order a file browser's tri-state checkbox uses.
  const cycle = (scope, targetId) => setState(prev => {
    const key = targetKey(scope, targetId);
    return { ...prev, [key]: (prev[key] || 'none') === 'all' ? 'none' : 'all' };
  });

  const toAssign = [];
  const toUnassign = [];
  every.forEach(({ scope, targetId }) => {
    const key = targetKey(scope, targetId);
    const now = state[key] || 'none';
    if (now === (initial[key] || 'none')) return;    // untouched
    if (now === 'all') toAssign.push({ scope, targetId });
    else if (now === 'none') toUnassign.push({ scope, targetId });
  });

  const changes = toAssign.length + toUnassign.length;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-window assign-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Where {count} reference{count === 1 ? '' : 's'} appl{count === 1 ? 'ies' : 'y'}</h2>
          <button className="btn btn-secondary icon-btn" onClick={onCancel}><X size={15} /></button>
        </div>

        <div className="modal-body">
          <p className="assign-intro">
            Ticked means attached. Untick to detach. A half-filled box means only some of your
            selection is attached there — click once to attach them all, again to detach them all.
          </p>

          <div className="assign-quick">
            {activeSceneId && (
              <button className="btn btn-secondary" onClick={() => cycle('scene', activeSceneId)}>
                Current scene
              </button>
            )}
            {activeShotId && (
              <button className="btn btn-secondary" onClick={() => cycle('shot', activeShotId)}>
                Current shot
              </button>
            )}
            <button
              className="btn btn-secondary"
              disabled={!activeSceneId}
              onClick={() => {
                const scene = scenes.find(s => s.id === activeSceneId);
                setState(prev => {
                  const next = { ...prev };
                  (scene?.shots || []).forEach(shot => { next[targetKey('shot', shot.id)] = 'all'; });
                  return next;
                });
              }}
            >
              Every shot in this scene
            </button>
          </div>

          <div className="assign-tree">
            <TriRow
              root
              state={stateOf('project', null)}
              onToggle={() => cycle('project', null)}
              label={<strong>Whole project</strong>}
              hint="every shot, now and later"
            />

            {scenes.map(scene => {
              const shots = scene.shots || [];
              const attached = shots.filter(shot => stateOf('shot', shot.id) === 'all').length;
              const open = expanded[scene.id];

              return (
                <div key={scene.id} className="assign-scene">
                  <TriRow
                    state={stateOf('scene', scene.id)}
                    onToggle={() => cycle('scene', scene.id)}
                    disclosure={open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    onDisclosure={() => setExpanded(prev => ({ ...prev, [scene.id]: !prev[scene.id] }))}
                    label={<span>{scene.name}</span>}
                    hint={attached > 0 ? `${attached}/${shots.length} shots` : `${shots.length} shots`}
                  />

                  {open && shots.map(shot => (
                    <TriRow
                      key={shot.id}
                      indent
                      state={stateOf('shot', shot.id)}
                      onToggle={() => cycle('shot', shot.id)}
                      label={<span>{shot.name}</span>}
                    />
                  ))}
                </div>
              );
            })}

            {/* Assets are a separate kind of target from the timeline: these
                references ride along when the asset's own artwork is generated,
                which is how one style board keeps every character sheet
                consistent. */}
            {assetLibrary.length > 0 && (() => {
              const everyAssets = stateOf('asset', null) === 'all';
              const attached = assetLibrary.filter(a => stateOf('asset', a.id) === 'all').length;

              return (
                <div className="assign-scene">
                  <TriRow
                    state={stateOf('asset', null)}
                    onToggle={() => cycle('asset', null)}
                    disclosure={assetsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    onDisclosure={() => setAssetsOpen(v => !v)}
                    label={<strong>Every asset</strong>}
                    hint={everyAssets ? 'on — incl. ones you add later' : (attached > 0 ? `${attached}/${assetLibrary.length} picked` : 'incl. ones you add later')}
                  />

                  {assetsOpen && assetLibrary.map(asset => (
                    <TriRow
                      key={asset.id}
                      indent
                      state={everyAssets ? 'all' : stateOf('asset', asset.id)}
                      // Covered by the blanket row, so ticking one individually
                      // would be a no-op that looks like it did something.
                      disabled={everyAssets}
                      onToggle={() => cycle('asset', asset.id)}
                      label={<span>&lt;{asset.tag}&gt;{asset.name && asset.name !== asset.tag ? ` — ${asset.name}` : ''}</span>}
                      hint={everyAssets ? 'via Every asset' : undefined}
                    />
                  ))}
                </div>
              );
            })()}
          </div>

          <div className="assign-options">
            <label className="settings-check">
              <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
              <span>
                Send these with generations straight away
                <em>Leave off to attach them but hold them back — you can switch them on later from any shot or asset.</em>
              </span>
            </label>

            <label className="mini-field">
              <span>Role</span>
              <select className="select-field" value={role} onChange={(e) => setRole(e.target.value)}>
                {REFERENCE_ROLES.map(r => <option key={r.id} value={r.id}>{r.label} — {r.hint}</option>)}
              </select>
            </label>
            <label className="mini-field">
              <span>Other references already on a target</span>
              <select className="select-field" value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="add">Keep them</option>
                <option value="replace">Replace them with this selection</option>
              </select>
            </label>
          </div>
        </div>

        <div className="modal-footer">
          <span className="assign-summary">
            {changes === 0 ? 'No changes' : [
              toAssign.length ? `attach to ${toAssign.length}` : '',
              toUnassign.length ? `detach from ${toUnassign.length}` : ''
            ].filter(Boolean).join(', ')}
          </span>
          <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={changes === 0}
            onClick={() => onConfirm(toAssign, toUnassign, { role, mode, enabled: live })}
          >
            <Check size={14} /> Apply
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The per-shot and per-scene strip: what this shot will actually send, with a
 * tick on each one.
 *
 * Inherited references are shown alongside the shot's own but visibly demoted,
 * so it is obvious that unticking one here is a decision about this shot rather
 * than about the scene it came from.
 */
/**
 * One row of the assign tree. `state` is 'all' | 'some' | 'none' — 'some' shows
 * as a half-filled box, which is the only honest rendering when a multi-select
 * is attached to a target unevenly.
 */
function TriRow({ state, onToggle, label, hint, disclosure, onDisclosure, indent, root, disabled }) {
  return (
    <div className={`assign-row ${indent ? 'shot' : ''} ${root ? 'root' : ''} ${disabled ? 'disabled' : ''}`}>
      <input
        type="checkbox"
        checked={state === 'all'}
        disabled={disabled}
        ref={el => { if (el) el.indeterminate = state === 'some'; }}
        onChange={onToggle}
      />
      {disclosure && (
        <button className="assign-disclosure" onClick={onDisclosure}>{disclosure}</button>
      )}
      <label onClick={disabled ? undefined : onToggle}>{label}</label>
      {hint && <em>{hint}</em>}
    </div>
  );
}

/** Where an inherited entry came from, in the space of a corner badge. */
function inheritedLabel(entry) {
  if (entry.scope === 'project') return 'all';
  if (entry.scope === 'asset') return 'assets';   // the every-asset assignment
  return 'scene';
}

export function ReferenceStrip({ entries, onToggleEntry, onOpenPanel, capacity, label = 'References', compact = false }) {
  if (entries.length === 0) {
    return (
      <button className="reference-strip-empty" onClick={onOpenPanel}>
        <ImageIcon size={12} /> No references — assign some
      </button>
    );
  }

  const sending = entries.filter(entry => entry.enabled);
  // `capacity === null` means the caller has no model in hand (the scene strip)
  // and is not making a claim either way. Zero is a real answer, and it means
  // nothing at all is uploaded — saying "N sending" there would be a lie.
  const knownCapacity = capacity !== null && capacity !== undefined;
  const takesNone = knownCapacity && capacity === 0;
  const overCapacity = knownCapacity && capacity > 0 && sending.length > capacity;

  return (
    <div className={`reference-strip ${compact ? 'compact' : ''} ${takesNone ? 'inert' : ''}`}>
      <div className="reference-strip-head">
        <span>{label}</span>
        <em className={overCapacity || takesNone ? 'over' : ''}>
          {takesNone
            ? `${sending.length} on, none sent — this model reads no reference images`
            : `${sending.length} sending${capacity > 0 ? ` · model takes ${capacity}` : ''}`}
        </em>
        <button onClick={onOpenPanel} title="Open the reference board"><Plus size={11} /></button>
      </div>

      <div className="reference-strip-items">
        {entries.map(entry => (
          <button
            key={entry.edge.id}
            className={`reference-strip-item ${entry.enabled ? 'on' : 'off'} ${entry.inherited ? 'inherited' : ''}`}
            onClick={() => onToggleEntry(entry)}
            title={`${entry.ref.name}${entry.inherited ? ` — from ${entry.scope}` : ''}\n${entry.enabled ? 'Sent with generations. Click to hold it back.' : 'Held back. Click to send it.'}`}
          >
            <AssetImage path={entry.ref.path} alt={entry.ref.name} />
            <span className="reference-strip-tick">{entry.enabled ? <Check size={9} /> : <X size={9} />}</span>
            {entry.inherited && <span className="reference-strip-scope">{inheritedLabel(entry)}</span>}
          </button>
        ))}
      </div>

      {overCapacity && (
        <span className="reference-strip-warning">
          Only the first {capacity} will be uploaded — untick the rest or reorder them.
        </span>
      )}
    </div>
  );
}
