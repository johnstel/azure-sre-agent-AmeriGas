const crypto = require('crypto');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1']);
const KUBERNETES_NAME_PATTERN = /^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$/;
const RESOURCE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,61}$/;
const WORKLOAD_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{2,9})$/;

function isLoopbackHostname(hostname) {
  if (!hostname) return false;
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function isLoopbackAddress(address) {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/, '').toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function isLocalRequest(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    const first = String(forwardedFor).split(',')[0].trim();
    if (isLoopbackAddress(first)) return true;
  }

  const remoteAddress = req.socket?.remoteAddress || req.ip || '';
  if (isLoopbackAddress(remoteAddress)) return true;

  const hostname = req.hostname || req.headers.host || '';
  return isLoopbackHostname(hostname.split(':')[0]);
}

function getAllowedOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return null;

  try {
    const parsed = new URL(origin);
    const host = req.get('host') || '';
    const isSameHost = parsed.hostname === (req.hostname || '') || parsed.hostname === host.split(':')[0] || isLoopbackHostname(parsed.hostname);
    return isSameHost ? origin : null;
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function validateKubernetesName(value, label) {
  if (typeof value !== 'string' || !KUBERNETES_NAME_PATTERN.test(value)) {
    throw new Error(`${label} must be a valid Kubernetes resource name`);
  }
  return value;
}

function validateResourceName(value, label) {
  if (typeof value !== 'string' || !RESOURCE_NAME_PATTERN.test(value)) {
    throw new Error(`${label} must contain only letters, numbers, dots, underscores, and dashes`);
  }
  return value;
}

function validateWorkloadName(value, label) {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }

  const normalized = value.trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{2,9})$/.test(normalized)) {
    throw new Error(`${label} must be 3-10 lowercase letters, numbers, or hyphens`);
  }

  return normalized;
}

function parseToolAllowlist(value) {
  return new Set(String(value || '').split(',').map(item => item.trim()).filter(Boolean));
}

function shouldAllowPrivilegedTool(toolName, env = process.env) {
  const allowlist = parseToolAllowlist(env.MISSION_CONTROL_PRIVILEGED_TOOL_ALLOWLIST);
  if (allowlist.has(toolName)) {
    return { allowed: true, reason: 'tool allowlisted' };
  }

  return {
    allowed: false,
    reason: `Tool '${toolName}' requires explicit allowlisting. Set MISSION_CONTROL_PRIVILEGED_TOOL_ALLOWLIST to enable it.`,
  };
}

function createCsrfTokenStore() {
  const tokens = new Set();
  return {
    issue() {
      const token = crypto.randomBytes(16).toString('hex');
      tokens.add(token);
      return token;
    },
    validate(token) {
      if (!token) return false;
      return tokens.delete(token);
    },
  };
}

function validateCsrf(req, tokenStore, options = {}) {
  if (options.isLocal !== false && options.isLocal) return true;
  const token = req.get('x-csrf-token') || req.headers['x-csrf-token'];
  return tokenStore.validate(token);
}

module.exports = {
  isLocalRequest,
  getAllowedOrigin,
  escapeHtml,
  validateKubernetesName,
  validateResourceName,
  validateWorkloadName,
  parseToolAllowlist,
  shouldAllowPrivilegedTool,
  createCsrfTokenStore,
  validateCsrf,
};
