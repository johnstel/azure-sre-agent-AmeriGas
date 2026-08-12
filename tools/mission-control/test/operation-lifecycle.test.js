const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createOperation,
  isTerminal,
  transitionToTerminal,
  finishOperation,
  cancelOperation,
  appendLog,
} = require('../operation-lifecycle');

function fakeSubscriber() {
  const writes = [];
  let ended = false;
  return {
    write: (chunk) => writes.push(chunk),
    end: () => { ended = true; },
    get writes() { return writes; },
    get ended() { return ended; },
  };
}

test('createOperation starts running with no terminal fields set', () => {
  const op = createOperation('deploy', 'Deploy to eastus2');
  assert.equal(op.status, 'running');
  assert.equal(op.exitCode, null);
  assert.equal(op.endedAt, null);
  assert.equal(isTerminal(op), false);
  assert.ok(op.id);
});

test('finishOperation transitions running -> completed/failed exactly once and notifies subscribers', () => {
  const op = createOperation('validate', 'Validate rg');
  const sub = fakeSubscriber();
  op.subscribers.add(sub);

  const applied = finishOperation(op, 0);

  assert.equal(applied, true);
  assert.equal(op.status, 'completed');
  assert.equal(op.exitCode, 0);
  assert.ok(op.endedAt);
  assert.equal(op.process, null);
  assert.equal(op.subscribers.size, 0, 'subscribers must be cleared after finalization');
  assert.equal(sub.writes.length, 2, 'a system log line plus a done event');
  assert.match(sub.writes[1], /event: done/);
  assert.match(sub.writes[1], /"status":"completed"/);
});

test('a non-zero exit code finalizes as failed', () => {
  const op = createOperation('deploy', 'Deploy');
  assert.equal(finishOperation(op, 1), true);
  assert.equal(op.status, 'failed');
  assert.equal(op.exitCode, 1);
});

test('cancelOperation transitions running -> cancelled and notifies subscribers exactly once', () => {
  const op = createOperation('deploy', 'Deploy');
  const sub = fakeSubscriber();
  op.subscribers.add(sub);

  const applied = cancelOperation(op);

  assert.equal(applied, true);
  assert.equal(op.status, 'cancelled');
  assert.equal(op.exitCode, null);
  assert.ok(op.endedAt);
  assert.equal(op.process, null);
  assert.equal(op.subscribers.size, 0);
  assert.equal(sub.writes.length, 1);
  assert.match(sub.writes[0], /"status":"cancelled"/);
});

test('REGRESSION: a child-close event arriving after cancellation must never overwrite the truthful cancelled outcome', () => {
  // Simulates: operator cancels (kills the child with SIGTERM), then the
  // killed child's 'close' event fires afterward (e.g. with a SIGTERM
  // exit code) and would previously call finishOperation() unconditionally.
  const op = createOperation('destroy', 'Destroy rg');
  op.process = { kill: () => {} };

  const cancelApplied = cancelOperation(op);
  assert.equal(cancelApplied, true);
  assert.equal(op.status, 'cancelled');
  const cancelledEndedAt = op.endedAt;

  // The late child 'close' event fires — this must be a truthful no-op.
  const finishApplied = finishOperation(op, 143); // e.g. 128 + SIGTERM(15)

  assert.equal(finishApplied, false, 'finishOperation must report it did not apply');
  assert.equal(op.status, 'cancelled', 'status must remain cancelled, never overwritten to failed');
  assert.equal(op.exitCode, null, 'exitCode must remain untouched from the cancellation, not the late exit code');
  assert.equal(op.endedAt, cancelledEndedAt, 'endedAt must not be updated by the late event');
});

test('REGRESSION: a child-error event arriving after cancellation must also never overwrite cancelled', () => {
  const op = createOperation('destroy', 'Destroy rg');
  cancelOperation(op);

  // child.on('error', ...) path also routes through finishOperation(op, 1)
  const applied = finishOperation(op, 1);

  assert.equal(applied, false);
  assert.equal(op.status, 'cancelled');
});

test('CANCEL RACE: a cancel request that loses the race to a process that already completed must never overwrite the real outcome', () => {
  // Simulates: the process legitimately completes (finishOperation runs
  // first), and only afterward does a concurrent DELETE/cancel request
  // get processed for the same operation.
  const op = createOperation('validate', 'Validate rg');
  const sub = fakeSubscriber();
  op.subscribers.add(sub);

  const finishApplied = finishOperation(op, 0);
  assert.equal(finishApplied, true);
  assert.equal(op.status, 'completed');
  const completedEndedAt = op.endedAt;

  const cancelApplied = cancelOperation(op);

  assert.equal(cancelApplied, false, 'cancelOperation must report it did not apply');
  assert.equal(op.status, 'completed', 'status must remain the real completed outcome, never overwritten to cancelled');
  assert.equal(op.exitCode, 0);
  assert.equal(op.endedAt, completedEndedAt);
});

test('CANCEL RACE: cancelling an already-failed operation is a truthful no-op', () => {
  const op = createOperation('deploy', 'Deploy');
  finishOperation(op, 1);
  assert.equal(op.status, 'failed');

  assert.equal(cancelOperation(op), false);
  assert.equal(op.status, 'failed');
  assert.equal(op.exitCode, 1);
});

test('duplicate finishOperation calls (e.g. both child "error" and "close" firing) are idempotent — only the first is applied', () => {
  const op = createOperation('deploy', 'Deploy');
  assert.equal(finishOperation(op, 1), true);
  const firstEndedAt = op.endedAt;

  // A second, differently-coded finish attempt must not change anything.
  assert.equal(finishOperation(op, 0), false);
  assert.equal(op.status, 'failed');
  assert.equal(op.exitCode, 1);
  assert.equal(op.endedAt, firstEndedAt);
});

test('duplicate cancelOperation calls are idempotent', () => {
  const op = createOperation('deploy', 'Deploy');
  assert.equal(cancelOperation(op), true);
  assert.equal(cancelOperation(op), false);
  assert.equal(op.status, 'cancelled');
});

test('transitionToTerminal on a null/undefined op is a safe no-op', () => {
  assert.equal(transitionToTerminal(null, 'cancelled'), false);
  assert.equal(transitionToTerminal(undefined, 'failed'), false);
});

test('appendLog pushes an entry and streams it to every current subscriber, but never to a subscriber added after the fact', () => {
  const op = createOperation('deploy', 'Deploy');
  const sub1 = fakeSubscriber();
  op.subscribers.add(sub1);
  appendLog(op, 'stdout', 'hello');
  const sub2 = fakeSubscriber();
  op.subscribers.add(sub2);
  appendLog(op, 'stdout', 'world');

  assert.equal(op.log.length, 2);
  assert.equal(sub1.writes.length, 2, 'sub1 was present for both log lines');
  assert.equal(sub2.writes.length, 1, 'sub2 only receives log lines appended after it subscribed');
});

test('isTerminal reflects status accurately for every known state', () => {
  const op = createOperation('deploy', 'Deploy');
  assert.equal(isTerminal(op), false);
  finishOperation(op, 0);
  assert.equal(isTerminal(op), true);
});
