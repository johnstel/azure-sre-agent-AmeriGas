'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveConfiguredScope, resolveDeployedScope, isValidGuid, isValidResourceGroupName } = require('../deployment-scope');

// All tests in this file mock the injected `az(...)` function and/or pass an
// explicit `env` object — none of them make a live Azure call, and none of
// them mutate the real process environment. This is intentional: there is
// no live Azure environment available in CI/dev, and this module must
// remain fully testable via mocks per issue #27's discovery-refactor
// requirement.

const VALID_SUBSCRIPTION_ID = '11111111-1111-4111-8111-111111111111';
const VALID_RESOURCE_GROUP = 'rg-srelab-eastus2';

function configuredEnv(overrides = {}) {
  return {
    MISSION_CONTROL_SUBSCRIPTION_ID: VALID_SUBSCRIPTION_ID,
    MISSION_CONTROL_RESOURCE_GROUP: VALID_RESOURCE_GROUP,
    ...overrides,
  };
}

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

test('isValidGuid accepts well-formed GUIDs and rejects everything else', () => {
  assert.equal(isValidGuid(VALID_SUBSCRIPTION_ID), true);
  assert.equal(isValidGuid('not-a-guid'), false);
  assert.equal(isValidGuid(''), false);
  assert.equal(isValidGuid(undefined), false);
});

test('isValidResourceGroupName accepts real resource group names and rejects unsafe input', () => {
  assert.equal(isValidResourceGroupName('rg-srelab-eastus2'), true);
  assert.equal(isValidResourceGroupName('rg;drop table'), false);
  assert.equal(isValidResourceGroupName(''), false);
});

test('resolveConfiguredScope NEVER silently falls back — throws when nothing is configured', () => {
  assert.throws(() => resolveConfiguredScope({}), /Server readiness scope is not configured/);
});

test('resolveConfiguredScope throws on a malformed subscription ID rather than accepting anything', () => {
  assert.throws(
    () => resolveConfiguredScope(configuredEnv({ MISSION_CONTROL_SUBSCRIPTION_ID: 'not-a-guid' })),
    /must be a valid GUID/
  );
});

test('resolveConfiguredScope throws on a malformed resource group name rather than accepting anything', () => {
  assert.throws(
    () => resolveConfiguredScope(configuredEnv({ MISSION_CONTROL_RESOURCE_GROUP: 'bad;name' })),
    /must be a valid Azure resource group name/
  );
});

test('resolveConfiguredScope accepts the AZURE_* environment variable aliases', () => {
  const scope = resolveConfiguredScope({
    AZURE_SUBSCRIPTION_ID: VALID_SUBSCRIPTION_ID,
    AZURE_RESOURCE_GROUP: VALID_RESOURCE_GROUP,
  });
  assert.equal(scope.subscriptionId, VALID_SUBSCRIPTION_ID);
  assert.equal(scope.resourceGroupName, VALID_RESOURCE_GROUP);
});

test('resolveConfiguredScope accepts the MISSION_CONTROL_RESOURCE_GROUP_NAME alias', () => {
  const scope = resolveConfiguredScope({
    MISSION_CONTROL_SUBSCRIPTION_ID: VALID_SUBSCRIPTION_ID,
    MISSION_CONTROL_RESOURCE_GROUP_NAME: VALID_RESOURCE_GROUP,
  });
  assert.equal(scope.resourceGroupName, VALID_RESOURCE_GROUP);
});

test('resolveDeployedScope requires an injected az function', async () => {
  await assert.rejects(() => resolveDeployedScope({ env: configuredEnv() }), TypeError);
});

test('resolveDeployedScope NEVER silently falls back — throws when nothing is configured, without ever calling az', async () => {
  const { az, calls } = mockAz([]);
  await assert.rejects(() => resolveDeployedScope({ az, env: {} }), /Server readiness scope is not configured/);
  assert.equal(calls.length, 0);
});

test('resolveDeployedScope resolves the live scope when the account/resource group match the configured values', async () => {
  const { az } = mockAz([
    ['account show', { id: VALID_SUBSCRIPTION_ID, name: 'Demo Subscription' }],
    ['group show', { name: VALID_RESOURCE_GROUP, location: 'eastus2' }],
  ]);

  const scope = await resolveDeployedScope({ az, env: configuredEnv() });

  assert.equal(scope.subscriptionId, VALID_SUBSCRIPTION_ID);
  assert.equal(scope.subscriptionName, 'Demo Subscription');
  assert.equal(scope.resourceGroupName, VALID_RESOURCE_GROUP);
  assert.equal(scope.location, 'eastus2');
});

test('resolveDeployedScope rejects a caller-supplied subscriptionId that does not match the configured one (never silently prefers either value)', async () => {
  const { az } = mockAz([
    ['account show', { id: VALID_SUBSCRIPTION_ID, name: 'Demo Subscription' }],
    ['group show', { name: VALID_RESOURCE_GROUP, location: 'eastus2' }],
  ]);

  await assert.rejects(
    () => resolveDeployedScope({ az, subscriptionId: '22222222-2222-4222-8222-222222222222', env: configuredEnv() }),
    /does not match the server-configured subscription/
  );
});

test('resolveDeployedScope rejects a caller-supplied resourceGroupName that does not match the configured one', async () => {
  const { az } = mockAz([
    ['account show', { id: VALID_SUBSCRIPTION_ID, name: 'Demo Subscription' }],
    ['group show', { name: VALID_RESOURCE_GROUP, location: 'eastus2' }],
  ]);

  await assert.rejects(
    () => resolveDeployedScope({ az, resourceGroupName: 'rg-some-other-group', env: configuredEnv() }),
    /does not match the server-configured resource group/
  );
});

test('resolveDeployedScope accepts a caller-supplied subscriptionId/resourceGroupName that matches the configured values exactly', async () => {
  const { az } = mockAz([
    ['account show', { id: VALID_SUBSCRIPTION_ID, name: 'Demo Subscription' }],
    ['group show', { name: VALID_RESOURCE_GROUP, location: 'eastus2' }],
  ]);

  const scope = await resolveDeployedScope({
    az,
    subscriptionId: VALID_SUBSCRIPTION_ID,
    resourceGroupName: VALID_RESOURCE_GROUP,
    env: configuredEnv(),
  });

  assert.equal(scope.subscriptionId, VALID_SUBSCRIPTION_ID);
  assert.equal(scope.resourceGroupName, VALID_RESOURCE_GROUP);
});

test('resolveDeployedScope throws when the live Azure account context is a different subscription than configured', async () => {
  const { az } = mockAz([
    ['account show', { id: '33333333-3333-4333-8333-333333333333', name: 'Wrong Subscription' }],
  ]);

  await assert.rejects(
    () => resolveDeployedScope({ az, env: configuredEnv() }),
    /Azure account context subscription .* does not match the configured subscription/
  );
});

test('resolveDeployedScope throws when no active Azure account subscription is available at all', async () => {
  const { az } = mockAz([
    ['account show', {}],
  ]);

  await assert.rejects(() => resolveDeployedScope({ az, env: configuredEnv() }), /No active Azure account subscription is available/);
});

test('resolveDeployedScope throws when the configured resource group does not actually exist in the subscription', async () => {
  const { az } = mockAz([
    ['account show', { id: VALID_SUBSCRIPTION_ID, name: 'Demo Subscription' }],
    ['group show', {}],
  ]);

  await assert.rejects(
    () => resolveDeployedScope({ az, env: configuredEnv() }),
    new RegExp(`Configured resource group "${VALID_RESOURCE_GROUP}" was not found`)
  );
});

test('resolveDeployedScope remains deterministic across a brand-tag migration: resolution never depends on any Azure tag value', async () => {
  // Simulates both the "already migrated" (zavagas-propane-demo tag) and
  // "not yet migrated" (amerigas-propane-demo tag, or no tag at all) states
  // — in both cases resolution is identical because it is driven entirely
  // by the configured environment variables, never by a tag lookup.
  const { az, calls } = mockAz([
    ['account show', { id: VALID_SUBSCRIPTION_ID, name: 'Demo Subscription' }],
    ['group show', { name: VALID_RESOURCE_GROUP, location: 'eastus2', tags: { workload: 'amerigas-propane-demo' } }],
  ]);

  const scope = await resolveDeployedScope({ az, env: configuredEnv() });

  assert.equal(scope.resourceGroupName, VALID_RESOURCE_GROUP);
  assert.equal(calls.some((c) => c.join(' ').includes('--tag')), false);
  assert.equal(calls.some((c) => c[0] === 'group' && c[1] === 'list'), false);
});
