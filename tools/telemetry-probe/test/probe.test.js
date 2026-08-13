'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}`)), 5000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (pattern.test(output)) {
        clearTimeout(timeout);
        resolve(output);
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Embedded dependency server exited with code ${code}: ${output}`));
    });
  });
}

async function availablePort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

test('probe propagates W3C trace context and emits correlated real-response telemetry', async () => {
  const received = [];
  let traceparent;
  let transactionIdHeader;
  let runCorrelationHeader;
  const target = http.createServer((request, response) => {
    traceparent = request.headers.traceparent;
    transactionIdHeader = request.headers['x-transaction-id'];
    runCorrelationHeader = request.headers['x-run-correlation-id'];
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
  const { observeTarget, targets } = require('../probe');

  try {
    const healthyServices = ['tank-monitor', 'inventory-service', 'order-service'];
    const healthyResults = [];
    for (const service of healthyServices) {
      healthyResults.push(await observeTarget({
        service,
        url: `http://127.0.0.1:${targetPort}/healthy`,
      }));
    }
    const result = await observeTarget({
      service: 'order-pricing-dependency',
      url: `http://127.0.0.1:${targetPort}/controlled-failure`,
      controlledFailure: true,
    });

    assert.equal(healthyResults.every(({ statusCode }) => statusCode === 200), true);
    assert.equal(result.statusCode, 503);
    assert.equal(result.route, '/controlled-failure');
    assert.match(traceparent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
    assert.equal(transactionIdHeader, process.env.RUN_CORRELATION_ID);
    assert.equal(runCorrelationHeader, process.env.RUN_CORRELATION_ID);
    assert.equal(received.length, 12);

    const tracePayload = received.filter((entry) => entry.path === '/v1/traces')[1].body;
    const spans = tracePayload.resourceSpans[0].scopeSpans[0].spans;
    assert.equal(spans[0].traceId, spans[1].traceId);
    assert.equal(spans[1].parentSpanId, spans[0].spanId);
    assert.equal(spans[0].kind, 1);
    assert.equal(spans[1].kind, 3);
    assert.equal(spans.some(({ kind }) => kind === 2), false);

    for (const entry of received) {
      const resourceGroup = entry.body.resourceSpans?.[0]
        || entry.body.resourceMetrics?.[0]
        || entry.body.resourceLogs?.[0];
      const resourceAttributes = Object.fromEntries(
        resourceGroup.resource.attributes.map(({ key, value }) => [key, value.stringValue]),
      );
      assert.equal(resourceAttributes['service.name'], 'telemetry-probe');
      assert.equal(resourceAttributes['service.namespace'], 'propane');
      assert.equal(resourceAttributes['deployment.environment'], 'demo');
      assert.equal(resourceAttributes['transaction.id'], process.env.RUN_CORRELATION_ID);
      assert.equal(healthyServices.includes(resourceAttributes['service.name']), false);
    }

    const dependencyTargets = received
      .filter((entry) => entry.path === '/v1/traces')
      .map((entry) => Object.fromEntries(
        entry.body.resourceSpans[0].scopeSpans[0].spans[1].attributes
          .map(({ key, value }) => [key, value.stringValue]),
      ));
    assert.deepEqual(
      dependencyTargets.map((entry) => entry['peer.service']).sort(),
      ['inventory-service', 'order-pricing-dependency', 'order-service', 'tank-monitor'],
    );
    assert.equal(dependencyTargets.every((entry) => entry['server.address'] === '127.0.0.1'), true);
    assert.equal(dependencyTargets.every((entry) => entry['span.role'] === 'observed-http-client'), true);

    const healthyLog = received.find((entry) => entry.path === '/v1/logs').body;
    const healthyLogKeys = healthyLog.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.map(({ key }) => key);
    assert.equal(healthyLogKeys.includes('exception.type'), false);
    assert.equal(healthyLogKeys.includes('exception.message'), false);

    const controlledTarget = targets.find(({ controlledFailure }) => controlledFailure);
    assert.equal(controlledTarget.service, 'order-pricing-dependency');
    assert.equal(new URL(controlledTarget.url).pathname, '/controlled-failure');
  } finally {
    await Promise.all([close(target), close(collector)]);
  }
});

test('repo-owned controlled failure route returns deterministic 503 and emits correlated telemetry', async () => {
  const manifest = fs.readFileSync(path.resolve(__dirname, '../../../k8s/base/application.yaml'), 'utf8');
  const configMapStart = manifest.indexOf('  name: order-pricing-dependency-script');
  const scriptStart = manifest.indexOf('  server.js: |\n', configMapStart) + '  server.js: |\n'.length;
  const scriptEnd = manifest.indexOf('\n---', scriptStart);
  assert.ok(configMapStart >= 0 && scriptStart > configMapStart && scriptEnd > scriptStart);
  const serverSource = manifest.slice(scriptStart, scriptEnd)
    .split('\n')
    .map((line) => line.startsWith('    ') ? line.slice(4) : line)
    .join('\n');

  const received = [];
  const collector = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      response.writeHead(200);
      response.end('{}');
    });
  });
  const collectorPort = await listen(collector);
  const dependencyPort = await availablePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'controlled-failure-'));
  const serverPath = path.join(tempDir, 'server.js');
  const configDir = path.join(tempDir, 'config');
  fs.mkdirSync(configDir);
  fs.writeFileSync(serverPath, serverSource, 'utf8');

  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(dependencyPort),
      CONFIG_DIR: configDir,
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collectorPort}`,
      OTEL_SERVICE_NAME: 'order-pricing-dependency',
      SERVICE_NAMESPACE: 'propane',
      DEPLOYMENT_ENVIRONMENT: 'demo',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForOutput(child, /"event":"startup"/);
    const transactionId = '0123456789abcdef0123456789abcdef';
    const traceId = 'abcdef0123456789abcdef0123456789';
    const parentSpanId = '0123456789abcdef';
    const response = await fetch(`http://127.0.0.1:${dependencyPort}/controlled-failure`, {
      headers: {
        traceparent: `00-${traceId}-${parentSpanId}-01`,
        'x-transaction-id': transactionId,
        'x-run-correlation-id': transactionId,
      },
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.status, 'controlled_failure');
    assert.equal(body.route, '/controlled-failure');
    assert.equal(body.transactionId, transactionId);

    const deadline = Date.now() + 3000;
    while (received.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(received.map(({ path: signalPath }) => signalPath).sort(), ['/v1/logs', '/v1/traces']);
    const tracePayload = received.find(({ path: signalPath }) => signalPath === '/v1/traces').body;
    const resourceAttributes = Object.fromEntries(
      tracePayload.resourceSpans[0].resource.attributes.map(({ key, value }) => [key, value.stringValue]),
    );
    const span = tracePayload.resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(resourceAttributes['service.name'], 'order-pricing-dependency');
    assert.equal(resourceAttributes['transaction.id'], transactionId);
    assert.equal(span.kind, 2);
    assert.equal(span.traceId, traceId);
    assert.equal(span.parentSpanId, parentSpanId);
    assert.equal(span.status.code, 2);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await close(collector);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
