const test = require('node:test');
const assert = require('node:assert/strict');
const { redactText, redactDeep } = require('../redact');

test('redactText strips Bearer tokens', () => {
  const out = redactText('calling API with Authorization: Bearer sk-abc123def456ghij');
  assert.doesNotMatch(out, /sk-abc123def456ghij/);
  assert.match(out, /Bearer \[REDACTED\]/);
});

test('redactText strips key=value style connection string secrets', () => {
  const out = redactText('conn: AccountKey=SGVsbG9Xb3JsZEZvb0Jhcg==;Endpoint=sb://x');
  assert.doesNotMatch(out, /SGVsbG9Xb3JsZEZvb0Jhcg==/);
  assert.match(out, /AccountKey=\[REDACTED\]/);
});

test('redactText strips JWTs', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const out = redactText(`token was ${jwt} in the response`);
  assert.doesNotMatch(out, /eyJhbGciOiJIUzI1NiJ9/);
  assert.match(out, /\[REDACTED-JWT\]/);
});

test('redactText strips userinfo embedded in URLs', () => {
  const out = redactText('fetching https://admin:hunter2@example.com/api');
  assert.doesNotMatch(out, /hunter2/);
  assert.match(out, /https:\/\/\[REDACTED\]@example\.com/);
});

test('redactText leaves ordinary operational text untouched', () => {
  const text = 'pod tank-monitor-67548b8dd7-2rw5x restarted 3 times, status CrashLoopBackOff';
  assert.equal(redactText(text), text);
});

test('redactDeep recurses through nested objects and arrays without mutating non-string values', () => {
  const input = {
    toolName: 'get_pod_logs',
    count: 3,
    nested: { header: 'Authorization: Bearer sk-verysecrettoken12345', ok: true },
    list: ['plain text', 'token: apikeyvalue1234567890'],
  };
  const out = redactDeep(input);
  assert.equal(out.count, 3);
  assert.equal(out.nested.ok, true);
  assert.doesNotMatch(out.nested.header, /sk-verysecrettoken12345/);
  assert.doesNotMatch(out.list[1], /apikeyvalue1234567890/);
  assert.equal(out.list[0], 'plain text');
});

test('redactDeep handles circular references without throwing', () => {
  const obj = { name: 'incident' };
  obj.self = obj;
  const out = redactDeep(obj);
  assert.equal(out.name, 'incident');
  assert.equal(out.self, '[circular]');
});

test('redactText and redactDeep pass through non-string primitives unchanged', () => {
  assert.equal(redactText(42), 42);
  assert.equal(redactText(null), null);
  assert.equal(redactDeep(42), 42);
  assert.equal(redactDeep(null), null);
  assert.equal(redactDeep(undefined), undefined);
});
