const { AsyncLocalStorage } = require('async_hooks');

const approvalContextStore = new AsyncLocalStorage();

function parseCookies(cookieHeader = '') {
  return cookieHeader.split(';').reduce((acc, part) => {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName) return acc;
    const name = rawName.trim();
    const value = rawValue.join('=').trim();
    acc[name] = value ? decodeURIComponent(value) : '';
    return acc;
  }, {});
}

function getOperatorAuthConfig() {
  return {
    bearerToken: process.env.MISSION_CONTROL_OPERATOR_TOKEN || '',
    username: process.env.MISSION_CONTROL_OPERATOR_USERNAME || '',
    password: process.env.MISSION_CONTROL_OPERATOR_PASSWORD || '',
    sessionToken: process.env.MISSION_CONTROL_OPERATOR_SESSION_TOKEN || '',
  };
}

function isSameOrigin(req) {
  const host = req.get('host');
  if (!host) return false;
  const expectedOrigin = `${req.protocol || 'http'}://${host}`;
  const origin = req.get('origin');
  const referer = req.get('referer');
  const candidates = [origin, referer].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (new URL(candidate).origin === expectedOrigin) return true;
    } catch {
      // Ignore malformed headers and continue.
    }
  }
  return false;
}

function authenticateOperator(req) {
  const { bearerToken, username, password, sessionToken } = getOperatorAuthConfig();
  const configured = Boolean(bearerToken || (username && password) || sessionToken);
  if (!configured) {
    return { ok: false, reason: 'Operator authentication is not configured.' };
  }

  const authorization = req.get('authorization') || '';
  const xToken = req.get('x-mission-control-operator-token') || '';
  const queryToken = req.query?.operator_token || '';
  const cookies = parseCookies(req.get('cookie') || '');

  if (bearerToken) {
    if (authorization.startsWith('Bearer ')) {
      const supplied = authorization.slice(7).trim();
      if (supplied === bearerToken) return { ok: true };
    }
    if (xToken === bearerToken || queryToken === bearerToken) return { ok: true };
  }

  if (username && password) {
    if (authorization.startsWith('Basic ')) {
      const encoded = authorization.slice(6).trim();
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const [suppliedUser, ...suppliedPasswordParts] = decoded.split(':');
      const suppliedPassword = suppliedPasswordParts.join(':');
      if (suppliedUser === username && suppliedPassword === password) return { ok: true };
    }
  }

  if (sessionToken && cookies.mission_control_operator_session === sessionToken) {
    return { ok: true };
  }

  return { ok: false, reason: 'Operator authentication required.' };
}

function createOperatorAuthMiddleware() {
  return (req, res, next) => {
    if (req.method === 'OPTIONS') return next();

    const auth = authenticateOperator(req);
    if (!auth.ok) {
      return res.status(401).json({ error: auth.reason });
    }

    if (!isSameOrigin(req)) {
      return res.status(403).json({ error: 'Same-origin CSRF protection rejected the request.' });
    }

    next();
  };
}

function withApprovalContext(context, fn) {
  return approvalContextStore.run(context, fn);
}

function getApprovalContext() {
  return approvalContextStore.getStore() || {};
}

module.exports = {
  createOperatorAuthMiddleware,
  authenticateOperator,
  getApprovalContext,
  withApprovalContext,
};
