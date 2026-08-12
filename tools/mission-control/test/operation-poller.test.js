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

test('an initial `since` cursor (e.g. handed off from a prior EventSource connection) is used for the very first poll — never since=0 when entries were already rendered elsewhere', async () => {
  const { fn: api, calls } = makeFakeApi([
    { response: { status: 'running', log: [{ ts: '11', stream: 'stdout', text: 'k' }], logLength: 11 } },
    { response: { status: 'completed', exitCode: 0, log: [], logLength: 11 } },
  ]);

  const deliveries = [];
  const poller = createOperationPoller({
    api,
    operationId: 'op-since',
    intervalMs: 5,
    since: 10,
    onLogEntries: (entries) => deliveries.push(...entries),
  });
  poller.start();
  await wait(40);

  assert.equal(calls[0], 'operations/op-since?since=10', 'the first poll must resume from the handed-off cursor, not from 0');
  assert.deepEqual(deliveries.map((e) => e.text), ['k'], 'only the genuinely new entry (index 10) is delivered, never the 10 that were already rendered before the handoff');
});

test('a negative or non-finite `since` option is treated as 0 rather than producing an invalid cursor', async () => {
  const { fn: api, calls } = makeFakeApi([{ response: { status: 'completed', exitCode: 0, log: [], logLength: 0 } }]);
  createOperationPoller({ api, operationId: 'op-neg', intervalMs: 5, since: -5 }).start();
  await wait(20);
  assert.equal(calls[0], 'operations/op-neg?since=0');
});

test('REGRESSION: end-to-end EventSource-to-poller handoff simulation — N lines already rendered via a simulated "EventSource", then the poller must resume from exactly since=N with no duplicate and no missed lines across the handoff', async () => {
  // Simulate a full server-side operation log of 15 entries. A fake
  // "EventSource" renders the first N=8 synchronously (as if they'd
  // already arrived before the stream broke), tracking a renderedCount
  // cursor exactly the way app.js's appendLogEntries does. The poller is
  // then created with `since: renderedCount` (mirroring
  // startOperationPolling), and must fetch/deliver only entries [8..15)
  // — never re-delivering [0..8) and never skipping any of [8..15).
  const fullLog = Array.from({ length: 15 }, (_, i) => ({ ts: String(i), stream: 'stdout', text: `line-${i}` }));
  const N = 8;

  const rendered = [];
  let renderedCount = 0;
  function simulateAppendLogEntries(entries) {
    rendered.push(...entries);
    renderedCount += entries.length;
  }

  // The "EventSource" phase: entries [0..N) arrive one at a time, exactly as they would over SSE.
  for (let i = 0; i < N; i += 1) simulateAppendLogEntries([fullLog[i]]);
  assert.equal(renderedCount, N);

  // The stream breaks; app.js falls back to the poller, handing off the exact cursor.
  const { fn: api, calls } = makeFakeApi([
    { response: { status: 'running', log: fullLog.slice(N, N + 4), logLength: N + 4 } },
    { response: { status: 'completed', exitCode: 0, log: fullLog.slice(N + 4), logLength: fullLog.length } },
  ]);
  const poller = createOperationPoller({
    api,
    operationId: 'op-handoff',
    intervalMs: 5,
    since: renderedCount,
    onLogEntries: simulateAppendLogEntries,
  });
  poller.start();
  await wait(40);

  assert.equal(calls[0], `operations/op-handoff?since=${N}`, 'the very first poll must resume exactly where the simulated EventSource left off');
  assert.equal(rendered.length, fullLog.length, 'every line must eventually be rendered exactly once across the handoff');
  assert.deepEqual(rendered.map((e) => e.text), fullLog.map((e) => e.text), 'no duplicate and no missing lines, in the correct order, across the EventSource-to-poller handoff');
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

test('stop() called while a poll is in flight fences the response: no onLogEntries/onTerminal/onError callback fires once that in-flight request resolves, and no further poll is scheduled', async () => {
  let resolveApi;
  const api = () => new Promise((resolve) => { resolveApi = resolve; });

  let logCalls = 0, terminalCalls = 0, errorCalls = 0;
  const poller = createOperationPoller({
    api,
    operationId: 'op-9',
    intervalMs: 5,
    onLogEntries: () => { logCalls += 1; },
    onTerminal: () => { terminalCalls += 1; },
    onError: () => { errorCalls += 1; },
  });
  poller.start();
  await wait(10); // let tick() start and begin awaiting api()
  poller.stop();
  // Resolve the in-flight request only AFTER stop() has already been called.
  resolveApi({ status: 'completed', exitCode: 0, log: [{ ts: '1', stream: 'stdout', text: 'late' }], logLength: 1 });
  await wait(20);

  assert.equal(logCalls, 0, 'a stopped poller must never deliver log entries from an in-flight request that resolves late');
  assert.equal(terminalCalls, 0, 'a stopped poller must never report a terminal status from a late-resolving request');
  assert.equal(errorCalls, 0, 'a stopped poller must never report an error from a late-resolving request either');
});

test('stop() called while a poll is in flight and that poll rejects: no onError/onGiveUp fires and the failure is silently discarded', async () => {
  let rejectApi;
  const api = () => new Promise((_resolve, reject) => { rejectApi = reject; });

  let errorCalls = 0, giveUpCalls = 0;
  const poller = createOperationPoller({
    api,
    operationId: 'op-10',
    intervalMs: 5,
    maxConsecutiveErrors: 1,
    onError: () => { errorCalls += 1; },
    onGiveUp: () => { giveUpCalls += 1; },
  });
  poller.start();
  await wait(10);
  poller.stop();
  rejectApi(new Error('late network failure'));
  await wait(20);

  assert.equal(errorCalls, 0, 'a stopped poller must never surface an error from a late-rejecting in-flight request');
  assert.equal(giveUpCalls, 0, 'a stopped poller must never give up from a late-rejecting in-flight request');
});

test('switching operation ids: starting a new poller after stopping the old one means a late response from the OLD operation can never be attributed to the NEW one', async () => {
  const responses = { 'op-old': null, 'op-new': null };
  let resolveOld;
  const api = (path) => {
    if (path.startsWith('operations/op-old')) return new Promise((resolve) => { resolveOld = resolve; });
    return Promise.resolve({ status: 'running', log: [{ ts: '1', stream: 'stdout', text: 'new-operation-log' }], logLength: 1 });
  };

  const deliveries = [];
  const oldPoller = createOperationPoller({
    api, operationId: 'op-old', intervalMs: 5,
    onLogEntries: (entries) => deliveries.push(...entries.map((e) => ({ ...e, _from: 'old' }))),
    onTerminal: () => deliveries.push({ _from: 'old', terminal: true }),
  });
  oldPoller.start();
  await wait(10); // let the old poller start awaiting its (never-resolving-yet) request
  oldPoller.stop(); // simulates app.js switching to a new operation id

  const newPoller = createOperationPoller({
    api, operationId: 'op-new', intervalMs: 5,
    onLogEntries: (entries) => deliveries.push(...entries.map((e) => ({ ...e, _from: 'new' }))),
  });
  newPoller.start();
  await wait(20);

  // Now let the OLD operation's long-delayed response finally arrive.
  resolveOld({ status: 'completed', exitCode: 0, log: [{ ts: '2', stream: 'stdout', text: 'stale-old-operation-log' }], logLength: 1 });
  await wait(20);
  newPoller.stop();

  assert.ok(deliveries.some((d) => d._from === 'new'), 'the new poller must still deliver its own log entries');
  assert.ok(!deliveries.some((d) => d._from === 'old'), 'the stale old poller must never deliver log entries or a terminal state after being superseded');
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
