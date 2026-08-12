const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createTools,
  EVIDENCE_CATEGORY_BY_TOOL,
  recordProposedActionIfActive,
  recordActionResultIfActive,
  recordEvidenceIfActive,
} = require('../copilot-tools');
const { createSecurityState, createApprovalSignature, approvePendingApproval } = require('../security-policy');
const { withApprovalContext } = require('../auth');
const { createIncidentTimelineEngine } = require('../incident-timeline');

/** Drive an approval-required tool through its full propose -> approve -> execute cycle for tests, returning the final handler response. */
async function runApprovedTool(tool, securityState, params, sessionId = 'test-session') {
  const firstResponse = await withApprovalContext({ sessionId }, () => tool.handler(params));
  const pending = securityState.pendingApproval;
  if (!pending) throw new Error(`Expected ${tool.name} to require approval, but no pending approval was recorded. First response: ${firstResponse}`);
  const approval = approvePendingApproval(securityState, pending.id, { sessionId, actionKey: pending.actionKey });
  if (!approval.success) throw new Error(`Failed to approve ${tool.name} in test harness: ${approval.reason}`);
  return withApprovalContext({ sessionId }, () => tool.handler(params));
}

test('createTools still returns the full tool catalog when passed an incidentStore', () => {
  const engine = createIncidentTimelineEngine();
  const tools = createTools(createSecurityState(), engine);
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('get_pods'));
  assert.ok(names.includes('fix_all'));
  assert.equal(typeof tools.find((t) => t.name === 'get_pods').handler, 'function');
});

test('EVIDENCE_CATEGORY_BY_TOOL categorizes each diagnostic tool into a known incident evidence category', () => {
  const { EVIDENCE_CATEGORIES } = require('../incident-timeline');
  for (const [toolName, category] of Object.entries(EVIDENCE_CATEGORY_BY_TOOL)) {
    assert.ok(EVIDENCE_CATEGORIES.includes(category), `${toolName} maps to an unknown category "${category}"`);
  }
  assert.equal(EVIDENCE_CATEGORY_BY_TOOL.get_pods, 'kubernetes');
  assert.equal(EVIDENCE_CATEGORY_BY_TOOL.get_pod_logs, 'logs');
});

test('recordProposedActionIfActive does nothing when there is no active incident', () => {
  const engine = createIncidentTimelineEngine();
  // No incident activated.
  recordProposedActionIfActive(engine, { approvalId: 'a1', actionKey: 'fix_all::{}' }, 'fix_all', {});
  assert.equal(engine.getActive(), null);
});

test('recordProposedActionIfActive records a proposed action against the active incident using the gate actionKey', () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'mongodb' });
  recordProposedActionIfActive(engine, { approvalId: 'a1', actionKey: 'fix_all::{}' }, 'fix_all', { foo: 'bar' });

  const stored = engine.getIncident(incident.correlationId);
  const proposal = stored.milestones.find((m) => m.type === 'action_proposed');
  assert.ok(proposal);
  assert.equal(proposal.data.toolName, 'fix_all');
  assert.equal(proposal.data.runMode, 'agent-assisted:approval-required');
  assert.equal(proposal.data.actionKey, 'fix_all::{}');
});

test('recordProposedActionIfActive is a no-op when the gate has no approvalId (non-mutating tool)', () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'mongodb' });
  recordProposedActionIfActive(engine, { approvalId: undefined }, 'get_pods', {});
  const stored = engine.getIncident(incident.correlationId);
  assert.equal(stored.milestones.filter((m) => m.type === 'action_proposed').length, 0);
});

test('recordActionResultIfActive records success/failure using the same actionKey algorithm the security policy uses', () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'crash' });
  const params = { deployment: 'inventory-service' };
  const actionKey = createApprovalSignature('restart_deployment', params);

  // Simulate: proposed (as security-policy would generate the same actionKey), then approved, then executed.
  engine.proposeAction(incident.correlationId, { actionKey, toolName: 'restart_deployment', params });
  engine.approveAction(incident.correlationId, { actionKey, approver: 'test-operator' });

  recordActionResultIfActive(engine, 'restart_deployment', params, { success: true, summary: 'deployment.apps/inventory-service restarted' });

  const stored = engine.getIncident(incident.correlationId);
  const resultMilestone = stored.milestones.find((m) => m.type === 'action_executed');
  assert.ok(resultMilestone);
  assert.equal(resultMilestone.data.success, true);
  assert.equal(resultMilestone.data.actionKey, actionKey, 'the actionKey computed independently must match the one used at proposal/approval time');
});

test('recordActionResultIfActive ignores non-approval-required tools (evidence tools are not "actions")', () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'oom' });
  recordActionResultIfActive(engine, 'get_pods', {}, { success: true, summary: 'irrelevant' });
  const stored = engine.getIncident(incident.correlationId);
  assert.equal(stored.milestones.filter((m) => m.type === 'action_executed').length, 0);
});

test('recordEvidenceIfActive tags the correct category and includes a stable callId derived from tool+params+session', () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'oom' });
  recordEvidenceIfActive(engine, { sessionId: 'chat-123' }, 'get_pod_logs', { pod_name: 'tank-monitor-1' }, 'log output here');

  const stored = engine.getIncident(incident.correlationId);
  const evidence = stored.milestones.find((m) => m.type === 'evidence_collected');
  assert.ok(evidence);
  assert.equal(evidence.data.category, 'logs');
  assert.equal(evidence.data.toolName, 'get_pod_logs');

  // Calling again with identical params/session must not create a duplicate (dedup by callId).
  recordEvidenceIfActive(engine, { sessionId: 'chat-123' }, 'get_pod_logs', { pod_name: 'tank-monitor-1' }, 'log output here (retry)');
  const evidenceEntries = engine.getIncident(incident.correlationId).milestones.filter((m) => m.type === 'evidence_collected');
  assert.equal(evidenceEntries.length, 1);
});

test('recordEvidenceIfActive is a no-op with no incidentStore or no active incident', () => {
  assert.doesNotThrow(() => recordEvidenceIfActive(null, {}, 'get_pods', {}, 'x'));
  const engine = createIncidentTimelineEngine();
  assert.doesNotThrow(() => recordEvidenceIfActive(engine, {}, 'get_pods', {}, 'x'));
});

test('the record_incident_root_cause tool records a root cause against the active incident without requiring approval', async () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'oom' });
  const tools = createTools(createSecurityState(), engine);
  const tool = tools.find((t) => t.name === 'record_incident_root_cause');
  assert.ok(tool, 'record_incident_root_cause must be registered as a tool');

  const response = await tool.handler({ statement: 'tank-monitor memory limit (16Mi) is too low for peak IoT ingestion' });
  assert.match(response, /Root cause recorded/);

  const stored = engine.getIncident(incident.correlationId);
  const rootCause = stored.milestones.find((m) => m.type === 'root_cause_identified');
  assert.ok(rootCause);
  assert.match(rootCause.data.statement, /memory limit/);
  assert.equal(rootCause.data.assertedBy, 'agent');
});

test('the record_incident_root_cause tool is a graceful no-op when there is no active incident', async () => {
  const engine = createIncidentTimelineEngine();
  const tools = createTools(createSecurityState(), engine);
  const tool = tools.find((t) => t.name === 'record_incident_root_cause');
  const response = await tool.handler({ statement: 'some finding' });
  assert.match(response, /no active incident/i);
});

test('deploy_infrastructure records a FAILED action result when the script fails, even though the handler catches the error internally', async () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'oom' });
  const securityState = createSecurityState();
  const failure = Object.assign(new Error('script exited non-zero'), { code: 1, stdout: 'partial output', stderr: 'boom: pwsh script failed' });
  const failingRunner = async () => { throw failure; };
  const tools = createTools(securityState, engine, { runCommand: failingRunner });
  const tool = tools.find((t) => t.name === 'deploy_infrastructure');
  assert.ok(tool, 'deploy_infrastructure must be registered');

  const finalResponse = await runApprovedTool(tool, securityState, { location: 'eastus2' });

  // The tool must still return a descriptive error string to the caller...
  assert.match(finalResponse, /Error:.*Deployment failed/s);

  // ...but critically, the incident evidence timeline must record this as
  // an actual failure, never a false success inferred merely because the
  // inner handler didn't let the exception propagate on its own.
  const stored = engine.getIncident(incident.correlationId);
  const resultMilestone = stored.milestones.find((m) => m.type === 'action_executed');
  assert.ok(resultMilestone, 'an action_executed milestone must be recorded');
  assert.equal(resultMilestone.data.success, false, 'a caught deploy_infrastructure failure must never be recorded as success:true');
  assert.match(resultMilestone.data.summary, /Deployment failed/);
});

test('destroy_infrastructure records a FAILED action result when the script fails, even though the handler catches the error internally', async () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'mongodb' });
  const securityState = createSecurityState();
  const failure = Object.assign(new Error('script exited non-zero'), { code: 1, stdout: '', stderr: 'boom: destroy script failed' });
  const failingRunner = async () => { throw failure; };
  const tools = createTools(securityState, engine, { runCommand: failingRunner });
  const tool = tools.find((t) => t.name === 'destroy_infrastructure');
  assert.ok(tool, 'destroy_infrastructure must be registered');

  const finalResponse = await runApprovedTool(tool, securityState, { resource_group: 'rg-srelab-eastus2' });

  assert.match(finalResponse, /Error:.*Destroy operation failed/s);

  const stored = engine.getIncident(incident.correlationId);
  const resultMilestone = stored.milestones.find((m) => m.type === 'action_executed');
  assert.ok(resultMilestone);
  assert.equal(resultMilestone.data.success, false, 'a caught destroy_infrastructure failure must never be recorded as success:true');
  assert.match(resultMilestone.data.summary, /Destroy operation failed/);
});

test('deploy_infrastructure records a successful action result when the underlying script actually succeeds', async () => {
  const engine = createIncidentTimelineEngine();
  const incident = engine.activate({ scenarioId: 'oom' });
  const securityState = createSecurityState();
  const succeedingRunner = async () => ({ stdout: 'deployment ok', stderr: '' });
  const tools = createTools(securityState, engine, { runCommand: succeedingRunner });
  const tool = tools.find((t) => t.name === 'deploy_infrastructure');

  const finalResponse = await runApprovedTool(tool, securityState, { location: 'eastus2' });
  assert.match(finalResponse, /Deployment completed successfully/);

  const stored = engine.getIncident(incident.correlationId);
  const resultMilestone = stored.milestones.find((m) => m.type === 'action_executed');
  assert.equal(resultMilestone.data.success, true);
});
