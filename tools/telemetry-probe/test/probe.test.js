'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('probe propagates W3C trace context and emits correlated real-response telemetry', async () => {
  const received = [];
  let traceparent;
  const target = http.createServer((request, response) => {
    traceparent = request.headers.traceparent;
    const status = request.url === '/healthy' ? 200 : 503;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(status === 200 ? '{"status":"healthy"}' : '{"status":"controlled failure"}');
  });
  const collector = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      response.writeHead(200);
      response.end('{}');
    });
  });

  const targetPort = await listen(target);
  const collectorPort = await listen(collector);
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${collectorPort}`;
  process.env.RUN_CORRELATION_ID = '0123456789abcdef0123456789abcdef';
  process.env.SCENARIO_ID = 'observability-test';
  const modulePath = require.resolve('../probe');
  delete require.cache[modulePath];
  const { observeTarget } = require('../probe');

  try {
    const healthyResult = await observeTarget({
      service: 'tank-monitor',
      url: `http://127.0.0.1:${targetPort}/healthy`,
    });
    const result = await observeTarget({
      service: 'order-service',
      url: `http://127.0.0.1:${targetPort}/controlled-failure`,
      controlledFailure: true,
    });

    assert.equal(healthyResult.statusCode, 200);
    assert.equal(result.statusCode, 503);
    assert.match(traceparent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
    assert.deepEqual(received.map((entry) => entry.path).sort(), [
      '/v1/logs', '/v1/logs', '/v1/metrics', '/v1/metrics', '/v1/traces', '/v1/traces',
    ]);

    const tracePayload = received.filter((entry) => entry.path === '/v1/traces')[1].body;
    const spans = tracePayload.resourceSpans[0].scopeSpans[0].spans;
    assert.equal(spans[0].traceId, spans[1].traceId);
    assert.equal(spans[1].parentSpanId, spans[0].spanId);
    assert.equal(spans[0].kind, 2);
    assert.equal(spans[1].kind, 3);
    assert.equal(spans[1].events[0].name, 'exception');

    const resourceAttributes = Object.fromEntries(
      tracePayload.resourceSpans[0].resource.attributes.map(({ key, value }) => [key, value.stringValue]),
    );
    assert.equal(resourceAttributes['service.name'], 'order-service');
    assert.equal(resourceAttributes['service.namespace'], 'propane');
    assert.equal(resourceAttributes['deployment.environment'], 'demo');
    assert.equal(resourceAttributes['transaction.id'], process.env.RUN_CORRELATION_ID);

    const healthyLog = received.find((entry) =>
      entry.path === '/v1/logs'
      && entry.body.resourceLogs[0].resource.attributes.some(({ key, value }) =>
        key === 'service.name' && value.stringValue === 'tank-monitor')).body;
    const healthyLogKeys = healthyLog.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.map(({ key }) => key);
    assert.equal(healthyLogKeys.includes('exception.type'), false);
    assert.equal(healthyLogKeys.includes('exception.message'), false);
  } finally {
    await Promise.all([close(target), close(collector)]);
  }
});
