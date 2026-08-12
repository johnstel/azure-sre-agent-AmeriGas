const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIncidentStore } = require('../incident-store');

function tempFilePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-incident-store-'));
  return path.join(dir, 'incidents.json');
}

test('incident store persists activation to disk and reloads it (reconnect-safe)', () => {
  const filePath = tempFilePath();
  const store = createIncidentStore({ filePath });
  const incident = store.activate({ scenarioId: 'oom', scenarioName: 'OOMKilled', domain: 'Bulk Tank', impactedService: 'tank-monitor' });

  assert.ok(fs.existsSync(filePath), 'persistence file must be written on activation');

  // Simulate a server restart / browser reconnect: create a brand-new store instance
  // backed by the same file and confirm the active incident survives.
  const reloaded = createIncidentStore({ filePath });
  const active = reloaded.getActive();
  assert.ok(active, 'active incident must survive a reload from disk');
  assert.equal(active.correlationId, incident.correlationId);
  assert.equal(active.scenarioId, 'oom');
});

test('incident store continues monotonic sequencing across a reload', () => {
  const filePath = tempFilePath();
  const store = createIncidentStore({ filePath });
  const incident = store.activate({ scenarioId: 'crash' });
  store.recordImpact(incident.correlationId, {});

  const reloaded = createIncidentStore({ filePath });
  const beforeSeqs = reloaded.getIncident(incident.correlationId).milestones.map((m) => m.seq);
  reloaded.recordEvidence(incident.correlationId, { toolName: 'get_pods', category: 'kubernetes', callId: 'x' });
  const afterSeqs = reloaded.getIncident(incident.correlationId).milestones.map((m) => m.seq);
  assert.ok(Math.max(...afterSeqs) > Math.max(...beforeSeqs));
});

test('incident store persists non-secret redacted state only', () => {
  const filePath = tempFilePath();
  const store = createIncidentStore({ filePath });
  const incident = store.activate({ scenarioId: 'mongodb' });
  store.recordEvidence(incident.correlationId, {
    toolName: 'get_pod_logs',
    category: 'logs',
    callId: 'x',
    summary: 'Authorization: Bearer sk-secrettoken1234567890',
  });

  const raw = fs.readFileSync(filePath, 'utf8');
  assert.doesNotMatch(raw, /sk-secrettoken1234567890/);
});

test('a missing or empty persistence file does not throw and starts fresh', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-incident-store-empty-'));
  const filePath = path.join(dir, 'does-not-exist.json');
  const store = createIncidentStore({ filePath });
  assert.equal(store.getActive(), null);

  fs.writeFileSync(filePath, '', 'utf8');
  const storeFromEmpty = createIncidentStore({ filePath });
  assert.equal(storeFromEmpty.getActive(), null);
});

test('a corrupt persistence file is reported via onPersistError and does not crash the store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-incident-store-corrupt-'));
  const filePath = path.join(dir, 'incidents.json');
  fs.writeFileSync(filePath, '{not valid json', 'utf8');

  let capturedError = null;
  const store = createIncidentStore({ filePath, onPersistError: (err) => { capturedError = err; } });
  assert.ok(capturedError, 'a JSON parse error must be surfaced via onPersistError');
  assert.equal(store.getActive(), null);
});

test('writes are atomic: no temp file is left behind after a successful persist', () => {
  const filePath = tempFilePath();
  const store = createIncidentStore({ filePath });
  store.activate({ scenarioId: 'oom' });
  const dir = path.dirname(filePath);
  const entries = fs.readdirSync(dir);
  assert.ok(entries.every((f) => !f.endsWith('.tmp')), 'no .tmp files should remain after a successful write');
  assert.ok(entries.includes(path.basename(filePath)));
});
