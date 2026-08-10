const APPROVAL_REQUIRED_TOOLS = new Set([
  'apply_break_scenario',
  'fix_all',
  'fix_network',
  'fix_extras',
  'scale_deployment',
  'restart_deployment',
  'deploy_infrastructure',
  'destroy_infrastructure',
]);

const UNTRUSTED_TELEMETRY_TOOLS = new Set([
  'get_pods',
  'get_pod_logs',
  'describe_pod',
  'get_events',
  'get_deployments',
  'get_services',
  'get_nodes',
  'get_cluster_health',
  'validate_deployment',
  'get_cluster_info',
  'kubectl_readonly',
]);

function createSecurityState() {
  return {
    pendingApproval: null,
    untrustedTelemetryActive: false,
  };
}

function createApprovalSignature(params = {}) {
  return JSON.stringify(params ?? {});
}

function markTelemetry(state, toolName) {
  if (!state || !UNTRUSTED_TELEMETRY_TOOLS.has(toolName)) return;
  state.untrustedTelemetryActive = true;
}

function wrapUntrustedTelemetry(text) {
  if (typeof text !== 'string') return text;
  const trimmed = text.trim();
  if (!trimmed) return text;
  return `[UNTRUSTED TELEMETRY] ${trimmed}`;
}

function evaluateToolAccess(state, toolName, params = {}) {
  if (!APPROVAL_REQUIRED_TOOLS.has(toolName)) {
    markTelemetry(state, toolName);
    return { allowed: true };
  }

  const signature = createApprovalSignature(params);
  if (state?.pendingApproval && state.pendingApproval.toolName === toolName && state.pendingApproval.paramsSignature === signature) {
    if (state.pendingApproval.approved) {
      state.pendingApproval = null;
      return { allowed: true };
    }
    if (state.pendingApproval.denied) {
      state.pendingApproval = null;
    }
  }

  const approvalId = `approval-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  state.pendingApproval = {
    id: approvalId,
    toolName,
    params,
    paramsSignature: signature,
    approved: false,
    denied: false,
    reason: `Explicit human approval is required before ${toolName} can run.`,
  };

  return {
    allowed: false,
    approvalId,
    message: `${state.pendingApproval.reason}\nAsk the operator to approve this action with /api/approval/approve and the approval ID ${approvalId}.`,
  };
}

function approvePendingApproval(state, approvalId) {
  if (!state?.pendingApproval || state.pendingApproval.id !== approvalId) {
    return { success: false, reason: 'No matching pending approval was found.' };
  }

  state.pendingApproval.approved = true;
  return { success: true, approvalId, toolName: state.pendingApproval.toolName };
}

function denyPendingApproval(state, approvalId) {
  if (!state?.pendingApproval || state.pendingApproval.id !== approvalId) {
    return { success: false, reason: 'No matching pending approval was found.' };
  }

  state.pendingApproval.denied = true;
  return { success: true, approvalId, toolName: state.pendingApproval.toolName };
}

function validateKubectlArgs(args) {
  const normalizedArgs = (args || '').trim().split(/\s+/).filter(Boolean);
  if (normalizedArgs.length === 0) {
    return { allowed: false, reason: 'The kubectl request was empty.' };
  }

  const [command, ...rest] = normalizedArgs;
  const allowedCommands = new Set(['get', 'describe', 'logs', 'top', 'config']);
  if (!allowedCommands.has(command)) {
    return { allowed: false, reason: `The kubectl command '${command}' is not allowed. Only read-only operations are permitted.` };
  }

  if (command === 'config') {
    const allowedConfigArgs = new Set(['current-context']);
    if (rest.length === 1 && allowedConfigArgs.has(rest[0])) {
      return { allowed: true, normalizedArgs };
    }
    return { allowed: false, reason: 'Only "kubectl config current-context" is allowed.' };
  }

  const allowedResources = new Set([
    'pods',
    'pod',
    'deployments',
    'deployment',
    'svc',
    'services',
    'service',
    'endpoints',
    'endpoint',
    'nodes',
    'node',
    'events',
    'event',
    'networkpolicy',
    'networkpolicies',
    'configmap',
    'configmaps',
    'namespace',
    'namespaces',
  ]);

  const resource = rest[0];
  if (!resource) {
    return { allowed: false, reason: 'The kubectl request must specify a supported resource.' };
  }

  if (!allowedResources.has(resource)) {
    return { allowed: false, reason: `The resource '${resource}' is not in the safe read-only allowlist.` };
  }

  return { allowed: true, normalizedArgs };
}

module.exports = {
  APPROVAL_REQUIRED_TOOLS,
  UNTRUSTED_TELEMETRY_TOOLS,
  createSecurityState,
  evaluateToolAccess,
  approvePendingApproval,
  denyPendingApproval,
  markTelemetry,
  wrapUntrustedTelemetry,
  validateKubectlArgs,
};
