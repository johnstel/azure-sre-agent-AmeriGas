'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveDeployedScope, DEPLOYMENT_WORKLOAD_TAG } = require('../deployment-scope');

// All tests in this file mock the injected `az(...)` function — none of
// them make a live Azure call. This is intentional: there is no live Azure
// environment available in CI/dev, and this module must remain fully
// testable via mocks per issue #27's discovery-refactor requirement.

function mockAz(responses) {
  const calls = [];
  return {
    calls,
    az: async (...args) => {
      calls.push(args);
      const key = args.join(' ');
      for (const [pattern, value] of responses) {
        if (typeof pattern === 'string' ? key.includes(pattern) : pattern.test(key)) {
          if (value instanceof Error) throw value;
          return typeof value === 'string' ? value : JSON.stringify(value);
        }
      }
      throw new Error(`mockAz: no response configured for "${key}"`);
    },
  };
}

test('resolveDeployedScope requires an injected az function', async () => {
  await assert.rejects(() => resolveDeployedScope({}), TypeError);
});

test('resolveDeployedScope uses an explicit resourceGroupName override and verifies it exists (never trusts it blindly)', async () => {
  const { az, calls } = mockAz([
    ['account show', { id: 'sub-explicit', name: 'Explicit Sub' }],
    ['group exists', 'true'],
    ['group show', { name: 'rg-explicit', location: 'eastus2' }],
  ]);

  const scope = await resolveDeployedScope({ az, resourceGroupName: 'rg-explicit', env: {} });

  assert.equal(scope.subscriptionId, 'sub-explicit');
  assert.equal(scope.resourceGroupName, 'rg-explicit');
  assert.equal(scope.location, 'eastus2');
  assert.equal(scope.discoveredBy, 'explicit');
  // Must never call `group list` (the ambiguous "find any resource group"
  // path) once an explicit resource group is configured.
  assert.equal(calls.some((c) => c.includes('list')), false);
});

test('resolveDeployedScope fails loudly when an explicitly configured resource group does not exist', async () => {
  const { az } = mockAz([
    ['account show', { id: 'sub-explicit', name: 'Explicit Sub' }],
    ['group exists', 'false'],
  ]);

  await assert.rejects(
    () => resolveDeployedScope({ az, resourceGroupName: 'rg-does-not-exist', env: {} }),
    /rg-does-not-exist.*was not found/s
  );
});

test('resolveDeployedScope reads explicit overrides from environment variables when no override is passed directly', async () => {
  const { az } = mockAz([
    ['account show', { id: 'sub-from-account', name: 'Account Sub' }],
    ['group exists', 'true'],
    ['group show', { name: 'rg-from-env', location: 'swedencentral' }],
  ]);

  const scope = await resolveDeployedScope({
    az,
    env: {
      MISSION_CONTROL_SUBSCRIPTION_ID: 'sub-from-env',
      MISSION_CONTROL_RESOURCE_GROUP: 'rg-from-env',
    },
  });

  assert.equal(scope.subscriptionId, 'sub-from-env');
  assert.equal(scope.resourceGroupName, 'rg-from-env');
  assert.equal(scope.discoveredBy, 'explicit');
});

test('resolveDeployedScope falls back to the single resource group tagged with the deployment slug only when nothing explicit is configured', async () => {
  const { az } = mockAz([
    ['account show', { id: 'sub-tagged', name: 'Tagged Sub' }],
    ['group list', [{ name: 'rg-srelab-eastus2', location: 'eastus2' }]],
  ]);

  const scope = await resolveDeployedScope({ az, env: {} });

  assert.equal(scope.resourceGroupName, 'rg-srelab-eastus2');
  assert.equal(scope.discoveredBy, 'tag');
});

test('resolveDeployedScope NEVER silently picks "the first resource group" — zero tagged matches throws instead of guessing', async () => {
  const { az } = mockAz([
    ['account show', { id: 'sub-empty', name: 'Empty Sub' }],
    ['group list', []],
  ]);

  await assert.rejects(
    () => resolveDeployedScope({ az, env: {} }),
    new RegExp(`No resource group.*tagged workload=${DEPLOYMENT_WORKLOAD_TAG}`)
  );
});

test('resolveDeployedScope NEVER silently picks "the first resource group" — multiple tagged matches throws instead of guessing', async () => {
  const { az } = mockAz([
    ['account show', { id: 'sub-ambiguous', name: 'Ambiguous Sub' }],
    ['group list', [
      { name: 'rg-srelab-eastus2', location: 'eastus2' },
      { name: 'rg-srelab-swedencentral', location: 'swedencentral' },
    ]],
  ]);

  await assert.rejects(
    () => resolveDeployedScope({ az, env: {} }),
    /Multiple resource groups are tagged.*rg-srelab-eastus2.*rg-srelab-swedencentral/s
  );
});

test('resolveDeployedScope throws when no subscription can be determined at all', async () => {
  const { az } = mockAz([
    ['account show', {}],
  ]);

  await assert.rejects(() => resolveDeployedScope({ az, env: {} }), /Could not determine an Azure subscription/);
});

test('resolveDeployedScope remains deterministic across a tag migration: an explicit resource group override is checked before any tag lookup', async () => {
  // Simulates the "already migrated" state (new zavagas-propane-demo tag)
  // as well as the "not yet migrated" state (old amerigas-propane-demo tag,
  // or no tag at all) — in both cases, an explicit override short-circuits
  // the tag lookup entirely, so migrating the tag can never break discovery
  // for a caller that configures the resource group explicitly.
  const { az, calls } = mockAz([
    ['account show', { id: 'sub-migrated', name: 'Migrated Sub' }],
    ['group exists', 'true'],
    ['group show', { name: 'rg-srelab-eastus2', location: 'eastus2' }],
  ]);

  const scope = await resolveDeployedScope({ az, resourceGroupName: 'rg-srelab-eastus2', env: {} });

  assert.equal(scope.resourceGroupName, 'rg-srelab-eastus2');
  assert.equal(calls.some((c) => c.join(' ').includes('--tag')), false);
});
