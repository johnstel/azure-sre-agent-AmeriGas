'use strict';

const crypto = require('node:crypto');

const OTLP_ENDPOINT = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://otel-collector.propane.svc.cluster.local:4318').replace(/\/$/, '');
const RUN_ID_PATTERN = /^[a-f0-9]{32}$/;
const PROBE_SERVICE_NAME = 'telemetry-probe';
const runId = (process.env.RUN_CORRELATION_ID || crypto.randomUUID()).replaceAll('-', '').toLowerCase();
const scenarioId = process.env.SCENARIO_ID || 'observability-baseline';

if (!RUN_ID_PATTERN.test(runId)) {
  throw new Error('RUN_CORRELATION_ID must be a UUID represented by 32 hexadecimal characters');
}
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(scenarioId)) {
  throw new Error('SCENARIO_ID must contain only lowercase letters, numbers, and hyphens');
}

const targets = [
  { service: 'tank-monitor', url: 'http://tank-monitor:3000/health' },
  { service: 'inventory-service', url: 'http://inventory-service:3002/health' },
  { service: 'order-service', url: 'http://order-service:3001/health' },
  {
    service: 'order-pricing-dependency',
    url: 'http://order-pricing-dependency:4000/controlled-failure',
    controlledFailure: true,
  },
];

const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
const nanoTime = () => (BigInt(Date.now()) * 1000000n).toString();
const stringValue = (value) => ({ stringValue: String(value) });
const intValue = (value) => ({ intValue: String(value) });
const attributes = (entries) => Object.entries(entries).map(([key, value]) => ({
  key,
  value: typeof value === 'number' ? intValue(value) : stringValue(value),
}));

function resource() {
  return {
    attributes: attributes({
      'service.name': PROBE_SERVICE_NAME,
      'service.namespace': 'propane',
      'deployment.environment': 'demo',
      'scenario.id': scenarioId,
      'run.correlation_id': runId,
      'transaction.id': runId,
      'telemetry.source': 'repo-owned-synthetic-probe',
    }),
  };
}

async function postOtlp(signal, payload) {
  const response = await fetch(`${OTLP_ENDPOINT}/v1/${signal}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`OTLP ${signal} export failed with HTTP ${response.status}`);
  }
}

async function observeTarget(target) {
  const traceId = hex(16);
  const transactionSpanId = hex(8);
  const dependencySpanId = hex(8);
  const started = nanoTime();
  const startedMs = Date.now();
  let statusCode = 0;
  let errorMessage = '';

  try {
    const response = await fetch(target.url, {
      headers: {
        traceparent: `00-${traceId}-${dependencySpanId}-01`,
        'x-transaction-id': runId,
        'x-run-correlation-id': runId,
      },
      signal: AbortSignal.timeout(10000),
    });
    statusCode = response.status;
    await response.arrayBuffer();
    if (!response.ok) errorMessage = `Observed HTTP ${statusCode} from ${target.url}`;
  } catch (error) {
    errorMessage = `Observed request failure for ${target.url}: ${error.message}`;
  }

  const ended = nanoTime();
  const durationMs = Math.max(0, Date.now() - startedMs);
  const expectedFailure = Boolean(target.controlledFailure);
  const failed = statusCode === 0 || statusCode >= 400;
  const common = {
    'http.request.method': 'GET',
    'http.response.status_code': statusCode,
    'url.full': target.url,
    'server.address': new URL(target.url).hostname,
    'server.port': Number(new URL(target.url).port),
    'peer.service': target.service,
    'target.service': target.service,
    'http.route': new URL(target.url).pathname,
    'scenario.id': scenarioId,
    'run.correlation_id': runId,
    'transaction.id': runId,
    'failure.controlled': String(expectedFailure),
  };

  const spans = [
    {
      traceId,
      spanId: transactionSpanId,
      name: `observe ${target.service}`,
      kind: 1,
      startTimeUnixNano: started,
      endTimeUnixNano: ended,
      attributes: attributes({
        'span.role': 'synthetic-transaction',
        'target.service': target.service,
        'scenario.id': scenarioId,
        'run.correlation_id': runId,
        'transaction.id': runId,
      }),
      status: failed && !expectedFailure
        ? { code: 2, message: errorMessage || `HTTP ${statusCode}` }
        : { code: 1 },
    },
    {
      traceId,
      spanId: dependencySpanId,
      parentSpanId: transactionSpanId,
      name: `GET ${target.service}`,
      kind: 3,
      startTimeUnixNano: started,
      endTimeUnixNano: ended,
      attributes: attributes({ ...common, 'span.role': 'observed-http-client' }),
      status: failed ? { code: 2, message: errorMessage || `HTTP ${statusCode}` } : { code: 1 },
      events: failed ? [{
        timeUnixNano: ended,
        name: 'exception',
        attributes: attributes({
          'exception.type': expectedFailure ? 'ControlledHttpFailure' : 'ObservedHttpFailure',
          'exception.message': errorMessage || `Observed HTTP ${statusCode}`,
          'exception.stacktrace': 'Synthetic probe recorded the real HTTP response; no application stack was available.',
          'transaction.id': runId,
          'run.correlation_id': runId,
        }),
      }] : [],
    },
  ];

  await Promise.all([
    postOtlp('traces', {
      resourceSpans: [{
        resource: resource(),
        scopeSpans: [{ scope: { name: 'amerigas.telemetry-probe', version: '1.0.0' }, spans }],
      }],
    }),
    postOtlp('metrics', {
      resourceMetrics: [{
        resource: resource(),
        scopeMetrics: [{
          scope: { name: 'amerigas.telemetry-probe', version: '1.0.0' },
          metrics: [{
            name: 'propane.synthetic.http.duration',
            description: 'Observed duration of a real in-cluster HTTP request',
            unit: 'ms',
            gauge: {
              dataPoints: [{
                attributes: attributes({
                  'peer.service': target.service,
                  'server.address': new URL(target.url).hostname,
                  'transaction.id': runId,
                  'failure.controlled': String(expectedFailure),
                }),
                timeUnixNano: ended,
                asDouble: durationMs,
              }],
            },
          }],
        }],
      }],
    }),
    postOtlp('logs', {
      resourceLogs: [{
        resource: resource(),
        scopeLogs: [{
          scope: { name: 'amerigas.telemetry-probe', version: '1.0.0' },
          logRecords: [{
            timeUnixNano: ended,
            observedTimeUnixNano: ended,
            traceId,
            spanId: dependencySpanId,
            severityNumber: failed ? 17 : 9,
            severityText: failed ? 'ERROR' : 'INFO',
            body: stringValue(failed
              ? (errorMessage || `Observed HTTP ${statusCode}`)
              : `Observed healthy HTTP ${statusCode} from ${target.service}`),
            attributes: attributes({
              ...common,
              'peer.service': target.service,
              ...(failed ? {
                'exception.type': expectedFailure ? 'ControlledHttpFailure' : 'ObservedHttpFailure',
                'exception.message': errorMessage || `Observed HTTP ${statusCode}`,
              } : {}),
            }),
          }],
        }],
      }],
    }),
  ]);

  return {
    service: target.service,
    route: new URL(target.url).pathname,
    statusCode,
    traceId,
    controlledFailure: expectedFailure,
  };
}

async function main() {
  const results = [];
  for (const target of targets) {
    results.push(await observeTarget(target));
  }
  console.log(JSON.stringify({ runCorrelationId: runId, results }));
  return results;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Telemetry probe failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, observeTarget, targets };
