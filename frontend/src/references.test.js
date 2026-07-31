import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REFERENCE_SCHEMA_VERSION,
  assignReferences,
  assignmentStateFor,
  edgesFor,
  enabledAssetReferencePaths,
  enabledReferencePaths,
  filterReferences,
  groupReferences,
  isUnassigned,
  migrateReferenceState,
  normalizeReference,
  pruneAssignments,
  reorderEdge,
  resolveShotReferences,
  setEdgeEnabled,
  unassignReferences,
  usageOf
} from './references.js';

const ref = (id, extra = {}) => normalizeReference({ id, path: `assets/${id}.png`, name: id, ...extra });

/** A two-scene project whose first shot carries two legacy references. */
function legacyProject() {
  return {
    referenceImages: [
      { id: 'r1', path: 'assets/r1.png', name: 'Neon alley' },
      { id: 'r2', path: 'assets/r2.png', name: 'Rain' },
      { id: 'r3', path: 'assets/r3.png', name: 'Ralph' }
    ],
    scenes: [
      { id: 'sc1', name: 'Cold Open', shots: [
        { id: 'sh1', name: 'Shot 1', referenceImages: ['r1', 'r2'] },
        { id: 'sh2', name: 'Shot 2', referenceImages: [] }
      ] },
      { id: 'sc2', name: 'The Garage', shots: [
        { id: 'sh3', name: 'Shot 3', referenceImages: ['r3'] }
      ] }
    ]
  };
}

// --- MIGRATION -------------------------------------------------------------

test('legacy per-shot reference arrays become assignment edges', () => {
  const { references, assignments, scenes } = migrateReferenceState(legacyProject());

  assert.equal(references.length, 3);
  assert.equal(assignments.length, 3);

  const shot1 = edgesFor(assignments, 'shot', 'sh1');
  assert.deepEqual(shot1.map(e => e.refId), ['r1', 'r2']);
  assert.deepEqual(shot1.map(e => e.order), [0, 1], 'original order is preserved for capacity trimming');
  assert.ok(shot1.every(e => e.enabled), 'a migrated reference is on by default');

  // The legacy field is cleared so there is one source of truth afterwards.
  assert.deepEqual(scenes[0].shots[0].referenceImages, []);
});

test('migration gives every reference the metadata the board sorts on', () => {
  const { references } = migrateReferenceState(legacyProject());
  assert.equal(references[0].kind, 'other');
  assert.deepEqual(references[0].tags, []);
  assert.equal(references[0].assetId, null);
  assert.ok(references[0].createdAt);
});

test('migration does not run twice over an already-migrated project', () => {
  const first = migrateReferenceState(legacyProject());
  const again = migrateReferenceState({
    referenceImages: first.references,
    refAssignments: first.assignments,
    scenes: first.scenes,
    referenceSchemaVersion: REFERENCE_SCHEMA_VERSION
  });

  assert.equal(again.assignments.length, 3, 'edges are not duplicated on reload');
});

test('a reference id left behind by a deleted image is dropped, not resurrected', () => {
  const project = legacyProject();
  project.scenes[0].shots[0].referenceImages.push('ghost');
  const { assignments } = migrateReferenceState(project);
  assert.ok(!assignments.some(e => e.refId === 'ghost'));
});

// --- SCOPE RESOLUTION ------------------------------------------------------

const scene = { id: 'sc1', name: 'Scene', shots: [{ id: 'sh1', name: 'Shot' }] };
const shot = scene.shots[0];
const refs = [ref('own'), ref('sceneWide'), ref('projectWide')];

function scopedAssignments() {
  let edges = [];
  edges = assignReferences(edges, ['own'], [{ scope: 'shot', targetId: 'sh1' }]);
  edges = assignReferences(edges, ['sceneWide'], [{ scope: 'scene', targetId: 'sc1' }]);
  edges = assignReferences(edges, ['projectWide'], [{ scope: 'project' }]);
  return edges;
}

test('a shot sees its own, its scene’s and the project’s references, most specific first', () => {
  const entries = resolveShotReferences({ shot, scene, references: refs, assignments: scopedAssignments() });

  assert.deepEqual(entries.map(e => e.ref.id), ['own', 'sceneWide', 'projectWide']);
  assert.deepEqual(entries.map(e => e.scope), ['shot', 'scene', 'project']);
  assert.deepEqual(entries.map(e => e.inherited), [false, true, true]);
  assert.ok(entries.every(e => e.enabled));
});

test('the most specific scope wins when the same image is attached twice', () => {
  let edges = assignReferences([], ['own'], [{ scope: 'shot', targetId: 'sh1' }]);
  edges = assignReferences(edges, ['own'], [{ scope: 'project' }]);

  const entries = resolveShotReferences({ shot, scene, references: refs, assignments: edges });
  assert.equal(entries.length, 1, 'no duplicate upload of the same image');
  assert.equal(entries[0].scope, 'shot');
});

// --- SEND CONTROL ----------------------------------------------------------

test('unticking a shot’s own reference keeps the assignment but stops the upload', () => {
  const edges = scopedAssignments();
  const ownEdge = edges.find(e => e.refId === 'own');
  const next = setEdgeEnabled(edges, ownEdge.id, false);

  const entries = resolveShotReferences({ shot, scene, references: refs, assignments: next });
  assert.equal(entries.find(e => e.ref.id === 'own').enabled, false);
  assert.ok(!isUnassigned(next, 'own'), 'it is still assigned to the shot');

  assert.deepEqual(
    enabledReferencePaths({ shot, scene, references: refs, assignments: next }),
    ['assets/sceneWide.png', 'assets/projectWide.png']
  );
});

test('a shot can opt out of one inherited reference without affecting its siblings', () => {
  const edges = scopedAssignments();
  const picky = { ...shot, refExclusions: ['sceneWide'] };

  assert.deepEqual(
    enabledReferencePaths({ shot: picky, scene, references: refs, assignments: edges }),
    ['assets/own.png', 'assets/projectWide.png']
  );
  // The sibling shot is untouched.
  assert.deepEqual(
    enabledReferencePaths({ shot, scene, references: refs, assignments: edges }),
    ['assets/own.png', 'assets/sceneWide.png', 'assets/projectWide.png']
  );
});

test('a shot can refuse every inherited reference at once and keep its own', () => {
  const solo = { ...shot, useInheritedRefs: false };
  assert.deepEqual(
    enabledReferencePaths({ shot: solo, scene, references: refs, assignments: scopedAssignments() }),
    ['assets/own.png']
  );
});

test('send order puts the shot’s own choices first, so they survive a capacity trim', () => {
  const paths = enabledReferencePaths({ shot, scene, references: refs, assignments: scopedAssignments() });
  assert.equal(paths[0], 'assets/own.png');
});

// --- BULK ASSIGNMENT -------------------------------------------------------

test('many references attach to many shots in one operation', () => {
  const targets = [
    { scope: 'shot', targetId: 'sh1' },
    { scope: 'shot', targetId: 'sh2' },
    { scope: 'shot', targetId: 'sh3' }
  ];
  const edges = assignReferences([], ['r1', 'r2', 'r3', 'r4'], targets);

  assert.equal(edges.length, 12);
  assert.equal(edgesFor(edges, 'shot', 'sh2').length, 4);
  assert.deepEqual(edgesFor(edges, 'shot', 'sh2').map(e => e.order), [0, 1, 2, 3]);
});

test('assigning the same reference twice does not duplicate the edge', () => {
  let edges = assignReferences([], ['r1'], [{ scope: 'shot', targetId: 'sh1' }]);
  edges = assignReferences(edges, ['r1', 'r2'], [{ scope: 'shot', targetId: 'sh1' }]);

  assert.equal(edges.length, 2);
  assert.deepEqual(edgesFor(edges, 'shot', 'sh1').map(e => e.refId), ['r1', 'r2']);
});

test('replace mode clears the target before assigning', () => {
  let edges = assignReferences([], ['r1', 'r2'], [{ scope: 'shot', targetId: 'sh1' }]);
  edges = assignReferences(edges, ['r3'], [{ scope: 'shot', targetId: 'sh1' }], { mode: 'replace' });

  assert.deepEqual(edgesFor(edges, 'shot', 'sh1').map(e => e.refId), ['r3']);
});

test('replace mode leaves other targets alone', () => {
  let edges = assignReferences([], ['r1'], [{ scope: 'shot', targetId: 'sh1' }, { scope: 'shot', targetId: 'sh2' }]);
  edges = assignReferences(edges, ['r2'], [{ scope: 'shot', targetId: 'sh1' }], { mode: 'replace' });

  assert.deepEqual(edgesFor(edges, 'shot', 'sh2').map(e => e.refId), ['r1']);
});

test('unassigning without targets detaches a reference everywhere', () => {
  const edges = assignReferences([], ['r1'], [
    { scope: 'shot', targetId: 'sh1' },
    { scope: 'scene', targetId: 'sc1' },
    { scope: 'project' }
  ]);

  assert.equal(usageOf(edges, 'r1').total, 3);
  assert.ok(isUnassigned(unassignReferences(edges, ['r1']), 'r1'));
});

test('unassigning from one target leaves the others intact', () => {
  const edges = assignReferences([], ['r1'], [
    { scope: 'shot', targetId: 'sh1' },
    { scope: 'project' }
  ]);
  const next = unassignReferences(edges, ['r1'], [{ scope: 'shot', targetId: 'sh1' }]);

  assert.deepEqual(usageOf(next, 'r1'), {
    project: true, sceneIds: [], shotIds: [], allAssets: false, assetIds: [], total: 1
  });
});

test('reordering swaps send priority within a target only', () => {
  const edges = assignReferences([], ['r1', 'r2'], [{ scope: 'shot', targetId: 'sh1' }]);
  const second = edgesFor(edges, 'shot', 'sh1')[1];
  const next = reorderEdge(edges, second.id, 'up');

  assert.deepEqual(edgesFor(next, 'shot', 'sh1').map(e => e.refId), ['r2', 'r1']);
});

test('deleting a shot prunes its edges but spares project-wide ones', () => {
  const edges = assignReferences([], ['r1'], [
    { scope: 'shot', targetId: 'sh1' },
    { scope: 'shot', targetId: 'gone' },
    { scope: 'project' }
  ]);
  const next = pruneAssignments(edges, { references: [ref('r1')], scenes: [scene] });

  assert.equal(next.length, 2);
  assert.ok(!next.some(e => e.targetId === 'gone'));
});

// --- ASSET SCOPE -----------------------------------------------------------

const assets = [
  { id: 'a1', tag: 'Ralph' },
  { id: 'a2', tag: 'Garage' },
  { id: 'a3', tag: 'Wrench' }
];
const assetRefs = [ref('styleBoard'), ref('ralphOwn')];

test('one style reference reaches every asset in a single assignment', () => {
  const edges = assignReferences([], ['styleBoard'], [{ scope: 'asset', targetId: null }]);
  assert.equal(edges.length, 1, 'one edge, not one per asset');

  assets.forEach(asset => {
    assert.deepEqual(
      enabledAssetReferencePaths({ asset, references: assetRefs, assignments: edges }),
      ['assets/styleBoard.png'],
      `<${asset.tag}> receives it`
    );
  });
});

test('an all-assets reference also covers assets created later', () => {
  const edges = assignReferences([], ['styleBoard'], [{ scope: 'asset', targetId: null }]);
  const brandNew = { id: 'a99', tag: 'LaterCharacter' };

  assert.deepEqual(
    enabledAssetReferencePaths({ asset: brandNew, references: assetRefs, assignments: edges }),
    ['assets/styleBoard.png']
  );
});

test('an asset’s own reference is sent before a shared one, surviving a capacity trim', () => {
  let edges = assignReferences([], ['styleBoard'], [{ scope: 'asset', targetId: null }]);
  edges = assignReferences(edges, ['ralphOwn'], [{ scope: 'asset', targetId: 'a1' }]);

  assert.deepEqual(
    enabledAssetReferencePaths({ asset: assets[0], references: assetRefs, assignments: edges }),
    ['assets/ralphOwn.png', 'assets/styleBoard.png']
  );
});

test('one asset can opt out of a shared reference without affecting the others', () => {
  const edges = assignReferences([], ['styleBoard'], [{ scope: 'asset', targetId: null }]);
  const picky = { ...assets[0], refExclusions: ['styleBoard'] };

  assert.deepEqual(enabledAssetReferencePaths({ asset: picky, references: assetRefs, assignments: edges }), []);
  assert.deepEqual(
    enabledAssetReferencePaths({ asset: assets[1], references: assetRefs, assignments: edges }),
    ['assets/styleBoard.png'],
    'the other assets still get it'
  );
  assert.ok(!isUnassigned(edges, 'styleBoard'), 'and it stays assigned');
});

test('unticking an asset-specific reference stops the upload but keeps the assignment', () => {
  const edges = assignReferences([], ['ralphOwn'], [{ scope: 'asset', targetId: 'a1' }]);
  const next = setEdgeEnabled(edges, edges[0].id, false);

  assert.deepEqual(enabledAssetReferencePaths({ asset: assets[0], references: assetRefs, assignments: next }), []);
  assert.equal(usageOf(next, 'ralphOwn').assetIds.length, 1);
});

test('asset scope does not leak into shots, and project scope does not leak into assets', () => {
  let edges = assignReferences([], ['styleBoard'], [{ scope: 'asset', targetId: null }]);
  edges = assignReferences(edges, ['ralphOwn'], [{ scope: 'project' }]);

  assert.deepEqual(
    enabledReferencePaths({ shot, scene, references: assetRefs, assignments: edges }),
    ['assets/ralphOwn.png'],
    'a shot sees the project reference but not the asset one'
  );
  assert.deepEqual(
    enabledAssetReferencePaths({ asset: assets[0], references: assetRefs, assignments: edges }),
    ['assets/styleBoard.png'],
    'an asset sees the asset reference but not the project one'
  );
});

test('usage reports all-assets separately from individually picked assets', () => {
  let edges = assignReferences([], ['styleBoard'], [{ scope: 'asset', targetId: null }]);
  edges = assignReferences(edges, ['ralphOwn'], [{ scope: 'asset', targetId: 'a1' }, { scope: 'asset', targetId: 'a2' }]);

  assert.equal(usageOf(edges, 'styleBoard').allAssets, true);
  assert.deepEqual(usageOf(edges, 'styleBoard').assetIds, []);
  assert.equal(usageOf(edges, 'ralphOwn').allAssets, false);
  assert.deepEqual(usageOf(edges, 'ralphOwn').assetIds, ['a1', 'a2']);
});

test('deleting an asset prunes its edges but spares the all-assets one', () => {
  let edges = assignReferences([], ['styleBoard'], [{ scope: 'asset', targetId: null }]);
  edges = assignReferences(edges, ['styleBoard'], [{ scope: 'asset', targetId: 'gone' }]);

  const next = pruneAssignments(edges, { references: [ref('styleBoard')], scenes: [], assetLibrary: assets });
  assert.equal(next.length, 1);
  assert.equal(next[0].targetId, null);
});

// --- WHAT THE ASSIGN DIALOG OPENS SHOWING ----------------------------------

test('a target holding the whole selection reads as fully attached', () => {
  const edges = assignReferences([], ['r1', 'r2'], [{ scope: 'asset', targetId: null }]);
  assert.deepEqual(assignmentStateFor(edges, ['r1', 'r2']), { 'asset:all': 'all' });
});

test('a target holding only part of the selection reads as partial', () => {
  const edges = assignReferences([], ['r1'], [{ scope: 'asset', targetId: null }]);
  assert.deepEqual(assignmentStateFor(edges, ['r1', 'r2']), { 'asset:all': 'some' });
});

test('a target holding none of the selection is simply absent', () => {
  const edges = assignReferences([], ['other'], [{ scope: 'shot', targetId: 'sh1' }]);
  assert.deepEqual(assignmentStateFor(edges, ['r1']), {});
});

test('every scope gets a distinct key, and every-asset is not the same as one asset', () => {
  let edges = assignReferences([], ['r1'], [{ scope: 'project' }]);
  edges = assignReferences(edges, ['r1'], [{ scope: 'scene', targetId: 'sc1' }]);
  edges = assignReferences(edges, ['r1'], [{ scope: 'shot', targetId: 'sh1' }]);
  edges = assignReferences(edges, ['r1'], [{ scope: 'asset', targetId: null }]);
  edges = assignReferences(edges, ['r1'], [{ scope: 'asset', targetId: 'a1' }]);

  assert.deepEqual(assignmentStateFor(edges, ['r1']), {
    project: 'all',
    'scene:sc1': 'all',
    'shot:sh1': 'all',
    'asset:all': 'all',
    'asset:a1': 'all'
  });
});

test('the every-asset assignment can be taken back', () => {
  const edges = assignReferences([], ['r1'], [{ scope: 'asset', targetId: null }]);
  assert.equal(assignmentStateFor(edges, ['r1'])['asset:all'], 'all');

  const next = unassignReferences(edges, ['r1'], [{ scope: 'asset', targetId: null }]);
  assert.deepEqual(assignmentStateFor(next, ['r1']), {});
  assert.deepEqual(enabledAssetReferencePaths({ asset: assets[0], references: [ref('r1')], assignments: next }), []);
});

test('detaching from every-asset leaves an individual asset assignment alone', () => {
  let edges = assignReferences([], ['r1'], [{ scope: 'asset', targetId: null }]);
  edges = assignReferences(edges, ['r1'], [{ scope: 'asset', targetId: 'a1' }]);

  const next = unassignReferences(edges, ['r1'], [{ scope: 'asset', targetId: null }]);
  assert.deepEqual(assignmentStateFor(next, ['r1']), { 'asset:a1': 'all' });
});

test('references can be attached but held back, then switched on later', () => {
  const edges = assignReferences([], ['r1'], [{ scope: 'asset', targetId: null }], { enabled: false });
  const refs = [ref('r1')];

  assert.ok(!isUnassigned(edges, 'r1'), 'attached');
  assert.deepEqual(enabledAssetReferencePaths({ asset: assets[0], references: refs, assignments: edges }), [], 'but not sent');

  const live = setEdgeEnabled(edges, edges[0].id, true);
  assert.deepEqual(
    enabledAssetReferencePaths({ asset: assets[0], references: refs, assignments: live }),
    ['assets/r1.png']
  );
});

test('assignment defaults to live, so a plain assign takes effect immediately', () => {
  const edges = assignReferences([], ['r1'], [{ scope: 'shot', targetId: 'sh1' }]);
  assert.equal(edges[0].enabled, true);
});

// --- BROWSING --------------------------------------------------------------

const board = [
  ref('a', { kind: 'character', tags: ['hero'], name: 'Ralph' }),
  ref('b', { kind: 'style', tags: ['neon', 'night'], name: 'Neon alley' }),
  ref('c', { kind: 'style', tags: ['neon'], name: 'Wet street', notes: 'the puddles, not the colour' }),
  ref('d', { kind: 'prop', name: 'Wrench' })
];

test('search covers name, notes, tags and type', () => {
  assert.deepEqual(filterReferences(board, { search: 'ralph' }).map(r => r.id), ['a']);
  assert.deepEqual(filterReferences(board, { search: 'puddles' }).map(r => r.id), ['c']);
  assert.deepEqual(filterReferences(board, { search: 'neon' }).map(r => r.id), ['b', 'c']);
  assert.deepEqual(filterReferences(board, { search: 'prop' }).map(r => r.id), ['d']);
});

test('kind and tag filters intersect', () => {
  assert.deepEqual(filterReferences(board, { kinds: ['style'] }).map(r => r.id), ['b', 'c']);
  assert.deepEqual(filterReferences(board, { kinds: ['style'], tags: ['night'] }).map(r => r.id), ['b']);
});

test('the unused filter finds references attached to nothing', () => {
  const edges = assignReferences([], ['a'], [{ scope: 'project' }]);
  assert.deepEqual(
    filterReferences(board, { onlyUnused: true, assignments: edges }).map(r => r.id),
    ['b', 'c', 'd']
  );
});

test('grouping by type drops empty buckets', () => {
  const groups = groupReferences(board, 'kind');
  assert.deepEqual(groups.map(g => g.id), ['character', 'style', 'prop']);
  assert.deepEqual(groups.find(g => g.id === 'style').refs.map(r => r.id), ['b', 'c']);
});

test('grouping by tag collects untagged references rather than hiding them', () => {
  const groups = groupReferences(board, 'tag');
  assert.deepEqual(groups.find(g => g.id === 'unassigned').refs.map(r => r.id), ['d']);
  assert.deepEqual(groups.find(g => g.label === 'neon').refs.map(r => r.id), ['b', 'c']);
});

test('grouping by scene files a shot-scoped reference under that shot’s scene', () => {
  const edges = assignReferences([], ['a'], [{ scope: 'shot', targetId: 'sh1' }]);
  const groups = groupReferences(board, 'scene', { assignments: edges, scenes: [scene] });

  assert.deepEqual(groups.find(g => g.id === 'scene:sc1').refs.map(r => r.id), ['a']);
  assert.equal(groups.find(g => g.id === 'unassigned').refs.length, 3);
});
