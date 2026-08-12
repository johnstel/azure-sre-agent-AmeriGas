const crypto = require('crypto');

const KUBERNETES_NAME_PATTERN = /^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$/;
const RESOURCE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,61}$/;
const WORKLOAD_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{2,9})$/;

function isIpv4Loopback(address) {
  if (typeof address !== 'string') return false;
  const normalized = address.trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) return false;
  const octets = normalized.split('.').map((part) => Number(part));
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === 127 && octets[1] === 0 && octets[2] === 0 && octets[3] === 1;
}

function normalizeLoopbackAddress(address) {
  if (typeof address !== 'string') return null;

  const trimmed = address.trim();
  if (!trimmed) return null;

  const bracketless = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  const withoutZone = bracketless.split('%')[0];

  if (withoutZone.startsWith('::ffff:')) {
    const ipv4 = withoutZone.slice(7);
    return isIpv4Loopback(ipv4) ? '127.0.0.1' : null;
  }

  if (withoutZone === '::1' || withoutZone === '0:0:0:0:0:0:0:1') return '::1';
  if (isIpv4Loopback(withoutZone)) return withoutZone;
  return null;
}

function isLoopbackAddress(address) {
  return Boolean(normalizeLoopbackAddress(address));
}

function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string') return false;
  const normalized = hostname.toLowerCase().trim();
  if (!normalized) return false;
  if (normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  return normalized === '127.0.0.1' || normalized.startsWith('127.');
}

function isLocalRequest(req) {
  const remoteAddress = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  return isLoopbackAddress(remoteAddress);
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
