const test = require('node:test');
const assert = require('node:assert/strict');
const { createApiClient, REMOTE_TOKEN_HEADER, REMOTE_TOKEN_STORAGE_KEY } = require('../public/api-client');

/** A minimal Headers-like polyfill matching enough of the browser API for these tests (Node has a global Headers since v18, but we build our own fake fetch anyway). */
function makeFakeStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
    _dump: () => ({ ...store }),
  };
}

function jsonResponse(status, body, ok = status >= 200 && status < 300) {
  const response = {
    status,
    ok,
    json: async () => body,
    clone() {
      // Return a fresh object with its own independent json() so both the
      // original and the clone can be read without "body already used" issues.
      return jsonResponse(status, body, ok);
    },
  };
  return response;
}

/** Builds a fake fetch that serves CSRF tokens from an incrementing counter and records every call. */
function makeFakeFetch({ csrfTokens = null, handlers = {} } = {}) {
  const calls = [];
  let csrfCounter = 0;
  const tokenQueue = csrfTokens ? [...csrfTokens] : null;

  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts, headers: opts && opts.headers ? new Headers(opts.headers) : new Headers() });
    if (url.startsWith('/api/csrf-token')) {
      const token = tokenQueue ? tokenQueue.shift() : `token-${++csrfCounter}`;
      return jsonResponse(200, { token });
    }
    const handler = handlers[url];
    if (handler) return handler(calls[calls.length - 1], calls.length);
    return jsonResponse(200, { ok: true });
  };

  return { fetchImpl, calls };
}

test('a GET request never fetches or attaches a CSRF token', async () => {
  const { fetchImpl, calls } = makeFakeFetch();
  const client = createApiClient({ fetch: fetchImpl, storage: null });

  await client.api('pods');

  const csrfCalls = calls.filter((c) => c.url.startsWith('/api/csrf-token'));
  assert.equal(csrfCalls.length, 0, 'a GET must never trigger a CSRF token fetch');
  assert.equal(calls[0].headers.has('X-CSRF-Token'), false);
});

test('sequential POST requests each use a unique, freshly-fetched CSRF token', async () => {
  const { fetchImpl, calls } = makeFakeFetch({ csrfTokens: ['tok-a', 'tok-b'] });
  const client = createApiClient({ fetch: fetchImpl, storage: null });

  await client.request('break/oom', { method: 'POST' });
  await client.request('break/oom', { method: 'POST' });

  const postCalls = calls.filter((c) => c.url === '/api/break/oom');
  assert.equal(postCalls.length, 2);
  const tokenA = postCalls[0].headers.get('X-CSRF-Token');
  const tokenB = postCalls[1].headers.get('X-CSRF-Token');
  assert.equal(tokenA, 'tok-a');
  assert.equal(tokenB, 'tok-b');
  assert.notEqual(tokenA, tokenB, 'each sequential mutation must use its own fresh token');
});

test('concurrent POST/DELETE requests each get distinct CSRF tokens, never sharing an in-flight fetch', async () => {
  const { fetchImpl, calls } = makeFakeFetch({ csrfTokens: ['tok-1', 'tok-2', 'tok-3'] });
  const client = createApiClient({ fetch: fetchImpl, storage: null });

  const [r1, r2, r3] = await Promise.all([
    client.request('fix/all', { method: 'POST' }),
    client.request('fix/network', { method: 'POST' }),
    client.request('operations/abc', { method: 'DELETE' }),
  ]);

  assert.ok(r1 && r2 && r3);
  const csrfCalls = calls.filter((c) => c.url.startsWith('/api/csrf-token'));
  assert.equal(csrfCalls.length, 3, 'each concurrent mutation must independently request its own token');

  const usedTokens = calls
    .filter((c) => c.url !== '/api/csrf-token')
    .map((c) => c.headers.get('X-CSRF-Token'));
  assert.equal(usedTokens.length, 3);
  assert.equal(new Set(usedTokens).size, 3, 'no two concurrent mutations may end up with the same CSRF token');
});

test('the remote token, once set, is attached on both GET and mutating requests', async () => {
  const { fetchImpl, calls } = makeFakeFetch();
  const client = createApiClient({ fetch: fetchImpl, storage: null });
  client.setRemoteToken('super-secret-remote-token');

  await client.api('pods');
  await client.request('fix/all', { method: 'POST' });

  for (const call of calls.filter((c) => !c.url.startsWith('/api/csrf-token'))) {
    assert.equal(call.headers.get(REMOTE_TOKEN_HEADER), 'super-secret-remote-token');
  }
});

test('the remote token is never included in the request URL/query string for any call', async () => {
  const { fetchImpl, calls } = makeFakeFetch();
  const client = createApiClient({ fetch: fetchImpl, storage: null });
  client.setRemoteToken('should-never-appear-in-a-url-xyz123');

  await client.api('pods');
  await client.request('fix/all', { method: 'POST' });
  await client.request('incidents/INC-1/export.json', {});

  for (const call of calls) {
    assert.equal(call.url.includes('should-never-appear-in-a-url-xyz123'), false, `token leaked into URL: ${call.url}`);
  }
});

test('the remote token is persisted to the supplied storage (sessionStorage-like) and read back on construction, never written elsewhere', async () => {
  const storage = makeFakeStorage();
  const { fetchImpl } = makeFakeFetch();
  const client = createApiClient({ fetch: fetchImpl, storage });

  client.setRemoteToken('persisted-token-abc');
  assert.equal(storage.getItem(REMOTE_TOKEN_STORAGE_KEY), 'persisted-token-abc');

  // A fresh client instance backed by the SAME storage must pick up the token.
  const client2 = createApiClient({ fetch: fetchImpl, storage });
  assert.equal(client2.getRemoteToken(), 'persisted-token-abc');
});

test('clearRemoteToken removes the token from memory and storage', async () => {
  const storage = makeFakeStorage({ [REMOTE_TOKEN_STORAGE_KEY]: 'old-token' });
  const { fetchImpl } = makeFakeFetch();
  const client = createApiClient({ fetch: fetchImpl, storage });
  assert.equal(client.getRemoteToken(), 'old-token');

  client.clearRemoteToken();
  assert.equal(client.getRemoteToken(), null);
  assert.equal(storage.getItem(REMOTE_TOKEN_STORAGE_KEY), null);
});

test('a storage that throws on access degrades to in-memory-only behavior without crashing', async () => {
  const throwingStorage = {
    getItem() { throw new Error('storage disabled'); },
    setItem() { throw new Error('storage disabled'); },
    removeItem() { throw new Error('storage disabled'); },
  };
  const { fetchImpl } = makeFakeFetch();
  const client = createApiClient({ fetch: fetchImpl, storage: throwingStorage });
  assert.equal(client.getRemoteToken(), null);
  assert.doesNotThrow(() => client.setRemoteToken('x'));
  assert.equal(client.getRemoteToken(), 'x', 'in-memory value must still work even when storage access throws');
});

test('a 401 invokes onAuthRequired exactly once for several concurrent requests, and retries all of them once a token is supplied', async () => {
  let firstAttemptCount = 0;
  const { fetchImpl, calls } = makeFakeFetch({
    handlers: {
      '/api/pods': (call) => {
        if (!call.headers.get(REMOTE_TOKEN_HEADER)) {
          firstAttemptCount += 1;
          return jsonResponse(401, { error: 'Authentication required for privileged operations' });
        }
        return jsonResponse(200, { items: [] });
      },
    },
  });

  let authPromptCalls = 0;
  const onAuthRequired = async () => {
    authPromptCalls += 1;
    return 'operator-supplied-token';
  };
  const client = createApiClient({ fetch: fetchImpl, storage: null, onAuthRequired });

  const results = await Promise.all([client.api('pods'), client.api('pods'), client.api('pods')]);

  assert.equal(authPromptCalls, 1, 'concurrent 401s must share a single auth prompt, not open one per request');
  assert.equal(firstAttemptCount, 3, 'each of the 3 original requests should have failed once before being retried');
  for (const r of results) assert.deepEqual(r, { items: [] });
  assert.equal(client.getRemoteToken(), 'operator-supplied-token');
});

test('a 401 that resolves with no token (operator cancelled) returns the original failure without retrying forever', async () => {
  const { fetchImpl, calls } = makeFakeFetch({
    handlers: {
      '/api/pods': () => jsonResponse(401, { error: 'Authentication required for privileged operations' }),
    },
  });
  const onAuthRequired = async () => null;
  const client = createApiClient({ fetch: fetchImpl, storage: null, onAuthRequired });

  const result = await client.api('pods');

  assert.equal(result.error, 'Authentication required for privileged operations');
  const podsCalls = calls.filter((c) => c.url === '/api/pods');
  assert.equal(podsCalls.length, 1, 'exactly one attempt — no retry loop when no token is supplied');
});

test('a persistent 401 (wrong token even after retrying) never loops more than once', async () => {
  const { fetchImpl, calls } = makeFakeFetch({
    handlers: {
      '/api/pods': () => jsonResponse(401, { error: 'Authentication required for privileged operations' }),
    },
  });
  let promptCount = 0;
  const onAuthRequired = async () => { promptCount += 1; return 'still-wrong-token'; };
  const client = createApiClient({ fetch: fetchImpl, storage: null, onAuthRequired });

  await client.api('pods');

  assert.equal(promptCount, 1, 'onAuthRequired must be invoked at most once per original request, capping total retries at one');
  assert.equal(calls.filter((c) => c.url === '/api/pods').length, 2, 'exactly one retry — original attempt plus one retry, never more');
});

test('an explicit CSRF rejection (403 "Invalid CSRF token") triggers exactly one retry with a freshly-fetched token', async () => {
  let attempt = 0;
  const { fetchImpl, calls } = makeFakeFetch({
    csrfTokens: ['stale-token', 'fresh-token'],
    handlers: {
      '/api/fix/all': () => {
        attempt += 1;
        if (attempt === 1) return jsonResponse(403, { error: 'Invalid CSRF token' });
        return jsonResponse(200, { success: true });
      },
    },
  });
  const client = createApiClient({ fetch: fetchImpl, storage: null });

  const response = await client.request('fix/all', { method: 'POST' });
  const body = await response.json();

  assert.equal(body.success, true);
  const fixCalls = calls.filter((c) => c.url === '/api/fix/all');
  assert.equal(fixCalls.length, 2, 'exactly one retry after the explicit CSRF rejection');
  assert.equal(fixCalls[0].headers.get('X-CSRF-Token'), 'stale-token');
  assert.equal(fixCalls[1].headers.get('X-CSRF-Token'), 'fresh-token');
  assert.notEqual(fixCalls[0].headers.get('X-CSRF-Token'), fixCalls[1].headers.get('X-CSRF-Token'));
});

test('a 403 that is NOT an explicit CSRF rejection is never retried', async () => {
  const { fetchImpl, calls } = makeFakeFetch({
    handlers: {
      '/api/deploy': () => jsonResponse(403, { error: 'Remote access is disabled by default. Configure MISSION_CONTROL_AUTH_TOKEN to enable it.' }),
    },
  });
  const client = createApiClient({ fetch: fetchImpl, storage: null });

  const response = await client.request('deploy', { method: 'POST' });
  const body = await response.json();

  assert.match(body.error, /Remote access is disabled/);
  assert.equal(calls.filter((c) => c.url === '/api/deploy').length, 1, 'a non-CSRF 403 must never trigger a blind retry');
});

test('a persistent CSRF rejection never loops more than once', async () => {
  const { fetchImpl, calls } = makeFakeFetch({
    handlers: {
      '/api/fix/all': () => jsonResponse(403, { error: 'Invalid CSRF token' }),
    },
  });
  const client = createApiClient({ fetch: fetchImpl, storage: null });

  const response = await client.request('fix/all', { method: 'POST' });
  assert.equal(response.status, 403);
  assert.equal(calls.filter((c) => c.url === '/api/fix/all').length, 2, 'exactly one retry, never an infinite loop');
});

test('api() returns parsed JSON while request() returns the raw response object', async () => {
  const { fetchImpl } = makeFakeFetch({
    handlers: { '/api/pods': () => jsonResponse(200, { items: ['a'] }) },
  });
  const client = createApiClient({ fetch: fetchImpl, storage: null });

  const parsed = await client.api('pods');
  assert.deepEqual(parsed, { items: ['a'] });

  const raw = await client.request('pods', {});
  assert.equal(typeof raw.json, 'function');
  assert.deepEqual(await raw.json(), { items: ['a'] });
});

test('buildRequestOptions sets Content-Type for a JSON body but not for FormData, and always includes a fresh CSRF token for mutations', async () => {
  const { fetchImpl } = makeFakeFetch({ csrfTokens: ['tok-x'] });
  const client = createApiClient({ fetch: fetchImpl, storage: null });

  const jsonOpts = await client.buildRequestOptions({ method: 'POST', body: JSON.stringify({ a: 1 }) });
  assert.equal(jsonOpts.headers.get('Content-Type'), 'application/json');
  assert.equal(jsonOpts.headers.get('X-CSRF-Token'), 'tok-x');

  const fakeFormData = { constructor: { name: 'FormData' } };
  Object.setPrototypeOf(fakeFormData, FormData.prototype);
  const formOpts = await client.buildRequestOptions({ method: 'POST', body: fakeFormData });
  assert.equal(formOpts.headers.has('Content-Type'), false);
});

test('a network-level fetch rejection propagates as a rejected promise (never swallowed, never retried in a loop)', async () => {
  let callCount = 0;
  const failingFetch = async () => { callCount += 1; throw new Error('network down'); };
  const client = createApiClient({ fetch: failingFetch, storage: null });

  await assert.rejects(() => client.api('pods'), /network down/);
  assert.equal(callCount, 1, 'a network failure must propagate to the caller, not be retried automatically');
});

test('a network-level fetch rejection on a mutating request also propagates cleanly, without attempting a CSRF/auth retry (there is no response to inspect)', async () => {
  let podsCallCount = 0;
  let csrfCallCount = 0;
  const failingFetch = async (url) => {
    if (url.startsWith('/api/csrf-token')) { csrfCallCount += 1; return jsonResponse(200, { token: 'tok' }); }
    podsCallCount += 1;
    throw new Error('connection reset');
  };
  const client = createApiClient({ fetch: failingFetch, storage: null });

  await assert.rejects(() => client.request('fix/all', { method: 'POST' }), /connection reset/);
  assert.equal(podsCallCount, 1, 'a rejected mutating fetch must not be retried');
  assert.equal(csrfCallCount, 1, 'exactly one CSRF token should have been fetched for the single attempt');
});

test('the api-client module source never references localStorage or console logging of tokens', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(__dirname, '../public/api-client.js'), 'utf8');
  assert.doesNotMatch(source, /\blocalStorage\s*\.\s*(get|set|remove)Item/, 'the remote token must never be persisted via a localStorage call');
  assert.doesNotMatch(source, /window\.localStorage/, 'the module must never reference window.localStorage');
  assert.doesNotMatch(source, /console\.(log|warn|error|info|debug)/, 'the module must never log request contents (which could include the token header)');
});
