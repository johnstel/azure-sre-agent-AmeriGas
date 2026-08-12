/**
 * Reconnect-safe persistence for the incident timeline engine.
 *
 * Uses a plain JSON file with atomic writes (write-to-temp then rename) —
 * the same lightweight, dependency-free approach already used throughout
 * this repo (no database is used anywhere else in Mission Control). Engine
 * state is redacted before it is ever recorded (see incident-timeline.js),
 * so the file on disk never contains secrets — only scenario ids,
 * timestamps, evidence-source categories, and short (redacted) summaries.
 *
 * On startup, if a prior state file exists it is loaded so an active
 * incident survives a Mission Control server restart or the browser
 * reconnecting mid-run (the "refresh/reconnect must not lose the active
 * incident timeline" acceptance criterion).
 */

const fs = require('fs');
const path = require('path');
const { createIncidentTimelineEngine } = require('./incident-timeline');

const MUTATING_METHODS = [
  'activate',
  'recordImpact',
  'recordEvidence',
  'recordRootCause',
  'proposeAction',
  'approveAction',
  'denyAction',
  'expireAction',
  'recordActionResult',
  'recordPostActionAssertion',
  'recordRecovery',
  'schedulePendingAssertion',
  'bumpPendingAssertionAttempt',
  'resolvePendingAssertion',
  'finalize',
  'sweepExpiredApprovals',
];

function createIncidentStore(options = {}) {
  const filePath = options.filePath || path.resolve(__dirname, '.data', 'incidents.json');
  const onPersistError = typeof options.onPersistError === 'function' ? options.onPersistError : () => {};
  const engine = createIncidentTimelineEngine(options);

  function persist() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const snapshot = engine.exportState();
      const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      onPersistError(err);
    }
  }

  function load() {
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw.trim()) return;
      engine.importState(JSON.parse(raw));
    } catch (err) {
      onPersistError(err);
    }
  }

  if (options.skipLoad !== true) load();

  const store = { ...engine };
  for (const methodName of MUTATING_METHODS) {
    if (typeof engine[methodName] !== 'function') continue;
    store[methodName] = (...args) => {
      const result = engine[methodName](...args);
      persist();
      return result;
    };
  }
  store.__persistNow = persist;
  store.__filePath = filePath;
  return store;
}

module.exports = { createIncidentStore };
