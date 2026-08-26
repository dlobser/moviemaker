const test = require('node:test');
const assert = require('node:assert');
const {
  summariseProject, looksLikeDefaultProject, revisionOf, guardRevision, guardContent
} = require('./projectGuard.js');

const placeholderShot = {
  id: 'shot_1',
  name: 'Shot 1',
  setup: 'Wide establishing shot of a futuristic cyberpunk city skyline, neon lights reflecting in the rain.',
  description: 'A glowing hover-car slowly flies between towering skyscrapers.',
  dialogue: 'A voiceover says: "Welcome to New Eden, where dreams are manufactured."'
};

const defaultProject = { scenes: [{ id: 's1', shots: [placeholderShot] }] };

/** A project of `count` real shots, spread over one scene. */
function realProject(count, extra = {}) {
  return {
    scenes: [{
      id: 's1',
      shots: Array.from({ length: count }, (_, i) => ({ id: `shot_${i}`, setup: `Charlie walks in, take ${i}` }))
    }],
    ...extra
  };
}

test('summariseProject counts shots across scenes and the flat legacy list', () => {
  assert.deepStrictEqual(
    summariseProject({ scenes: [{ shots: [{}, {}] }, { shots: [{}] }] }).shots, 3
  );
  assert.strictEqual(summariseProject({ shots: [{}, {}] }).shots, 2);
  assert.strictEqual(summariseProject(null).shots, 0);
  assert.strictEqual(summariseProject({ edit: { video: [{}, {}, {}] } }).editClips, 3);
});

test('looksLikeDefaultProject only matches the untouched starter', () => {
  assert.ok(looksLikeDefaultProject(defaultProject));
  // One shot the user actually wrote is not the placeholder.
  assert.ok(!looksLikeDefaultProject(realProject(1)));
  // Placeholder text alongside real work is a project, not a fresh boot.
  assert.ok(!looksLikeDefaultProject({ ...defaultProject, edit: { video: [{ id: 'vc1' }] } }));
  assert.ok(!looksLikeDefaultProject({ scenes: [{ shots: [placeholderShot, { id: 'b' }] }] }));
});

test('revisionOf distinguishes a same-mtime rewrite of a different length', () => {
  assert.strictEqual(revisionOf(null), null);
  assert.notStrictEqual(
    revisionOf({ mtimeMs: 1000, size: 40 }),
    revisionOf({ mtimeMs: 1000, size: 90000 })
  );
  assert.strictEqual(revisionOf({ mtimeMs: 1000.4, size: 40 }), '1000:40');
});

test('guardRevision refuses a stale or baseline-less save', () => {
  assert.ok(guardRevision('a:1', 'a:1').ok);
  assert.strictEqual(guardRevision('a:1', 'b:2').reason, 'stale');
  assert.strictEqual(guardRevision(undefined, 'b:2').reason, 'no-baseline');
  // A brand new project has no file yet, and that is a legitimate baseline.
  assert.ok(guardRevision(null, null, {}).ok === false); // null base is still no baseline...
  assert.ok(guardRevision('none', 'none').ok);           // ...the server sends the sentinel instead
  assert.ok(guardRevision(undefined, 'b:2', { force: true }).ok);
});

test('guardContent refuses the placeholder over a real project', () => {
  const verdict = guardContent(defaultProject, realProject(45));
  assert.strictEqual(verdict.reason, 'placeholder');
  assert.strictEqual(verdict.before.shots, 45);
  assert.strictEqual(verdict.after.shots, 1);
});

test('guardContent refuses an empty save over a real project', () => {
  assert.strictEqual(guardContent({ scenes: [] }, realProject(45)).reason, 'empty');
});

test('guardContent refuses a save that halves a big project', () => {
  assert.strictEqual(guardContent(realProject(4), realProject(45)).reason, 'shrink');
});

test('guardContent allows ordinary edits', () => {
  assert.ok(guardContent(realProject(45), realProject(45)).ok);
  assert.ok(guardContent(realProject(46), realProject(45)).ok);
  // Deleting a scene of four out of forty-five is routine work, not a wipe.
  assert.ok(guardContent(realProject(41), realProject(45)).ok);
  // Small projects have no floor to fall from.
  assert.ok(guardContent(realProject(1), realProject(4)).ok);
  // A first save has nothing underneath it.
  assert.ok(guardContent(defaultProject, null).ok);
  // The starter project may overwrite itself.
  assert.ok(guardContent(defaultProject, defaultProject).ok);
});

test('guardContent protects a project whose work is all in the timeline', () => {
  const timelineOnly = { scenes: [], edit: { video: Array.from({ length: 30 }, (_, i) => ({ id: `vc${i}` })) } };
  assert.strictEqual(guardContent({ scenes: [] }, timelineOnly).reason, 'empty');
  assert.strictEqual(guardContent(defaultProject, timelineOnly).reason, 'placeholder');
});

test('force overrides every content refusal', () => {
  assert.ok(guardContent(defaultProject, realProject(45), { force: true }).ok);
  assert.ok(guardContent({ scenes: [] }, realProject(45), { force: true }).ok);
});
