// The half of the reorganisation that touches a disk: real folders, real
// renames, real collisions.
//
// `assetPaths.test.js` proves the plan is right. This proves that carrying it
// out does not lose a file — which is the failure that matters, because it is
// the one you cannot undo.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  listMediaFiles, resolveRecordedPath, invalidateIndex,
  applyMoves, resolveInsideRoot, siblingNames, reserveNewFile, readLedger
} = require('./assetOrganizer.js');

/** A throwaway project folder with the named files already in assets/. */
function makeProject(files = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-assets-'));
  files.forEach(relative => {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, relative); // contents = its own name, so a
  });                                     // mixed-up move is visible
  invalidateIndex(root);
  return root;
}

const read = (root, relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = (root, relative) => fs.existsSync(path.join(root, relative));

// --- the fence ---------------------------------------------------------------

test('a path outside the media root resolves to nothing at all', () => {
  const root = makeProject([]);
  assert.equal(resolveInsideRoot(root, '../secrets.txt'), null);
  assert.equal(resolveInsideRoot(root, 'assets/../../secrets.txt'), null);
  assert.equal(resolveInsideRoot(root, 'checkpoints/a.json'), null);
  // A sibling folder whose name merely starts the same way is still outside.
  assert.equal(resolveInsideRoot(root, 'assets-old/a.png'), null);
  assert.notEqual(resolveInsideRoot(root, 'assets/a.png'), null);
});

test('a move that escapes the media root is refused, not attempted', () => {
  const root = makeProject(['assets/a.png']);
  const { moved, failed } = applyMoves(root, [{ from: 'assets/a.png', to: '../stolen.png' }]);
  assert.deepEqual(moved, []);
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /outside the media root/);
  assert.equal(exists(root, 'assets/a.png'), true);
});

// --- walking -----------------------------------------------------------------

test('the walk finds files at every depth and reports them project-relative', () => {
  const root = makeProject([
    'assets/loose.png',
    'assets/shots/01-open/01-dawn/images/dawn_v01.png',
    'assets/library/characters/ralph/ralph_01.png'
  ]);
  assert.deepEqual(listMediaFiles(root).sort(), [
    'assets/library/characters/ralph/ralph_01.png',
    'assets/loose.png',
    'assets/shots/01-open/01-dawn/images/dawn_v01.png'
  ]);
});

test('a project with no media root yet walks to nothing rather than throwing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-empty-'));
  assert.deepEqual(listMediaFiles(root), []);
});

// --- moving ------------------------------------------------------------------

test('a move creates the folders it needs and carries the file, not a copy', () => {
  const root = makeProject(['assets/img_1.png']);
  const { moved, failed } = applyMoves(root, [
    { from: 'assets/img_1.png', to: 'assets/shots/01-open/01-dawn/images/dawn_v01.png' }
  ]);
  assert.equal(failed.length, 0);
  assert.equal(moved.length, 1);
  assert.equal(exists(root, 'assets/img_1.png'), false);
  assert.equal(read(root, 'assets/shots/01-open/01-dawn/images/dawn_v01.png'), 'assets/img_1.png');
});

test('two files exchanging names both survive it', () => {
  // The whole reason staging exists. A blind sequential rename destroys one.
  const root = makeProject(['assets/a.png', 'assets/b.png']);
  const { moved, failed } = applyMoves(root, [
    { from: 'assets/a.png', to: 'assets/b.png' },
    { from: 'assets/b.png', to: 'assets/a.png' }
  ]);
  assert.equal(failed.length, 0);
  assert.equal(moved.length, 2);
  assert.equal(read(root, 'assets/b.png'), 'assets/a.png');
  assert.equal(read(root, 'assets/a.png'), 'assets/b.png');
});

test('a rotation of three files keeps all three', () => {
  const root = makeProject(['assets/a.png', 'assets/b.png', 'assets/c.png']);
  applyMoves(root, [
    { from: 'assets/a.png', to: 'assets/b.png' },
    { from: 'assets/b.png', to: 'assets/c.png' },
    { from: 'assets/c.png', to: 'assets/a.png' }
  ]);
  assert.equal(read(root, 'assets/b.png'), 'assets/a.png');
  assert.equal(read(root, 'assets/c.png'), 'assets/b.png');
  assert.equal(read(root, 'assets/a.png'), 'assets/c.png');
});

test('the staging folder does not survive a successful run', () => {
  const root = makeProject(['assets/a.png', 'assets/b.png']);
  applyMoves(root, [
    { from: 'assets/a.png', to: 'assets/b.png' },
    { from: 'assets/b.png', to: 'assets/a.png' }
  ]);
  assert.equal(exists(root, 'assets/.organize-staging'), false);
});

test('a source that vanished is reported, and the rest still move', () => {
  const root = makeProject(['assets/b.png']);
  const { moved, failed } = applyMoves(root, [
    { from: 'assets/gone.png', to: 'assets/bin/gone.png' },
    { from: 'assets/b.png', to: 'assets/bin/b.png' }
  ]);
  assert.deepEqual(moved.map(m => m.from), ['assets/b.png']);
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /no longer exists/);
});

test('a move to where the file already is is not a move', () => {
  const root = makeProject(['assets/bin/a.png']);
  const { moved, failed } = applyMoves(root, [{ from: 'assets/bin/a.png', to: 'assets/bin/a.png' }]);
  assert.deepEqual(moved, []);
  assert.deepEqual(failed, []);
  assert.equal(exists(root, 'assets/bin/a.png'), true);
});

test('folders emptied by the move are cleared away, but the root stays', () => {
  const root = makeProject(['assets/shots/01-old/01-gone/images/x.png']);
  applyMoves(root, [{ from: 'assets/shots/01-old/01-gone/images/x.png', to: 'assets/bin/x.png' }]);
  assert.equal(exists(root, 'assets/shots'), false);
  assert.equal(exists(root, 'assets'), true);
  assert.equal(exists(root, 'assets/bin/x.png'), true);
});

// --- finding a file whose recorded path is stale -----------------------------

test('a path that still resolves is returned unchanged', () => {
  const root = makeProject(['assets/library/characters/ralph/ralph_01.png']);
  assert.equal(
    resolveRecordedPath(root, 'assets/library/characters/ralph/ralph_01.png'),
    'assets/library/characters/ralph/ralph_01.png'
  );
});

test('an old checkpoint path finds the file at its new home by name', () => {
  // This is what keeps every checkpoint and auto-backup working after a clean.
  const root = makeProject(['assets/shots/01-open/01-dawn/images/img_1761420033.png']);
  assert.equal(
    resolveRecordedPath(root, 'assets/img_1761420033.png'),
    'assets/shots/01-open/01-dawn/images/img_1761420033.png'
  );
});

test('an ambiguous name resolves to nothing rather than to a guess', () => {
  // Showing the wrong picture is worse than showing a missing one: only one of
  // the two looks like a problem.
  const root = makeProject(['assets/bin/dup.png', 'assets/reference/dup.png']);
  assert.equal(resolveRecordedPath(root, 'assets/dup.png'), null);
});

test('a file that is genuinely gone stays gone', () => {
  const root = makeProject(['assets/a.png']);
  assert.equal(resolveRecordedPath(root, 'assets/never-existed.png'), null);
});

test('the lookup index notices a move without being told twice', () => {
  const root = makeProject(['assets/img_9.png']);
  assert.equal(resolveRecordedPath(root, 'assets/img_9.png'), 'assets/img_9.png');
  applyMoves(root, [{ from: 'assets/img_9.png', to: 'assets/bin/img_9.png' }]);
  assert.equal(resolveRecordedPath(root, 'assets/img_9.png'), 'assets/bin/img_9.png');
});

// --- the forwarding ledger ---------------------------------------------------
//
// The basename index cannot help once a file is renamed as well as moved, and
// this layout renames everything. The ledger is what actually keeps a path
// recorded in an old checkpoint pointing at a real file.

test('a renamed file is still found by the path it used to have', () => {
  const root = makeProject(['assets/img_100.png']);
  applyMoves(root, [
    { from: 'assets/img_100.png', to: 'assets/shots/01-open/01-dawn/images/dawn_v01.png' }
  ]);
  assert.equal(
    resolveRecordedPath(root, 'assets/img_100.png'),
    'assets/shots/01-open/01-dawn/images/dawn_v01.png'
  );
});

test('the ledger travels inside the media root and is never swept up as a stray', () => {
  const root = makeProject(['assets/a.png']);
  applyMoves(root, [{ from: 'assets/a.png', to: 'assets/bin/a.png' }]);
  assert.equal(exists(root, 'assets/.organize-ledger.json'), true);
  assert.equal(listMediaFiles(root).includes('assets/.organize-ledger.json'), false);
});

test('a second move repoints the first address rather than growing a chain', () => {
  const root = makeProject(['assets/a.png']);
  applyMoves(root, [{ from: 'assets/a.png', to: 'assets/bin/a.png' }]);
  applyMoves(root, [{ from: 'assets/bin/a.png', to: 'assets/reference/rain_01.png' }]);

  const ledger = readLedger(root);
  assert.equal(ledger['assets/a.png'], 'assets/reference/rain_01.png');
  assert.equal(resolveRecordedPath(root, 'assets/a.png'), 'assets/reference/rain_01.png');
});

test('a file that comes back to its own name is not left forwarding to itself', () => {
  const root = makeProject(['assets/a.png']);
  applyMoves(root, [{ from: 'assets/a.png', to: 'assets/bin/a.png' }]);
  applyMoves(root, [{ from: 'assets/bin/a.png', to: 'assets/a.png' }]);

  // The round trip leaves one honest entry — bin/a.png really did become
  // a.png — and no self-referential one, which would be a loop to follow.
  const ledger = readLedger(root);
  assert.equal(ledger['assets/a.png'], undefined);
  assert.equal(ledger['assets/bin/a.png'], 'assets/a.png');
  assert.equal(resolveRecordedPath(root, 'assets/a.png'), 'assets/a.png');
});

test('a forwarding address to a file that has since been deleted is not followed', () => {
  const root = makeProject(['assets/a.png']);
  applyMoves(root, [{ from: 'assets/a.png', to: 'assets/bin/a.png' }]);
  fs.unlinkSync(path.join(root, 'assets/bin/a.png'));
  invalidateIndex(root);
  assert.equal(resolveRecordedPath(root, 'assets/a.png'), null);
});

test('a corrupt ledger costs a lookup, not the run', () => {
  const root = makeProject(['assets/a.png']);
  fs.writeFileSync(path.join(root, 'assets/.organize-ledger.json'), 'not json at all');
  assert.deepEqual(readLedger(root), {});
  const { failed } = applyMoves(root, [{ from: 'assets/a.png', to: 'assets/bin/a.png' }]);
  assert.deepEqual(failed, []);
  assert.equal(exists(root, 'assets/bin/a.png'), true);
});

// --- writing something new ---------------------------------------------------

test('siblings are what is in the folder, and nothing when there is no folder', () => {
  const root = makeProject(['assets/shots/01-open/01-dawn/images/dawn_v01.png']);
  assert.deepEqual(siblingNames(root, 'assets/shots/01-open/01-dawn/images'), ['dawn_v01.png']);
  assert.deepEqual(siblingNames(root, 'assets/shots/09-nothing/01-here/images'), []);
});

test('reserving a new file makes its folder and hands back both paths', () => {
  const root = makeProject([]);
  const spot = reserveNewFile(root, 'assets/library/props/lamp', 'lamp_01.png');
  assert.equal(spot.relativePath, 'assets/library/props/lamp/lamp_01.png');
  assert.equal(fs.existsSync(path.dirname(spot.absolutePath)), true);
  fs.writeFileSync(spot.absolutePath, 'x');
  assert.equal(exists(root, 'assets/library/props/lamp/lamp_01.png'), true);
});

test('reserving outside the media root throws rather than writing there', () => {
  const root = makeProject([]);
  assert.throws(() => reserveNewFile(root, '../elsewhere', 'a.png'), /outside the media root/);
});
