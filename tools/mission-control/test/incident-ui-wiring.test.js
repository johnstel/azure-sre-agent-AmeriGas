const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readPublic(file) {
  return fs.readFileSync(path.resolve(__dirname, '../public', file), 'utf8');
}

test('index.html declares the incident timeline panel with the elements app.js expects', () => {
  const html = readPublic('index.html');
  assert.match(html, /id="incident-panel"/);
  assert.match(html, /id="incident-panel-empty"/);
  assert.match(html, /id="incident-panel-content"/);
  assert.match(html, /id="incident-scorecard-mount"/);
  assert.match(html, /id="incident-evidence-mount"/);
  assert.match(html, /id="incident-timeline-mount"/);
  assert.match(html, /id="incident-links-mount"/);
  assert.match(html, /id="incident-recent-select"/);
  assert.match(html, /data-action="export-incident-md"/);
  assert.match(html, /data-action="export-incident-json"/);
});

test('index.html loads incident-timeline-ui.js before app.js so window.IncidentTimelineUI exists when app.js runs', () => {
  const html = readPublic('index.html');
  const uiScriptIndex = html.indexOf('/incident-timeline-ui.js');
  const appScriptIndex = html.indexOf('/app.js');
  assert.ok(uiScriptIndex > -1, 'incident-timeline-ui.js must be loaded');
  assert.ok(appScriptIndex > -1, 'app.js must be loaded');
  assert.ok(uiScriptIndex < appScriptIndex, 'incident-timeline-ui.js must load before app.js');
});

test('index.html keeps a strict CSP with no inline script/style script-src additions', () => {
  const html = readPublic('index.html');
  const cspMatch = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(cspMatch, 'CSP meta tag must exist');
  assert.match(cspMatch[1], /script-src 'self'/);
  assert.doesNotMatch(cspMatch[1], /unsafe-inline'[^;]*script/i);
});

test('app.js wires the incident timeline refresh loop, recent-run selector, and export actions', () => {
  const js = readPublic('app.js');
  assert.match(js, /function refreshActiveIncident/);
  assert.match(js, /function refreshRecentIncidents/);
  assert.match(js, /function renderIncidentSnapshot/);
  assert.match(js, /function exportIncident/);
  assert.match(js, /setInterval\(refreshActiveIncident/);
  assert.match(js, /incident-recent-select['"]\)\.addEventListener\('change'/);
  assert.match(js, /case 'export-incident-md':/);
  assert.match(js, /case 'export-incident-json':/);
  assert.match(js, /window\.IncidentTimelineUI/);
});

test('app.js fetches incidents through the shared api() helper (CSRF/auth wiring reused, not a bespoke fetch)', () => {
  const js = readPublic('app.js');
  assert.match(js, /api\('incidents\/active'\)/);
  assert.match(js, /api\('incidents\?limit=10'\)/);
  assert.match(js, /api\('incidents\/' \+ encodeURIComponent/);
});

test('incident export always opens the redacted server-generated export endpoint, never constructs content client-side', () => {
  const js = readPublic('app.js');
  assert.match(js, /\/api\/incidents\/' \+ encodeURIComponent\(currentIncidentCorrelationId\) \+ '\/export\.' \+ format/);
});
