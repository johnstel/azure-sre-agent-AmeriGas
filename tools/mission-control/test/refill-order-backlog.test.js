const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function readManifest() {
  return fs.readFileSync(path.resolve(__dirname, '../../../k8s/base/application.yaml'), 'utf8');
}

function readScenarioManifest() {
  return fs.readFileSync(path.resolve(__dirname, '../../../k8s/scenarios/refill-order-backlog.yaml'), 'utf8');
}

function createElement() {
  return {
    className: '',
    innerHTML: '',
    children: [],
    parentNode: null,
    style: {},
    appendChild(node) {
      node.parentNode = this;
      this.children.push(node);
      return node;
    },
    prepend(node) {
      node.parentNode = this;
      this.children.unshift(node);
    },
    removeChild(node) {
      const idx = this.children.indexOf(node);
      if (idx >= 0) this.children.splice(idx, 1);
      return node;
    },
  };
}

function loadRefillOrderBacklogRuntime() {
  const manifestText = readManifest();
  const startIndex = manifestText.indexOf('const REFILL_ORDER_BACKLOG = {');
  const endIndex = manifestText.indexOf('const BULK_TANK_SAFETY_ALARM = {', startIndex);

  if (startIndex === -1 || endIndex === -1) {
    throw new Error('Missing refill order backlog runtime in deployed inline portal script.');
  }

  const runtimeSource = manifestText.slice(startIndex, endIndex);
  const elements = new Map();
  const context = {
    console,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    Boolean,
    isNaN,
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, createElement());
        return elements.get(id);
      },
      createElement() {
        return createElement();
      },
    },
    window: {},
    globalThis: {},
  };

  context.window = context;
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(`${runtimeSource}; this.__refillOrderBacklog = { backlog: REFILL_ORDER_BACKLOG, pauseRefillOrderConsumer, advanceRefillOrderBacklog, processPoisonRefillOrder, recoverRefillOrderBacklog, renderRefillOrderBacklog, appendRefillOrderLog };`, context);

  return context.__refillOrderBacklog;
}

test('healthy producers continue while the refill consumer remains paused', () => {
  const runtime = loadRefillOrderBacklogRuntime();
  const backlog = runtime.backlog;

  assert.equal(backlog.producerHealthy, true);
  assert.equal(backlog.consumerPaused, true);
  assert.equal(backlog.activeConsumerCount, 0);
  assert.equal(backlog.status, 'paused');
  assert.equal(backlog.queueDepth, 14);
  assert.equal(backlog.oldestMessageAgeSeconds, 420);
  assert.equal(backlog.affectedOrderIds.length, 4);
  assert.equal(backlog.affectedOrderIds[0], 'RO-1041');
  assert.equal(backlog.affectedOrderIds[1], 'RO-1042');
  assert.equal(backlog.affectedOrderIds[2], 'RO-1043');
  assert.equal(backlog.affectedOrderIds[3], 'RO-1044');
  assert.equal(backlog.malformedEventId, 'EV-REFILL-2047');
});

test('queue depth and oldest message age rise monotonically while the backlog grows', () => {
  const runtime = loadRefillOrderBacklogRuntime();
  const beforeDepth = runtime.backlog.queueDepth;
  const beforeAge = runtime.backlog.oldestMessageAgeSeconds;

  runtime.pauseRefillOrderConsumer();
  runtime.advanceRefillOrderBacklog();

  assert.ok(runtime.backlog.queueDepth > beforeDepth);
  assert.ok(runtime.backlog.oldestMessageAgeSeconds >= beforeAge + 30);
  assert.equal(runtime.backlog.status, 'queue-growing');
  assert.equal(runtime.backlog.consumerPaused, true);
});

test('malformed refill events retry a bounded number of times before landing in the DLQ', () => {
  const runtime = loadRefillOrderBacklogRuntime();
  runtime.backlog.retryCount = 1;

  runtime.processPoisonRefillOrder();
  assert.equal(runtime.backlog.retryCount, 2);
  assert.equal(runtime.backlog.status, 'retrying');

  runtime.processPoisonRefillOrder();
  assert.equal(runtime.backlog.retryCount, 3);
  assert.equal(runtime.backlog.status, 'dead-lettered');
  assert.ok(runtime.backlog.deadLetterQueue.some((entry) => entry.eventId === 'EV-REFILL-2047'));
  assert.equal(runtime.backlog.deadLetterQueue.at(-1).retries, 3);
});

test('recovery drains valid refill orders exactly once without duplicating fulfillment', () => {
  const runtime = loadRefillOrderBacklogRuntime();
  runtime.backlog.queueDepth = 14;
  runtime.backlog.validOrdersDrained = 0;
  runtime.backlog.recoveredOrderIds = [];
  runtime.backlog.consumerPaused = true;
  runtime.backlog.activeConsumerCount = 0;
  runtime.backlog.recoveryComplete = false;

  const firstDrain = runtime.recoverRefillOrderBacklog();
  assert.equal(firstDrain.length, 4);
  assert.equal(firstDrain[0], 'RO-1041');
  assert.equal(firstDrain[1], 'RO-1042');
  assert.equal(firstDrain[2], 'RO-1043');
  assert.equal(firstDrain[3], 'RO-1044');
  assert.equal(runtime.backlog.validOrdersDrained, 4);
  assert.equal(runtime.backlog.queueDepth, 10);
  assert.equal(runtime.backlog.consumerPaused, false);
  assert.equal(runtime.backlog.activeConsumerCount, 2);
  assert.equal(runtime.backlog.recoveryComplete, true);

  const secondDrain = runtime.recoverRefillOrderBacklog();
  assert.equal(secondDrain.length, 0);
  assert.equal(runtime.backlog.validOrdersDrained, 4);
  assert.equal(runtime.backlog.recoveredOrderIds.length, 4);
  assert.ok(runtime.backlog.deadLetterQueue.some((entry) => entry.eventId === 'EV-REFILL-2047'));
});

test('the manifest and scenario manifest expose the required backlog telemetry and DLQ evidence', () => {
  const appText = readManifest();
  const scenarioText = readScenarioManifest();

  assert.match(appText, /queueName:\s*'refill-orders'/);
  assert.match(appText, /deadLetterQueueName:\s*'refill-orders-dlq'/);
  assert.match(appText, /oldestMessageAgeSeconds:\s*420/);
  assert.match(appText, /activeConsumerCount:\s*0/);
  assert.match(appText, /affectedOrderIds:\s*\['RO-1041', 'RO-1042', 'RO-1043', 'RO-1044'\]/);
  assert.match(appText, /malformedEventId:\s*'EV-REFILL-2047'/);
  assert.match(appText, /Recovery drained valid refill orders exactly once/i);

  assert.match(scenarioText, /queue_name: "refill-orders"/);
  assert.match(scenarioText, /oldest_message_age_seconds: "420"/);
  assert.match(scenarioText, /active_consumer_count: "0"/);
  assert.match(scenarioText, /malformed_event_id: "EV-REFILL-2047"/);
  assert.match(scenarioText, /dead_letter_contents: "EV-REFILL-2047\|RO-2047\|Malformed refill-order payload\|retries=3"/);
});

test('the deployed inline UI exposes the refill backlog card with operational evidence', () => {
  const manifestText = readManifest();

  assert.match(manifestText, /id="refill-order-backlog"/);
  assert.match(manifestText, /Queue depth/i);
  assert.match(manifestText, /Oldest message/i);
  assert.match(manifestText, /Active consumers/i);
  assert.match(manifestText, /Affected refill orders:/i);
  assert.match(manifestText, /DLQ contents:/i);
  assert.match(manifestText, /Paused consumer/i);
  assert.match(manifestText, /Recovery drained valid refill orders exactly once/i);
});
