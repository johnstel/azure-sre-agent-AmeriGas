/**
 * Domain: Shared
 *
 * Deterministic math for the "Dependency Latency" breakable scenario
 * (issue #22): a gradual, configuration-driven slowdown of the synthetic
 * order-checkout -> pricing-lookup dependency hop.
 *
 * This module is intentionally dependency-free and side-effect-free (no
 * network, no filesystem, no `Math.random`) so it can be:
 *   1. Unit tested directly (see test/order-dependency-latency.test.js),
 *      including a five-cycle baseline/failure/recovery harness that runs
 *      entirely in memory ("fake/local mode").
 *   2. Mirrored by the self-contained runtime scripts embedded in the
 *      `order-pricing-dependency-script` and `order-checkout-probe-script`
 *      ConfigMaps in k8s/base/application.yaml, which cannot `require()`
 *      this file (they run from a mounted ConfigMap with no node_modules).
 *      The scenario manifest test (order-dependency-latency-scenario.test.js)
 *      cross-checks that the deployed inline scripts use the same constants
 *      and formulas as this module so the two never silently drift apart.
 *
 * Every value here is a deterministic function of its inputs (sequence
 * numbers, elapsed milliseconds, run ids) rather than real randomness or
 * wall-clock/network timing, so repeated runs are exactly reproducible —
 * satisfying the issue #22 requirement that thresholds "do not depend on
 * public internet timing."
 */

const crypto = require('node:crypto');

// Documented SLO/error-ceiling contract for this scenario. Keep in sync with
// the `slo_p95_threshold_ms` / `error_rate_ceiling_bp` values in
// k8s/base/application.yaml's order-pricing-dependency-config ConfigMap and
// with docs/BREAKABLE-SCENARIOS.md.
const DEFAULT_SLO_P95_THRESHOLD_MS = 500;
const DEFAULT_ERROR_RATE_CEILING_PCT = 2; // 2%

const DEFAULT_BASELINE_CONFIG = {
  delayMode: 'fixed',
  fixedDelayMs: 45,
  jitterSpreadMs: 15,
  errorRateBp: 20, // 0.2%
};

const DEFAULT_SCENARIO_CONFIG = {
  delayMode: 'ramp',
  rampFromMs: 45,
  rampToMs: 950,
  rampDurationSeconds: 75,
  jitterSpreadMs: 25,
  errorRateBp: 40, // 0.4%
};

/**
 * Compute the base (pre-jitter) dependency delay in milliseconds for a
 * given config and elapsed-since-config-change time.
 *
 * `delayMode: 'fixed'` returns a constant delay (the baseline/recovery
 * state). `delayMode: 'ramp'` linearly ramps from `rampFromMs` to
 * `rampToMs` over `rampDurationSeconds`, then holds at `rampToMs` — this is
 * the "gradual" incident shape described in issue #22, as opposed to a
 * step-function failure.
 */
function computeDelayMs(config, elapsedMs) {
  const mode = config && config.delayMode === 'ramp' ? 'ramp' : 'fixed';
  if (mode === 'fixed') {
    return Math.max(0, Number((config && config.fixedDelayMs) || 0));
  }

  const from = Number((config && config.rampFromMs) || 0);
  const to = Number((config && config.rampToMs) != null ? config.rampToMs : from);
  const durationMs = Math.max(1, Number((config && config.rampDurationSeconds) || 1) * 1000);
  const clampedElapsedMs = Math.max(0, Math.min(Number(elapsedMs) || 0, durationMs));
  const ratio = clampedElapsedMs / durationMs;
  return Math.max(0, Math.round(from + (to - from) * ratio));
}

/**
 * Deterministic pseudo-random jitter in [0, spreadMs) derived purely from
 * the request sequence number. Uses the classic sine-based hash trick so it
 * needs no PRNG state and is 100% reproducible for a given sequence number.
 */
function deterministicJitterMs(sequence, spreadMs) {
  const spread = Math.max(0, Number(spreadMs) || 0);
  if (spread === 0) return 0;
  const x = Math.sin(Number(sequence) * 12.9898) * 43758.5453;
  const frac = x - Math.floor(x);
  return Math.floor(frac * spread);
}

/**
 * Deterministic synthetic-error decision. `errorRateBp` is basis points
 * (1/100th of a percent), e.g. 20 == 0.2%, 200 == 2%. Instead of a plain
 * `sequence % 10000 < bp` test (which would cluster every error into the
 * first `bp` sequence numbers and badly skew any window smaller than
 * 10000 requests), the sequence is first spread across the 0..9999 range
 * with a fixed coprime multiplier (a Weyl sequence). This keeps errors
 * evenly distributed across any window while remaining a pure, reproducible
 * function of the sequence number (no `Math.random`).
 */
function isSyntheticError(sequence, errorRateBp) {
  const bp = Number(errorRateBp) || 0;
  if (bp <= 0) return false;
  const bucket = (Math.abs(Number(sequence) || 0) * 9973) % 10000;
  return bucket < bp;
}

function computeQuantile(samplesMs, percentile) {
  if (!Array.isArray(samplesMs) || samplesMs.length === 0) return 0;
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
  return sorted[rank];
}

function computeQuantiles(samplesMs) {
  return {
    p50: computeQuantile(samplesMs, 50),
    p95: computeQuantile(samplesMs, 95),
    p99: computeQuantile(samplesMs, 99),
  };
}

/** Deterministically derive a 32-hex-char W3C trace id from a run id + sequence. */
function deriveTraceId(runId, sequence) {
  return crypto.createHash('sha256').update(`trace:${runId}:${sequence}`).digest('hex').slice(0, 32);
}

/** Deterministically derive a 16-hex-char W3C span id from a run id + sequence + label. */
function deriveSpanId(runId, sequence, label) {
  return crypto.createHash('sha256').update(`span:${runId}:${sequence}:${label || ''}`).digest('hex').slice(0, 16);
}

function buildTraceParent(traceId, spanId, sampled = true) {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}

/** Parse a W3C `traceparent` header. Returns null for anything malformed so callers must fail closed instead of fabricating a trace. */
function parseTraceParent(header) {
  if (typeof header !== 'string') return null;
  const parts = header.split('-');
  if (parts.length !== 4 || parts[0] !== '00') return null;
  const [, traceId, spanId] = parts;
  if (!/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(spanId)) return null;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId, spanId };
}

function toOtlpAttributeValue(value) {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number' && Number.isInteger(value)) return { intValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  return { stringValue: String(value) };
}

function toOtlpKeyValue(key, value) {
  return { key, value: toOtlpAttributeValue(value) };
}

/** OTLP span kind constants (see OpenTelemetry proto `Span.SpanKind`). */
const OTLP_SPAN_KIND = {
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
};

/** OTLP status code constants (see OpenTelemetry proto `Status.StatusCode`). */
const OTLP_STATUS_CODE = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
};

/** Build a single OTLP/HTTP JSON span object (resourceSpans[].scopeSpans[].spans[] shape). */
function buildOtlpSpan({ traceId, spanId, parentSpanId, name, kind, startUnixNano, endUnixNano, attributes, statusCode, statusMessage }) {
  const span = {
    traceId,
    spanId,
    name,
    kind: kind || OTLP_SPAN_KIND.INTERNAL,
    startTimeUnixNano: String(startUnixNano),
    endTimeUnixNano: String(endUnixNano),
    attributes: Object.entries(attributes || {}).map(([key, value]) => toOtlpKeyValue(key, value)),
    status: { code: statusCode != null ? statusCode : OTLP_STATUS_CODE.OK, message: statusMessage || '' },
  };
  if (parentSpanId) span.parentSpanId = parentSpanId;
  return span;
}

/** Build a full OTLP/HTTP JSON trace export payload (POST body for /v1/traces). */
function buildOtlpTracePayload({ resourceAttributes, scopeName, spans }) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: Object.entries(resourceAttributes || {}).map(([key, value]) => toOtlpKeyValue(key, value)),
        },
        scopeSpans: [
          {
            scope: { name: scopeName || 'order-dependency-latency' },
            spans: spans || [],
          },
        ],
      },
    ],
  };
}

/**
 * Evaluate the scenario's core invariants for a measured window. This is the
 * single source of truth for "is this a genuine latency-led incident"
 * (rather than a crash/error-led one) and for baseline/recovery health.
 */
function evaluateInvariants({ p95Ms, sloThresholdMs, errorRatePct, errorCeilingPct, readyReplicas, desiredReplicas }) {
  const threshold = sloThresholdMs != null ? sloThresholdMs : DEFAULT_SLO_P95_THRESHOLD_MS;
  const ceiling = errorCeilingPct != null ? errorCeilingPct : DEFAULT_ERROR_RATE_CEILING_PCT;
  const sloBreached = Number(p95Ms) > Number(threshold);
  const errorWithinCeiling = Number(errorRatePct) <= Number(ceiling);
  const allReady = Number(desiredReplicas) > 0 && Number(readyReplicas) >= Number(desiredReplicas);
  return {
    sloBreached,
    errorWithinCeiling,
    allReady,
    // A "genuine" latency-led incident: SLO breached, errors still low, pods still Ready.
    latencyLedIncident: sloBreached && errorWithinCeiling && allReady,
    // A "healthy" baseline/recovery window: SLO respected, errors low, pods Ready.
    healthy: !sloBreached && errorWithinCeiling && allReady,
  };
}

/**
 * Simulate one phase (baseline | failure | recovery) of synthetic
 * order-checkout traffic entirely in memory, one request per simulated
 * second, and return latency samples/quantiles/error-rate for that phase.
 */
function simulatePhase({ phase, requestCount, startSequence = 0, config, errorRateBp, jitterSpreadMs, intervalMs = 1000 }) {
  const samples = [];
  let errors = 0;
  for (let i = 0; i < requestCount; i++) {
    const sequence = startSequence + i;
    const elapsedMs = i * intervalMs;
    const baseDelay = computeDelayMs(config, elapsedMs);
    const jitter = deterministicJitterMs(sequence, jitterSpreadMs);
    const totalDelayMs = baseDelay + jitter;
    if (isSyntheticError(sequence, errorRateBp)) errors += 1;
    samples.push(totalDelayMs);
  }
  const quantiles = computeQuantiles(samples);
  const errorRatePct = requestCount > 0 ? (errors / requestCount) * 100 : 0;
  return { phase, requestCount, samples, quantiles, errors, errorRatePct };
}

/**
 * Deterministic five-cycle (default) baseline -> failure -> recovery
 * harness. Every cycle uses the same fixed formulas/config, so results are
 * exactly reproducible across cycles and across process runs — this is the
 * "fake/local mode" validation required by issue #22 in environments with
 * no live AKS cluster.
 */
function runDeterministicCycles({
  cycles = 5,
  requestsPerPhase = 60,
  runIdPrefix = 'harness',
  baselineConfig = DEFAULT_BASELINE_CONFIG,
  scenarioConfig = DEFAULT_SCENARIO_CONFIG,
  sloThresholdMs = DEFAULT_SLO_P95_THRESHOLD_MS,
  errorCeilingPct = DEFAULT_ERROR_RATE_CEILING_PCT,
} = {}) {
  const results = [];
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const runId = `${runIdPrefix}-${cycle}`;

    const baseline = simulatePhase({
      phase: 'baseline',
      requestCount: requestsPerPhase,
      startSequence: 0,
      config: baselineConfig,
      errorRateBp: baselineConfig.errorRateBp,
      jitterSpreadMs: baselineConfig.jitterSpreadMs,
    });
    const failure = simulatePhase({
      phase: 'failure',
      requestCount: requestsPerPhase,
      startSequence: requestsPerPhase,
      config: scenarioConfig,
      errorRateBp: scenarioConfig.errorRateBp,
      jitterSpreadMs: scenarioConfig.jitterSpreadMs,
    });
    const recovery = simulatePhase({
      phase: 'recovery',
      requestCount: requestsPerPhase,
      startSequence: requestsPerPhase * 2,
      config: baselineConfig,
      errorRateBp: baselineConfig.errorRateBp,
      jitterSpreadMs: baselineConfig.jitterSpreadMs,
    });

    const invariants = {
      baseline: evaluateInvariants({
        p95Ms: baseline.quantiles.p95,
        sloThresholdMs,
        errorRatePct: baseline.errorRatePct,
        errorCeilingPct,
        readyReplicas: 1,
        desiredReplicas: 1,
      }),
      failure: evaluateInvariants({
        p95Ms: failure.quantiles.p95,
        sloThresholdMs,
        errorRatePct: failure.errorRatePct,
        errorCeilingPct,
        readyReplicas: 1,
        desiredReplicas: 1,
      }),
      recovery: evaluateInvariants({
        p95Ms: recovery.quantiles.p95,
        sloThresholdMs,
        errorRatePct: recovery.errorRatePct,
        errorCeilingPct,
        readyReplicas: 1,
        desiredReplicas: 1,
      }),
    };

    // Time (in simulated seconds) at which the failure phase's cumulative
    // p95-so-far first exceeds the SLO threshold — used to assert the "within
    // three minutes" acceptance criterion.
    let secondsToBreach = null;
    for (let i = 1; i <= failure.requestCount; i += 1) {
      const soFar = computeQuantiles(failure.samples.slice(0, i));
      if (soFar.p95 > sloThresholdMs) {
        secondsToBreach = i - 1;
        break;
      }
    }

    results.push({
      cycle,
      runId,
      baseline,
      failure,
      recovery,
      invariants,
      secondsToBreach,
    });
  }
  return results;
}

module.exports = {
  DEFAULT_SLO_P95_THRESHOLD_MS,
  DEFAULT_ERROR_RATE_CEILING_PCT,
  DEFAULT_BASELINE_CONFIG,
  DEFAULT_SCENARIO_CONFIG,
  OTLP_SPAN_KIND,
  OTLP_STATUS_CODE,
  computeDelayMs,
  deterministicJitterMs,
  isSyntheticError,
  computeQuantile,
  computeQuantiles,
  deriveTraceId,
  deriveSpanId,
  buildTraceParent,
  parseTraceParent,
  toOtlpAttributeValue,
  toOtlpKeyValue,
  buildOtlpSpan,
  buildOtlpTracePayload,
  evaluateInvariants,
  simulatePhase,
  runDeterministicCycles,
};
