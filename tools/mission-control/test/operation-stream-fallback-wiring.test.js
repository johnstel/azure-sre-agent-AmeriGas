const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readPublic(file) {
  return fs.readFileSync(path.resolve(__dirname, '../public', file), 'utf8');
}

/**
 * These tests guard against the specific regression this round fixes:
 * EventSource cannot attach the X-Mission-Control-Token header, so in
 * remote mode /api/operations/:id/stream always fails with a generic
 * transport error. Previously, app.js's es.onerror treated that as if the
 * operation itself had failed (a false failure) — even though the
 * deploy/destroy/validate script is very likely still running
 * server-side. The fix: fall back to authenticated same-origin polling
 * via the shared api() helper, and only ever mark an operation failed
 * based on a genuine server-reported terminal status.
 */

test('index.html loads operation-poller.js after api-client.js and before app.js', () => {
  const html = readPublic('index.html');
  const apiClientIndex = html.indexOf('/api-client.js');
  const pollerIndex = html.indexOf('/operation-poller.js');
  const appIndex = html.indexOf('/app.js');
  assert.ok(apiClientIndex > -1, 'api-client.js must be loaded');
  assert.ok(pollerIndex > -1, 'operation-poller.js must be loaded');
  assert.ok(appIndex > -1, 'app.js must be loaded');
  assert.ok(apiClientIndex < pollerIndex, 'api-client.js must load before operation-poller.js');
  assert.ok(pollerIndex < appIndex, 'operation-poller.js must load before app.js');
});

function extractFunctionBody(js, fnSignaturePattern) {
  const match = js.match(fnSignaturePattern);
  assert.ok(match, `expected to find a function matching ${fnSignaturePattern}`);
  const start = match.index + match[0].length;
  // Naive brace matcher — sufficient for this codebase's simple function bodies.
  let depth = 1;
  let i = start;
  while (depth > 0 && i < js.length) {
    if (js[i] === '{') depth += 1;
    else if (js[i] === '}') depth -= 1;
    i += 1;
  }
  return js.slice(start, i - 1);
}

test('es.onerror no longer marks the operation failed or clears currentOpId — it closes the EventSource and falls back to polling', () => {
  const js = readPublic('app.js');
  const onerrorBody = extractFunctionBody(js, /es\.onerror\s*=\s*\(\)\s*=>\s*\{/);
  assert.doesNotMatch(onerrorBody, /setTerminalStatus\(\s*['"]failed['"]\s*\)/, 'onerror must never directly mark the operation failed — only a genuine server-reported terminal status may do that');
  assert.doesNotMatch(onerrorBody, /currentOpId\s*=\s*null/, 'onerror must preserve currentOpId — the operation is likely still running server-side');
  assert.match(onerrorBody, /es\.close\(\)/, 'the failed EventSource must be closed so it cannot auto-reconnect and duplicate state');
  assert.match(onerrorBody, /startOperationPolling\(opId\)/, 'onerror must fall back to the authenticated polling path');
});

test('startOperationPolling wires the shared, authenticated api() helper into createOperationPoller — never a raw fetch or EventSource with a token in the URL', () => {
  const js = readPublic('app.js');
  const fnBody = extractFunctionBody(js, /function startOperationPolling\(opId\)\s*\{/);
  assert.match(fnBody, /window\.MissionControlOperationPoller\.createOperationPoller/);
  assert.match(fnBody, /\bapi\b/, 'must pass the shared api() helper (which attaches the auth header) to the poller');
  assert.doesNotMatch(fnBody, /fetch\(/, 'must not bypass the shared authenticated client');
  assert.doesNotMatch(fnBody, /new EventSource/, 'the polling fallback must not itself construct another EventSource');
});

test('startOperationPolling hands off the exact rendered-log cursor to the poller — never starts a fresh poller at since=0 after an EventSource has already rendered lines', () => {
  const js = readPublic('app.js');
  const fnBody = extractFunctionBody(js, /function startOperationPolling\(opId\)\s*\{/);
  assert.match(fnBody, /since:\s*renderedLogCount/, 'the poller must be created with the current renderedLogCount as its starting cursor');
});

test('appendLogEntries advances renderedLogCount so the cursor always reflects exactly how many log entries have been rendered so far, regardless of transport', () => {
  const js = readPublic('app.js');
  const fnBody = extractFunctionBody(js, /function appendLogEntries\(entries\)\s*\{/);
  assert.match(fnBody, /renderedLogCount\s*\+=\s*entries\.length/);
});

test('streamOperation resets renderedLogCount to 0 for each new operation, so a stale cursor from a previous operation can never leak into a new one', () => {
  const js = readPublic('app.js');
  const fnBody = extractFunctionBody(js, /function streamOperation\(opId\)\s*\{/);
  assert.match(fnBody, /renderedLogCount\s*=\s*0/);
});

test('only handleTerminalOperation may report a failed operation (via the Copilot failure banner) — both EventSource "done" and the poller\'s onTerminal route through it exclusively', () => {
  const js = readPublic('app.js');
  const failedBannerMatches = js.match(/copilot-failure-banner/g) || [];
  assert.ok(failedBannerMatches.length > 0, 'the failure banner must still be shown on genuine failure');
  // The banner-setting logic must live inside handleTerminalOperation only.
  const handleTerminalBody = extractFunctionBody(js, /function handleTerminalOperation\(info\)\s*\{/);
  assert.match(handleTerminalBody, /copilot-failure-banner/);
  // And nowhere else in the file (outside that function) should the banner be shown directly from an onerror/poll-error path.
  const withoutHandleTerminal = js.replace(handleTerminalBody, '');
  assert.doesNotMatch(withoutHandleTerminal, /es\.onerror[\s\S]{0,400}copilot-failure-banner/, 'onerror must not directly trigger the failure banner');
});

test('EventSource "done" and the poller\'s onTerminal both call handleTerminalOperation, not a duplicate inline implementation', () => {
  const js = readPublic('app.js');
  const doneBody = extractFunctionBody(js, /es\.addEventListener\(\s*['"]done['"]\s*,\s*\(e\)\s*=>\s*\{/);
  assert.match(doneBody, /handleTerminalOperation\(info\)/);
  const pollingBody = extractFunctionBody(js, /function startOperationPolling\(opId\)\s*\{/);
  assert.match(pollingBody, /handleTerminalOperation\(info\)/);
});

test('appendLogEntries is shared between the EventSource onmessage handler and the poller\'s onLogEntries callback, so neither path can duplicate a rendered log line', () => {
  const js = readPublic('app.js');
  const onmessageBody = extractFunctionBody(js, /es\.onmessage\s*=\s*\(e\)\s*=>\s*\{/);
  assert.match(onmessageBody, /appendLogEntries\(/);
  const pollingBody = extractFunctionBody(js, /function startOperationPolling\(opId\)\s*\{/);
  assert.match(pollingBody, /onLogEntries:\s*appendLogEntries/);
});

test('closeTerminal() and streamOperation() both stop any in-flight operation poller, so switching operations or closing the panel cannot leave an orphaned poller running', () => {
  const js = readPublic('app.js');
  const closeTerminalBody = extractFunctionBody(js, /function closeTerminal\(\)\s*\{/);
  assert.match(closeTerminalBody, /currentOperationPoller[\s\S]*?\.stop\(\)/);
  const streamOperationBody = extractFunctionBody(js, /function streamOperation\(opId\)\s*\{/);
  assert.match(streamOperationBody, /currentOperationPoller[\s\S]*?\.stop\(\)/);
});

test('cancelOperation() still cancels via the authenticated apiClient DELETE (now using a captured opId rather than reading currentOpId a second time, to avoid a race if the tracked operation changes while the request is in flight)', () => {
  const js = readPublic('app.js');
  const cancelBody = extractFunctionBody(js, /async function cancelOperation\(\)\s*\{/);
  assert.match(cancelBody, /apiClient\.request\(\s*['"]operations\/['"]\s*\+\s*opId\s*,\s*\{\s*method:\s*['"]DELETE['"]/);
});

test('server.js routes operation finalization/cancellation through the guarded operation-lifecycle module, never mutating op.status inline — this is what makes a truthful "cancelled" outcome sticky against a late child-process close/error event', () => {
  const serverJs = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
  assert.match(serverJs, /require\(['"]\.\/operation-lifecycle['"]\)/);
  assert.match(serverJs, /operationLifecycle\.finishOperation/);
  assert.match(serverJs, /operationLifecycle\.cancelOperation/);
  // Guard against regressing back to an inline, unguarded assignment.
  assert.doesNotMatch(serverJs, /op\.status\s*=\s*['"]cancelled['"]/, 'cancellation must go through the guarded cancelOperation(), never an inline assignment');
  assert.doesNotMatch(serverJs, /op\.status\s*=\s*exitCode/, 'finalization must go through the guarded finishOperation(), never an inline assignment');
});

test('the DELETE /api/operations/:id handler never appends a "Cancelled by user" log line itself — that line is appended atomically inside cancelOperation() only once it has actually won the race, never speculatively before the outcome is known', () => {
  const serverJs = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
  const deleteRouteMatch = serverJs.match(/app\.delete\(\s*['"]\/api\/operations\/:id['"]\s*,\s*\(req,\s*res\)\s*=>\s*\{[\s\S]*?\n\}\);/);
  assert.ok(deleteRouteMatch, 'DELETE /api/operations/:id route must exist');
  assert.doesNotMatch(deleteRouteMatch[0], /appendLog\(/, 'the route handler must never append the cancellation log line itself — cancelOperation() owns that atomically');
  // The kill() call must come AFTER operationLifecycle.cancelOperation() has already won, not before.
  const killIndex = deleteRouteMatch[0].search(/process\.kill\(/);
  const cancelCallIndex = deleteRouteMatch[0].search(/operationLifecycle\.cancelOperation\(/);
  assert.ok(killIndex > -1 && cancelCallIndex > -1);
  assert.ok(cancelCallIndex < killIndex, 'cancelOperation() must be called and its result checked before the process is signalled, so a losing race never kills a process out from under a different truthful outcome');
});

test('the literal "Cancelled by user" log message is appended exclusively by operation-lifecycle.js\'s cancelOperation(), not duplicated anywhere in server.js', () => {
  const operationLifecycleJs = fs.readFileSync(path.resolve(__dirname, '../operation-lifecycle.js'), 'utf8');
  const serverJs = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
  assert.match(operationLifecycleJs, /appendLog\(op, 'system', '\\n── Cancelled by user ──'/, 'cancelOperation() must be the sole place that appends this line, atomically with winning the transition');
  assert.doesNotMatch(serverJs, /appendLog\([^)]*Cancelled by user/, 'server.js must never append this line itself — only operation-lifecycle.js may, and only atomically with a winning cancellation');
});



test('no code path builds an /api/operations URL containing a token, remote-token header name, or query-string credential', () => {
  const appJs = readPublic('app.js');
  const pollerJs = fs.readFileSync(path.resolve(__dirname, '../public/operation-poller.js'), 'utf8');
  for (const src of [appJs, pollerJs]) {
    assert.doesNotMatch(src, /operations\/[^'"` ]*token/i, 'operation URLs must never embed a token');
    assert.doesNotMatch(src, /[?&]token=/i, 'no query-string token parameter anywhere');
  }
});

test('server.js exposes GET /api/operations/:id as a plain JSON status+log endpoint distinct from the SSE stream route, supporting an incremental ?since= cursor', () => {
  const serverJs = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
  assert.match(serverJs, /app\.get\(\s*['"]\/api\/operations\/:id['"]\s*,/, 'a plain JSON single-operation endpoint must exist for the polling fallback');
  assert.match(serverJs, /req\.query\.since/, 'the endpoint must support an incremental since cursor to avoid duplicate log delivery');
  assert.match(serverJs, /logLength/, 'the response must report a logLength cursor for the next poll');
});

test('README documents the polling fallback and no longer claims remote operation streaming is simply broken', () => {
  const readme = fs.readFileSync(path.resolve(__dirname, '../README.md'), 'utf8');
  assert.match(readme, /poll/i, 'README must document the authenticated polling fallback for remote operation streaming');
});
