const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  computeDelayMs,
  DEFAULT_SLO_P95_THRESHOLD_MS,
  DEFAULT_ERROR_RATE_CEILING_PCT,
} = require('../order-dependency-latency');
const { SCENARIO_MAP, SCENARIO_METADATA } = require('../scenario-catalog');
const { evaluateScenarioHealth } = require('../scenario-health');
const { normalizeScenarioId, inventoryScenarioResources, DEFAULT_REPO_ROOT } = require('../scenario-lifecycle');

function readManifest() {
  return fs.readFileSync(path.resolve(__dirname, '../../../k8s/base/application.yaml'), 'utf8');
}

function readScenarioManifest() {
  return fs.readFileSync(path.resolve(__dirname, '../../../k8s/scenarios/dependency-latency.yaml'), 'utf8');
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

function loadOrderDependencyLatencyRuntime() {
  const manifestText = readManifest();
  const startIndex = manifestText.indexOf('const ORDER_DEPENDENCY_LATENCY = {');
  const endIndex = manifestText.indexOf('const BULK_TANK_SAFETY_ALARM = {', startIndex);

  if (startIndex === -1 || endIndex === -1) {
    throw new Error('Missing order dependency latency runtime in deployed inline portal script.');
  }

  const runtimeSource = manifestText.slice(startIndex, endIndex);
  const elements = new Map();
  const logLines = [];
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
    // appendRefillOrderLog itself lives earlier in the deployed script (in
    // the REFILL_ORDER_BACKLOG section); stub it here so the extracted
    // ORDER_DEPENDENCY_LATENCY slice — which calls it, matching the shared
    // ops-log convention — can run standalone.
    appendRefillOrderLog(level, message) {
      logLines.push({ level, message });
    },
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
  vm.runInContext(
    `${runtimeSource}; this.__orderDependencyLatency = { latency: ORDER_DEPENDENCY_LATENCY, renderOrderDependencyLatency, startOrderDependencyLatencyIncident, advanceOrderDependencyLatencyRamp, recoverOrderDependencyLatency };`,
    context,
  );

  return context.__orderDependencyLatency;
}

test('the dependency-latency scenario is registered in the shared catalog without duplicating an existing array', () => {
  assert.equal(SCENARIO_MAP.latency, 'dependency-latency.yaml');
  assert.equal(normalizeScenarioId('latency'), 'latency');
  assert.equal(normalizeScenarioId('dependency-latency'), 'latency');
  assert.equal(normalizeScenarioId('order-latency'), 'latency');
  assert.equal(normalizeScenarioId('slow-dependency'), 'latency');
  assert.equal(normalizeScenarioId('gradual-latency'), 'latency');

  const metadata = SCENARIO_METADATA.latency;
  assert.ok(metadata, 'SCENARIO_METADATA must include a "latency" entry');
  assert.equal(metadata.domain, 'Shared');
  assert.equal(metadata.impactedService, 'order-pricing-dependency');
});

test('the scenario manifest file is discovered by the shared inventory scan used for reset', () => {
  const inventory = inventoryScenarioResources(DEFAULT_REPO_ROOT);
  const entry = inventory.find((item) => item.scenarioId === 'latency');
  assert.ok(entry, 'dependency-latency.yaml must be inventoried for scenario-owned resource cleanup');
  assert.equal(entry.file, 'dependency-latency.yaml');

  const configMapResource = entry.resources.find((r) => r.kind === 'ConfigMap' && r.name === 'order-pricing-dependency-config');
  assert.ok(configMapResource, 'the scenario must override the order-pricing-dependency-config ConfigMap so reset can restore the baseline via kind+name cleanup + base reapply');
});

test('evaluateScenarioHealth reports latency scenario active only when the ConfigMap is in ramp mode and targeted pods are Ready', () => {
  const readyDependencyPod = {
    metadata: { name: 'order-pricing-dependency-abc123' },
    status: { phase: 'Running', containerStatuses: [{ name: 'order-pricing-dependency', ready: true, restartCount: 0, state: { running: {} } }] },
  };
  const readyProbePod = {
    metadata: { name: 'order-checkout-probe-def456' },
    status: { phase: 'Running', containerStatuses: [{ name: 'order-checkout-probe', ready: true, restartCount: 0, state: { running: {} } }] },
  };
  const notReadyDependencyPod = {
    metadata: { name: 'order-pricing-dependency-abc123' },
    status: { phase: 'Running', containerStatuses: [{ name: 'order-pricing-dependency', ready: false, restartCount: 0, state: { running: {} } }] },
  };

  const rampConfigMap = { metadata: { name: 'order-pricing-dependency-config' }, data: { delay_mode: 'ramp' } };
  const fixedConfigMap = { metadata: { name: 'order-pricing-dependency-config' }, data: { delay_mode: 'fixed' } };

  const activeResult = evaluateScenarioHealth('latency', {
    pods: [readyDependencyPod, readyProbePod],
    configMaps: [rampConfigMap],
  });
  assert.equal(activeResult.active, true);

  const healthyResult = evaluateScenarioHealth('latency', {
    pods: [readyDependencyPod, readyProbePod],
    configMaps: [fixedConfigMap],
  });
  assert.equal(healthyResult.active, false);

  const notReadyResult = evaluateScenarioHealth('latency', {
    pods: [notReadyDependencyPod, readyProbePod],
    configMaps: [rampConfigMap],
  });
  assert.equal(notReadyResult.active, false, 'a scenario where the dependency pod is not Ready must never be reported as the genuine latency-led incident');

  const noConfigMapResult = evaluateScenarioHealth('latency', { pods: [readyDependencyPod, readyProbePod], configMaps: [] });
  assert.equal(noConfigMapResult.active, false);
});

test('the base and scenario manifests declare the documented SLO threshold, error ceiling, and ramp/fixed delay configuration', () => {
  const appText = readManifest();
  const scenarioText = readScenarioManifest();

  // Baseline: low fixed delay, healthy SLO/error posture.
  assert.match(appText, /name: order-pricing-dependency-config/);
  assert.match(appText, /delay_mode: "fixed"/);
  assert.match(appText, /fixed_delay_ms: "45"/);
  assert.match(appText, /slo_p95_threshold_ms: "500"/);
  assert.match(appText, /error_rate_ceiling_bp: "200"/);

  // Baseline readiness probe must hit /healthz — never the delayed route.
  assert.match(appText, /path: \/healthz\n\s+port: 4000/);
  assert.match(appText, /path: \/healthz\n\s+port: 4100/);

  // Scenario override: ramped high-delay configuration with a config-change clue.
  assert.match(scenarioText, /name: order-pricing-dependency-config/);
  assert.match(scenarioText, /delay_mode: "ramp"/);
  assert.match(scenarioText, /ramp_from_ms: "45"/);
  assert.match(scenarioText, /ramp_to_ms: "950"/);
  assert.match(scenarioText, /ramp_duration_seconds: "75"/);
  assert.match(scenarioText, /config_change_reason: "Emergency change: pricing-lookup dependency timeout raised from 45ms to 950ms/);
  assert.match(scenarioText, /config_changed_by: "platform-ops-oncall"/);
});

test('the deployed inline dependency-hop script and probe script do not accept an arbitrary proxy target or use shell interpolation', () => {
  const appText = readManifest();
  assert.match(appText, /name: order-pricing-dependency-script/);
  assert.match(appText, /name: order-checkout-probe-script/);

  // Neither runtime script reads a caller-supplied "target"/"url" field from
  // request input; DEPENDENCY_URL and OTEL_EXPORTER_OTLP_ENDPOINT are only
  // ever sourced from process.env (fixed at deploy time).
  assert.doesNotMatch(appText, /payload\.(target|url|proxyTo|forwardTo)/);
  assert.doesNotMatch(appText, /req\.query/);

  // Containers run `node /app/server.js` directly, never `sh -c` with
  // interpolated request/config data.
  assert.match(appText, /command: \["node", "\/app\/server\.js"\]/);
});

test('computeDelayMs (shared with the deployed runtime scripts) satisfies the documented SLO/threshold contract', () => {
  const fixedBaseline = { delayMode: 'fixed', fixedDelayMs: 45 };
  assert.ok(computeDelayMs(fixedBaseline, 0) < DEFAULT_SLO_P95_THRESHOLD_MS);

  const rampScenario = { delayMode: 'ramp', rampFromMs: 45, rampToMs: 950, rampDurationSeconds: 75 };
  assert.ok(computeDelayMs(rampScenario, 75000) > DEFAULT_SLO_P95_THRESHOLD_MS);
  assert.equal(DEFAULT_ERROR_RATE_CEILING_PCT, 2);
});

test('the ORDER_DEPENDENCY_LATENCY business-impact widget starts healthy, activates, ramps, and recovers', () => {
  const runtime = loadOrderDependencyLatencyRuntime();
  assert.equal(runtime.latency.status, 'healthy');
  assert.ok(runtime.latency.currentP95Ms < runtime.latency.sloP95ThresholdMs);

  runtime.startOrderDependencyLatencyIncident('run-test-1');
  assert.equal(runtime.latency.status, 'active');
  assert.equal(runtime.latency.runId, 'run-test-1');
  assert.equal(runtime.latency.delayMode, 'ramp');
  assert.match(runtime.latency.configChangeReason, /Emergency change/);

  const before = runtime.latency.currentP95Ms;
  runtime.advanceOrderDependencyLatencyRamp();
  assert.ok(runtime.latency.currentP95Ms > before, 'ramp must monotonically increase p95 while active');

  // Advance until the ramp ceiling and confirm the SLO is breached.
  for (let i = 0; i < 10; i += 1) runtime.advanceOrderDependencyLatencyRamp();
  assert.ok(runtime.latency.currentP95Ms > runtime.latency.sloP95ThresholdMs, 'ramped latency must exceed the documented SLO threshold');
  assert.ok(runtime.latency.currentP95Ms <= runtime.latency.rampToMs, 'ramp must hold at the configured ceiling, not exceed it');

  runtime.recoverOrderDependencyLatency();
  assert.equal(runtime.latency.status, 'recovered');
  assert.equal(runtime.latency.delayMode, 'fixed');
  assert.ok(runtime.latency.currentP95Ms < runtime.latency.sloP95ThresholdMs, 'recovery must restore latency below the SLO threshold');
});

test('the deployed inline UI exposes the order dependency latency card with p95/SLO/config-change evidence', () => {
  const manifestText = readManifest();

  assert.match(manifestText, /id="order-dependency-latency"/);
  assert.match(manifestText, /Order Fulfillment Latency/i);
  assert.match(manifestText, /p95 latency/i);
  assert.match(manifestText, /Error rate/i);
  assert.match(manifestText, /Delayed dependency:/i);
  assert.match(manifestText, /SLO breached:/i);
  assert.match(manifestText, /Config change:/i);
});

test('the otel-collector Prometheus receiver scrapes both new services for latency metrics evidence', () => {
  const manifestText = readManifest();
  assert.match(manifestText, /order-pricing-dependency\.propane\.svc\.cluster\.local:4000/);
  assert.match(manifestText, /order-checkout-probe\.propane\.svc\.cluster\.local:4100/);
});
