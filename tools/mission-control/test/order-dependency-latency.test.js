const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SLO_P95_THRESHOLD_MS,
  DEFAULT_ERROR_RATE_CEILING_PCT,
  computeDelayMs,
  deterministicJitterMs,
  isSyntheticError,
  computeQuantile,
  computeQuantiles,
  deriveTraceId,
  deriveSpanId,
  buildTraceParent,
  parseTraceParent,
  buildOtlpSpan,
  buildOtlpTracePayload,
  OTLP_SPAN_KIND,
  OTLP_STATUS_CODE,
  evaluateInvariants,
  simulatePhase,
  runDeterministicCycles,
} = require('../order-dependency-latency');

test('fixed delay mode returns a constant delay regardless of elapsed time', () => {
  const config = { delayMode: 'fixed', fixedDelayMs: 45 };
  assert.equal(computeDelayMs(config, 0), 45);
  assert.equal(computeDelayMs(config, 60000), 45);
  assert.equal(computeDelayMs(config, 999999), 45);
});

test('ramp delay mode linearly increases from rampFromMs to rampToMs then holds', () => {
  const config = { delayMode: 'ramp', rampFromMs: 100, rampToMs: 900, rampDurationSeconds: 60 };
  assert.equal(computeDelayMs(config, 0), 100);
  assert.equal(computeDelayMs(config, 30000), 500); // halfway through the ramp
  assert.equal(computeDelayMs(config, 60000), 900); // ramp complete
  assert.equal(computeDelayMs(config, 120000), 900); // holds at the ceiling past the ramp window
});

test('ramp delay math is monotonically non-decreasing across the ramp window', () => {
  const config = { delayMode: 'ramp', rampFromMs: 45, rampToMs: 950, rampDurationSeconds: 75 };
  let previous = -Infinity;
  for (let ms = 0; ms <= 75000; ms += 1000) {
    const delay = computeDelayMs(config, ms);
    assert.ok(delay >= previous, `delay at ${ms}ms (${delay}) should not decrease from previous (${previous})`);
    previous = delay;
  }
});

test('deterministic jitter is reproducible and bounded by the configured spread', () => {
  const spread = 25;
  for (let sequence = 0; sequence < 500; sequence += 1) {
    const jitter = deterministicJitterMs(sequence, spread);
    assert.ok(jitter >= 0 && jitter < spread, `jitter ${jitter} out of bounds for sequence ${sequence}`);
    assert.equal(jitter, deterministicJitterMs(sequence, spread), 'jitter must be identical across repeated calls');
  }
  assert.equal(deterministicJitterMs(1, 0), 0);
});

test('synthetic error selection is deterministic and matches the configured basis-point rate', () => {
  const errorRateBp = 200; // 2%
  let errors = 0;
  const total = 10000;
  for (let sequence = 0; sequence < total; sequence += 1) {
    if (isSyntheticError(sequence, errorRateBp)) errors += 1;
  }
  assert.equal(errors, errorRateBp);
  assert.equal(isSyntheticError(5, errorRateBp), isSyntheticError(5, errorRateBp));
  assert.equal(isSyntheticError(0, 0), false);
});

test('quantile computation matches expected percentiles for a known sample set', () => {
  const samples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  const quantiles = computeQuantiles(samples);
  assert.equal(quantiles.p50, 50);
  assert.equal(quantiles.p95, 95);
  assert.equal(quantiles.p99, 99);
  assert.equal(computeQuantile([], 95), 0);
  assert.equal(computeQuantile([42], 95), 42);
});

test('trace id/span id derivation is deterministic and W3C-shaped', () => {
  const traceId = deriveTraceId('run-1', 7);
  const spanId = deriveSpanId('run-1', 7, 'order.checkout');
  assert.match(traceId, /^[0-9a-f]{32}$/);
  assert.match(spanId, /^[0-9a-f]{16}$/);
  assert.equal(traceId, deriveTraceId('run-1', 7));
  assert.equal(spanId, deriveSpanId('run-1', 7, 'order.checkout'));
  assert.notEqual(traceId, deriveTraceId('run-2', 7));
  assert.notEqual(spanId, deriveSpanId('run-1', 7, 'dependency.pricing-lookup'));

  const traceparent = buildTraceParent(traceId, spanId);
  assert.match(traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  const parsed = parseTraceParent(traceparent);
  assert.deepEqual(parsed, { traceId, spanId });
});

test('parseTraceParent fails closed on malformed or all-zero trace context', () => {
  assert.equal(parseTraceParent(null), null);
  assert.equal(parseTraceParent('not-a-traceparent'), null);
  assert.equal(parseTraceParent('00-' + '0'.repeat(32) + '-' + '0'.repeat(16) + '-01'), null);
  assert.equal(parseTraceParent('01-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01'), null);
});

test('OTLP span/trace payload builder produces the standard resourceSpans/scopeSpans/spans shape', () => {
  const traceId = deriveTraceId('run-1', 1);
  const rootSpanId = deriveSpanId('run-1', 1, 'order.checkout');
  const depSpanId = deriveSpanId('run-1', 1, 'dependency.pricing-lookup');

  const rootSpan = buildOtlpSpan({
    traceId,
    spanId: rootSpanId,
    name: 'order.checkout',
    kind: OTLP_SPAN_KIND.SERVER,
    startUnixNano: 1000000000,
    endUnixNano: 1500000000,
    attributes: { 'scenario.id': 'latency', 'scenario.run_id': 'run-1' },
    statusCode: OTLP_STATUS_CODE.OK,
  });
  const depSpan = buildOtlpSpan({
    traceId,
    spanId: depSpanId,
    parentSpanId: rootSpanId,
    name: 'dependency.pricing-lookup',
    kind: OTLP_SPAN_KIND.CLIENT,
    startUnixNano: 1100000000,
    endUnixNano: 1490000000,
    attributes: { 'dependency.delay_ms': 390 },
    statusCode: OTLP_STATUS_CODE.OK,
  });

  const payload = buildOtlpTracePayload({
    resourceAttributes: { 'service.name': 'order-pricing-dependency', 'service.namespace': 'propane' },
    scopeName: 'order-dependency-latency',
    spans: [rootSpan, depSpan],
  });

  assert.ok(Array.isArray(payload.resourceSpans));
  assert.equal(payload.resourceSpans.length, 1);
  const [resourceSpan] = payload.resourceSpans;
  assert.ok(Array.isArray(resourceSpan.resource.attributes));
  assert.ok(resourceSpan.resource.attributes.some((a) => a.key === 'service.name' && a.value.stringValue === 'order-pricing-dependency'));
  assert.equal(resourceSpan.scopeSpans.length, 1);
  const [scopeSpan] = resourceSpan.scopeSpans;
  assert.equal(scopeSpan.spans.length, 2);
  assert.equal(scopeSpan.spans[1].parentSpanId, rootSpanId);
  assert.equal(scopeSpan.spans[0].traceId, scopeSpan.spans[1].traceId, 'root and dependency spans must share one trace id');
});

test('evaluateInvariants distinguishes a latency-led incident from an error-led or crash-led one', () => {
  const latencyLed = evaluateInvariants({
    p95Ms: 900, sloThresholdMs: 500, errorRatePct: 0.4, errorCeilingPct: 2, readyReplicas: 1, desiredReplicas: 1,
  });
  assert.equal(latencyLed.sloBreached, true);
  assert.equal(latencyLed.errorWithinCeiling, true);
  assert.equal(latencyLed.allReady, true);
  assert.equal(latencyLed.latencyLedIncident, true);
  assert.equal(latencyLed.healthy, false);

  const errorLed = evaluateInvariants({
    p95Ms: 900, sloThresholdMs: 500, errorRatePct: 10, errorCeilingPct: 2, readyReplicas: 1, desiredReplicas: 1,
  });
  assert.equal(errorLed.latencyLedIncident, false, 'high error rate must not be reported as a genuine latency-led incident');

  const crashLed = evaluateInvariants({
    p95Ms: 900, sloThresholdMs: 500, errorRatePct: 0.4, errorCeilingPct: 2, readyReplicas: 0, desiredReplicas: 1,
  });
  assert.equal(crashLed.latencyLedIncident, false, 'pods that are not Ready must not be reported as a genuine latency-led incident');

  const healthyBaseline = evaluateInvariants({
    p95Ms: 60, sloThresholdMs: 500, errorRatePct: 0.2, errorCeilingPct: 2, readyReplicas: 1, desiredReplicas: 1,
  });
  assert.equal(healthyBaseline.healthy, true);
  assert.equal(healthyBaseline.latencyLedIncident, false);
});

test('a single simulated failure phase breaches the SLO within the phase while keeping errors low', () => {
  const phase = simulatePhase({
    phase: 'failure',
    requestCount: 60,
    startSequence: 0,
    config: { delayMode: 'ramp', rampFromMs: 45, rampToMs: 950, rampDurationSeconds: 60 },
    errorRateBp: 40,
    jitterSpreadMs: 25,
  });
  assert.ok(phase.quantiles.p95 > DEFAULT_SLO_P95_THRESHOLD_MS);
  assert.ok(phase.errorRatePct <= DEFAULT_ERROR_RATE_CEILING_PCT);
});

test('a single simulated baseline phase stays under the SLO threshold', () => {
  const phase = simulatePhase({
    phase: 'baseline',
    requestCount: 60,
    startSequence: 0,
    config: { delayMode: 'fixed', fixedDelayMs: 45 },
    errorRateBp: 20,
    jitterSpreadMs: 15,
  });
  assert.ok(phase.quantiles.p95 < DEFAULT_SLO_P95_THRESHOLD_MS);
});

test('five deterministic baseline/failure/recovery cycles are repeatable and each satisfy the scenario contract', () => {
  const results = runDeterministicCycles({ cycles: 5, requestsPerPhase: 60 });
  assert.equal(results.length, 5);

  for (const result of results) {
    assert.equal(result.invariants.baseline.healthy, true, `cycle ${result.cycle} baseline should be healthy`);
    assert.equal(result.invariants.failure.latencyLedIncident, true, `cycle ${result.cycle} failure should be a genuine latency-led incident`);
    assert.equal(result.invariants.recovery.healthy, true, `cycle ${result.cycle} recovery should restore health`);
    // Acceptance criterion: activation raises p95 above threshold within 3 minutes (180s).
    assert.ok(result.secondsToBreach !== null, `cycle ${result.cycle} never breached the SLO threshold`);
    assert.ok(result.secondsToBreach <= 180, `cycle ${result.cycle} took ${result.secondsToBreach}s to breach the SLO, expected <= 180s`);
  }

  // Repeated runs (cycles) must produce comparable — here, identical — quantiles
  // since the math is a pure deterministic function of the request sequence.
  const [first, ...rest] = results;
  for (const result of rest) {
    assert.equal(result.baseline.quantiles.p95, first.baseline.quantiles.p95, 'baseline p95 must be comparable across repeated cycles');
    assert.equal(result.failure.quantiles.p95, first.failure.quantiles.p95, 'failure p95 must be comparable across repeated cycles');
    assert.equal(result.recovery.quantiles.p95, first.recovery.quantiles.p95, 'recovery p95 must be comparable across repeated cycles');
  }
});

test('runDeterministicCycles is reproducible across independent invocations (no reliance on wall-clock/network timing)', () => {
  const runA = runDeterministicCycles({ cycles: 3, requestsPerPhase: 40 });
  const runB = runDeterministicCycles({ cycles: 3, requestsPerPhase: 40 });
  assert.deepEqual(
    runA.map((r) => r.failure.quantiles),
    runB.map((r) => r.failure.quantiles),
  );
  assert.deepEqual(
    runA.map((r) => r.secondsToBreach),
    runB.map((r) => r.secondsToBreach),
  );
});
