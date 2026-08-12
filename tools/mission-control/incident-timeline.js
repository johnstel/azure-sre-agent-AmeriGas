/**
 * Incident evidence timeline engine.
 *
 * A per-demo-run "incident" is a chronological record of a single breakable
 * scenario run: activation, first observed impact, evidence gathered,
 * root-cause identification, a proposed remediation action and its
 * approval/denial/expiry, the action's result, a post-action assertion, and
 * recovery / final state.
 *
 * Design goals (see GitHub issue #17):
 *  - Every milestone gets a server-assigned monotonic sequence number and
 *    timestamp (`recordedAt`) at the moment the server observes it, so the
 *    rendered timeline is always non-decreasing even if the underlying
 *    events arrive out of order or are delivered more than once (duplicate
 *    tool callbacks). The optional `occurredAt` field preserves a
 *    source-reported timestamp for evidence purposes without affecting
 *    ordering.
 *  - Nothing is fabricated: metrics (time-to-detect / time-to-root-cause /
 *    time-to-recover) are only computed when the relevant milestones exist;
 *    otherwise the field is `null` and callers must render "not observed in
 *    this run" rather than inventing a number.
 *  - Denial, expiry, failed actions, and partial recovery are first-class
 *    final states, not just absence of success.
 *  - Evidence-source categories (kubernetes/logs/metrics/traces/knowledge)
 *    are tracked explicitly, including categories with no data collected in
 *    a given run, and traces/knowledge are marked as not natively available
 *    unless a future issue (see registerNativeIntegration) wires a real
 *    provider — see docs/DEMO-SCRIPT.md and issue #19 / #23 for the intended
 *    native SRE Agent integration this stubs out.
 *  - All milestone payloads are redacted before being stored, so persisted
 *    and exported state never contains secrets.
 */

const crypto = require('crypto');
const { redactDeep } = require('./redact');

const MILESTONE = Object.freeze({
  ACTIVATION: 'activation',
  IMPACT_DETECTED: 'impact_detected',
  INVESTIGATION_STARTED: 'investigation_started',
  EVIDENCE_COLLECTED: 'evidence_collected',
  ROOT_CAUSE_IDENTIFIED: 'root_cause_identified',
  ACTION_PROPOSED: 'action_proposed',
  ACTION_APPROVED: 'action_approved',
  ACTION_DENIED: 'action_denied',
  ACTION_EXPIRED: 'action_expired',
  ACTION_EXECUTED: 'action_executed',
  POST_ACTION_ASSERTION: 'post_action_assertion',
  RECOVERY: 'recovery',
  FINAL_STATE: 'final_state',
});

const FINAL_STATE = Object.freeze({
  RECOVERED: 'recovered',
  PARTIAL_RECOVERY: 'partial_recovery',
  FAILED: 'failed',
  DENIED: 'denied',
  EXPIRED: 'expired',
  UNRESOLVED: 'unresolved',
});

const EVIDENCE_CATEGORIES = Object.freeze(['kubernetes', 'logs', 'metrics', 'traces', 'knowledge']);

// Categories with no native provider wired up yet. Future issues can call
// registerNativeIntegration(category, descriptor) to replace these — see the
// module-level registry below. This is the explicit extension point for
// issue #19 (native response-plan / SRE Agent thread integration) and #23.
const DEFAULT_NATIVE_AVAILABILITY = Object.freeze({
  kubernetes: { available: true, description: 'Collected via kubectl through Mission Control Copilot tools.' },
  logs: { available: true, description: 'Collected via kubectl logs through Mission Control Copilot tools.' },
  metrics: { available: false, description: 'Only `kubectl top` is available locally; native Azure Monitor / Application Insights metrics are not wired into this tool set. See the SRE Agent thread link when configured.' },
  traces: { available: false, description: 'Distributed trace evidence is not wired into this local Copilot tool set. Planned as a native SRE Agent integration (see extension hook below, tracked for a future issue).' },
  knowledge: { available: false, description: 'Knowledge-base evidence is not wired into this local Copilot tool set. Planned as a native SRE Agent integration (see extension hook below, tracked for a future issue).' },
});

/**
 * Registry of native evidence-source integrations. Empty by default; a
 * future issue can call registerNativeIntegration('traces', { available:
 * true, describe: () => '...', buildLink: (incident) => 'https://...' }) to
 * replace a stub without touching this engine's core logic. This is the
 * documented extension contract for issues #19 and #23.
 */
function createNativeIntegrationRegistry() {
  const registry = new Map();

  function register(category, descriptor) {
    if (!EVIDENCE_CATEGORIES.includes(category)) {
      throw new Error(`Unknown evidence category "${category}"`);
    }
    if (!descriptor || typeof descriptor !== 'object') {
      throw new Error('descriptor must be an object with at least an `available` boolean');
    }
    registry.set(category, { ...DEFAULT_NATIVE_AVAILABILITY[category], ...descriptor });
  }

  function get(category) {
    return registry.get(category) || DEFAULT_NATIVE_AVAILABILITY[category] || { available: false, description: 'Unknown evidence category.' };
  }

  return { register, get };
}

function generateCorrelationId(nowMs) {
  const stamp = Math.max(0, Math.trunc(nowMs)).toString(36).toUpperCase();
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `INC-${stamp}-${rand}`;
}

function toIso(msOrDate) {
  if (msOrDate === null || msOrDate === undefined) return null;
  const date = msOrDate instanceof Date ? msOrDate : new Date(msOrDate);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Human-friendly duration formatting, e.g. 1m 4s. Returns null for null input. */
function formatDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return null;
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function createApprovalSignatureFallback(toolName, params) {
  return JSON.stringify({ toolName, params: params || {} });
}

function createIncidentTimelineEngine(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const nativeIntegrations = options.nativeIntegrations || createNativeIntegrationRegistry();

  /** @type {Map<string, object>} */
  const incidents = new Map();
  let activeCorrelationId = null;
  let seqCounter = 0;

  function nextSeq() {
    seqCounter += 1;
    return seqCounter;
  }

  function getIncidentOrThrow(correlationId) {
    const incident = incidents.get(correlationId);
    if (!incident) throw new Error(`Unknown incident correlationId: ${correlationId}`);
    return incident;
  }

  function findMilestone(incident, type, dedupeKey) {
    if (dedupeKey === undefined) return incident.milestones.find((m) => m.type === type);
    return incident.milestones.find((m) => m.type === type && m.dedupeKey === dedupeKey);
  }

  /**
   * Record a milestone with a server-assigned monotonic sequence number.
   * If `dedupeKey` matches an existing milestone of the same type, no new
   * entry is created (idempotent against duplicate/out-of-order callbacks);
   * the existing entry's data is shallow-merged with the new data instead so
   * later refinements (e.g. an updated root-cause statement) are retained
   * without moving the milestone's position in the timeline or its
   * originally recorded time.
   */
  function record(incident, type, data, opts = {}) {
    const { dedupeKey = null, occurredAt = null } = opts;
    if (dedupeKey !== null) {
      const existing = findMilestone(incident, type, dedupeKey);
      if (existing) {
        existing.data = redactDeep({ ...existing.data, ...data });
        existing.updateCount = (existing.updateCount || 0) + 1;
        return existing;
      }
    }
    const entry = {
      seq: nextSeq(),
      type,
      recordedAt: toIso(clock()),
      occurredAt: occurredAt ? toIso(occurredAt) : null,
      dedupeKey,
      updateCount: 0,
      data: redactDeep(data || {}),
    };
    incident.milestones.push(entry);
    return entry;
  }

  function activate(input = {}) {
    const existing = activeCorrelationId ? incidents.get(activeCorrelationId) : null;
    if (existing && !existing.finalState) {
      // An unresolved incident is already active; keep the correlation
      // stable rather than starting an overlapping second incident.
      return existing;
    }

    const now = clock();
    const correlationId = generateCorrelationId(now);
    const incident = {
      correlationId,
      scenarioId: input.scenarioId || null,
      scenarioName: input.scenarioName || null,
      domain: input.domain || null,
      impactedService: input.impactedService || null,
      relatedIds: Array.isArray(input.relatedIds) ? input.relatedIds.slice() : [],
      runMode: input.runMode || 'operator-direct',
      createdAt: toIso(now),
      milestones: [],
      finalState: null,
    };
    incidents.set(correlationId, incident);
    activeCorrelationId = correlationId;
    record(incident, MILESTONE.ACTIVATION, {
      scenarioId: incident.scenarioId,
      scenarioName: incident.scenarioName,
      domain: incident.domain,
      impactedService: incident.impactedService,
      relatedIds: incident.relatedIds,
      runMode: incident.runMode,
    }, { dedupeKey: 'activation' });
    return incident;
  }

  function recordImpact(correlationId, data = {}, opts = {}) {
    const incident = getIncidentOrThrow(correlationId);
    return record(incident, MILESTONE.IMPACT_DETECTED, data, { dedupeKey: 'impact', occurredAt: opts.occurredAt });
  }

  function recordEvidence(correlationId, data = {}, opts = {}) {
    const incident = getIncidentOrThrow(correlationId);
    // First piece of evidence gathered marks investigation start.
    if (!findMilestone(incident, MILESTONE.INVESTIGATION_STARTED)) {
      record(incident, MILESTONE.INVESTIGATION_STARTED, {
        toolName: data.toolName || null,
        category: data.category || null,
      }, { dedupeKey: 'investigation-started' });
    }
    const dedupeKey = data.callId || `${data.toolName || 'tool'}:${JSON.stringify(data.params || {})}`;
    return record(incident, MILESTONE.EVIDENCE_COLLECTED, data, { dedupeKey, occurredAt: opts.occurredAt });
  }

  function recordRootCause(correlationId, data = {}, opts = {}) {
    const incident = getIncidentOrThrow(correlationId);
    return record(incident, MILESTONE.ROOT_CAUSE_IDENTIFIED, data, { dedupeKey: 'root-cause', occurredAt: opts.occurredAt });
  }

  function proposeAction(correlationId, data = {}) {
    const incident = getIncidentOrThrow(correlationId);
    const actionKey = data.actionKey || createApprovalSignatureFallback(data.toolName, data.params);
    return record(incident, MILESTONE.ACTION_PROPOSED, { ...data, actionKey }, { dedupeKey: actionKey });
  }

  function approveAction(correlationId, data = {}) {
    const incident = getIncidentOrThrow(correlationId);
    const actionKey = data.actionKey;
    if (!actionKey) throw new Error('approveAction requires actionKey');
    // Only approve an action that was actually proposed against *this*
    // incident. This guards against a stale actionKey (e.g. from an action
    // proposed against a previous, already-finalized incident) being
    // recorded as if it belonged to the current run.
    if (!findMilestone(incident, MILESTONE.ACTION_PROPOSED, actionKey)) return null;
    return record(incident, MILESTONE.ACTION_APPROVED, data, { dedupeKey: `approved:${actionKey}` });
  }

  function denyAction(correlationId, data = {}) {
    const incident = getIncidentOrThrow(correlationId);
    const actionKey = data.actionKey;
    if (!actionKey) throw new Error('denyAction requires actionKey');
    if (!findMilestone(incident, MILESTONE.ACTION_PROPOSED, actionKey)) return null;
    const entry = record(incident, MILESTONE.ACTION_DENIED, data, { dedupeKey: `denied:${actionKey}` });
    finalize(correlationId, FINAL_STATE.DENIED, { reason: 'proposed action was denied by the operator' });
    return entry;
  }

  function expireAction(correlationId, data = {}) {
    const incident = getIncidentOrThrow(correlationId);
    const actionKey = data.actionKey;
    if (!actionKey) throw new Error('expireAction requires actionKey');
    if (!findMilestone(incident, MILESTONE.ACTION_PROPOSED, actionKey)) return null;
    // Don't mark an action expired if it was already resolved (approved/denied).
    if (findMilestone(incident, MILESTONE.ACTION_APPROVED, `approved:${actionKey}`)) return null;
    if (findMilestone(incident, MILESTONE.ACTION_DENIED, `denied:${actionKey}`)) return null;
    const entry = record(incident, MILESTONE.ACTION_EXPIRED, data, { dedupeKey: `expired:${actionKey}` });
    finalize(correlationId, FINAL_STATE.EXPIRED, { reason: 'proposed action expired before it was approved or denied' });
    return entry;
  }

  function recordActionResult(correlationId, data = {}) {
    const incident = getIncidentOrThrow(correlationId);
    const actionKey = data.actionKey;
    if (!actionKey) throw new Error('recordActionResult requires actionKey');
    if (!findMilestone(incident, MILESTONE.ACTION_PROPOSED, actionKey)) return null;
    const entry = record(incident, MILESTONE.ACTION_EXECUTED, data, { dedupeKey: `result:${actionKey}` });
    if (data.success === false) {
      finalize(correlationId, FINAL_STATE.FAILED, { reason: 'the approved/direct action failed to execute' });
    }
    return entry;
  }

  function recordPostActionAssertion(correlationId, data = {}) {
    const incident = getIncidentOrThrow(correlationId);
    const actionKey = data.actionKey || 'unspecified';
    const entry = record(incident, MILESTONE.POST_ACTION_ASSERTION, data, { dedupeKey: `assertion:${actionKey}` });
    if (data.passed === false && !incident.finalState) {
      finalize(correlationId, FINAL_STATE.PARTIAL_RECOVERY, { reason: 'post-action assertion did not confirm recovery' });
    }
    return entry;
  }

  function recordRecovery(correlationId, data = {}) {
    const incident = getIncidentOrThrow(correlationId);
    return record(incident, MILESTONE.RECOVERY, data, { dedupeKey: 'recovery' });
  }

  function finalize(correlationId, finalState, data = {}) {
    const incident = getIncidentOrThrow(correlationId);
    if (!Object.values(FINAL_STATE).includes(finalState)) {
      throw new Error(`Unknown final state: ${finalState}`);
    }
    if (incident.finalState) return findMilestone(incident, MILESTONE.FINAL_STATE);
    incident.finalState = finalState;
    return record(incident, MILESTONE.FINAL_STATE, { ...data, finalState }, { dedupeKey: 'final-state' });
  }

  /** Best-effort sweep for approvals that expired without an approve/deny call. */
  function sweepExpiredApprovals(nowMs, pendingApprovals = []) {
    for (const pending of pendingApprovals) {
      if (!pending || pending.expiresAt > nowMs) continue;
      for (const incident of incidents.values()) {
        if (incident.finalState) continue;
        if (findMilestone(incident, MILESTONE.ACTION_PROPOSED, pending.actionKey)) {
          expireAction(incident.correlationId, { actionKey: pending.actionKey, toolName: pending.toolName });
        }
      }
    }
  }

  function getIncident(correlationId) {
    return incidents.get(correlationId) || null;
  }

  function getActive() {
    if (!activeCorrelationId) return null;
    const incident = incidents.get(activeCorrelationId);
    if (!incident || incident.finalState) return null;
    return incident;
  }

  function listRecent(limit = 10) {
    return Array.from(incidents.values())
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  function computeMetrics(correlationIdOrIncident) {
    const incident = typeof correlationIdOrIncident === 'string' ? getIncidentOrThrow(correlationIdOrIncident) : correlationIdOrIncident;
    const activation = findMilestone(incident, MILESTONE.ACTIVATION);
    const impact = findMilestone(incident, MILESTONE.IMPACT_DETECTED);
    const rootCause = findMilestone(incident, MILESTONE.ROOT_CAUSE_IDENTIFIED);
    const recovery = findMilestone(incident, MILESTONE.RECOVERY);

    const deltaMs = (a, b) => (a && b ? new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime() : null);

    const timeToDetectMs = deltaMs(activation, impact);
    const timeToRootCauseMs = deltaMs(activation, rootCause);
    const timeToRecoverMs = deltaMs(activation, recovery);

    return {
      timeToDetectMs,
      timeToDetect: formatDuration(timeToDetectMs),
      timeToRootCauseMs,
      timeToRootCause: formatDuration(timeToRootCauseMs),
      timeToRecoverMs,
      timeToRecover: formatDuration(timeToRecoverMs),
    };
  }

  function summarizeEvidence(correlationIdOrIncident) {
    const incident = typeof correlationIdOrIncident === 'string' ? getIncidentOrThrow(correlationIdOrIncident) : correlationIdOrIncident;
    const evidenceMilestones = incident.milestones.filter((m) => m.type === MILESTONE.EVIDENCE_COLLECTED);
    return EVIDENCE_CATEGORIES.map((category) => {
      const used = evidenceMilestones.filter((m) => m.data.category === category);
      const native = nativeIntegrations.get(category);
      return {
        category,
        count: used.length,
        used: used.length > 0,
        toolNames: [...new Set(used.map((m) => m.data.toolName).filter(Boolean))],
        nativeAvailable: native.available,
        nativeDescription: native.description,
      };
    });
  }

  function toRedactedSnapshot(correlationIdOrIncident) {
    const incident = typeof correlationIdOrIncident === 'string' ? getIncidentOrThrow(correlationIdOrIncident) : correlationIdOrIncident;
    return redactDeep({
      correlationId: incident.correlationId,
      scenarioId: incident.scenarioId,
      scenarioName: incident.scenarioName,
      domain: incident.domain,
      impactedService: incident.impactedService,
      relatedIds: incident.relatedIds,
      runMode: incident.runMode,
      createdAt: incident.createdAt,
      finalState: incident.finalState,
      milestones: incident.milestones,
      metrics: computeMetrics(incident),
      evidence: summarizeEvidence(incident),
    });
  }

  function toRedactedMarkdown(correlationIdOrIncident) {
    const snapshot = toRedactedSnapshot(correlationIdOrIncident);
    const lines = [];
    lines.push(`# Incident Evidence Pack — ${snapshot.correlationId}`);
    lines.push('');
    lines.push(`- **Scenario:** ${snapshot.scenarioName || snapshot.scenarioId || 'unspecified'} (\`${snapshot.scenarioId || 'n/a'}\`)`);
    lines.push(`- **Domain:** ${snapshot.domain || 'unspecified'}`);
    lines.push(`- **Impacted service:** ${snapshot.impactedService || 'unspecified'}`);
    if (snapshot.relatedIds.length > 0) lines.push(`- **Related ids:** ${snapshot.relatedIds.join(', ')}`);
    lines.push(`- **Run mode:** ${snapshot.runMode}`);
    lines.push(`- **Created:** ${snapshot.createdAt}`);
    lines.push(`- **Final state:** ${snapshot.finalState || 'unresolved (run still active or was never finalized)'}`);
    lines.push('');
    lines.push('## Measured outcome (observed values only)');
    lines.push('');
    lines.push(`- Time to detect: ${snapshot.metrics.timeToDetect || 'not observed in this run'}`);
    lines.push(`- Time to root cause: ${snapshot.metrics.timeToRootCause || 'not observed in this run'}`);
    lines.push(`- Time to recover: ${snapshot.metrics.timeToRecover || 'not observed in this run'}`);
    lines.push('');
    lines.push('> No human-benchmark or ROI figures are included. Only values measured from server timestamps in this run are reported.');
    lines.push('');
    lines.push('## Evidence sources used');
    lines.push('');
    lines.push('| Category | Used | Count | Tools | Native integration |');
    lines.push('|---|---|---|---|---|');
    for (const e of snapshot.evidence) {
      lines.push(`| ${e.category} | ${e.used ? 'yes' : 'no'} | ${e.count} | ${e.toolNames.join(', ') || '—'} | ${e.nativeAvailable ? 'available' : `not available — ${e.nativeDescription}`} |`);
    }
    lines.push('');
    lines.push('## Timeline');
    lines.push('');
    for (const m of snapshot.milestones) {
      lines.push(`- \`${m.recordedAt}\` **${m.type}**${m.occurredAt ? ` (source event time: ${m.occurredAt})` : ''} — ${JSON.stringify(m.data)}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  return {
    MILESTONE,
    FINAL_STATE,
    EVIDENCE_CATEGORIES,
    activate,
    recordImpact,
    recordEvidence,
    recordRootCause,
    proposeAction,
    approveAction,
    denyAction,
    expireAction,
    recordActionResult,
    recordPostActionAssertion,
    recordRecovery,
    finalize,
    sweepExpiredApprovals,
    getIncident,
    getActive,
    listRecent,
    computeMetrics,
    summarizeEvidence,
    toRedactedSnapshot,
    toRedactedMarkdown,
    registerNativeIntegration: nativeIntegrations.register,
    getNativeIntegration: nativeIntegrations.get,
    exportState() {
      return {
        seqCounter,
        activeCorrelationId,
        incidents: Array.from(incidents.values()),
      };
    },
    importState(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return;
      seqCounter = Number.isFinite(snapshot.seqCounter) ? snapshot.seqCounter : 0;
      activeCorrelationId = snapshot.activeCorrelationId || null;
      incidents.clear();
      for (const incident of snapshot.incidents || []) {
        if (incident && incident.correlationId) incidents.set(incident.correlationId, incident);
      }
    },
  };
}

module.exports = {
  createIncidentTimelineEngine,
  createNativeIntegrationRegistry,
  generateCorrelationId,
  formatDuration,
  MILESTONE,
  FINAL_STATE,
  EVIDENCE_CATEGORIES,
};
