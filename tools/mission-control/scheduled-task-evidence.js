/**
 * Trusted, server-side evidence store for the native Azure SRE Agent
 * scheduled task `daily-propane-health-report` (issue #24), consumed by
 * the presenter `scheduled-task` gate (issue #20 integration).
 *
 * WHY THIS EXISTS: the presenter gate previously trusted a bare
 * `scheduledTaskAvailable` boolean with no way to verify it came from a
 * real execution (see presenter-mode.js `resolveTrustedPresenterGate`,
 * case 'scheduled-task', prior to this change). That is exactly the kind
 * of client-supplied gate truth `rejectClientGeneratedGateTruth` already
 * refuses everywhere else in this file. This module replaces the boolean
 * with a structured, server-recorded evidence record — task id, prompt
 * version hash, thread id, timestamp, and outcome status — captured ONLY
 * from an authenticated operator call (see server.js's
 * `/api/scheduled-task/evidence` route, gated by
 * createOperatorAuthMiddleware(), same as /api/approval) after a real
 * `scripts/bootstrap-sre-agent-scheduled-task.ps1 -Action RunNow` or
 * `-Action History` execution. Freshness is computed at EVALUATION time
 * (not read from the client), so an evidence record recorded hours ago
 * correctly becomes stale even if nobody calls this module again.
 *
 * Persistence uses the same write-to-temp-then-rename JSON file pattern as
 * incident-store.js — no database elsewhere in this project either.
 */

const fs = require('fs');
const path = require('path');

// A daily task is expected to run once every 24h; a generous buffer keeps
// a slightly late run (weekend maintenance window, a manual RunNow the
// night before) from flapping the gate, while still catching genuinely
// abandoned automation. Exported so tests and callers can reason about the
// exact bound instead of a magic number.
const MAX_EVIDENCE_AGE_MINUTES = 26 * 60;
const MAX_TELEMETRY_PROOF_AGE_MINUTES = 5;

// Statuses the underlying report is contractually allowed to produce (see
// docs/sre-agent-scheduled-tasks/daily-propane-health-report-prompt.md).
// Any other value is untrusted output and never unlocks the gate.
const VALID_STATUSES = new Set(['Healthy', 'Degraded', 'Insufficient evidence']);

// A status that DOES represent a fresh, completed execution but must never
// unlock the gate on its own — issue #24 requires missing/stale telemetry
// to produce a "failed readiness integration signal, never Healthy", and
// the presenter gate is exactly such a readiness signal.
const STATUSES_THAT_NEVER_UNLOCK = new Set(['Insufficient evidence']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function createScheduledTaskEvidenceStore(options = {}) {
  const filePath = options.filePath || path.resolve(__dirname, '.data', 'scheduled-task-evidence.json');
  const telemetryProofPath = options.telemetryProofPath || path.join(path.dirname(filePath), 'telemetry-proof.json');
  const onPersistError = typeof options.onPersistError === 'function' ? options.onPersistError : () => {};
  const clock = typeof options.clock === 'function' ? options.clock : () => new Date();

  function readRaw() {
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw.trim()) return null;
      return JSON.parse(raw);
    } catch (err) {
      onPersistError(err);
      return null;
    }
  }

  function writeRaw(record) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      onPersistError(err);
    }
  }

  function evaluateTelemetryProof() {
    let proof;
    try {
      if (!fs.existsSync(telemetryProofPath)) {
        return { valid: false, reason: 'fresh Application Insights telemetry proof has not been recorded' };
      }
      proof = JSON.parse(fs.readFileSync(telemetryProofPath, 'utf8'));
    } catch (err) {
      onPersistError(err);
      return { valid: false, reason: 'Application Insights telemetry proof is unreadable' };
    }

    if (!/^[a-f0-9]{32}$/.test(proof.transactionId || '')) {
      return { valid: false, reason: 'Application Insights telemetry proof has an invalid transaction id' };
    }
    const verifiedAt = new Date(proof.verifiedAt);
    if (Number.isNaN(verifiedAt.getTime())) {
      return { valid: false, reason: 'Application Insights telemetry proof has an invalid timestamp' };
    }
    const ageMinutes = (clock().getTime() - verifiedAt.getTime()) / 60000;
    if (ageMinutes < 0 || ageMinutes > MAX_TELEMETRY_PROOF_AGE_MINUTES) {
      return {
        valid: false,
        reason: ageMinutes < 0
          ? 'Application Insights telemetry proof timestamp is in the future'
          : `Application Insights telemetry proof is stale (${Math.round(ageMinutes)} minutes old, max ${MAX_TELEMETRY_PROOF_AGE_MINUTES})`,
      };
    }

    const minimums = {
      requestCount: 3,
      dependencyCount: 4,
      correlatedOperationCount: 1,
      serviceCount: 3,
      metricCount: 3,
      exceptionCount: 1,
      traceCount: 3,
      kubernetesEventCount: 1,
    };
    for (const [field, minimum] of Object.entries(minimums)) {
      if (!Number.isInteger(proof[field]) || proof[field] < minimum) {
        return { valid: false, reason: `Application Insights telemetry proof is incomplete (${field} < ${minimum})` };
      }
    }

    return {
      valid: true,
      transactionId: proof.transactionId,
      verifiedAt: verifiedAt.toISOString(),
      ageMinutes,
    };
  }

  /**
   * Validates and records a fresh execution result. Only ever called from
   * an authenticated operator route (server.js) — never from unauthenticated
   * presenter/gate traffic. Rejects (does not persist) any payload missing
   * a required identity field or carrying an unrecognized status, so a
   * malformed or partial report can never masquerade as trusted evidence.
   * `recordedAt` is always the SERVER's own clock, never client-supplied,
   * so a caller cannot backdate/forward-date evidence to manufacture
   * freshness.
   */
  function recordExecutionEvidence(evidence = {}) {
    const { taskId, promptVersionHash, threadId, timestamp, status } = evidence || {};
    const missingFields = ['taskId', 'promptVersionHash', 'threadId', 'timestamp', 'status'].filter(
      (field) => !isNonEmptyString(evidence[field]),
    );
    if (missingFields.length > 0) {
      return { ok: false, reason: `missing required evidence field(s): ${missingFields.join(', ')}` };
    }
    if (!VALID_STATUSES.has(status)) {
      return { ok: false, reason: `unrecognized status '${status}'; must be one of ${Array.from(VALID_STATUSES).join(', ')}` };
    }
    const parsedTimestamp = new Date(timestamp);
    if (Number.isNaN(parsedTimestamp.getTime())) {
      return { ok: false, reason: `timestamp '${timestamp}' is not a valid ISO date` };
    }

    const record = {
      taskId,
      promptVersionHash,
      threadId,
      timestamp: parsedTimestamp.toISOString(),
      status,
      recordedAt: clock().toISOString(),
    };
    writeRaw(record);
    return { ok: true, record };
  }

  /**
   * Evaluates the current evidence against a fresh call to the server
   * clock — freshness is always computed NOW, never cached from record
   * time, so a gate check an hour after the last write correctly reflects
   * an hour of additional staleness.
   */
  function evaluate() {
    const record = readRaw();
    if (!record) {
      return { available: false, reason: 'no scheduled-task execution evidence has been recorded yet' };
    }

    const missingFields = ['taskId', 'promptVersionHash', 'threadId', 'timestamp', 'status'].filter(
      (field) => !isNonEmptyString(record[field]),
    );
    if (missingFields.length > 0) {
      return { available: false, reason: `recorded evidence is missing required field(s): ${missingFields.join(', ')}` };
    }

    const recordedTimestamp = new Date(record.timestamp);
    if (Number.isNaN(recordedTimestamp.getTime())) {
      return { available: false, reason: 'recorded evidence has an invalid timestamp' };
    }

    const ageMinutes = (clock().getTime() - recordedTimestamp.getTime()) / 60000;
    const fresh = ageMinutes >= 0 && ageMinutes <= MAX_EVIDENCE_AGE_MINUTES;

    if (!fresh) {
      return {
        available: false,
        reason: ageMinutes < 0 ? 'recorded evidence timestamp is in the future' : `recorded evidence is stale (${Math.round(ageMinutes)} minutes old, max ${MAX_EVIDENCE_AGE_MINUTES})`,
        taskId: record.taskId,
        threadId: record.threadId,
        timestamp: record.timestamp,
        status: record.status,
        ageMinutes,
      };
    }

    if (STATUSES_THAT_NEVER_UNLOCK.has(record.status)) {
      return {
        available: false,
        reason: `most recent execution reported '${record.status}' — missing/stale telemetry must never unlock this gate`,
        taskId: record.taskId,
        promptVersionHash: record.promptVersionHash,
        threadId: record.threadId,
        timestamp: record.timestamp,
        status: record.status,
        ageMinutes,
      };
    }

    const telemetryProof = evaluateTelemetryProof();
    if (!telemetryProof.valid) {
      return {
        available: false,
        reason: telemetryProof.reason,
        taskId: record.taskId,
        promptVersionHash: record.promptVersionHash,
        threadId: record.threadId,
        timestamp: record.timestamp,
        status: record.status,
        ageMinutes,
        telemetryProof,
      };
    }

    return {
      available: true,
      reason: `fresh execution (${Math.round(ageMinutes)} minutes old) reported '${record.status}' with correlated telemetry transaction ${telemetryProof.transactionId}`,
      taskId: record.taskId,
      promptVersionHash: record.promptVersionHash,
      threadId: record.threadId,
      timestamp: record.timestamp,
      status: record.status,
      ageMinutes,
      telemetryProof,
    };
  }

  return { recordExecutionEvidence, evaluate, __filePath: filePath };
}

module.exports = {
  createScheduledTaskEvidenceStore,
  MAX_EVIDENCE_AGE_MINUTES,
  MAX_TELEMETRY_PROOF_AGE_MINUTES,
  VALID_STATUSES,
};
