'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Acceptance criterion (issue #27): "README, demo script, portals, Mission
// Control, and SRE Agent knowledge include the fictional-data disclaimer."
// This exact sentence must appear verbatim on every required surface.
const REQUIRED_DISCLAIMER = 'ZavaGas and all companies, people, locations, operational data, and incidents in this lab are fictional and used only for demonstration.';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

test('README.md includes the exact fictional-data disclaimer', () => {
  assert.ok(readRepoFile('README.md').includes(REQUIRED_DISCLAIMER));
});

test('docs/DEMO-SCRIPT.md includes the exact fictional-data disclaimer', () => {
  assert.ok(readRepoFile('docs/DEMO-SCRIPT.md').includes(REQUIRED_DISCLAIMER));
});

test('docs/sre-agent-knowledge.md includes the exact fictional-data disclaimer', () => {
  assert.ok(readRepoFile('docs/sre-agent-knowledge.md').includes(REQUIRED_DISCLAIMER));
});

test('the deployed customer portal includes the exact fictional-data disclaimer', () => {
  const manifestText = readRepoFile('k8s/base/application.yaml');
  const customerPortalStart = manifestText.indexOf('name: customer-portal-html');
  const customerPortalEnd = manifestText.indexOf('kind: ConfigMap', manifestText.indexOf('name: customer-portal-nginx'));
  const customerPortalSection = manifestText.slice(customerPortalStart, customerPortalEnd);
  assert.ok(customerPortalSection.includes(REQUIRED_DISCLAIMER), 'customer-portal-html ConfigMap is missing the fictional-data disclaimer');
});

test('the deployed dispatch console includes the exact fictional-data disclaimer', () => {
  const manifestText = readRepoFile('k8s/base/application.yaml');
  const dispatchConsoleStart = manifestText.indexOf('name: dispatch-console-html');
  const dispatchConsoleEnd = manifestText.indexOf('kind: ConfigMap', manifestText.indexOf('name: dispatch-console-nginx'));
  const dispatchConsoleSection = manifestText.slice(dispatchConsoleStart, dispatchConsoleEnd);
  assert.ok(dispatchConsoleSection.includes(REQUIRED_DISCLAIMER), 'dispatch-console-html ConfigMap is missing the fictional-data disclaimer');
});

test('Mission Control includes the exact fictional-data disclaimer', () => {
  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');
  assert.ok(indexHtml.includes(REQUIRED_DISCLAIMER));
});
