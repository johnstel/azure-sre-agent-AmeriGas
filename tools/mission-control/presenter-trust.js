/**
 * Builds the FULL trusted server-side evidence object consumed by
 * presenter-mode.js's resolveTrustedPresenterGate — NEVER derived from
 * client/request input. This closes two related defects found in review:
 *
 *   1. server.js's presenter mutation routes only ever populated
 *      serverProof with scheduled-task evidence, leaving every other gate
 *      kind (readiness, baseline, scenario, approval, remediation,
 *      recovery, incident-value) with no real evidence to evaluate at
 *      all -- those gates therefore ALWAYS denied, regardless of the
 *      actual state of the system.
 *   2. A gate-specific evidence source (e.g. the scheduled-task evidence
 *      store) must never crowd out or substitute for a different gate's
 *      own authoritative evidence. This function always assembles the
 *      complete picture from each gate kind's OWN store, so scheduled-task
 *      evidence can only ever affect the 'scheduled-task' gate.
 *
 * Every top-level gate kind is backed by its own authoritative source:
 *   - readiness / baseline  -> a live cluster snapshot + verifyBaselineState
 *     (scenario-lifecycle.js), matching the same baseline-fingerprint logic
 *     Start-DemoScenario/Reset-DemoBaseline already use. Any failure to
 *     reach the cluster degrades to an explicit false/"unknown" result --
 *     never a fabricated "healthy" default.
 *   - scenario              -> evaluateScenarioHealth (scenario-health.js)
 *     against the same cluster snapshot, scoped to the active incident's
 *     scenarioId.
 *   - approval / remediation / recovery / incident-value
 *                           -> the real, in-memory incidentStore's active
 *     incident record (with its actual milestones), which
 *     resolveTrustedPresenterGate already knows how to match exact action
 *     bindings against.
 *   - scheduled-task        -> scheduledTaskEvidenceStore.evaluate().
 */

async function buildTrustedPresenterServerProof({
  incidentStore,
  scheduledTaskEvidenceStore,
  collectClusterSnapshot,
  verifyBaselineState,
  evaluateScenarioHealth,
  repoRoot,
  namespace = 'propane',
  incidentCorrelationId,
}) {
  // A presenter run stays bound to ONE specific incident for its entire
  // lifetime (from the moment it is linked via `incidentCorrelationId`),
  // including after that incident is finalized -- the 'recovery' gate's
  // whole job is to confirm the BOUND incident reached
  // finalState === 'recovered', which requires seeing it even after
  // incidentStore.getActive() stops returning it (getActive() only
  // returns UNRESOLVED incidents by design; see incident-timeline.js).
  // When no incidentCorrelationId is bound yet (e.g. the very first
  // /start call before any track/incident linkage exists), fall back to
  // whatever incident is currently active.
  let activeIncident = null;
  if (incidentStore) {
    if (incidentCorrelationId && typeof incidentStore.getIncident === 'function') {
      activeIncident = incidentStore.getIncident(incidentCorrelationId) || null;
    }
    if (!activeIncident && typeof incidentStore.getActive === 'function') {
      activeIncident = incidentStore.getActive() || null;
    }
  }

  // Cluster-derived evidence (readiness/baseline, scenario activity) is
  // fetched ONCE and reused for both -- never fabricated; any failure to
  // reach the cluster degrades to an explicit "unknown"/false result,
  // never a fabricated "healthy" default.
  let clusterSnapshot = null;
  if (typeof collectClusterSnapshot === 'function') {
    try {
      clusterSnapshot = await collectClusterSnapshot(repoRoot, undefined, namespace);
    } catch {
      clusterSnapshot = null;
    }
  }

  let baselineReady = false;
  let readiness = { status: 'unknown', ready: false, remaining: [] };
  if (clusterSnapshot && typeof verifyBaselineState === 'function') {
    try {
      const verification = verifyBaselineState(clusterSnapshot);
      baselineReady = Boolean(verification && verification.ok === true);
      readiness = {
        status: baselineReady ? 'ready' : 'degraded',
        ready: baselineReady,
        remaining: verification && Array.isArray(verification.remaining) ? verification.remaining : [],
      };
    } catch {
      baselineReady = false;
      readiness = { status: 'unknown', ready: false, remaining: [] };
    }
  }

  let scenarioHealth = { active: null, reason: 'no active incident', scenarioId: null };
  if (clusterSnapshot && activeIncident && activeIncident.scenarioId && typeof evaluateScenarioHealth === 'function') {
    try {
      const evaluated = evaluateScenarioHealth(activeIncident.scenarioId, clusterSnapshot);
      scenarioHealth = {
        active: evaluated ? evaluated.active : null,
        reason: evaluated ? evaluated.reason : 'scenario health indicator unavailable',
        scenarioId: activeIncident.scenarioId,
      };
    } catch {
      scenarioHealth = { active: null, reason: 'scenario health evaluation failed', scenarioId: activeIncident.scenarioId };
    }
  }

  const scheduledTaskEvidence = scheduledTaskEvidenceStore && typeof scheduledTaskEvidenceStore.evaluate === 'function'
    ? scheduledTaskEvidenceStore.evaluate()
    : { available: false, reason: 'scheduled-task evidence store not configured' };

  return {
    activeIncident,
    incident: activeIncident,
    scenarioId: activeIncident ? (activeIncident.scenarioId || null) : null,
    incidentCorrelationId: activeIncident ? (activeIncident.correlationId || null) : null,
    baselineReady,
    baselineHealthPass: baselineReady,
    readiness,
    health: readiness,
    scenarioHealth,
    scenarioActive: Boolean(scenarioHealth && scenarioHealth.active === true),
    scheduledTaskAvailable: scheduledTaskEvidence.available === true,
    scheduledTaskEvidence,
    // Deliberately left unpopulated -- no server store currently backs
    // "native SRE Agent evidence" independent of the scheduled task; a
    // future evidence source should populate this the same way, never a
    // fabricated default.
    nativeEvidenceAvailable: false,
    nativeEvidence: { available: false, categories: [] },
  };
}

module.exports = { buildTrustedPresenterServerProof };
