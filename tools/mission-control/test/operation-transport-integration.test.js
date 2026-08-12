const test = require('node:test');
const assert = require('node:assert/strict');
const { createOperation, appendLog, finishOperation } = require('../operation-lifecycle');
const { createOperationPoller } = require('../public/operation-poller');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds a fake api(path) function that serves GET /api/operations/:id
 * exactly the way server.js's real handler does: op.log.slice(since) plus
 * status/exitCode/logLength. This lets us exercise the real
 * operation-lifecycle.js and the real operation-poller.js together,
 * proving the actual persisted-log contract between them end-to-end.
 */
function makeRealServerLikeApi(op) {
  return async (path) => {
    const match = path.match(/^operations\/([^?]+)(?:\?since=(\d+))?$/);
    assert.ok(match, `unexpected path shape: ${path}`);
    const since = match[2] ? Number(match[2]) : 0;
    if (match[1] !== op.id) return { error: 'Operation not found' };
    return {
      id: op.id,
      status: op.status,
      exitCode: op.exitCode,
      log: op.log.slice(since),
      logLength: op.log.length,
    };
  };
}

test('INTEGRATION: SSE-to-poll handoff includes the terminal summary line exactly once — the poller must see it via the persisted log, not miss it', async () => {
  const op = createOperation('validate', 'Validate rg');
  const api = makeRealServerLikeApi(op);

  // Simulate a "live SSE" phase: some lines are appended and would have
  // been delivered live. Track how many have been "rendered" the same
  // way app.js's renderedLogCount does.
  appendLog(op, 'stdout', 'line-1');
  appendLog(op, 'stdout', 'line-2');
  const renderedSoFar = op.log.length; // = 2, simulating the EventSource-rendered cursor at the moment the stream broke

  const delivered = [];
  let terminalInfo = null;
  const poller = createOperationPoller({
    api,
    operationId: op.id,
    intervalMs: 5,
    since: renderedSoFar, // hand off exactly like startOperationPolling() does
    onLogEntries: (entries) => delivered.push(...entries),
    onTerminal: (info) => { terminalInfo = info; },
  });
  poller.start();
  await wait(20);

  // The operation finishes while the poller is running — the terminal
  // summary line is appended to op.log by finishOperation() itself.
  finishOperation(op, 1);
  await wait(20);

  assert.deepEqual(terminalInfo, { status: 'failed', exitCode: 1 });
  assert.deepEqual(delivered.map((e) => e.text), [op.log[op.log.length - 1].text], 'only the genuinely new terminal line should be delivered, never line-1/line-2 which were already rendered before the handoff');
  assert.match(delivered[0].text, /Operation failed \(exit 1\)/, 'the terminal summary line must be delivered to the poller, not just to a live SSE subscriber');
});

test('INTEGRATION: polling-only lifecycle (no EventSource/SSE subscriber ever attaches) still delivers every log line including the terminal summary line, and reports the terminal status exactly once', async () => {
  const op = createOperation('deploy', 'Deploy');
  const api = makeRealServerLikeApi(op);

  const delivered = [];
  let terminalInfo = null;
  const poller = createOperationPoller({
    api,
    operationId: op.id,
    intervalMs: 5,
    onLogEntries: (entries) => delivered.push(...entries),
    onTerminal: (info) => { terminalInfo = info; },
  });
  poller.start();
  await wait(10);

  appendLog(op, 'system', 'starting');
  appendLog(op, 'stdout', 'working');
  await wait(20);

  finishOperation(op, 0);
  await wait(20);

  assert.deepEqual(terminalInfo, { status: 'completed', exitCode: 0 });
  const texts = delivered.map((e) => e.text);
  assert.deepEqual(texts.filter((t) => t === 'starting' || t === 'working'), ['starting', 'working']);
  assert.ok(texts.some((t) => /Operation completed \(exit 0\)/.test(t)), 'the terminal summary line must reach a client that only ever polled, never used EventSource at all');
  // No duplicates anywhere.
  assert.equal(new Set(texts).size, texts.length, 'no log line delivered more than once across the whole polling-only lifecycle');
});

test('INTEGRATION: op.log never contains the terminal summary line twice even though it is now persisted (appendLog) AND op.subscribers are separately notified of "done"', async () => {
  const op = createOperation('destroy', 'Destroy rg');
  finishOperation(op, 1);
  const summaryLines = op.log.filter((e) => /Operation failed/.test(e.text));
  assert.equal(summaryLines.length, 1);
});
