const crypto = require('crypto');

/**
 * Operation lifecycle state machine for long-running Mission Control
 * operations (deploy/destroy/validate), extracted so the terminal-state
 * guard can be unit tested without spinning up the real Express
 * app/CopilotClient (server.js's startup IIFE has real side effects and
 * is intentionally never required in tests).
 *
 * Terminal status is sticky: exactly one legitimate transition out of
 * 'running' is ever allowed, and every later attempt is a guaranteed
 * no-op that leaves the operation's status/exitCode/endedAt/log
 * completely untouched. This is what prevents a genuinely truthful
 * 'cancelled' outcome from being silently overwritten by a 'failed' when
 * the SIGTERM'd child process's 'close' event arrives afterward — and,
 * symmetrically, prevents a cancel request that loses a race against a
 * process that already completed/failed from clobbering that real
 * outcome.
 *
 * A subtler race: Node's child_process emits 'exit' as soon as the
 * underlying OS process has actually terminated, but 'close' (the event
 * finishOperation() is driven from, so that stdout/stderr are fully
 * flushed into the log first) can fire a tick or more later. In that
 * narrow window the process has truly already exited, but op.status is
 * still 'running' — a cancel request arriving in exactly that window
 * must not be allowed to win and record 'cancelled', because the real
 * outcome (completed/failed) is already determined and about to be
 * recorded once 'close' fires. markChildExited(op) records that the
 * process has genuinely exited, and cancelOperation() refuses to
 * transition once that flag is set — "exit-before-cancel" always
 * preserves the true completed/failed outcome, while "cancel-before-exit"
 * (the normal case: we call cancelOperation() and *then* kill the
 * process, which only exits afterward) is unaffected.
 */

function createOperation(type, label, { now = () => new Date().toISOString() } = {}) {
  return {
    id: crypto.randomBytes(4).toString('hex'),
    type,
    label,
    status: 'running',
    startedAt: now(),
    endedAt: null,
    exitCode: null,
    log: [],
    subscribers: new Set(),
    process: null,
    childExited: false,
  };
}

function isTerminal(op) {
  return Boolean(op) && op.status !== 'running';
}

/**
 * Records that the underlying child process has genuinely exited (Node's
 * 'exit' or 'error' event on the ChildProcess), independent of whether
 * 'close' — and therefore finishOperation() — has fired yet. This is the
 * authoritative signal cancelOperation() checks to refuse a
 * too-late cancellation attempt; see the module doc comment above.
 */
function markChildExited(op) {
  if (op) op.childExited = true;
}

/**
 * Attempts to transition `op` out of 'running' into a terminal status.
 * Returns true iff this call actually performed the transition; returns
 * false — and leaves `op` completely untouched — if it was already
 * terminal. Callers must treat a `false` return as "someone else already
 * decided the truthful outcome" and must not layer any further mutation
 * on top.
 */
function transitionToTerminal(op, status, { exitCode = null, endedAt, now = () => new Date().toISOString() } = {}) {
  if (!op || op.status !== 'running') return false;
  op.status = status;
  op.exitCode = exitCode;
  op.endedAt = endedAt || now();
  return true;
}

function appendLog(op, stream, text, { now = () => new Date().toISOString() } = {}) {
  const entry = { ts: now(), stream, text };
  op.log.push(entry);
  for (const res of op.subscribers) res.write(`data: ${JSON.stringify(entry)}\n\n`);
  return entry;
}

/**
 * Finalizes an operation from a child process outcome (exit code or a
 * spawn error). Returns false without changing anything if the operation
 * was already finalized by something else — most commonly, the operator
 * already cancelled it and the killed child's 'close'/'error' event is
 * simply arriving late.
 */
function finishOperation(op, exitCode, opts = {}) {
  const status = exitCode === 0 ? 'completed' : 'failed';
  if (!transitionToTerminal(op, status, { exitCode, ...opts })) return false;
  op.process = null;
  // Persist the terminal summary line in op.log (via appendLog, which
  // also broadcasts it to any currently-subscribed live SSE clients)
  // instead of writing it directly to subscribers only. Writing it only
  // to live subscribers made it invisible to a client that only ever
  // polls GET /api/operations/:id (its `since` cursor reads exclusively
  // from op.log), and to any EventSource that reconnects after this
  // point (the stream endpoint replays op.log as backlog). Persisting it
  // here means both transports observe the exact same log with the same
  // cursor semantics, and a live SSE subscriber still sees it exactly
  // once (via this appendLog call), not duplicated.
  appendLog(op, 'system', `\n── Operation ${op.status} (exit ${exitCode}) ──`, { now: () => op.endedAt });
  for (const res of op.subscribers) {
    res.write(`event: done\ndata: ${JSON.stringify({ status: op.status, exitCode })}\n\n`);
    res.end();
  }
  op.subscribers.clear();
  return true;
}

/**
 * Cancels a running operation (operator-initiated `DELETE`). Returns
 * false without changing anything if the operation already reached a
 * terminal state on its own (e.g. it completed/failed a moment before
 * the cancel request was processed) — the caller should treat a `false`
 * return as "already finished", not as an error, and must not overwrite
 * the real outcome with 'cancelled'.
 *
 * Also returns false — again leaving `op` completely untouched — if
 * markChildExited(op) has already been called for this operation. That
 * means the underlying process has genuinely already exited (even though
 * 'close' — and finishOperation() — may not have fired yet), so the true
 * completed/failed outcome is already determined and about to be
 * recorded; a cancellation request arriving in that narrow window must
 * not be allowed to record 'cancelled' instead.
 *
 * The "Cancelled by user" log line is appended here — atomically with
 * the winning transition, via the same guarded transitionToTerminal()
 * call — rather than by the caller before invoking cancelOperation().
 * That ordering matters: if the cancel line were appended first and
 * cancelOperation() then lost the race (e.g. because the process had
 * already genuinely exited), the log would misleadingly claim the
 * operation was cancelled by the user even though the real, different
 * outcome (completed/failed) is what actually gets recorded. Appending
 * the line only after transitionToTerminal() has actually won means a
 * losing cancel attempt leaves no cancel-related log trace at all.
 */
function cancelOperation(op, opts = {}) {
  if (!op || op.childExited) return false;
  if (!transitionToTerminal(op, 'cancelled', opts)) return false;
  op.process = null;
  appendLog(op, 'system', '\n── Cancelled by user ──', { now: () => op.endedAt });
  for (const res of op.subscribers) {
    res.write(`event: done\ndata: ${JSON.stringify({ status: 'cancelled', exitCode: null })}\n\n`);
    res.end();
  }
  op.subscribers.clear();
  return true;
}

module.exports = { createOperation, isTerminal, markChildExited, transitionToTerminal, appendLog, finishOperation, cancelOperation };
