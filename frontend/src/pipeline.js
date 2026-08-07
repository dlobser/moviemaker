// The pipeline run controller: one cancel token, one pause switch, a straight
// line of stages that each drain fully before the next starts.
//
// Pure logic — stages are injected as { id, label, candidates, run } and the
// controller knows nothing about React, shots or providers. Candidate
// predicates are the SOURCE OF TRUTH, not a work queue: every stage re-derives
// its work from project state when it starts, so resume-after-reload is just
// "run again with the same options" and completed work is naturally skipped.
//
// Per-candidate failures retry with backoff, then are marked failed WITHOUT
// blocking siblings — a failed shot image simply makes that shot ineligible
// for the video stage via its own candidate predicate.

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param stages  [{ id, label, candidates(ctx) -> [...] | Promise, run(candidate, ctx) -> Promise, concurrency? }]
 * @param options { skip?: Set<stageId>, concurrency?, retry?: { attempts, backoffMs }, dryRun? }
 * @param ctx     opaque, handed to candidates() and run()
 * @returns { start, pause, resume, cancel, subscribe, snapshot }
 */
export function createPipelineRun({ stages, options = {}, ctx = {} }) {
  const skip = options.skip instanceof Set ? options.skip : new Set(options.skip || []);
  const retry = { attempts: 2, backoffMs: 1000, ...(options.retry || {}) };

  const state = {
    id: options.id || `run_${Date.now().toString(36)}`,
    status: 'idle', // idle | running | paused | done | cancelled
    startedAt: null,
    finishedAt: null,
    options: { skip: [...skip], dryRun: Boolean(options.dryRun) },
    stageStates: Object.fromEntries(stages.map(stage => [stage.id, {
      status: skip.has(stage.id) ? 'skipped' : 'pending',
      total: 0,
      done: 0,
      failed: []
    }]))
  };

  const subscribers = new Set();
  const snapshot = () => JSON.parse(JSON.stringify(state));
  const emit = () => { const snap = snapshot(); subscribers.forEach(fn => fn(snap)); };

  let cancelled = false;
  let paused = false;
  let pauseWaiters = [];
  let started = false;

  const waitWhilePaused = async () => {
    while (paused && !cancelled) {
      await new Promise(resolve => pauseWaiters.push(resolve));
    }
  };

  const candidateId = (candidate, index) => (
    candidate?.id || candidate?.shot?.id || candidate?.asset?.id || `#${index}`
  );

  async function start() {
    if (started) return snapshot();
    started = true;
    state.status = 'running';
    state.startedAt = new Date().toISOString();
    emit();

    for (const stage of stages) {
      if (cancelled) break;
      const stageState = state.stageStates[stage.id];
      if (stageState.status === 'skipped') continue;
      await waitWhilePaused();
      if (cancelled) break;

      const candidates = await stage.candidates(ctx);
      stageState.total = candidates.length;
      stageState.done = 0;
      stageState.failed = [];
      stageState.status = 'running';
      emit();

      const workerCount = Math.max(1, Math.min(
        stage.concurrency || options.concurrency || 1,
        Math.max(1, candidates.length)
      ));
      let cursor = 0;

      const worker = async () => {
        while (true) {
          if (cancelled) return;
          await waitWhilePaused();
          if (cancelled) return;
          const index = cursor;
          cursor += 1;
          if (index >= candidates.length) return;

          const candidate = candidates[index];
          let lastError = null;
          let attempts = 0;

          if (!options.dryRun) {
            for (attempts = 1; attempts <= retry.attempts; attempts++) {
              try {
                const result = await stage.run(candidate, ctx);
                // Stage fns in this codebase resolve { ok: false } rather than
                // throwing — treat both shapes as failure.
                if (result && result.ok === false) throw new Error(result.error || 'failed');
                lastError = null;
                break;
              } catch (error) {
                lastError = error;
                if (cancelled) break;
                if (attempts < retry.attempts) await delay(retry.backoffMs * attempts);
              }
            }
          }

          if (lastError) {
            stageState.failed.push({ id: candidateId(candidate, index), error: lastError.message, attempts });
          }
          stageState.done += 1;
          emit();
        }
      };

      await Promise.all(Array.from({ length: workerCount }, worker));
      stageState.status = cancelled ? 'cancelled' : 'done';
      emit();
    }

    state.status = cancelled ? 'cancelled' : 'done';
    state.finishedAt = new Date().toISOString();
    emit();
    return snapshot();
  }

  return {
    start,
    pause: () => {
      if (state.status !== 'running') return;
      paused = true;
      state.status = 'paused';
      emit();
    },
    resume: () => {
      if (!paused) return;
      paused = false;
      state.status = cancelled ? 'cancelled' : 'running';
      pauseWaiters.splice(0).forEach(resolve => resolve());
      emit();
    },
    cancel: () => {
      cancelled = true;
      // A paused run must still be able to die.
      paused = false;
      pauseWaiters.splice(0).forEach(resolve => resolve());
      state.status = 'cancelled';
      emit();
    },
    subscribe: (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    snapshot
  };
}

/**
 * Dry-run cost estimate: per stage, count the candidates and total the known
 * per-unit prices; credit-priced models are counted separately rather than
 * pretending to a number nobody published.
 *
 * `priceFor(stage, candidate, ctx)` -> { price: number|null } — null means
 * credit-priced or unknown.
 */
export async function estimateRun({ stages, skip = new Set(), ctx = {}, priceFor }) {
  const rows = [];
  for (const stage of stages) {
    if (skip.has(stage.id)) {
      rows.push({ stageId: stage.id, label: stage.label, skipped: true, count: 0, knownCost: 0, creditRuns: 0 });
      continue;
    }
    const candidates = await stage.candidates(ctx);
    let knownCost = 0;
    let creditRuns = 0;
    for (const candidate of candidates) {
      const { price } = priceFor ? (priceFor(stage, candidate, ctx) || {}) : {};
      if (typeof price === 'number') knownCost += price;
      else creditRuns += 1;
    }
    rows.push({ stageId: stage.id, label: stage.label, skipped: false, count: candidates.length, knownCost, creditRuns });
  }
  return rows;
}
