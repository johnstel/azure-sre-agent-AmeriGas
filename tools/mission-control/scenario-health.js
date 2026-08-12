/**
 * Server-authoritative scenario health evaluation.
 *
 * This mirrors the client-side indicator logic in public/app.js
 * (SCENARIO_INDICATORS) but operates on raw `kubectl -o json` output so the
 * *server* — not the browser — can make authoritative statements about
 * whether a given breakable scenario's failure signature is currently
 * observable in the cluster. This is what lets the incident timeline record
 * "first observed impact" and "recovery" with a server timestamp instead of
 * trusting client polling.
 *
 * Kept intentionally dependency-free (no kubectl/az calls here) so it can be
 * unit tested against fixture data.
 */

/** Parse a raw pod object (from `kubectl get pods -o json`) into a flat summary. */
function parsePodStatus(pod) {
  const status = (pod && pod.status) || {};
  const containerStatuses = status.containerStatuses || [];
  let phase = status.phase || 'Unknown';
  let reason = '';
  let restarts = 0;

  for (const container of containerStatuses) {
    restarts += Number(container.restartCount || 0);
    const state = container.state || {};
    if (state.waiting) {
      phase = state.waiting.reason || 'Waiting';
      reason = state.waiting.reason || '';
    } else if (state.terminated) {
      phase = state.terminated.reason || 'Terminated';
      reason = state.terminated.reason || '';
    }
  }

  const initContainerStatuses = status.initContainerStatuses || [];
  for (const container of initContainerStatuses) {
    const state = container.state || {};
    if (state.waiting) {
      phase = `Init:${state.waiting.reason || 'Waiting'}`;
      reason = state.waiting.reason || '';
    }
  }

  return {
    name: (pod && pod.metadata && pod.metadata.name) || '',
    status: phase,
    reason,
    restarts,
  };
}

// Mirrors public/app.js SCENARIO_INDICATORS for scenarios that are detectable
// purely from pod status. `network` and `service` are evaluated separately
// below because they depend on NetworkPolicy / Endpoints objects.
const POD_INDICATORS = {
  oom: (p) => p.name.startsWith('tank-monitor') && (p.reason === 'OOMKilled' || p.status === 'CrashLoopBackOff' || p.restarts > 2),
  crash: (p) => p.name.startsWith('inventory-service') && (p.status === 'CrashLoopBackOff' || p.status === 'Error'),
  image: (p) => p.name.startsWith('order-service') && (p.status === 'ImagePullBackOff' || p.status === 'ErrImagePull'),
  cpu: (p) => p.name.startsWith('demand-forecast'),
  pending: (p) => p.name.startsWith('fleet-telemetry'),
  probe: (p) => p.name.startsWith('safety-compliance'),
  config: (p) => p.name.startsWith('delivery-zone'),
  mongodb: (p) => p.name.startsWith('mongodb') && p.status !== 'Running',
};

/**
 * Evaluate whether a scenario's failure signature is currently observable.
 *
 * @param {string} scenarioId - one of the SCENARIO_MAP keys from scenario-catalog.js
 * @param {{pods?: object[], networkPolicies?: object[], endpoints?: object[]}} cluster
 * @returns {{active: boolean|null, reason: string}} active is null when no
 *   server-side indicator exists for the scenario (never fabricated).
 */
function evaluateScenarioHealth(scenarioId, cluster = {}) {
  const pods = (cluster.pods || []).map(parsePodStatus);

  if (scenarioId === 'network') {
    const policies = cluster.networkPolicies || [];
    const active = policies.some((np) => np && np.metadata && np.metadata.name === 'deny-tank-monitor');
    return {
      active,
      reason: active
        ? 'deny-tank-monitor NetworkPolicy is present in the propane namespace'
        : 'no deny-tank-monitor NetworkPolicy found',
    };
  }

  if (scenarioId === 'service') {
    const endpoints = cluster.endpoints || [];
    const endpoint = endpoints.find((ep) => ep && ep.metadata && ep.metadata.name === 'tank-monitor');
    const addresses = endpoint ? (endpoint.subsets || []).flatMap((s) => s.addresses || []) : [];
    const tankRunning = pods.some((p) => p.name.startsWith('tank-monitor') && p.status === 'Running');
    const active = addresses.length === 0 && tankRunning;
    return {
      active,
      reason: active
        ? 'tank-monitor Service has zero endpoints while a tank-monitor pod is Running'
        : 'tank-monitor Service endpoints resolve normally',
    };
  }

  const indicator = POD_INDICATORS[scenarioId];
  if (!indicator) {
    return { active: null, reason: `No server-side health indicator is implemented for scenario "${scenarioId}"` };
  }

  const matches = pods.filter(indicator);
  return {
    active: matches.length > 0,
    reason: matches.length > 0
      ? `${matches.length} pod(s) match the unhealthy indicator: ${matches.map((p) => p.name).join(', ')}`
      : 'no pods currently match the unhealthy indicator',
  };
}

module.exports = { parsePodStatus, evaluateScenarioHealth, POD_INDICATORS };
