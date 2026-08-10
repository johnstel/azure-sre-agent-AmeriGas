const crypto = require('crypto');

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

const APPROVAL_TTL_MS = 10 * 60 * 1000;

function createSecurityState() {
  return {
    pendingApproval: null,
    untrustedTelemetryActive: false,
  };
}

function createApprovalSignature(toolName, params = {}) {
  return JSON.stringify({ toolName, params: sortObject(params ?? {}) });
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortObject(value[key]);
        return acc;
      }, {});
  }
  return value;
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

function isNonEmptyValue(value) {
  return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined;
}

function evaluateToolAccess(state, toolName, params = {}, context = {}) {
  if (!APPROVAL_REQUIRED_TOOLS.has(toolName)) {
    markTelemetry(state, toolName);
    return { allowed: true };
  }

  const actionKey = createApprovalSignature(toolName, params);
  const sessionId = context.sessionId || null;
  const pendingApproval = state?.pendingApproval;

  if (pendingApproval && pendingApproval.expiresAt > Date.now()) {
    if (pendingApproval.status === 'approved') {
      if (pendingApproval.sessionId === sessionId && pendingApproval.actionKey === actionKey) {
        state.pendingApproval = null;
        return { allowed: true };
      }
      state.pendingApproval = null;
      return evaluateToolAccess(state, toolName, params, context);
    }

    if (pendingApproval.status === 'pending') {
      if (pendingApproval.sessionId === sessionId && pendingApproval.actionKey === actionKey) {
        return {
          allowed: false,
          approvalId: pendingApproval.id,
          actionKey: pendingApproval.actionKey,
          message: `${pendingApproval.reason}\nAsk the operator to approve this action with /api/approval/approve and the approval ID ${pendingApproval.id}.`,
        };
      }

      return {
        allowed: false,
        approvalId: pendingApproval.id,
        actionKey: pendingApproval.actionKey,
        message: `A pending approval exists for ${pendingApproval.toolName} in session ${pendingApproval.sessionId || 'unknown'}.`,
      };
    }
  }

  if (pendingApproval && pendingApproval.expiresAt <= Date.now()) {
    state.pendingApproval = null;
  }

  const approvalId = crypto.randomBytes(16).toString('hex');
  state.pendingApproval = {
    id: approvalId,
    toolName,
    params,
    actionKey,
    sessionId,
    paramsSignature: actionKey,
    approved: false,
    denied: false,
    status: 'pending',
    expiresAt: Date.now() + APPROVAL_TTL_MS,
    reason: `Explicit human approval is required before ${toolName} can run.`,
  };

  return {
    allowed: false,
    approvalId,
    actionKey,
    message: `${state.pendingApproval.reason}\nAsk the operator to approve this action with /api/approval/approve and the approval ID ${approvalId}.`,
  };
}

function approvePendingApproval(state, approvalId, context = {}) {
  const pendingApproval = state?.pendingApproval;
  if (!pendingApproval || pendingApproval.id !== approvalId || pendingApproval.status !== 'pending') {
    return { success: false, reason: 'No matching pending approval was found.' };
  }
  if (pendingApproval.expiresAt <= Date.now()) {
    state.pendingApproval = null;
    return { success: false, reason: 'The pending approval has expired.' };
  }
  if (!isNonEmptyValue(context.sessionId) || !isNonEmptyValue(context.actionKey)) {
    return { success: false, reason: 'Both sessionId and actionKey are required.' };
  }
  if (pendingApproval.sessionId !== context.sessionId) {
    return { success: false, reason: 'The approval request does not match the initiating session.' };
  }
  if (pendingApproval.actionKey !== context.actionKey) {
    return { success: false, reason: 'The approval request does not match the requested action.' };
  }

  pendingApproval.approved = true;
  pendingApproval.status = 'approved';
  return { success: true, approvalId, toolName: pendingApproval.toolName, sessionId: pendingApproval.sessionId };
}

function denyPendingApproval(state, approvalId, context = {}) {
  const pendingApproval = state?.pendingApproval;
  if (!pendingApproval || pendingApproval.id !== approvalId || pendingApproval.status !== 'pending') {
    return { success: false, reason: 'No matching pending approval was found.' };
  }
  if (pendingApproval.expiresAt <= Date.now()) {
    state.pendingApproval = null;
    return { success: false, reason: 'The pending approval has expired.' };
  }
  if (!isNonEmptyValue(context.sessionId) || !isNonEmptyValue(context.actionKey)) {
    return { success: false, reason: 'Both sessionId and actionKey are required.' };
  }
  if (pendingApproval.sessionId !== context.sessionId) {
    return { success: false, reason: 'The approval request does not match the initiating session.' };
  }
  if (pendingApproval.actionKey !== context.actionKey) {
    return { success: false, reason: 'The approval request does not match the requested action.' };
  }

  pendingApproval.denied = true;
  pendingApproval.status = 'denied';
  state.pendingApproval = null;
  return { success: true, approvalId, toolName: pendingApproval.toolName };
}

function tokenizeKubectlArgs(args) {
  if (typeof args !== 'string') return [];
  const tokens = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < args.length; i += 1) {
    const char = args[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function validateKubectlArgs(args) {
  const normalizedArgs = tokenizeKubectlArgs(args || '');
  if (normalizedArgs.length === 0) {
    return { allowed: false, reason: 'The kubectl request was empty.' };
  }

  const [command, ...rest] = normalizedArgs;
  const allowedCommands = new Set(['get', 'describe', 'logs', 'top', 'config']);
  if (!allowedCommands.has(command)) {
    return { allowed: false, reason: `The kubectl command '${command}' is not allowed. Only read-only operations are permitted.` };
  }

  if (command === 'config') {
    const allowedConfigArgs = ['current-context'];
    if (rest.length === 1 && allowedConfigArgs.includes(rest[0])) {
      return { allowed: true, normalizedArgs: ['config', 'current-context'] };
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

  const deniedFlags = rest.slice(1).filter((token) => token.startsWith('-'));
  if (deniedFlags.length > 0) {
    return { allowed: false, reason: 'Only the explicit read-only grammar is permitted; flags beyond the safe allowlist are rejected.' };
  }

  if (command === 'logs') {
    const [resourceName, ...extraTokens] = rest.slice(1);
    if (!resourceName) {
      return { allowed: false, reason: 'The logs command requires a pod name.' };
    }
    if (extraTokens.length > 0 && extraTokens.some((token) => token.startsWith('-'))) {
      return { allowed: false, reason: 'The logs command only allows a pod name and no extra flags.' };
    }
    return { allowed: true, normalizedArgs: [command, resourceName] };
  }

  if (command === 'describe') {
    const [resourceName, ...extraTokens] = rest.slice(1);
    if (!resourceName) {
      return { allowed: false, reason: 'The describe command requires a resource name.' };
    }
    if (extraTokens.length > 0) {
      return { allowed: false, reason: 'The describe command only accepts a single resource name.' };
    }
    return { allowed: true, normalizedArgs: [command, resource, resourceName] };
  }

  if (command === 'top') {
    const supportedTopResources = new Set(['pods', 'nodes']);
    if (!supportedTopResources.has(resource)) {
      return { allowed: false, reason: 'The top command only permits pods or nodes.' };
    }
    return { allowed: true, normalizedArgs: [command, resource] };
  }

  if (command === 'get') {
    const [resourceName, ...extraTokens] = rest.slice(1);
    if (resourceName && resourceName.startsWith('-')) {
      return { allowed: false, reason: 'Namespace and output flags are not permitted.' };
    }
    if (rest.length > 1 && extraTokens.length > 0) {
      return { allowed: false, reason: 'The get command only accepts the resource name and no extra flags.' };
    }
    return { allowed: true, normalizedArgs: [command, resource] };
  }

  return { allowed: true, normalizedArgs: [command, resource] };
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
