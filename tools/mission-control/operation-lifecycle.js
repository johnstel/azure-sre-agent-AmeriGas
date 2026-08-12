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
  };
}

function isTerminal(op) {
  return Boolean(op) && op.status !== 'running';
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
  for (const res of op.subscribers) {
    res.write(`data: ${JSON.stringify({ ts: op.endedAt, stream: 'system', text: `\n── Operation ${op.status} (exit ${exitCode}) ──` })}\n\n`);
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
 */
function cancelOperation(op, opts = {}) {
  if (!transitionToTerminal(op, 'cancelled', opts)) return false;
  op.process = null;
  for (const res of op.subscribers) {
    res.write(`event: done\ndata: ${JSON.stringify({ status: 'cancelled', exitCode: null })}\n\n`);
    res.end();
  }
  op.subscribers.clear();
  return true;
}

module.exports = { createOperation, isTerminal, transitionToTerminal, appendLog, finishOperation, cancelOperation };
