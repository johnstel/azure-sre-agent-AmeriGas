const test = require('node:test');
const assert = require('node:assert/strict');
const { interpretCancelOperationResponse } = require('../public/cancel-response');

test('CANCEL WON: cancelled:true reports a genuine success toast and never needs to sync terminal UI (the live stream/poller already reflects it)', () => {
  const result = interpretCancelOperationResponse({
    ok: true,
    status: 200,
    data: { message: 'Cancelled', cancelled: true, status: 'cancelled', exitCode: null },
  });
  assert.equal(result.toastMessage, 'Operation cancelled');
  assert.equal(result.toastType, 'success');
  assert.equal(result.terminalInfo, null);
});

test('ALREADY-FINISHED RACE (completed): cancellation lost the race — reports a truthful informational message, never a fabricated success, and provides terminalInfo so the UI can sync immediately', () => {
  const result = interpretCancelOperationResponse({
    ok: true,
    status: 200,
    data: { message: 'Already finished', cancelled: false, status: 'completed', exitCode: 0 },
  });
  assert.equal(result.toastType, 'info');
  assert.match(result.toastMessage, /already completed/);
  assert.doesNotMatch(result.toastMessage, /^Operation cancelled$/);
  assert.deepEqual(result.terminalInfo, { status: 'completed', exitCode: 0 });
});

test('ALREADY-FINISHED RACE (failed): reports the true failed status truthfully, never success', () => {
  const result = interpretCancelOperationResponse({
    ok: true,
    status: 200,
    data: { message: 'Already finished', cancelled: false, status: 'failed', exitCode: 1 },
  });
  assert.equal(result.toastType, 'info');
  assert.match(result.toastMessage, /already failed/);
  assert.deepEqual(result.terminalInfo, { status: 'failed', exitCode: 1 });
});

test('ALREADY-FINISHED RACE (cancelled by someone/something else, e.g. a concurrent request winning first): cancelled:false with status "cancelled" must not be reported as this request\'s success', () => {
  const result = interpretCancelOperationResponse({
    ok: true,
    status: 200,
    data: { message: 'Already finished', cancelled: false, status: 'cancelled', exitCode: null },
  });
  assert.equal(result.toastType, 'info', 'this specific request did not win the race, so it must never get the success toast even though the operation IS cancelled');
  assert.notEqual(result.toastMessage, 'Operation cancelled');
  assert.deepEqual(result.terminalInfo, { status: 'cancelled', exitCode: null });
});

test('a response with no status field at all (e.g. an older/minimal server) falls back to a generic truthful "already finished" message and does not attempt to sync a terminal state it cannot describe', () => {
  const result = interpretCancelOperationResponse({
    ok: true,
    status: 200,
    data: { message: 'Already finished', cancelled: false },
  });
  assert.equal(result.toastType, 'info');
  assert.equal(result.toastMessage, 'Cancel had no effect — operation already finished');
  assert.equal(result.terminalInfo, null);
});

test('a non-ok HTTP response reports a truthful error using the body\'s error field, never a success or info toast', () => {
  const result = interpretCancelOperationResponse({
    ok: false,
    status: 404,
    data: { error: 'Operation not found' },
  });
  assert.equal(result.toastType, 'error');
  assert.equal(result.toastMessage, 'Operation not found');
  assert.equal(result.terminalInfo, null);
});

test('a non-ok HTTP response with no parsed body falls back to a generic status-based error message', () => {
  const result = interpretCancelOperationResponse({ ok: false, status: 500, data: null });
  assert.equal(result.toastType, 'error');
  assert.match(result.toastMessage, /500/);
});

test('never fabricates a "cancelled" success for any ok:true response unless data.cancelled is exactly true', () => {
  for (const data of [
    { cancelled: false, status: 'completed' },
    { cancelled: undefined, status: 'failed' },
    { cancelled: 'true', status: 'completed' }, // a truthy-but-not-boolean value must not count
    {},
    null,
  ]) {
    const result = interpretCancelOperationResponse({ ok: true, status: 200, data });
    assert.notEqual(result.toastMessage, 'Operation cancelled', `data=${JSON.stringify(data)} must never produce the success toast`);
    assert.notEqual(result.toastType, 'success');
  }
});

test('terminalInfo is never produced for a "running" status even if somehow reported alongside cancelled:false (defensive — a running op is not a terminal state to sync to)', () => {
  const result = interpretCancelOperationResponse({
    ok: true,
    status: 200,
    data: { cancelled: false, status: 'running', exitCode: null },
  });
  assert.equal(result.terminalInfo, null);
});

test('the module never references a remote/CSRF token — this is a pure decision function, authentication is entirely the caller\'s responsibility', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.resolve(__dirname, '../public/cancel-response.js'), 'utf8');
  assert.doesNotMatch(src, /token|csrf/i);
});
