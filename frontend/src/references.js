// The reference board: what a reference image *is*, where it applies, and which
// ones actually travel with a generation.
//
// Two ideas live here, and keeping them apart is the point:
//
//   * A **reference record** is an image plus what you know about it — its kind
//     (character / style / scenery / prop …), free tags, a note, and optionally
//     a link to an asset. It is owned by the project, not by a shot.
//
//   * An **assignment** is an edge from one reference to one target: the whole
//     project, a scene, or a shot. Edges rather than arrays-on-shots because the
//     operations that matter are bulk ones — assign twelve references to three
//     shots, show everything attached to scene 2, find what is used nowhere —
//     and every one of those is a single filter over a flat list.
//
// Scope resolution is deliberately most-specific-first: a shot's own references
// come before its scene's, which come before the project's. Models cap how many
// images they will read, so when the list is trimmed the ones chosen for *this
// shot* are the ones that survive.
//
// Every edge carries `enabled`. That is what keeps "assigned" and "actually
// sent" separate: unticking a reference on a shot leaves the assignment intact
// but stops it being uploaded, and because it lives in project state rather than
// in modal state, a batch run honours it too.

// --- KINDS -----------------------------------------------------------------

export const REFERENCE_KINDS = [
  { id: 'character', label: 'Character', color: '#8b5cf6' },
  { id: 'style', label: 'Style', color: '#06b6d4' },
  { id: 'scenery', label: 'Scenery', color: '#10b981' },
  { id: 'prop', label: 'Prop', color: '#f59e0b' },
  { id: 'wardrobe', label: 'Wardrobe', color: '#ec4899' },
  { id: 'lighting', label: 'Lighting', color: '#eab308' },
  { id: 'other', label: 'Other', color: '#64748b' }
];

export const REFERENCE_ROLES = [
  { id: 'style', label: 'Style', hint: 'Look, palette, grade, texture' },
  { id: 'subject', label: 'Subject', hint: 'Who or what is in frame' },
  { id: 'composition', label: 'Composition', hint: 'Framing, blocking, camera' }
];

// Assets are deliberately NOT a scope here.
//
// A shot's references are a live relationship — assign once, and the shot keeps
// resolving them. An asset's are not: an asset already owns a pool of images
// with its own per-image send ticks, and that pool is where people expect to
// manage them. Modelling the board→asset relationship as a live edge produced
// two parallel lists in the asset editor, and images the asset could mute but
// not remove without going back to the board. So the board *pushes* into the
// pool instead — see `assetsContaining` and the push helper in App.jsx.
export const REFERENCE_SCOPES = ['project', 'scene', 'shot'];

export function kindLabel(kindId) {
  return REFERENCE_KINDS.find(k => k.id === kindId)?.label || 'Other';
}

export function kindColor(kindId) {
  return REFERENCE_KINDS.find(k => k.id === kindId)?.color || '#64748b';
}

// The schema version stamped on migrated projects. Migration is idempotent
// because of it: without the stamp a second pass would fold every shot's
// legacy array into a second set of duplicate edges.
export const REFERENCE_SCHEMA_VERSION = 2;

let edgeCounter = 0;
function makeEdgeId() {
  edgeCounter += 1;
  return `edge_${Date.now().toString(36)}_${edgeCounter}`;
}

// --- RECORDS ---------------------------------------------------------------

/** Fill in everything a reference record needs, without discarding extras. */
export function normalizeReference(ref = {}) {
  return {
    id: ref.id || `ref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    path: ref.path || '',
    name: ref.name || 'Untitled',
    kind: REFERENCE_KINDS.some(k => k.id === ref.kind) ? ref.kind : 'other',
    tags: Array.isArray(ref.tags) ? ref.tags.filter(Boolean) : [],
    notes: typeof ref.notes === 'string' ? ref.notes : '',
    assetId: ref.assetId || null,
    source: ref.source || 'upload',
    createdAt: ref.createdAt || new Date().toISOString()
  };
}

/** Every distinct tag in use, sorted, for the filter rail. */
export function allReferenceTags(references = []) {
  const seen = new Set();
  references.forEach(ref => (ref.tags || []).forEach(tag => seen.add(tag)));
  return [...seen].sort((a, b) => a.localeCompare(b));
}

// --- MIGRATION -------------------------------------------------------------

/**
 * Bring a loaded project up to the current reference schema.
 *
 * Pre-v2 projects kept assignments as `shot.referenceImages: [refId]` and had no
 * per-reference metadata at all. Both are converted here, and the legacy arrays
 * are cleared so there is exactly one source of truth afterwards.
 *
 * Returns the pieces the caller needs to put into state; it never mutates its
 * input.
 */
export function migrateReferenceState(state = {}) {
  const references = (state.referenceImages || []).map(normalizeReference);
  const alreadyMigrated = state.referenceSchemaVersion >= REFERENCE_SCHEMA_VERSION;

  if (alreadyMigrated) {
    return {
      references,
      assignments: (state.refAssignments || []).map(normalizeAssignment).filter(Boolean),
      scenes: state.scenes || []
    };
  }

  const knownRefIds = new Set(references.map(r => r.id));
  const assignments = (state.refAssignments || []).map(normalizeAssignment).filter(Boolean);

  const scenes = (state.scenes || []).map(scene => ({
    ...scene,
    shots: (scene.shots || []).map(shot => {
      (shot.referenceImages || []).forEach((refId, index) => {
        if (!knownRefIds.has(refId)) return; // dangling id from a deleted image
        assignments.push({
          id: makeEdgeId(),
          refId,
          scope: 'shot',
          targetId: shot.id,
          role: 'style',
          enabled: true,
          order: index
        });
      });
      return { ...shot, referenceImages: [] };
    })
  }));

  return { references, assignments, scenes };
}

export function normalizeAssignment(edge) {
  if (!edge || !edge.refId || !REFERENCE_SCOPES.includes(edge.scope)) return null;
  if (edge.scope !== 'project' && !edge.targetId) return null;
  return {
    id: edge.id || makeEdgeId(),
    refId: edge.refId,
    scope: edge.scope,
    targetId: edge.scope === 'project' ? null : edge.targetId,
    role: REFERENCE_ROLES.some(r => r.id === edge.role) ? edge.role : 'style',
    enabled: edge.enabled !== false,
    order: Number.isFinite(edge.order) ? edge.order : 0
  };
}

// --- ASSIGNMENT QUERIES ----------------------------------------------------

/**
 * A stable identity for one assignment target, so the assign dialog and the
 * edge list agree on what "the same target" means.
 */
export function targetKey(scope, targetId = null) {
  if (scope === 'project') return 'project';
  return `${scope}:${targetId}`;
}

/**
 * The assets whose own image pool contains this reference.
 *
 * Board→asset membership is derived rather than stored: pushing a reference
 * into an asset copies its path into that asset's pool, so the pool itself is
 * the record. That keeps one source of truth and means deleting the image from
 * the asset actually removes it, instead of muting a link the asset cannot cut.
 */
export function assetsContaining(assetLibrary = [], path) {
  if (!path) return [];
  return assetLibrary.filter(asset => (asset.images || []).includes(path));
}

/**
 * How much of a selection is already attached to each target: 'all', 'some' or
 * absent. This is what lets the assign dialog open showing what is true rather
 * than blank — and therefore lets unticking mean "detach".
 */
export function assignmentStateFor(assignments = [], refIds = []) {
  const ids = new Set(refIds);
  const counts = new Map();

  assignments.forEach(edge => {
    if (!ids.has(edge.refId)) return;
    const key = targetKey(edge.scope, edge.targetId);
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  const state = {};
  counts.forEach((n, key) => {
    state[key] = n >= ids.size ? 'all' : 'some';
  });
  return state;
}

/** Edges pointing at one target. `targetId` is ignored for project scope. */
export function edgesFor(assignments = [], scope, targetId = null) {
  return assignments
    .filter(edge => edge.scope === scope && (scope === 'project' || edge.targetId === targetId))
    .sort((a, b) => a.order - b.order);
}

/** Every place a reference is attached, for the "used in" readout on a card. */
export function usageOf(assignments = [], refId) {
  const edges = assignments.filter(edge => edge.refId === refId);
  return {
    project: edges.some(e => e.scope === 'project'),
    sceneIds: [...new Set(edges.filter(e => e.scope === 'scene').map(e => e.targetId))],
    shotIds: [...new Set(edges.filter(e => e.scope === 'shot').map(e => e.targetId))],
    total: edges.length
  };
}

export function isUnassigned(assignments = [], refId) {
  return !assignments.some(edge => edge.refId === refId);
}

/**
 * The references in play for one shot, most specific first.
 *
 * Each entry reports where it came from and whether it will actually be sent,
 * so the UI can show an inherited scene reference greyed out next to the shot's
 * own without the caller re-deriving any of it.
 *
 * A shot opts out of an inherited reference through `shot.refExclusions`, and
 * out of all of them through `shot.useInheritedRefs === false`. Its own edges
 * are switched with the edge's own `enabled` flag.
 */
export function resolveShotReferences({ shot, scene, references = [], assignments = [] }) {
  if (!shot) return [];

  const byId = new Map(references.map(ref => [ref.id, ref]));
  const exclusions = new Set(shot.refExclusions || []);
  const inheritsAtAll = shot.useInheritedRefs !== false;
  const entries = [];
  const seen = new Set();

  const collect = (scope, targetId, inherited) => {
    edgesFor(assignments, scope, targetId).forEach(edge => {
      const ref = byId.get(edge.refId);
      if (!ref || seen.has(ref.id)) return;       // most specific scope wins
      seen.add(ref.id);

      const excluded = inherited && exclusions.has(ref.id);
      entries.push({
        ref,
        edge,
        scope,
        inherited,
        role: edge.role,
        excluded,
        enabled: edge.enabled !== false && !excluded && (!inherited || inheritsAtAll)
      });
    });
  };

  collect('shot', shot.id, false);
  if (scene) collect('scene', scene.id, true);
  collect('project', null, true);

  return entries;
}

/** Just the paths a generation should receive, in send order. */
export function enabledReferencePaths(args) {
  return resolveShotReferences(args)
    .filter(entry => entry.enabled && entry.ref.path)
    .map(entry => entry.ref.path);
}

/** The same shape for a scene, used by the scene header strip. */
export function resolveSceneReferences({ scene, references = [], assignments = [] }) {
  if (!scene) return [];
  const byId = new Map(references.map(ref => [ref.id, ref]));
  const entries = [];
  const seen = new Set();

  const collect = (scope, targetId, inherited) => {
    edgesFor(assignments, scope, targetId).forEach(edge => {
      const ref = byId.get(edge.refId);
      if (!ref || seen.has(ref.id)) return;
      seen.add(ref.id);
      entries.push({ ref, edge, scope, inherited, role: edge.role, excluded: false, enabled: edge.enabled !== false });
    });
  };

  collect('scene', scene.id, false);
  collect('project', null, true);
  return entries;
}

// --- ASSIGNMENT MUTATIONS --------------------------------------------------
// All pure: they take the current edge list and return the next one.

/**
 * Attach many references to many targets at once — the operation the whole
 * edge-list design exists for.
 *
 * `targets` is a list of `{ scope, targetId }`. `mode: 'replace'` clears each
 * target's existing edges first, which is what you want when re-doing a scene's
 * look; `'add'` (the default) leaves them and skips duplicates.
 */
export function assignReferences(assignments, refIds, targets, { role = 'style', mode = 'add', enabled = true } = {}) {
  let next = [...assignments];

  targets.forEach(({ scope, targetId = null }) => {
    if (!REFERENCE_SCOPES.includes(scope)) return;

    if (mode === 'replace') {
      next = next.filter(edge => !(edge.scope === scope && (scope === 'project' || edge.targetId === targetId)));
    }

    const existing = edgesFor(next, scope, targetId);
    let order = existing.length ? Math.max(...existing.map(e => e.order)) + 1 : 0;

    refIds.forEach(refId => {
      const duplicate = next.some(edge => (
        edge.refId === refId && edge.scope === scope && (scope === 'project' || edge.targetId === targetId)
      ));
      if (duplicate) return;
      next.push({ id: makeEdgeId(), refId, scope, targetId: scope === 'project' ? null : targetId, role, enabled, order });
      order += 1;
    });
  });

  return next;
}

/** Detach references from specific targets, or from everywhere. */
export function unassignReferences(assignments, refIds, targets = null) {
  const ids = new Set(refIds);
  if (!targets) return assignments.filter(edge => !ids.has(edge.refId));

  return assignments.filter(edge => {
    if (!ids.has(edge.refId)) return true;
    return !targets.some(({ scope, targetId = null }) => (
      edge.scope === scope && (scope === 'project' || edge.targetId === targetId)
    ));
  });
}

/** Flip whether one edge's reference is uploaded with a generation. */
export function setEdgeEnabled(assignments, edgeId, enabled) {
  return assignments.map(edge => (edge.id === edgeId ? { ...edge, enabled } : edge));
}

export function setEdgeRole(assignments, edgeId, role) {
  return assignments.map(edge => (edge.id === edgeId ? { ...edge, role } : edge));
}

/**
 * Move an edge within its target's ordering. Order decides who survives when a
 * model's input capacity trims the list, so it is a real editing operation, not
 * cosmetic.
 */
export function reorderEdge(assignments, edgeId, direction) {
  const edge = assignments.find(e => e.id === edgeId);
  if (!edge) return assignments;

  const siblings = edgesFor(assignments, edge.scope, edge.targetId);
  const index = siblings.findIndex(e => e.id === edgeId);
  const swapWith = siblings[direction === 'up' ? index - 1 : index + 1];
  if (!swapWith) return assignments;

  return assignments.map(e => {
    if (e.id === edge.id) return { ...e, order: swapWith.order };
    if (e.id === swapWith.id) return { ...e, order: edge.order };
    return e;
  });
}

/** Drop every edge for references or targets that no longer exist. */
export function pruneAssignments(assignments = [], { references = [], scenes = [] } = {}) {
  const refIds = new Set(references.map(r => r.id));
  const sceneIds = new Set(scenes.map(s => s.id));
  const shotIds = new Set(scenes.flatMap(s => (s.shots || []).map(shot => shot.id)));

  return assignments.filter(edge => {
    if (!refIds.has(edge.refId)) return false;
    if (edge.scope === 'scene') return sceneIds.has(edge.targetId);
    if (edge.scope === 'shot') return shotIds.has(edge.targetId);
    return true;
  });
}

// --- BROWSING --------------------------------------------------------------

export const GROUP_MODES = [
  { id: 'none', label: 'Nothing' },
  { id: 'kind', label: 'Type' },
  { id: 'scene', label: 'Scene' },
  { id: 'shot', label: 'Shot' },
  { id: 'tag', label: 'Tag' },
  { id: 'asset', label: 'Linked asset' }
];

export const SORT_MODES = [
  { id: 'added', label: 'Recently added' },
  { id: 'name', label: 'Name' },
  { id: 'kind', label: 'Type' },
  { id: 'usage', label: 'Most used' }
];

/** Search + kind/tag filters + the "show only unused" toggle. */
export function filterReferences(references, { search = '', kinds = [], tags = [], onlyUnused = false, assignments = [] } = {}) {
  const needle = search.trim().toLowerCase();
  const kindSet = new Set(kinds);
  const tagSet = new Set(tags);

  return references.filter(ref => {
    if (kindSet.size > 0 && !kindSet.has(ref.kind)) return false;
    if (tagSet.size > 0 && !(ref.tags || []).some(tag => tagSet.has(tag))) return false;
    if (onlyUnused && !isUnassigned(assignments, ref.id)) return false;
    if (!needle) return true;

    return [ref.name, ref.notes, kindLabel(ref.kind), ...(ref.tags || [])]
      .filter(Boolean)
      .some(field => String(field).toLowerCase().includes(needle));
  });
}

export function sortReferences(references, mode, assignments = []) {
  const list = [...references];
  switch (mode) {
    case 'name':
      return list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    case 'kind':
      return list.sort((a, b) => (a.kind || '').localeCompare(b.kind || '') || (a.name || '').localeCompare(b.name || ''));
    case 'usage':
      return list.sort((a, b) => usageOf(assignments, b.id).total - usageOf(assignments, a.id).total);
    default:
      return list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }
}

/**
 * Bucket references for display.
 *
 * A reference attached to three shots appears under all three — grouping is a
 * view of the assignments, not a partition of the library — so the counts in
 * the headers can exceed the number of images, which is the honest reading.
 * Anything with no home lands in a trailing "Unassigned" group so it can never
 * silently disappear from a grouped view.
 */
export function groupReferences(references, mode, { assignments = [], scenes = [], assetLibrary = [] } = {}) {
  if (mode === 'none') return [{ id: 'all', label: `All references (${references.length})`, refs: references }];

  const groups = new Map();
  const push = (id, label, ref) => {
    if (!groups.has(id)) groups.set(id, { id, label, refs: [] });
    groups.get(id).refs.push(ref);
  };
  const orphans = [];

  if (mode === 'kind') {
    REFERENCE_KINDS.forEach(kind => groups.set(kind.id, { id: kind.id, label: kind.label, refs: [] }));
    references.forEach(ref => push(ref.kind || 'other', kindLabel(ref.kind), ref));
    return [...groups.values()].filter(group => group.refs.length > 0);
  }

  if (mode === 'tag') {
    references.forEach(ref => {
      if (!(ref.tags || []).length) return orphans.push(ref);
      ref.tags.forEach(tag => push(`tag:${tag}`, tag, ref));
    });
  }

  if (mode === 'asset') {
    // Two different relationships land in this view, and both matter: a
    // reference can *depict* an asset (the assetId link, shown as the card's
    // tag badge) or have been pushed into one's image pool. Membership is read
    // from the pools rather than stored, so an image deleted inside the asset
    // editor stops appearing here with no bookkeeping.
    references.forEach(ref => {
      const related = new Map();
      assetsContaining(assetLibrary, ref.path).forEach(asset => related.set(asset.id, asset));
      const linked = assetLibrary.find(a => a.id === ref.assetId);
      if (linked) related.set(linked.id, linked);

      if (related.size === 0) return orphans.push(ref);
      related.forEach(asset => push(`asset:${asset.id}`, `<${asset.tag}>`, ref));
    });
  }

  if (mode === 'scene' || mode === 'shot') {
    const shotScene = new Map();
    scenes.forEach(scene => (scene.shots || []).forEach(shot => shotScene.set(shot.id, scene)));

    references.forEach(ref => {
      const usage = usageOf(assignments, ref.id);
      let placed = false;

      if (usage.project) {
        push('project', 'Whole project', ref);
        placed = true;
      }

      if (mode === 'scene') {
        usage.sceneIds.forEach(sceneId => {
          const scene = scenes.find(s => s.id === sceneId);
          if (scene) { push(`scene:${sceneId}`, scene.name || 'Scene', ref); placed = true; }
        });
        // A shot-scoped reference still belongs to that shot's scene here —
        // otherwise "group by scene" hides most of the board.
        usage.shotIds.forEach(shotId => {
          const scene = shotScene.get(shotId);
          if (scene) { push(`scene:${scene.id}`, scene.name || 'Scene', ref); placed = true; }
        });
      } else {
        usage.shotIds.forEach(shotId => {
          const scene = shotScene.get(shotId);
          const shot = (scene?.shots || []).find(s => s.id === shotId);
          if (shot) { push(`shot:${shotId}`, `${scene.name} · ${shot.name}`, ref); placed = true; }
        });
      }

      if (!placed) orphans.push(ref);
    });
  }

  const result = [...groups.values()].map(group => ({
    ...group,
    refs: [...new Set(group.refs)]
  }));

  if (orphans.length > 0) {
    result.push({ id: 'unassigned', label: 'Unassigned', refs: [...new Set(orphans)] });
  }
  return result;
}
