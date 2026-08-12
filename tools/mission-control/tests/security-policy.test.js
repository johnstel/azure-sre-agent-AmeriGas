const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSecurityState,
  evaluateToolAccess,
  approvePendingApproval,
  denyPendingApproval,
  markTelemetry,
  wrapUntrustedTelemetry,
  validateKubectlArgs,
} = require('../security-policy');

test('diagnostic tools mark telemetry as untrusted', () => {
  const state = createSecurityState();

  const gate = evaluateToolAccess(state, 'get_pods', {});
  assert.equal(gate.allowed, true);
  assert.equal(state.untrustedTelemetryActive, true);
});

test('remediation tools require explicit approval before execution', () => {
  const state = createSecurityState();

  const gate = evaluateToolAccess(state, 'fix_all', {}, { sessionId: 'chat-1' });
  assert.equal(gate.allowed, false);
  assert.equal(state.pendingApproval.toolName, 'fix_all');

  const approved = approvePendingApproval(state, gate.approvalId, { sessionId: 'chat-1', actionKey: gate.actionKey });
  assert.equal(approved.success, true);

  const secondGate = evaluateToolAccess(state, 'fix_all', {}, { sessionId: 'chat-1' });
  assert.equal(secondGate.allowed, true);
});

test('denied approvals clear the pending request', () => {
  const state = createSecurityState();
  const gate = evaluateToolAccess(state, 'restart_deployment', { deployment: 'tank-monitor' }, { sessionId: 'chat-2' });
  assert.equal(gate.allowed, false);

  const denied = denyPendingApproval(state, gate.approvalId, { sessionId: 'chat-2', actionKey: gate.actionKey });
  assert.equal(denied.success, true);

  const secondGate = evaluateToolAccess(state, 'restart_deployment', { deployment: 'tank-monitor' }, { sessionId: 'chat-2' });
  assert.equal(secondGate.allowed, false);
});

test('untrusted telemetry is wrapped before being returned to the operator', () => {
  const wrapped = wrapUntrustedTelemetry('pod tank-monitor restarted');
  assert.equal(wrapped, '[UNTRUSTED TELEMETRY] pod tank-monitor restarted');
});

test('kubectl allowlist permits read-only diagnostics and blocks destructive commands', () => {
  const allowed = validateKubectlArgs('get pods');
  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.normalizedArgs, ['get', 'pods']);

  const blocked = validateKubectlArgs('delete deployment tank-monitor -n propane');
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /not allowed/i);
});

test('kubectl restrictions reject namespace overrides, all-namespaces, impersonation, and context flags', () => {
  for (const payload of [
    'get pods -n kube-system',
    'get pods --namespace=kube-system',
    'get pods -A',
    'get pods --all-namespaces',
    'get pods --as=alice',
    'get pods --as alice',
    'get pods --kubeconfig=/tmp/config',
    'get pods --context=prod',
    'get pods --server=https://evil.example',
    'get pods --token=abc123',
    'get pods -o json',
    'get pods --output=json',
    'get pods --template={{.items}}',
    'get pods -f ./pod.yaml',
    'get pods --filename=./pod.yaml',
  ]) {
    const result = validateKubectlArgs(payload);
    assert.equal(result.allowed, false, `${payload} should be rejected`);
  }
});

test('expired approvals are rejected and replaced with a fresh pending request', () => {
  const state = createSecurityState();
  const gate = evaluateToolAccess(state, 'fix_all', {}, { sessionId: 'chat-expired' });
  assert.equal(gate.allowed, false);
  state.pendingApproval.expiresAt = Date.now() - 1000;

  const expired = approvePendingApproval(state, gate.approvalId, { sessionId: 'chat-expired', actionKey: gate.actionKey });
  assert.equal(expired.success, false);

  const replacement = evaluateToolAccess(state, 'fix_all', {}, { sessionId: 'chat-expired' });
  assert.equal(replacement.allowed, false);
  assert.notEqual(replacement.approvalId, gate.approvalId);
});

test('approvals are bound to the initiating session and exact action', () => {
  const state = createSecurityState();
  const gate = evaluateToolAccess(state, 'fix_all', {}, { sessionId: 'chat-1' });
  assert.equal(gate.allowed, false);

  const spoofed = approvePendingApproval(state, gate.approvalId, { sessionId: 'chat-2', actionKey: gate.actionKey });
  assert.equal(spoofed.success, false);

  const mismatchedAction = approvePendingApproval(state, gate.approvalId, { sessionId: 'chat-1', actionKey: 'different' });
  assert.equal(mismatchedAction.success, false);

  const approved = approvePendingApproval(state, gate.approvalId, { sessionId: 'chat-1', actionKey: gate.actionKey });
  assert.equal(approved.success, true);

  const replay = approvePendingApproval(state, gate.approvalId, { sessionId: 'chat-1', actionKey: gate.actionKey });
  assert.equal(replay.success, false);
});

test('approval handlers reject missing, blank, or mismatched bindings', () => {
  const state = createSecurityState();
  const gate = evaluateToolAccess(state, 'restart_deployment', { deployment: 'tank-monitor' }, { sessionId: 'chat-3' });
  assert.equal(gate.allowed, false);

  const missingSession = approvePendingApproval(state, gate.approvalId, { actionKey: gate.actionKey });
  assert.equal(missingSession.success, false);

  const undefinedAction = approvePendingApproval(state, gate.approvalId, { sessionId: 'chat-3', actionKey: undefined });
  assert.equal(undefinedAction.success, false);

  const nullAction = approvePendingApproval(state, gate.approvalId, { sessionId: 'chat-3', actionKey: null });
  assert.equal(nullAction.success, false);

  const whitespaceAction = approvePendingApproval(state, gate.approvalId, { sessionId: 'chat-3', actionKey: '   ' });
  assert.equal(whitespaceAction.success, false);

  const wrongSession = approvePendingApproval(state, gate.approvalId, { sessionId: 'chat-9', actionKey: gate.actionKey });
  assert.equal(wrongSession.success, false);

  const denyMissing = denyPendingApproval(state, gate.approvalId, { sessionId: 'chat-3', actionKey: '' });
  assert.equal(denyMissing.success, false);

  const matched = approvePendingApproval(state, gate.approvalId, { sessionId: 'chat-3', actionKey: gate.actionKey });
  assert.equal(matched.success, true);

  const replay = approvePendingApproval(state, gate.approvalId, { sessionId: 'chat-3', actionKey: gate.actionKey });
  assert.equal(replay.success, false);
});

test('markTelemetry ignores non-telemetry tools', () => {
  const state = createSecurityState();
  markTelemetry(state, 'deploy_infrastructure');
  assert.equal(state.untrustedTelemetryActive, false);
});

test('approvals bind to the exact incidentCorrelationId supplied at proposal time', () => {
  const state = createSecurityState();
  const gate = evaluateToolAccess(state, 'fix_all', {}, { sessionId: 'chat-1', incidentCorrelationId: 'INC-AAA' });
  assert.equal(gate.allowed, false);
  assert.equal(state.pendingApproval.incidentCorrelationId, 'INC-AAA');

  const approved = approvePendingApproval(state, gate.approvalId, { sessionId: 'chat-1', actionKey: gate.actionKey, incidentCorrelationId: 'INC-AAA' });
  assert.equal(approved.success, true);
  assert.equal(approved.incidentCorrelationId, 'INC-AAA');
});

test('an approval whose incident has since been superseded by a new run is rejected, not silently applied to whichever incident is now active', () => {
  const state = createSecurityState();
  const gate = evaluateToolAccess(state, 'fix_all', {}, { sessionId: 'chat-1', incidentCorrelationId: 'INC-AAA' });
  assert.equal(gate.allowed, false);

  // Approval arrives after a completely different incident became active
  // (e.g. the operator broke a new scenario while the old approval was
  // still outstanding).
  const stale = approvePendingApproval(state, gate.approvalId, { sessionId: 'chat-1', actionKey: gate.actionKey, incidentCorrelationId: 'INC-BBB' });
  assert.equal(stale.success, false);
  assert.match(stale.reason, /no longer matches the incident/i);

  // The pending approval must still be intact (not silently consumed) so a
  // correctly-bound retry can still succeed.
  assert.equal(state.pendingApproval.status, 'pending');
  const correct = approvePendingApproval(state, gate.approvalId, { sessionId: 'chat-1', actionKey: gate.actionKey, incidentCorrelationId: 'INC-AAA' });
  assert.equal(correct.success, true);
});

test('an approval for an incident that has since been finalized (terminal) is rejected — modeled as the caller now supplying no active incident', () => {
  const state = createSecurityState();
  const gate = evaluateToolAccess(state, 'fix_all', {}, { sessionId: 'chat-1', incidentCorrelationId: 'INC-AAA' });
  assert.equal(gate.allowed, false);

  // The route always passes the CURRENT active incident's correlationId (or
  // null if none is active/it finalized). A finalized incident means
  // getActive() returns null, so the caller passes incidentCorrelationId:
  // null here — which must not match the non-null value stored at
  // proposal time.
  const rejected = approvePendingApproval(state, gate.approvalId, { sessionId: 'chat-1', actionKey: gate.actionKey, incidentCorrelationId: null });
  assert.equal(rejected.success, false);
  assert.match(rejected.reason, /no longer matches the incident/i);
});

test('denial is likewise rejected when the incidentCorrelationId does not match, and the mismatch never clears the pending approval', () => {
  const state = createSecurityState();
  const gate = evaluateToolAccess(state, 'restart_deployment', { deployment: 'tank-monitor' }, { sessionId: 'chat-2', incidentCorrelationId: 'INC-AAA' });
  assert.equal(gate.allowed, false);

  const staleDeny = denyPendingApproval(state, gate.approvalId, { sessionId: 'chat-2', actionKey: gate.actionKey, incidentCorrelationId: 'INC-ZZZ' });
  assert.equal(staleDeny.success, false);
  assert.equal(state.pendingApproval.status, 'pending', 'a rejected stale denial must not consume the pending approval');

  const correctDeny = denyPendingApproval(state, gate.approvalId, { sessionId: 'chat-2', actionKey: gate.actionKey, incidentCorrelationId: 'INC-AAA' });
  assert.equal(correctDeny.success, true);
  assert.equal(correctDeny.incidentCorrelationId, 'INC-AAA');
});

test('approvals proposed with no active incident (e.g. deploy_infrastructure before any scenario is broken) match null-to-null, not treated as a mismatch', () => {
  const state = createSecurityState();
  const gate = evaluateToolAccess(state, 'deploy_infrastructure', { location: 'eastus2' }, { sessionId: 'chat-1' });
  assert.equal(gate.allowed, false);
  assert.equal(state.pendingApproval.incidentCorrelationId, null);

  const approved = approvePendingApproval(state, gate.approvalId, { sessionId: 'chat-1', actionKey: gate.actionKey });
  assert.equal(approved.success, true, 'omitting incidentCorrelationId on both sides must be treated as a valid null-to-null match');
});
