const test = require('node:test');
const assert = require('node:assert/strict');
const { createOperationPoller } = require('../public/operation-poller');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Builds a fake api(path) function serving a scripted sequence of responses/errors for a single operation id. */
function makeFakeApi(script) {
  const calls = [];
  let index = 0;
  const fn = async (path) => {
    calls.push(path);
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    if (step.throws) throw step.throws;
    if (typeof step.response === 'function') return step.response();
    return step.response;
  };
  return { fn, calls };
}

test('sequential polls request an increasing `since` cursor and never re-deliver already-seen log entries', async () => {
  const { fn: api, calls } = makeFakeApi([
    { response: { status: 'running', log: [{ ts: '1', stream: 'stdout', text: 'a' }], logLength: 1 } },
    { response: { status: 'running', log: [{ ts: '2', stream: 'stdout', text: 'b' }], logLength: 2 } },
    { response: { status: 'completed', exitCode: 0, log: [], logLength: 2 } },
  ]);

  const deliveries = [];
  const poller = createOperationPoller({
    api,
    operationId: 'op-1',
    intervalMs: 5,
    onLogEntries: (entries) => deliveries.push(...entries),
    onTerminal: () => {},
  });
  poller.start();
  await wait(60);

  assert.deepEqual(calls, ['operations/op-1?since=0', 'operations/op-1?since=1', 'operations/op-1?since=2']);
  assert.deepEqual(deliveries.map((e) => e.text), ['a', 'b']);
});

test('onTerminal is called exactly once when the server reports a non-running status, and polling stops immediately after', async () => {
  const { fn: api, calls } = makeFakeApi([
    { response: { status: 'running', log: [], logLength: 0 } },
    { response: { status: 'completed', exitCode: 0, log: [], logLength: 0 } },
  ]);

  let terminalCalls = 0;
  let lastInfo = null;
  const poller = createOperationPoller({
    api,
    operationId: 'op-2',
    intervalMs: 5,
    onTerminal: (info) => { terminalCalls += 1; lastInfo = info; },
  });
  poller.start();
  await wait(80);

  assert.equal(terminalCalls, 1);
  assert.deepEqual(lastInfo, { status: 'completed', exitCode: 0 });
  const callsAtTerminal = calls.length;
  await wait(40);
  assert.equal(calls.length, callsAtTerminal, 'no further polling after a terminal status is reported');
});

test('a failed operation reported by the server calls onTerminal with status "failed" — this is the only path that may mark an operation failed', async () => {
  const { fn: api } = makeFakeApi([
    { response: { status: 'running', log: [], logLength: 0 } },
    { response: { status: 'failed', exitCode: 1, log: [{ ts: '1', stream: 'stderr', text: 'boom' }], logLength: 1 } },
  ]);

  let terminalInfo = null;
  const poller = createOperationPoller({
    api,
    operationId: 'op-3',
    intervalMs: 5,
    onTerminal: (info) => { terminalInfo = info; },
  });
  poller.start();
  await wait(60);

  assert.deepEqual(terminalInfo, { status: 'failed', exitCode: 1 });
});

test('a poll-level failure (rejected api call) never calls onTerminal and never stops polling on its own — it only reports via onError', async () => {
  const { fn: api, calls } = makeFakeApi([
    { throws: new Error('network hiccup') },
    { throws: new Error('network hiccup') },
    { response: { status: 'running', log: [], logLength: 0 } },
    { response: { status: 'completed', exitCode: 0, log: [], logLength: 0 } },
  ]);

  let terminalCalls = 0;
  const errors = [];
  const poller = createOperationPoller({
    api,
    operationId: 'op-4',
    intervalMs: 5,
    onError: (err) => errors.push(err),
    onTerminal: () => { terminalCalls += 1; },
  });
  poller.start();
  await wait(80);

  assert.equal(errors.length, 2, 'the two transient failures must be reported');
  assert.equal(terminalCalls, 1, 'polling must recover and eventually reach the real terminal status');
  assert.ok(calls.length >= 4);
});

test('an operation that never resolves (e.g. a 404 after a server restart with no persisted operation state) never fabricates success or failure, and gives up after the consecutive-error cap', async () => {
  const { fn: api, calls } = makeFakeApi([
    { response: { error: 'Operation not found' } },
  ]);

  let terminalCalls = 0;
  let giveUpCalls = 0;
  const poller = createOperationPoller({
    api,
    operationId: 'op-5',
    intervalMs: 2,
    maxConsecutiveErrors: 5,
    onTerminal: () => { terminalCalls += 1; },
    onGiveUp: () => { giveUpCalls += 1; },
  });
  poller.start();
  await wait(60);

  assert.equal(terminalCalls, 0, 'a poll that can never determine status must never fabricate a terminal outcome');
  assert.equal(giveUpCalls, 1, 'polling must give up after the consecutive-error cap rather than continuing forever');
  const callsAtGiveUp = calls.length;
  assert.ok(callsAtGiveUp >= 5 && callsAtGiveUp < 20, `expected roughly maxConsecutiveErrors calls, got ${callsAtGiveUp}`);
  await wait(30);
  assert.equal(calls.length, callsAtGiveUp, 'no further polling after giving up');
});

test('stop() halts further polling immediately', async () => {
  const { fn: api, calls } = makeFakeApi([
    { response: { status: 'running', log: [], logLength: 0 } },
  ]);
  const poller = createOperationPoller({ api, operationId: 'op-6', intervalMs: 5 });
  poller.start();
  await wait(15);
  poller.stop();
  const callsAtStop = calls.length;
  await wait(40);
  assert.equal(calls.length, callsAtStop, 'no polling after stop()');
});

test('polling is serialized: no two polls are ever in flight concurrently, even when a poll is slower than the interval', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const api = async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await wait(30);
    concurrent -= 1;
    return { status: 'running', log: [], logLength: 0 };
  };

  const poller = createOperationPoller({ api, operationId: 'op-7', intervalMs: 5 });
  poller.start();
  await wait(150);
  poller.stop();

  assert.equal(maxConcurrent, 1, 'no two polls may ever be in flight at the same time');
});

test('the URL passed to api() never contains a token — only the operation id and a plain numeric cursor', async () => {
  const { fn: api, calls } = makeFakeApi([
    { response: { status: 'completed', exitCode: 0, log: [], logLength: 0 } },
  ]);
  const poller = createOperationPoller({ api, operationId: 'op-8-not-a-token', intervalMs: 5 });
  poller.start();
  await wait(30);

  for (const call of calls) {
    assert.match(call, /^operations\/op-8-not-a-token\?since=\d+$/);
  }
});

test('createOperationPoller requires an api function and an operationId', () => {
  assert.throws(() => createOperationPoller({ operationId: 'x' }), /requires an api/);
  assert.throws(() => createOperationPoller({ api: async () => {} }), /requires an operationId/);
});
