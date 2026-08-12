const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readPublic(file) {
  return fs.readFileSync(path.resolve(__dirname, '../public', file), 'utf8');
}

/**
 * These tests guard against the specific regression this round fixes:
 * app.js's cancelOperation() previously always toasted "Operation
 * cancelled" after any DELETE request, even when the server truthfully
 * reported "Already finished" because cancellation lost the race to a
 * process that had already exited (see operation-lifecycle.js's guarded
 * cancelOperation()). That was a fabricated success report. The fix:
 * server.js's DELETE response now includes a structured `cancelled`
 * boolean (and truthful `status`/`exitCode`) instead of only a
 * human-readable `message` string, and app.js branches on that field via
 * the extracted, unit-tested cancel-response.js module.
 */

function extractFunctionBody(js, fnSignaturePattern) {
  const match = js.match(fnSignaturePattern);
  assert.ok(match, `expected to find a function matching ${fnSignaturePattern}`);
  const start = match.index + match[0].length;
  let depth = 1;
  let i = start;
  while (depth > 0 && i < js.length) {
    if (js[i] === '{') depth += 1;
    else if (js[i] === '}') depth -= 1;
    i += 1;
  }
  return js.slice(start, i - 1);
}

test('index.html loads cancel-response.js after incident-export.js and before app.js', () => {
  const html = readPublic('index.html');
  const exportIndex = html.indexOf('/incident-export.js');
  const cancelIndex = html.indexOf('/cancel-response.js');
  const appIndex = html.indexOf('/app.js');
  assert.ok(exportIndex > -1 && cancelIndex > -1 && appIndex > -1);
  assert.ok(exportIndex < cancelIndex && cancelIndex < appIndex);
});

test('app.js\'s cancelOperation() delegates to the standalone, unit-tested cancel-response module rather than unconditionally toasting success', () => {
  const js = readPublic('app.js');
  const fnBody = extractFunctionBody(js, /async function cancelOperation\(\)\s*\{/);
  assert.match(fnBody, /window\.MissionControlCancelResponse\.interpretCancelOperationResponse/, 'cancelOperation must delegate the success/already-finished decision to the extracted module');
  assert.doesNotMatch(fnBody, /toast\(\s*['"]Operation cancelled['"]\s*\)\s*;\s*\n(?!.*if)/, 'must not unconditionally toast success without checking the response first');
});

test('cancelOperation() never toasts the literal success string directly — it always uses the interpreted result\'s toastMessage/toastType', () => {
  const js = readPublic('app.js');
  const fnBody = extractFunctionBody(js, /async function cancelOperation\(\)\s*\{/);
  // The only literal "Operation cancelled" string allowed in app.js now lives inside the delegated module, not here.
  assert.doesNotMatch(fnBody, /toast\(\s*['"]Operation cancelled['"]/, 'the literal success string must not be hardcoded in cancelOperation() itself — only cancel-response.js may decide when to say it');
  assert.match(fnBody, /toast\(result\.toastMessage,\s*result\.toastType\)/);
});

test('cancelOperation() reads the parsed JSON response body (never assumes success from a non-throwing request) and passes response.ok/status/data to the interpreter', () => {
  const js = readPublic('app.js');
  const fnBody = extractFunctionBody(js, /async function cancelOperation\(\)\s*\{/);
  assert.match(fnBody, /response\.json\(\)/);
  assert.match(fnBody, /ok:\s*response\.ok/);
  assert.match(fnBody, /status:\s*response\.status/);
});

test('cancelOperation() only syncs the terminal UI (handleTerminalOperation) when the interpreted result actually provides terminalInfo, and only for the operation that was actually requested to be cancelled', () => {
  const js = readPublic('app.js');
  const fnBody = extractFunctionBody(js, /async function cancelOperation\(\)\s*\{/);
  assert.match(fnBody, /if\s*\(\s*result\.terminalInfo\s*&&\s*currentOpId\s*===\s*opId\s*\)/, 'must guard on both terminalInfo being present and the operation still being the one currently tracked');
  assert.match(fnBody, /handleTerminalOperation\(result\.terminalInfo\)/);
});

test('server.js\'s DELETE /api/operations/:id route returns a structured cancelled boolean plus status/exitCode in every response branch, not just a message string', () => {
  const serverJs = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
  const deleteRouteMatch = serverJs.match(/app\.delete\(\s*['"]\/api\/operations\/:id['"]\s*,\s*\(req,\s*res\)\s*=>\s*\{[\s\S]*?\n\}\);/);
  assert.ok(deleteRouteMatch, 'DELETE /api/operations/:id route must exist');
  const routeBody = deleteRouteMatch[0];

  // Every res.json(...) call in this route must include a `cancelled` field.
  const jsonCalls = routeBody.match(/res\.json\(\{[^}]*\}\)/g) || [];
  assert.ok(jsonCalls.length >= 3, 'expected at least 3 distinct response branches (already-terminal, childExited, cancelOperation-lost, cancelOperation-won)');
  for (const call of jsonCalls) {
    assert.match(call, /cancelled:\s*(true|false)/, `every DELETE response must include an explicit cancelled boolean: ${call}`);
    assert.match(call, /status:\s*op\.status/, `every DELETE response must include the operation's truthful current status: ${call}`);
  }
  // Exactly one branch reports cancelled: true — the winning cancellation path.
  const trueCalls = jsonCalls.filter((c) => /cancelled:\s*true/.test(c));
  assert.equal(trueCalls.length, 1, 'exactly one response branch (the winning cancellation) may report cancelled: true');
});

test('cancel-response.js interpretation is never bypassed by a raw string match on "Already finished"/"Cancelled" in app.js', () => {
  const js = readPublic('app.js');
  const fnBody = extractFunctionBody(js, /async function cancelOperation\(\)\s*\{/);
  assert.doesNotMatch(fnBody, /['"]Already finished['"]/, 'cancelOperation() must never pattern-match on the message string — only the structured cancelled/status fields, via the extracted interpreter');
});
