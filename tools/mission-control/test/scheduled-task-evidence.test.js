const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createScheduledTaskEvidenceStore, MAX_EVIDENCE_AGE_MINUTES } = require('../scheduled-task-evidence');

function tempEvidencePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sched-evidence-')), 'evidence.json');
}

function validEvidence(overrides = {}) {
  return {
    taskId: 'daily-propane-health-report',
    promptVersionHash: 'a'.repeat(64),
    threadId: 'THREAD-123',
    timestamp: new Date().toISOString(),
    status: 'Healthy',
    ...overrides,
  };
}

test('evaluate() reports unavailable with a clear reason when nothing has ever been recorded', () => {
  const store = createScheduledTaskEvidenceStore({ filePath: tempEvidencePath() });
  const result = store.evaluate();
  assert.equal(result.available, false);
  assert.match(result.reason, /no scheduled-task execution evidence/i);
});

test('recordExecutionEvidence rejects a payload missing any required identity field, and does not persist it', () => {
  const filePath = tempEvidencePath();
  const store = createScheduledTaskEvidenceStore({ filePath });

  const missingThread = validEvidence({ threadId: '' });
  const result = store.recordExecutionEvidence(missingThread);
  assert.equal(result.ok, false);
  assert.match(result.reason, /threadId/);
  assert.equal(fs.existsSync(filePath), false);
});

test('recordExecutionEvidence rejects an unrecognized status value', () => {
  const store = createScheduledTaskEvidenceStore({ filePath: tempEvidencePath() });
  const result = store.recordExecutionEvidence(validEvidence({ status: 'Mostly Fine' }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /unrecognized status/i);
});

test('recordExecutionEvidence rejects an invalid timestamp', () => {
  const store = createScheduledTaskEvidenceStore({ filePath: tempEvidencePath() });
  const result = store.recordExecutionEvidence(validEvidence({ timestamp: 'not-a-date' }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /not a valid ISO date/i);
});

test('a freshly recorded Healthy execution evaluates as available with every identity field intact', () => {
  const store = createScheduledTaskEvidenceStore({ filePath: tempEvidencePath() });
  const recorded = store.recordExecutionEvidence(validEvidence());
  assert.equal(recorded.ok, true);

  const evaluated = store.evaluate();
  assert.equal(evaluated.available, true);
  assert.equal(evaluated.taskId, 'daily-propane-health-report');
  assert.equal(evaluated.threadId, 'THREAD-123');
  assert.equal(evaluated.status, 'Healthy');
  assert.equal(evaluated.promptVersionHash, 'a'.repeat(64));
});

test('a freshly recorded Degraded execution ALSO unlocks availability (degraded is still a real, fresh signal)', () => {
  const store = createScheduledTaskEvidenceStore({ filePath: tempEvidencePath() });
  store.recordExecutionEvidence(validEvidence({ status: 'Degraded' }));
  const evaluated = store.evaluate();
  assert.equal(evaluated.available, true);
  assert.equal(evaluated.status, 'Degraded');
});

test('an "Insufficient evidence" execution NEVER unlocks availability, even though it is fresh — missing/stale telemetry must never be silently treated as ready', () => {
  const store = createScheduledTaskEvidenceStore({ filePath: tempEvidencePath() });
  store.recordExecutionEvidence(validEvidence({ status: 'Insufficient evidence' }));
  const evaluated = store.evaluate();
  assert.equal(evaluated.available, false);
  assert.match(evaluated.reason, /Insufficient evidence/);
});

test('evidence recorded beyond MAX_EVIDENCE_AGE_MINUTES becomes unavailable — freshness is computed at evaluation time, not cached from record time', () => {
  const filePath = tempEvidencePath();
  let now = new Date('2024-01-01T00:00:00Z');
  const store = createScheduledTaskEvidenceStore({ filePath, clock: () => now });

  store.recordExecutionEvidence(validEvidence({ timestamp: now.toISOString() }));
  const immediatelyAfter = store.evaluate();
  assert.equal(immediatelyAfter.available, true);

  // Advance the clock well past the freshness bound without touching the
  // stored record at all.
  now = new Date(now.getTime() + (MAX_EVIDENCE_AGE_MINUTES + 60) * 60000);
  const laterResult = store.evaluate();
  assert.equal(laterResult.available, false);
  assert.match(laterResult.reason, /stale/i);
});

test('a timestamp in the future is rejected as available (never trusts a backdated/forward-dated evidence record)', () => {
  const filePath = tempEvidencePath();
  const now = new Date('2024-01-01T00:00:00Z');
  const store = createScheduledTaskEvidenceStore({ filePath, clock: () => now });
  const future = new Date(now.getTime() + 60 * 60000);
  store.recordExecutionEvidence(validEvidence({ timestamp: future.toISOString() }));

  const evaluated = store.evaluate();
  assert.equal(evaluated.available, false);
  assert.match(evaluated.reason, /future/i);
});

test('recordedAt is always the server clock, never derived from the client-supplied timestamp', () => {
  const filePath = tempEvidencePath();
  const serverNow = new Date('2024-06-01T12:00:00Z');
  const store = createScheduledTaskEvidenceStore({ filePath, clock: () => serverNow });
  const clientClaimedTimestamp = '2020-01-01T00:00:00Z';
  store.recordExecutionEvidence(validEvidence({ timestamp: clientClaimedTimestamp }));

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(raw.recordedAt, serverNow.toISOString());
  assert.equal(raw.timestamp, new Date(clientClaimedTimestamp).toISOString());
});

test('a subsequent recording overwrites the previous evidence (only the latest execution is trusted)', () => {
  const filePath = tempEvidencePath();
  const store = createScheduledTaskEvidenceStore({ filePath });
  store.recordExecutionEvidence(validEvidence({ threadId: 'THREAD-OLD', status: 'Healthy' }));
  store.recordExecutionEvidence(validEvidence({ threadId: 'THREAD-NEW', status: 'Degraded' }));

  const evaluated = store.evaluate();
  assert.equal(evaluated.threadId, 'THREAD-NEW');
  assert.equal(evaluated.status, 'Degraded');
});
