const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readPublic(file) {
  return fs.readFileSync(path.resolve(__dirname, '../public', file), 'utf8');
}

test('index.html loads api-client.js before app.js so window.MissionControlApiClient exists when app.js runs', () => {
  const html = readPublic('index.html');
  const apiClientScriptIndex = html.indexOf('/api-client.js');
  const appScriptIndex = html.indexOf('/app.js');
  assert.ok(apiClientScriptIndex > -1, 'api-client.js must be loaded');
  assert.ok(appScriptIndex > -1, 'app.js must be loaded');
  assert.ok(apiClientScriptIndex < appScriptIndex, 'api-client.js must load before app.js');
});

test('index.html declares the remote-auth modal with the elements app.js expects, and the token input is masked', () => {
  const html = readPublic('index.html');
  assert.match(html, /id="remote-auth-modal"/);
  assert.match(html, /id="remote-auth-token-input"/);
  assert.match(html, /type="password"[^>]*id="remote-auth-token-input"|id="remote-auth-token-input"[^>]*type="password"/);
  assert.match(html, /data-action="submit-remote-auth"/);
  assert.match(html, /data-action="cancel-remote-auth"/);
});

test('index.html keeps the strict existing CSP unchanged (adding a request header requires no CSP relaxation)', () => {
  const html = readPublic('index.html');
  const cspMatch = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(cspMatch, 'CSP meta tag must exist');
  assert.match(cspMatch[1], /connect-src 'self'/);
  assert.match(cspMatch[1], /script-src 'self'/);
  assert.doesNotMatch(cspMatch[1], /unsafe-inline'[^;]*script/i);
});

test('app.js creates the shared apiClient via MissionControlApiClient.createApiClient with an onAuthRequired callback', () => {
  const js = readPublic('app.js');
  assert.match(js, /window\.MissionControlApiClient\.createApiClient/);
  assert.match(js, /onAuthRequired:\s*showRemoteAuthModal/);
});

test('app.js wires submit/cancel actions for the remote-auth modal and an Enter/Escape keydown handler on the token input', () => {
  const js = readPublic('app.js');
  assert.match(js, /function showRemoteAuthModal/);
  assert.match(js, /function submitRemoteAuthToken/);
  assert.match(js, /function cancelRemoteAuthModal/);
  assert.match(js, /case 'submit-remote-auth':/);
  assert.match(js, /case 'cancel-remote-auth':/);
  assert.match(js, /remote-auth-token-input['"]\)\.addEventListener\('keydown'/);
});

test('app.js no longer contains any raw fetch("/api/...") call sites — every network call goes through the shared apiClient/api()', () => {
  const js = readPublic('app.js');
  assert.doesNotMatch(js, /\bfetch\(/, 'every network call must go through apiClient.request()/api() so CSRF and remote-token handling stay centralized');
});

test('app.js never assigns the token input value to textContent or any other DOM output surface', () => {
  const js = readPublic('app.js');
  // The token input's value is only ever read (to submit) and cleared — it
  // must never be echoed into textContent, innerHTML, toast(), or a log.
  assert.doesNotMatch(js, /textContent\s*=\s*(?:input\.value|token)\b/);
  assert.doesNotMatch(js, /toast\([^)]*token/i);
  assert.doesNotMatch(js, /console\.(log|warn|error|info|debug)\([^)]*token/i);
});

test('exportIncident delegates to the standalone, testable incident-export module via the authenticated apiClient (never window.open/plain navigation, which cannot attach the auth header) and never places a token in the URL/DOM', () => {
  const js = readPublic('app.js');
  const exportFnMatch = js.match(/async function exportIncident\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(exportFnMatch, 'exportIncident function must exist');
  const fnBody = exportFnMatch[0];
  assert.doesNotMatch(fnBody, /window\.open/, 'window.open cannot attach the X-Mission-Control-Token header, so it must not be used for exports');
  assert.match(fnBody, /MissionControlIncidentExport\.downloadIncidentExport/, 'exports must delegate to the standalone, unit-tested download module');
  assert.match(fnBody, /request:\s*\(path\)\s*=>\s*apiClient\.request\(path\)/, 'the download must be driven through the shared, authenticated apiClient so the auth header/401-prompt flow applies');
  assert.doesNotMatch(fnBody, /getRemoteToken|remoteToken|csrf/i, 'the token must never be referenced directly when constructing the export request/URL');
});

test('index.html loads incident-export.js after api-client.js and before app.js', () => {
  const html = readPublic('index.html');
  const apiClientIndex = html.indexOf('/api-client.js');
  const exportIndex = html.indexOf('/incident-export.js');
  const appIndex = html.indexOf('/app.js');
  assert.ok(apiClientIndex > -1 && exportIndex > -1 && appIndex > -1);
  assert.ok(apiClientIndex < exportIndex && exportIndex < appIndex);
});

test('README documents the remote token entry flow and explicitly rules out localStorage/query-string usage', () => {
  const readme = fs.readFileSync(path.resolve(__dirname, '../README.md'), 'utf8');
  assert.match(readme, /MISSION_CONTROL_AUTH_TOKEN/);
  assert.match(readme, /sessionStorage/);
  assert.match(readme, /never.*localStorage|localStorage.*never/i, 'the README should explicitly document that localStorage is never used for the token');
});
