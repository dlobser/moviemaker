// node --test frontend/src/pipeline.test.js
//
// The controller is pure given injected stage fns, so everything the panel
// depends on gets pinned down with fakes: drain order, retry-then-mark-failed
// without blocking siblings, one cancel token, pause/resume mid-stage,
// resume-from-state via re-derived candidates, and the dry-run estimate.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPipelineRun, estimateRun } from './pipeline.js';

const stage = (id, candidates, run, over = {}) => ({
  id, label: id, candidates: () => candidates(), run, ...over
});

test('stages drain fully, in order', async () => {
  const log = [];
  const run = createPipelineRun({
    stages: [
      stage('a', () => [1, 2], async (n) => { log.push(`a${n}`); }),
      stage('b', () => [3], async (n) => { log.push(`b${n}`); })
    ],
    options: { retry: { attempts: 1, backoffMs: 0 } }
  });
  const finalState = await run.start();
  assert.deepEqual(log, ['a1', 'a2', 'b3']);
  assert.equal(finalState.status, 'done');
  assert.equal(finalState.stageStates.a.done, 2);
});

test('a failing candidate retries with backoff then fails without blocking siblings', async () => {
  const tries = { x: 0, y: 0 };
  const run = createPipelineRun({
    stages: [stage('gen', () => [{ id: 'x' }, { id: 'y' }], async (c) => {
      tries[c.id] += 1;
      if (c.id === 'x') throw new Error('boom');
      return { ok: true };
    })],
    options: { retry: { attempts: 2, backoffMs: 1 } }
  });
  const finalState = await run.start();
  assert.equal(tries.x, 2, 'two attempts for the failure');
  assert.equal(tries.y, 1);
  assert.equal(finalState.stageStates.gen.done, 2, 'the failure still counts as processed');
  assert.deepEqual(finalState.stageStates.gen.failed.map(f => f.id), ['x']);
  assert.equal(finalState.status, 'done', 'a candidate failure never halts the run');
});

test('{ ok: false } results count as failures too', async () => {
  const run = createPipelineRun({
    stages: [stage('gen', () => [{ id: 'x' }], async () => ({ ok: false, error: 'provider said no' }))],
    options: { retry: { attempts: 1, backoffMs: 0 } }
  });
  const finalState = await run.start();
  assert.match(finalState.stageStates.gen.failed[0].error, /provider said no/);
});

test('skip leaves a stage untouched', async () => {
  let ran = 0;
  const run = createPipelineRun({
    stages: [
      stage('a', () => [1], async () => { ran += 1; }),
      stage('b', () => [1], async () => { ran += 1; })
    ],
    options: { skip: new Set(['a']), retry: { attempts: 1, backoffMs: 0 } }
  });
  const finalState = await run.start();
  assert.equal(ran, 1);
  assert.equal(finalState.stageStates.a.status, 'skipped');
});

test('cancel stops dispatch; in-flight work finishes', async () => {
  let started = 0;
  let run;
  run = createPipelineRun({
    stages: [stage('gen', () => [1, 2, 3, 4], async () => {
      started += 1;
      if (started === 1) run.cancel();
      await new Promise(r => setTimeout(r, 5));
    })],
    options: { retry: { attempts: 1, backoffMs: 0 } }
  });
  const finalState = await run.start();
  assert.equal(started, 1, 'no new candidates after cancel');
  assert.equal(finalState.status, 'cancelled');
});

test('pause holds the next candidate until resume', async () => {
  const log = [];
  let run;
  run = createPipelineRun({
    stages: [stage('gen', () => [1, 2], async (n) => {
      log.push(n);
      if (n === 1) {
        run.pause();
        setTimeout(() => run.resume(), 20);
      }
    })],
    options: { retry: { attempts: 1, backoffMs: 0 } }
  });
  const startedAt = Date.now();
  await run.start();
  assert.deepEqual(log, [1, 2]);
  assert.ok(Date.now() - startedAt >= 15, 'the second candidate waited for resume');
});

test('candidates re-derive from state — completed work naturally skips on a rerun', async () => {
  const world = { pending: [1, 2, 3] };
  const make = () => createPipelineRun({
    stages: [stage('gen', () => [...world.pending], async (n) => {
      world.pending = world.pending.filter(x => x !== n);
    })],
    options: { retry: { attempts: 1, backoffMs: 0 } }
  });
  await make().start();
  assert.deepEqual(world.pending, []);
  const rerun = await make().start();
  assert.equal(rerun.stageStates.gen.total, 0, 'nothing left to do the second time');
});

test('dry run counts without running anything', async () => {
  let ran = 0;
  const run = createPipelineRun({
    stages: [stage('gen', () => [1, 2], async () => { ran += 1; })],
    options: { dryRun: true }
  });
  const finalState = await run.start();
  assert.equal(ran, 0);
  assert.equal(finalState.stageStates.gen.done, 2);
});

test('subscribe sees progress and unsubscribing stops it', async () => {
  const seen = [];
  const run = createPipelineRun({
    stages: [stage('gen', () => [1], async () => {})],
    options: { retry: { attempts: 1, backoffMs: 0 } }
  });
  const off = run.subscribe(snap => seen.push(snap.status));
  await run.start();
  off();
  assert.ok(seen.includes('running') && seen.includes('done'));
});

test('the estimate totals known prices and counts credit-priced runs apart', async () => {
  const rows = await estimateRun({
    stages: [
      stage('imgs', () => [{ m: 'cheap' }, { m: 'cheap' }, { m: 'credits' }], async () => {}),
      stage('skipped', () => [{ m: 'cheap' }], async () => {})
    ],
    skip: new Set(['skipped']),
    priceFor: (s, c) => (c.m === 'cheap' ? { price: 0.003 } : { price: null })
  });
  assert.equal(rows[0].count, 3);
  assert.ok(Math.abs(rows[0].knownCost - 0.006) < 1e-9);
  assert.equal(rows[0].creditRuns, 1);
  assert.equal(rows[1].skipped, true);
});
