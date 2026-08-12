const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createIncidentTimelineEngine,
  MILESTONE,
  FINAL_STATE,
  formatDuration,
  generateCorrelationId,
} = require('../incident-timeline');

function makeClock(startMs = 1_700_000_000_000) {
  let now = startMs;
  return {
    tick(ms = 1000) {
      now += ms;
      return now;
    },
    now: () => now,
  };
}

test('generateCorrelationId produces a unique, prefixed id', () => {
  const a = generateCorrelationId(Date.now());
  const b = generateCorrelationId(Date.now());
  assert.match(a, /^INC-[0-9A-Z]+-[0-9A-F]{6}$/);
  assert.notEqual(a, b);
});

test('formatDuration renders human-friendly durations and null passes through', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(4400), '4s');
  assert.equal(formatDuration(65000), '1m 5s');
  assert.equal(formatDuration(null), null);
  assert.equal(formatDuration(undefined), null);
});

test('activate creates a unique correlation id shared by all evidence for that run', () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'oom', scenarioName: 'OOMKilled', domain: 'Bulk Tank', impactedService: 'tank-monitor' });

  assert.match(incident.correlationId, /^INC-/);
  assert.equal(incident.scenarioId, 'oom');
  assert.equal(engine.getActive().correlationId, incident.correlationId);

  engine.recordEvidence(incident.correlationId, { toolName: 'get_pods', category: 'kubernetes', callId: 'call-1' });
  const stored = engine.getIncident(incident.correlationId);
  assert.equal(stored.correlationId, incident.correlationId);
  // Every milestone belongs to the same incident record keyed by correlationId.
  assert.ok(stored.milestones.every((m) => typeof m.seq === 'number'));
});

test('activating while an incident is already unresolved keeps the same correlation id', () => {
  const engine = createIncidentTimelineEngine();
  const first = engine.activate({ scenarioId: 'oom' });
  const second = engine.activate({ scenarioId: 'crash' });
  assert.equal(second.correlationId, first.correlationId);
  assert.equal(engine.getIncident(first.correlationId).scenarioId, 'oom');
});

test('activating after a prior incident finalized starts a fresh correlation id', () => {
  const engine = createIncidentTimelineEngine();
  const first = engine.activate({ scenarioId: 'oom' });
  engine.finalize(first.correlationId, FINAL_STATE.RECOVERED, {});
  const second = engine.activate({ scenarioId: 'crash' });
  assert.notEqual(second.correlationId, first.correlationId);
});

test('milestones are recorded with monotonically increasing sequence numbers regardless of call order', () => {
  const clock = makeClock();
  const engine = createIncidentTimelineEngine({ clock: clock.now });
  const incident = engine.activate({ scenarioId: 'mongodb' });

  clock.tick(5000);
  engine.recordImpact(incident.correlationId, { reason: 'mongodb pod missing' });
  clock.tick(1000);
  // Simulate an "out of order" evidence callback whose *source* event time
  // (occurredAt) is actually earlier than the impact milestone above — the
  // server still records it in arrival order with a later seq/recordedAt.
  engine.recordEvidence(incident.correlationId, {
    toolName: 'get_events',
    category: 'kubernetes',
    callId: 'evt-1',
  }, { occurredAt: clock.now() - 60_000 });

  const stored = engine.getIncident(incident.correlationId);
  const seqs = stored.milestones.map((m) => m.seq);
  const sorted = [...seqs].sort((a, b) => a - b);
  assert.deepEqual(seqs, sorted, 'milestones must already be stored in non-decreasing seq order');

  // recordedAt must be non-decreasing across the stored order too.
  const recordedTimes = stored.milestones.map((m) => new Date(m.recordedAt).getTime());
  for (let i = 1; i < recordedTimes.length; i += 1) {
    assert.ok(recordedTimes[i] >= recordedTimes[i - 1], 'recordedAt must never go backwards in the stored timeline');
  }

  // occurredAt is preserved separately and is allowed to be "out of order" vs recordedAt.
  const evidenceMilestone = stored.milestones.find((m) => m.type === MILESTONE.EVIDENCE_COLLECTED);
  assert.ok(new Date(evidenceMilestone.occurredAt).getTime() < new Date(evidenceMilestone.recordedAt).getTime());
});

test('duplicate evidence callbacks for the same tool call are deduplicated, not counted twice', () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'oom' });

  engine.recordEvidence(incident.correlationId, { toolName: 'get_pods', category: 'kubernetes', callId: 'dup-1', summary: 'first' });
  engine.recordEvidence(incident.correlationId, { toolName: 'get_pods', category: 'kubernetes', callId: 'dup-1', summary: 'retry-callback' });

  const stored = engine.getIncident(incident.correlationId);
  const evidenceEntries = stored.milestones.filter((m) => m.type === MILESTONE.EVIDENCE_COLLECTED);
  assert.equal(evidenceEntries.length, 1, 'a duplicate callback with the same callId must not create a second timeline entry');
  assert.equal(evidenceEntries[0].updateCount, 1);
});

test('duplicate approval callbacks do not create duplicate milestones', () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'mongodb' });
  engine.proposeAction(incident.correlationId, { actionKey: 'fix_all::{}', toolName: 'fix_all', runMode: 'agent-assisted:approval-required' });

  engine.approveAction(incident.correlationId, { actionKey: 'fix_all::{}', approver: 'alice' });
  engine.approveAction(incident.correlationId, { actionKey: 'fix_all::{}', approver: 'alice' });

  const stored = engine.getIncident(incident.correlationId);
  const approvals = stored.milestones.filter((m) => m.type === MILESTONE.ACTION_APPROVED);
  assert.equal(approvals.length, 1);
});

test('investigation_started is recorded automatically on the first evidence call only', () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'oom' });
  engine.recordEvidence(incident.correlationId, { toolName: 'get_pods', category: 'kubernetes', callId: 'a' });
  engine.recordEvidence(incident.correlationId, { toolName: 'get_events', category: 'kubernetes', callId: 'b' });

  const stored = engine.getIncident(incident.correlationId);
  const started = stored.milestones.filter((m) => m.type === MILESTONE.INVESTIGATION_STARTED);
  assert.equal(started.length, 1);
});

test('missing evidence categories are reported as unused, and traces/knowledge are marked unavailable by default', () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'oom' });
  engine.recordEvidence(incident.correlationId, { toolName: 'get_pods', category: 'kubernetes', callId: 'a' });

  const evidence = engine.summarizeEvidence(incident.correlationId);
  const byCategory = Object.fromEntries(evidence.map((e) => [e.category, e]));

  assert.equal(byCategory.kubernetes.used, true);
  assert.equal(byCategory.logs.used, false);
  assert.equal(byCategory.metrics.used, false);
  assert.equal(byCategory.traces.used, false);
  assert.equal(byCategory.traces.nativeAvailable, false);
  assert.equal(byCategory.knowledge.nativeAvailable, false);
  assert.match(byCategory.traces.nativeDescription, /not wired/i);
});

test('a registered native integration overrides the default unavailable stub', () => {
  const engine = createIncidentTimelineEngine();
  engine.registerNativeIntegration('traces', { available: true, description: 'Wired to SRE Agent thread traces.' });
  const incident = engine.activate({ scenarioId: 'oom' });
  const evidence = engine.summarizeEvidence(incident.correlationId);
  const traces = evidence.find((e) => e.category === 'traces');
  assert.equal(traces.nativeAvailable, true);
  assert.match(traces.nativeDescription, /SRE Agent thread traces/);
});

test('metrics are only computed when the relevant milestones exist — never fabricated', () => {
  const clock = makeClock();
  const engine = createIncidentTimelineEngine({ clock: clock.now });
  const incident = engine.activate({ scenarioId: 'oom' });

  let metrics = engine.computeMetrics(incident.correlationId);
  assert.equal(metrics.timeToDetectMs, null);
  assert.equal(metrics.timeToRootCauseMs, null);
  assert.equal(metrics.timeToRecoverMs, null);

  clock.tick(10_000);
  engine.recordImpact(incident.correlationId, {});
  metrics = engine.computeMetrics(incident.correlationId);
  assert.equal(metrics.timeToDetectMs, 10_000);
  assert.equal(metrics.timeToDetect, '10s');
  assert.equal(metrics.timeToRootCauseMs, null, 'root cause was never identified in this run');
  assert.equal(metrics.timeToRecoverMs, null, 'recovery never happened in this run');

  clock.tick(5000);
  engine.recordRootCause(incident.correlationId, { statement: 'memory limit too low' });
  clock.tick(20_000);
  engine.recordRecovery(incident.correlationId, {});
  metrics = engine.computeMetrics(incident.correlationId);
  assert.equal(metrics.timeToRootCauseMs, 15_000);
  assert.equal(metrics.timeToRecoverMs, 35_000);
});

test('denial is represented as a final state and blocks further action on that actionKey', () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'crash' });
  engine.proposeAction(incident.correlationId, { actionKey: 'fix_all::{}', toolName: 'fix_all' });
  engine.denyAction(incident.correlationId, { actionKey: 'fix_all::{}', approver: 'bob' });

  const stored = engine.getIncident(incident.correlationId);
  assert.equal(stored.finalState, FINAL_STATE.DENIED);
  assert.ok(stored.milestones.some((m) => m.type === MILESTONE.ACTION_DENIED && m.data.approver === 'bob'));
  assert.equal(engine.getActive(), null, 'a denied incident should no longer be considered active');
});

test('expiry is represented distinctly from denial and does not fire if already approved', () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'crash' });
  engine.proposeAction(incident.correlationId, { actionKey: 'fix_all::{}', toolName: 'fix_all' });
  engine.approveAction(incident.correlationId, { actionKey: 'fix_all::{}', approver: 'carol' });
  engine.expireAction(incident.correlationId, { actionKey: 'fix_all::{}' });

  let stored = engine.getIncident(incident.correlationId);
  assert.equal(stored.finalState, null, 'an approved action must not later be marked expired');

  const engine2 = createIncidentTimelineEngine();
  const incident2 = engine2.activate({ scenarioId: 'crash' });
  engine2.proposeAction(incident2.correlationId, { actionKey: 'fix_all::{}', toolName: 'fix_all' });
  engine2.expireAction(incident2.correlationId, { actionKey: 'fix_all::{}' });
  stored = engine2.getIncident(incident2.correlationId);
  assert.equal(stored.finalState, FINAL_STATE.EXPIRED);
});

test('a failed action result is represented as a failed final state, not a fabricated success', () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'mongodb' });
  engine.proposeAction(incident.correlationId, { actionKey: 'fix_all::{}', toolName: 'fix_all' });
  engine.approveAction(incident.correlationId, { actionKey: 'fix_all::{}', approver: 'dave' });
  engine.recordActionResult(incident.correlationId, { actionKey: 'fix_all::{}', toolName: 'fix_all', success: false, summary: 'kubectl apply failed: context deadline exceeded' });

  const stored = engine.getIncident(incident.correlationId);
  assert.equal(stored.finalState, FINAL_STATE.FAILED);
});

test('a post-action assertion failure produces a partial_recovery final state, never a fabricated success', () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'mongodb' });
  engine.proposeAction(incident.correlationId, { actionKey: 'fix_network::{}', toolName: 'fix_network' });
  engine.approveAction(incident.correlationId, { actionKey: 'fix_network::{}', approver: 'erin' });
  engine.recordActionResult(incident.correlationId, { actionKey: 'fix_network::{}', toolName: 'fix_network', success: true, summary: 'networkpolicy.networking.k8s.io "deny-tank-monitor" deleted' });
  // Wrong fix for a mongodb scenario: the assertion (re-checking mongodb health) fails.
  engine.recordPostActionAssertion(incident.correlationId, { actionKey: 'fix_network::{}', passed: false, details: 'mongodb pod still has 0 replicas' });

  const stored = engine.getIncident(incident.correlationId);
  assert.equal(stored.finalState, FINAL_STATE.PARTIAL_RECOVERY);
  // No recovery milestone should exist because the scenario indicator never cleared.
  assert.ok(!stored.milestones.some((m) => m.type === MILESTONE.RECOVERY));
});

test('sweepExpiredApprovals marks unresolved proposals expired without double-recording resolved ones', () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'crash' });
  engine.proposeAction(incident.correlationId, { actionKey: 'fix_all::{}', toolName: 'fix_all' });

  engine.sweepExpiredApprovals(Date.now() + 1, [{ actionKey: 'fix_all::{}', toolName: 'fix_all', expiresAt: Date.now() }]);

  const stored = engine.getIncident(incident.correlationId);
  assert.equal(stored.finalState, FINAL_STATE.EXPIRED);
});

test('approveAction/denyAction/expireAction/recordActionResult are safe no-ops for an actionKey never proposed on that incident', () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'oom' });

  // No proposeAction call was ever made for this actionKey — simulates a
  // stale actionKey left over from a different/previous incident.
  assert.equal(engine.approveAction(incident.correlationId, { actionKey: 'never-proposed', approver: 'x' }), null);
  assert.equal(engine.denyAction(incident.correlationId, { actionKey: 'never-proposed', approver: 'x' }), null);
  assert.equal(engine.expireAction(incident.correlationId, { actionKey: 'never-proposed' }), null);
  assert.equal(engine.recordActionResult(incident.correlationId, { actionKey: 'never-proposed', toolName: 'fix_all', success: true }), null);

  const stored = engine.getIncident(incident.correlationId);
  assert.equal(stored.milestones.filter((m) => ['action_approved', 'action_denied', 'action_expired', 'action_executed'].includes(m.type)).length, 0);
  assert.equal(stored.finalState, null, 'no final state should be fabricated from an action that was never proposed on this incident');
});

test('export/import state round-trips exactly, preserving monotonic sequencing across a simulated restart', () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'oom' });
  engine.recordEvidence(incident.correlationId, { toolName: 'get_pods', category: 'kubernetes', callId: 'a' });
  const snapshot = engine.exportState();

  const restarted = createIncidentTimelineEngine();
  restarted.importState(snapshot);

  assert.equal(restarted.getActive().correlationId, incident.correlationId);
  // A new milestone recorded after "restart" must continue the sequence, not reset it.
  const before = restarted.getIncident(incident.correlationId).milestones.map((m) => m.seq);
  restarted.recordImpact(incident.correlationId, {});
  const after = restarted.getIncident(incident.correlationId).milestones.map((m) => m.seq);
  assert.ok(Math.max(...after) > Math.max(...before));
});

test('redaction is applied to milestone payloads at record time, not only at export time', () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'mongodb' });
  engine.recordEvidence(incident.correlationId, {
    toolName: 'get_pod_logs',
    category: 'logs',
    callId: 'log-1',
    summary: 'connecting with Authorization: Bearer sk-abc123def456ghijklmno and AccountKey=SGVsbG9Xb3JsZA==',
  });

  const stored = engine.getIncident(incident.correlationId);
  const evidence = stored.milestones.find((m) => m.type === MILESTONE.EVIDENCE_COLLECTED);
  assert.doesNotMatch(evidence.data.summary, /sk-abc123def456ghijklmno/);
  assert.doesNotMatch(evidence.data.summary, /SGVsbG9Xb3JsZA==/);
  assert.match(evidence.data.summary, /REDACTED/);
});

test('toRedactedMarkdown and toRedactedSnapshot never contain secret-looking values and include measured-only language', () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'oom', scenarioName: 'OOMKilled', domain: 'Bulk Tank', impactedService: 'tank-monitor' });
  engine.recordEvidence(incident.correlationId, {
    toolName: 'describe_pod',
    category: 'kubernetes',
    callId: 'd1',
    summary: 'token: aVerySecretToken1234567890',
  });

  const markdown = engine.toRedactedMarkdown(incident.correlationId);
  assert.doesNotMatch(markdown, /aVerySecretToken1234567890/);
  assert.match(markdown, /No human-benchmark or ROI figures/);
  assert.match(markdown, /not observed in this run/);

  const json = engine.toRedactedSnapshot(incident.correlationId);
  assert.equal(JSON.stringify(json).includes('aVerySecretToken1234567890'), false);
});
