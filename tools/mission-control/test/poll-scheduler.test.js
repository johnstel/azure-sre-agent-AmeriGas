const test = require('node:test');
const assert = require('node:assert/strict');
const { createPoller } = require('../poll-scheduler');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('createPoller never allows two ticks to run concurrently, even when a tick outlives the interval', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  let calls = 0;

  const poller = createPoller(async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    calls += 1;
    // This tick intentionally takes much longer than the poll interval,
    // reproducing the exact condition (a slow/hung kubectl call) that
    // causes a naive `setInterval(asyncFn, ms)` to overlap invocations.
    await wait(30);
    concurrent -= 1;
  }, 5);

  await wait(150);
  poller.stop();

  assert.equal(maxConcurrent, 1, 'no two ticks should ever be in flight at the same time');
  assert.ok(calls >= 2, `expected the poller to have ticked more than once, got ${calls}`);
});

test('createPoller.stop() halts further ticks', async () => {
  let calls = 0;
  const poller = createPoller(async () => { calls += 1; }, 5);

  await wait(25);
  poller.stop();
  const callsAtStop = calls;

  await wait(30);
  assert.equal(calls, callsAtStop, 'no further ticks should occur after stop()');
});

test('createPoller schedules the next tick only after the previous one settles, even on rejection', async () => {
  let calls = 0;
  let concurrent = 0;
  let maxConcurrent = 0;

  const poller = createPoller(async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    calls += 1;
    await wait(15);
    concurrent -= 1;
    throw new Error('simulated tick failure');
  }, 5);

  await wait(80);
  poller.stop();

  assert.equal(maxConcurrent, 1, 'a rejecting tick must not prevent the in-flight guard from working');
  assert.ok(calls >= 2, `expected multiple ticks despite failures, got ${calls}`);
});

test('createPoller.isInFlight() reflects whether a tick is currently running', async () => {
  let resolveTick;
  const tickStarted = new Promise((resolve) => { resolveTick = resolve; });
  let releaseTick;
  const releaseGate = new Promise((resolve) => { releaseTick = resolve; });

  const poller = createPoller(async () => {
    resolveTick();
    await releaseGate;
  }, 5);

  await tickStarted;
  assert.equal(poller.isInFlight(), true);
  releaseTick();
  await wait(10);
  assert.equal(poller.isInFlight(), false);
  poller.stop();
});
