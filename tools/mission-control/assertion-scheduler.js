/**
 * Post-action assertion scheduling with reconnect-safe (restart-safe)
 * persistence.
 *
 * Extracted from server.js so it can be exercised in isolation, with no
 * Express/CopilotClient/live-cluster dependency: given an incidentStore
 * (see incident-store.js) and a way to check a scenario's server-side
 * health, this module schedules a one-shot assertion after a remediation
 * action executes, persists enough state (via
 * incidentStore.schedulePendingAssertion) that a *fresh* instance created
 * after a process restart can find and resume any assertion that hadn't
 * run yet (or execute it immediately if it's already overdue — see
 * rehydrate()), and retries with a backoff when the health check is
 * transiently unavailable instead of silently giving up forever.
 */
function createAssertionScheduler(options = {}) {
  const { incidentStore, checkScenarioHealth, retryDelayMs = 5000 } = options;
  const setTimeoutFn = options.setTimeout || setTimeout;

  if (!incidentStore) throw new Error('createAssertionScheduler requires an incidentStore');
  if (typeof checkScenarioHealth !== 'function') throw new Error('createAssertionScheduler requires a checkScenarioHealth(scenarioId) function');

  /**
   * Actually perform the assertion check right now. `checkScenarioHealth`
   * must resolve to `null` when the cluster is transiently unreachable
   * (never fabricate a result), or `{ active, reason }` (active may be
   * `null` when no server-side indicator exists for the scenario at all).
   */
  async function runNow(correlationId, scenarioId, actionKey) {
    try {
      // Re-fetch the incident and re-validate it is still the same,
      // non-terminal run before mutating it — a lot can happen between
      // when this was scheduled and now (a fresh run could have started,
      // or another signal could have already finalized this one).
      const incident = incidentStore.getIncident(correlationId);
      if (!incident || incident.finalState) {
        incidentStore.resolvePendingAssertion(correlationId, actionKey);
        return;
      }

      const health = await checkScenarioHealth(scenarioId);
      if (!health) {
        // Transiently unreachable — retry with a backoff instead of
        // giving up forever (which would leave hasPendingAssertion true
        // indefinitely even once reachability is restored).
        incidentStore.bumpPendingAssertionAttempt(correlationId, actionKey, { dueAt: Date.now() + retryDelayMs });
        const retryTimer = setTimeoutFn(() => runNow(correlationId, scenarioId, actionKey), retryDelayMs);
        if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref();
        return;
      }

      if (health.active === null) {
        // No server-side indicator exists for this scenario; nothing will
        // ever be assertable, so resolve rather than retry forever.
        incidentStore.resolvePendingAssertion(correlationId, actionKey);
        return;
      }

      incidentStore.recordPostActionAssertion(correlationId, {
        actionKey,
        passed: !health.active,
        details: health.reason,
      });
    } catch {
      /* best effort; never throw from a background timer. The descriptor
         remains unresolved and will be retried on the next rehydration
         pass (e.g. after a restart) if nothing else retries it first. */
    }
  }

  /**
   * Schedule a one-shot assertion `delayMs` from now. Persists a pending
   * descriptor immediately (so it survives a restart even if the process
   * exits before the timer fires) and sets an in-memory timer. Idempotent
   * per actionKey: if an assertion is already scheduled/outstanding for
   * this exact actionKey, no second in-memory timer is created.
   */
  function schedule(correlationId, scenarioId, actionKey, delayMs = 8000) {
    const incident = incidentStore.getIncident(correlationId);
    const alreadyScheduled = Boolean(incident && (incident.pendingAssertions || []).some((p) => p.actionKey === actionKey && !p.resolved));
    incidentStore.schedulePendingAssertion(correlationId, { actionKey, scenarioId, dueAt: Date.now() + delayMs });
    if (alreadyScheduled) return;
    const timer = setTimeoutFn(() => runNow(correlationId, scenarioId, actionKey), delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /**
   * Reschedule an in-memory timer for every unresolved pending assertion
   * persisted from a prior run (call this once at startup, after the
   * incidentStore has loaded from disk). An overdue descriptor (dueAt
   * already in the past) executes promptly rather than waiting out a full
   * interval. Returns the number of descriptors rehydrated.
   */
  function rehydrate() {
    const pending = incidentStore.listUnresolvedPendingAssertions();
    for (const entry of pending) {
      const dueAtMs = new Date(entry.dueAt).getTime();
      const delay = Number.isFinite(dueAtMs) ? Math.max(0, dueAtMs - Date.now()) : 0;
      const timer = setTimeoutFn(() => runNow(entry.correlationId, entry.scenarioId, entry.actionKey), delay);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    return pending.length;
  }

  return { runNow, schedule, rehydrate };
}

module.exports = { createAssertionScheduler };
