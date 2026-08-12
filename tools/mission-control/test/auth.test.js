const test = require('node:test');
const assert = require('node:assert/strict');
const { authenticateOperator, createOperatorAuthMiddleware } = require('../auth');

/**
 * Builds a minimal fake Express-like request object. `headers` is a
 * case-insensitive map consumed by req.get(); `query` mirrors Express's
 * parsed query object (so a real query-string token, if ever supplied
 * again by a client, would appear here exactly the way Express exposes
 * it) — used to prove authenticateOperator never reads it.
 */
function fakeReq({ headers = {}, query = {}, method = 'GET', protocol = 'http' } = {}) {
  const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method,
    protocol,
    query,
    get(name) {
      return lowerHeaders[String(name).toLowerCase()];
    },
  };
}

function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('REGRESSION: a bearer token supplied only as a query-string parameter (?operator_token=...) never authenticates, even though it exactly matches the configured token', () => {
  withEnv({ MISSION_CONTROL_OPERATOR_TOKEN: 'secret-token', MISSION_CONTROL_OPERATOR_USERNAME: '', MISSION_CONTROL_OPERATOR_PASSWORD: '', MISSION_CONTROL_OPERATOR_SESSION_TOKEN: '' }, () => {
    const req = fakeReq({ query: { operator_token: 'secret-token' } });
    const result = authenticateOperator(req);
    assert.equal(result.ok, false, 'a query-string token must never authenticate, regardless of correctness');
  });
});

test('REGRESSION: no query-parameter name authenticates a request — token, access_token, and auth_token are all rejected', () => {
  withEnv({ MISSION_CONTROL_OPERATOR_TOKEN: 'secret-token', MISSION_CONTROL_OPERATOR_USERNAME: '', MISSION_CONTROL_OPERATOR_PASSWORD: '', MISSION_CONTROL_OPERATOR_SESSION_TOKEN: '' }, () => {
    for (const paramName of ['operator_token', 'token', 'access_token', 'auth_token']) {
      const req = fakeReq({ query: { [paramName]: 'secret-token' } });
      assert.equal(authenticateOperator(req).ok, false, `?${paramName}=... must never authenticate`);
    }
  });
});

test('a correct Authorization: Bearer header still authenticates (query removal must not regress the intended header mechanism)', () => {
  withEnv({ MISSION_CONTROL_OPERATOR_TOKEN: 'secret-token', MISSION_CONTROL_OPERATOR_USERNAME: '', MISSION_CONTROL_OPERATOR_PASSWORD: '', MISSION_CONTROL_OPERATOR_SESSION_TOKEN: '' }, () => {
    const req = fakeReq({ headers: { Authorization: 'Bearer secret-token' } });
    assert.deepEqual(authenticateOperator(req), { ok: true });
  });
});

test('a correct X-Mission-Control-Operator-Token header still authenticates', () => {
  withEnv({ MISSION_CONTROL_OPERATOR_TOKEN: 'secret-token', MISSION_CONTROL_OPERATOR_USERNAME: '', MISSION_CONTROL_OPERATOR_PASSWORD: '', MISSION_CONTROL_OPERATOR_SESSION_TOKEN: '' }, () => {
    const req = fakeReq({ headers: { 'X-Mission-Control-Operator-Token': 'secret-token' } });
    assert.deepEqual(authenticateOperator(req), { ok: true });
  });
});

test('an incorrect bearer token via header is rejected, and a query-string token cannot compensate for it', () => {
  withEnv({ MISSION_CONTROL_OPERATOR_TOKEN: 'secret-token', MISSION_CONTROL_OPERATOR_USERNAME: '', MISSION_CONTROL_OPERATOR_PASSWORD: '', MISSION_CONTROL_OPERATOR_SESSION_TOKEN: '' }, () => {
    const req = fakeReq({ headers: { Authorization: 'Bearer wrong-token' }, query: { operator_token: 'secret-token' } });
    assert.equal(authenticateOperator(req).ok, false);
  });
});

test('correct Basic auth (username/password) still authenticates', () => {
  withEnv({ MISSION_CONTROL_OPERATOR_TOKEN: '', MISSION_CONTROL_OPERATOR_USERNAME: 'alice', MISSION_CONTROL_OPERATOR_PASSWORD: 'p@ss', MISSION_CONTROL_OPERATOR_SESSION_TOKEN: '' }, () => {
    const encoded = Buffer.from('alice:p@ss').toString('base64');
    const req = fakeReq({ headers: { Authorization: `Basic ${encoded}` } });
    assert.deepEqual(authenticateOperator(req), { ok: true });
  });
});

test('a session token supplied as a query parameter never authenticates — only the configured session cookie does', () => {
  withEnv({ MISSION_CONTROL_OPERATOR_TOKEN: '', MISSION_CONTROL_OPERATOR_USERNAME: '', MISSION_CONTROL_OPERATOR_PASSWORD: '', MISSION_CONTROL_OPERATOR_SESSION_TOKEN: 'session-secret' }, () => {
    const reqWithQueryToken = fakeReq({ query: { operator_token: 'session-secret', session_token: 'session-secret' } });
    assert.equal(authenticateOperator(reqWithQueryToken).ok, false);

    const reqWithCookie = fakeReq({ headers: { Cookie: 'mission_control_operator_session=session-secret' } });
    assert.deepEqual(authenticateOperator(reqWithCookie), { ok: true }, 'the intended cookie mechanism must still work');
  });
});

test('when no operator auth is configured at all, every request is rejected regardless of any header/query supplied', () => {
  withEnv({ MISSION_CONTROL_OPERATOR_TOKEN: '', MISSION_CONTROL_OPERATOR_USERNAME: '', MISSION_CONTROL_OPERATOR_PASSWORD: '', MISSION_CONTROL_OPERATOR_SESSION_TOKEN: '' }, () => {
    const req = fakeReq({ headers: { Authorization: 'Bearer anything' }, query: { operator_token: 'anything' } });
    const result = authenticateOperator(req);
    assert.equal(result.ok, false);
    assert.match(result.reason, /not configured/i);
  });
});

test('the auth.js module source no longer references req.query or any query-string token parameter name', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.resolve(__dirname, '../auth.js'), 'utf8');
  assert.doesNotMatch(src, /req\.query/, 'auth.js must never read req.query for authentication purposes');
  assert.doesNotMatch(src, /queryToken/i);
});

test('createOperatorAuthMiddleware rejects a request authenticated only via a query-string token with 401, and same-origin/CSRF checks are not reached', () => {
  withEnv({ MISSION_CONTROL_OPERATOR_TOKEN: 'secret-token', MISSION_CONTROL_OPERATOR_USERNAME: '', MISSION_CONTROL_OPERATOR_PASSWORD: '', MISSION_CONTROL_OPERATOR_SESSION_TOKEN: '' }, () => {
    const middleware = createOperatorAuthMiddleware();
    const req = fakeReq({ query: { operator_token: 'secret-token' } });
    let statusCode = null;
    let body = null;
    let nextCalled = false;
    const res = {
      status(code) { statusCode = code; return this; },
      json(payload) { body = payload; return this; },
    };
    middleware(req, res, () => { nextCalled = true; });

    assert.equal(statusCode, 401);
    assert.match(body.error, /required/i);
    assert.equal(nextCalled, false, 'next() must never be called for an unauthenticated request');
  });
});

test('createOperatorAuthMiddleware allows a correctly header-authenticated, same-origin request through to next()', () => {
  withEnv({ MISSION_CONTROL_OPERATOR_TOKEN: 'secret-token', MISSION_CONTROL_OPERATOR_USERNAME: '', MISSION_CONTROL_OPERATOR_PASSWORD: '', MISSION_CONTROL_OPERATOR_SESSION_TOKEN: '' }, () => {
    const middleware = createOperatorAuthMiddleware();
    const req = fakeReq({
      headers: {
        Authorization: 'Bearer secret-token',
        Host: 'mission-control.example',
        Origin: 'http://mission-control.example',
      },
    });
    let statusCode = null;
    let nextCalled = false;
    const res = { status(code) { statusCode = code; return this; }, json() { return this; } };
    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(statusCode, null);
  });
});
