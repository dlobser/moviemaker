import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REFERENCE_SCHEMA_VERSION,
  assignReferences,
  edgesFor,
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

  assert.deepEqual(usageOf(next, 'r1'), { project: true, sceneIds: [], shotIds: [], total: 1 });
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
