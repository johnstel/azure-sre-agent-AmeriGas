const test = require('node:test');
const assert = require('node:assert/strict');
const { downloadIncidentExport } = require('../public/incident-export');

/** A minimal fake fetch-like Response for testing. */
function fakeResponse({ ok = true, status = 200, blobValue = 'blob-content', headers = {}, jsonBody = null } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const response = {
    ok,
    status,
    blob: async () => blobValue,
    headers: { get: (name) => headerMap.get(String(name).toLowerCase()) ?? null },
    clone() { return response; },
    json: async () => { if (jsonBody === null) throw new Error('not JSON'); return jsonBody; },
  };
  return response;
}

/** A minimal fake DOM (document + anchor element) for testing. */
function fakeDocument() {
  const created = [];
  const body = {
    appendChild: (el) => { created.push({ event: 'appendChild', el }); },
  };
  return {
    body,
    created,
    createElement: (tag) => {
      assert.equal(tag, 'a');
      const anchor = {
        tag,
        href: null,
        download: null,
        clicked: false,
        removed: false,
        click() { anchor.clicked = true; },
        remove() { anchor.removed = true; },
      };
      created.push({ event: 'createElement', anchor });
      return anchor;
    },
  };
}

/** A minimal fake URL (createObjectURL/revokeObjectURL) for testing. */
function fakeUrlImpl() {
  const created = [];
  const revoked = [];
  let counter = 0;
  return {
    created,
    revoked,
    createObjectURL: (blob) => { const url = `blob:fake-${counter++}`; created.push({ url, blob }); return url; },
    revokeObjectURL: (url) => { revoked.push(url); },
  };
}

function immediateSetTimeout(fn) { fn(); return 0; }

test('downloads the export via the injected authenticated request() — never a raw fetch/window.open/query-string token — and requests the exact correlationId/format path', async () => {
  const calls = [];
  const request = async (path) => { calls.push(path); return fakeResponse(); };
  const documentImpl = fakeDocument();
  const urlImpl = fakeUrlImpl();

  const result = await downloadIncidentExport({
    request, correlationId: 'INC-abc123', format: 'md', documentImpl, urlImpl, setTimeoutFn: immediateSetTimeout,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['incidents/INC-abc123/export.md']);
  for (const call of calls) {
    assert.doesNotMatch(call, /token/i, 'the export path must never contain a token');
  }
});

test('correlation ids with special characters are safely URL-encoded in the request path', async () => {
  const calls = [];
  const request = async (path) => { calls.push(path); return fakeResponse(); };
  await downloadIncidentExport({
    request, correlationId: 'INC/../weird id?', format: 'json',
    documentImpl: fakeDocument(), urlImpl: fakeUrlImpl(), setTimeoutFn: immediateSetTimeout,
  });
  assert.equal(calls[0], 'incidents/' + encodeURIComponent('INC/../weird id?') + '/export.json');
});

test('on success, creates an object URL from the response Blob, triggers a download via a temporary anchor, removes the anchor, and revokes the object URL afterward', async () => {
  const request = async () => fakeResponse({ blobValue: 'the-blob', headers: { 'Content-Disposition': 'attachment; filename="INC-1.md"' } });
  const documentImpl = fakeDocument();
  const urlImpl = fakeUrlImpl();

  const result = await downloadIncidentExport({
    request, correlationId: 'INC-1', format: 'md', documentImpl, urlImpl, setTimeoutFn: immediateSetTimeout,
  });

  assert.equal(result.ok, true);
  assert.equal(result.filename, 'INC-1.md');
  assert.equal(urlImpl.created.length, 1);
  assert.equal(urlImpl.created[0].blob, 'the-blob');

  const anchorEntry = documentImpl.created.find((e) => e.event === 'createElement');
  assert.ok(anchorEntry, 'an anchor element must be created');
  assert.equal(anchorEntry.anchor.download, 'INC-1.md');
  assert.equal(anchorEntry.anchor.href, urlImpl.created[0].url);
  assert.equal(anchorEntry.anchor.clicked, true, 'the anchor must be clicked to trigger the download');
  assert.equal(anchorEntry.anchor.removed, true, 'the anchor must be removed from the DOM after triggering the download');

  assert.deepEqual(urlImpl.revoked, [urlImpl.created[0].url], 'the object URL must be revoked exactly once, after the download was triggered');
});

test('falls back to "<correlationId>.<format>" as the filename when the server omits a Content-Disposition header', async () => {
  const request = async () => fakeResponse({ headers: {} });
  const result = await downloadIncidentExport({
    request, correlationId: 'INC-2', format: 'json',
    documentImpl: fakeDocument(), urlImpl: fakeUrlImpl(), setTimeoutFn: immediateSetTimeout,
  });
  assert.equal(result.filename, 'INC-2.json');
});

test('a non-ok HTTP response reports a truthful error via onError and never attempts a download (no object URL created, no anchor clicked)', async () => {
  const request = async () => fakeResponse({ ok: false, status: 404, jsonBody: { error: 'Incident not found' } });
  const documentImpl = fakeDocument();
  const urlImpl = fakeUrlImpl();
  const errors = [];

  const result = await downloadIncidentExport({
    request, correlationId: 'INC-missing', format: 'md', documentImpl, urlImpl,
    onError: (msg) => errors.push(msg), setTimeoutFn: immediateSetTimeout,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(errors, ['Incident not found']);
  assert.equal(urlImpl.created.length, 0, 'no object URL may be created for a failed export');
  assert.equal(documentImpl.created.length, 0, 'no anchor may be created/clicked for a failed export');
});

test('a non-ok HTTP response with a non-JSON body reports a generic but truthful status-based error, never a fabricated success', async () => {
  const request = async () => fakeResponse({ ok: false, status: 500 });
  const errors = [];
  const result = await downloadIncidentExport({
    request, correlationId: 'INC-3', format: 'md',
    documentImpl: fakeDocument(), urlImpl: fakeUrlImpl(),
    onError: (msg) => errors.push(msg), setTimeoutFn: immediateSetTimeout,
  });
  assert.equal(result.ok, false);
  assert.match(errors[0], /500/);
});

test('a network-level rejection (request() throws) is caught and reported via onError, never left as an unhandled rejection, and never attempts a download', async () => {
  const request = async () => { throw new Error('network down'); };
  const documentImpl = fakeDocument();
  const urlImpl = fakeUrlImpl();
  const errors = [];

  const result = await downloadIncidentExport({
    request, correlationId: 'INC-4', format: 'json', documentImpl, urlImpl,
    onError: (msg) => errors.push(msg), setTimeoutFn: immediateSetTimeout,
  });

  assert.equal(result.ok, false);
  assert.match(errors[0], /network down/);
  assert.equal(urlImpl.created.length, 0);
});

test('a missing correlationId is a safe no-op — no request is made, no error is raised', async () => {
  let called = false;
  const request = async () => { called = true; return fakeResponse(); };
  const result = await downloadIncidentExport({ request, correlationId: null, format: 'md' });
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test('downloadIncidentExport requires a request(path) function', async () => {
  await assert.rejects(() => downloadIncidentExport({ correlationId: 'INC-5', format: 'md' }), /requires a request/);
});

test('the object URL is only revoked once, via the injected setTimeout delay — never revoked synchronously before the anchor click, and never revoked more than once', async () => {
  const request = async () => fakeResponse();
  const urlImpl = fakeUrlImpl();
  let revokedBeforeTimeout = false;
  const deferredSetTimeout = (fn, delay) => {
    assert.equal(urlImpl.revoked.length, 0, 'revoke must not have happened yet at the moment the timeout is scheduled');
    revokedBeforeTimeout = urlImpl.revoked.length > 0;
    fn(); // simulate the timer firing
    return 0;
  };

  await downloadIncidentExport({
    request, correlationId: 'INC-6', format: 'md',
    documentImpl: fakeDocument(), urlImpl, setTimeoutFn: deferredSetTimeout,
  });

  assert.equal(revokedBeforeTimeout, false);
  assert.equal(urlImpl.revoked.length, 1);
});

test('never references a remote/CSRF token value anywhere in the module source — the injected request() function is solely responsible for authentication', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.resolve(__dirname, '../public/incident-export.js'), 'utf8');
  assert.doesNotMatch(src, /getRemoteToken|remoteToken|csrf/i, 'the module must never handle the token itself — that is exclusively apiClient\'s job');
  assert.doesNotMatch(src, /[?&]token=/i, 'no query-string token parameter anywhere');
});

test('the module never actually invokes window.open() as a function call (its doc comment only mentions the name to explain why it is avoided)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.resolve(__dirname, '../public/incident-export.js'), 'utf8');
  assert.doesNotMatch(src, /[^`.\w]window\.open\(/, 'window.open must never actually be called — only mentioned in documentation explaining why it is unsuitable');
});
