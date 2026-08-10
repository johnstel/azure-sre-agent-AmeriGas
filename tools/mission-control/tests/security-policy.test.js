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

  const gate = evaluateToolAccess(state, 'fix_all', {});
  assert.equal(gate.allowed, false);
  assert.equal(state.pendingApproval.toolName, 'fix_all');

  const approved = approvePendingApproval(state, gate.approvalId);
  assert.equal(approved.success, true);

  const secondGate = evaluateToolAccess(state, 'fix_all', {});
  assert.equal(secondGate.allowed, true);
});

test('denied approvals clear the pending request', () => {
  const state = createSecurityState();
  const gate = evaluateToolAccess(state, 'restart_deployment', { deployment: 'tank-monitor' });
  assert.equal(gate.allowed, false);

  const denied = denyPendingApproval(state, gate.approvalId);
  assert.equal(denied.success, true);

  const secondGate = evaluateToolAccess(state, 'restart_deployment', { deployment: 'tank-monitor' });
  assert.equal(secondGate.allowed, false);
});

test('untrusted telemetry is wrapped before being returned to the operator', () => {
  const wrapped = wrapUntrustedTelemetry('pod tank-monitor restarted');
  assert.equal(wrapped, '[UNTRUSTED TELEMETRY] pod tank-monitor restarted');
});

test('kubectl allowlist permits read-only diagnostics and blocks destructive commands', () => {
  const allowed = validateKubectlArgs('get pods -n propane -o wide');
  assert.equal(allowed.allowed, true);

  const blocked = validateKubectlArgs('delete deployment tank-monitor -n propane');
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /not allowed/i);
});

test('markTelemetry ignores non-telemetry tools', () => {
  const state = createSecurityState();
  markTelemetry(state, 'deploy_infrastructure');
  assert.equal(state.untrustedTelemetryActive, false);
});
