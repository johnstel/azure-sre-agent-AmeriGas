'use strict';

/**
 * Deterministic Azure subscription/resource-group discovery for the ZavaGas
 * demo lab. Shared by server.js (HTTP request handlers) and copilot-tools.js
 * (the get_cluster_info Copilot tool) so there is exactly one discovery
 * algorithm, not two independently drifting copies.
 *
 * This NEVER silently falls back to "whichever resource group happens to
 * exist": the subscription/resource group MUST be explicitly configured via
 * environment variables (typically set from deployment output — see
 * scripts/deploy.ps1), and are strictly validated:
 *
 *   - Both MISSION_CONTROL_SUBSCRIPTION_ID (or AZURE_SUBSCRIPTION_ID) and
 *     MISSION_CONTROL_RESOURCE_GROUP (or MISSION_CONTROL_RESOURCE_GROUP_NAME
 *     / AZURE_RESOURCE_GROUP) must be set, or resolution throws.
 *   - The subscription ID must be a syntactically valid GUID.
 *   - The resource group name must be a syntactically valid Azure resource
 *     group name.
 *   - If a caller-supplied subscriptionId/resourceGroupName (e.g. an HTTP
 *     request query parameter) is also present, it MUST match the
 *     server-configured value exactly, or resolution throws — a mismatch is
 *     never silently resolved by preferring one value over the other.
 *   - The live Azure account context's subscription must match the
 *     configured subscription, and the configured resource group must
 *     actually exist in it, or resolution throws.
 *
 * This remains deterministic across a brand-tag migration
 * (scripts/migrate-brand-tags.ps1): resolution here never depends on any
 * Azure tag value at all, only on the explicitly configured environment
 * variables, so migrating mutable tags can never change which
 * subscription/resource group Mission Control considers "the" deployed lab.
 */

function isValidGuid(value) {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(String(value || ''));
}

function isValidResourceGroupName(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._()\-]{0,88}$/.test(String(value || ''));
}

/**
 * Reads and strictly validates the server-configured subscription/resource
 * group from environment variables. Throws (with `statusCode: 400`) if
 * either is missing or malformed — never returns a partial/guessed scope.
 *
 * @param {NodeJS.ProcessEnv} [env] - defaults to process.env. Accepting an
 *   explicit env object keeps this fully testable without mutating the
 *   real process environment.
 */
function resolveConfiguredScope(env = process.env) {
  const subscriptionId = String(env.MISSION_CONTROL_SUBSCRIPTION_ID || env.AZURE_SUBSCRIPTION_ID || '').trim();
  const resourceGroupName = String(env.MISSION_CONTROL_RESOURCE_GROUP || env.MISSION_CONTROL_RESOURCE_GROUP_NAME || env.AZURE_RESOURCE_GROUP || '').trim();

  if (!subscriptionId || !resourceGroupName) {
    throw Object.assign(new Error('Server readiness scope is not configured. Set MISSION_CONTROL_SUBSCRIPTION_ID and MISSION_CONTROL_RESOURCE_GROUP on the server.'), { statusCode: 400 });
  }
  if (!isValidGuid(subscriptionId)) {
    throw Object.assign(new Error(`MISSION_CONTROL_SUBSCRIPTION_ID must be a valid GUID, received: ${subscriptionId}`), { statusCode: 400 });
  }
  if (!isValidResourceGroupName(resourceGroupName)) {
    throw Object.assign(new Error(`MISSION_CONTROL_RESOURCE_GROUP must be a valid Azure resource group name, received: ${resourceGroupName}`), { statusCode: 400 });
  }

  return { subscriptionId, resourceGroupName };
}

/**
 * Resolves the live Azure scope (account name/subscription, resource group
 * name/location) for display and readiness purposes, given an injected
 * `az(...)` function. Never makes a live Azure call itself in tests — the
 * `az` function is always caller-supplied so this module (and its tests)
 * never depend on a live Azure environment.
 *
 * If a caller-supplied subscriptionId/resourceGroupName is provided (e.g.
 * from an HTTP request query parameter), it MUST match the
 * server-configured scope exactly, or this throws instead of silently
 * preferring one value over the other.
 *
 * @param {object} options
 * @param {(...args: string[]) => Promise<string>} options.az
 * @param {string} [options.subscriptionId] - caller-supplied subscription to
 *   cross-check against the configured one (never used as the primary
 *   source of truth on its own).
 * @param {string} [options.resourceGroupName] - caller-supplied resource
 *   group to cross-check against the configured one.
 * @param {NodeJS.ProcessEnv} [options.env] - defaults to process.env.
 */
async function resolveDeployedScope({ az, subscriptionId: suppliedSubscriptionIdRaw, resourceGroupName: suppliedResourceGroupNameRaw, env = process.env } = {}) {
  if (typeof az !== 'function') {
    throw new TypeError('resolveDeployedScope requires an injected az(...) function');
  }

  const configured = resolveConfiguredScope(env);

  const suppliedSubscription = String(suppliedSubscriptionIdRaw || '').trim();
  const suppliedResourceGroup = String(suppliedResourceGroupNameRaw || '').trim();

  if (suppliedSubscription && suppliedSubscription !== configured.subscriptionId) {
    throw Object.assign(new Error(`Request subscriptionId "${suppliedSubscription}" does not match the server-configured subscription "${configured.subscriptionId}".`), { statusCode: 400 });
  }
  if (suppliedResourceGroup && suppliedResourceGroup !== configured.resourceGroupName) {
    throw Object.assign(new Error(`Request resourceGroupName "${suppliedResourceGroup}" does not match the server-configured resource group "${configured.resourceGroupName}".`), { statusCode: 400 });
  }

  const accountRaw = await az('account', 'show', '-o', 'json').catch(() => '{}');
  const account = JSON.parse(accountRaw || '{}');
  const actualSubscriptionId = String(account.id || account.subscriptionId || '').trim();
  if (!actualSubscriptionId) {
    throw Object.assign(new Error('No active Azure account subscription is available.'), { statusCode: 400 });
  }
  if (actualSubscriptionId !== configured.subscriptionId) {
    throw Object.assign(new Error(`Azure account context subscription "${actualSubscriptionId}" does not match the configured subscription "${configured.subscriptionId}".`), { statusCode: 400 });
  }

  const groupRaw = await az('group', 'show', '--subscription', configured.subscriptionId, '--name', configured.resourceGroupName, '-o', 'json').catch(() => '{}');
  const group = JSON.parse(groupRaw || '{}');
  if (!group || !group.name || String(group.name).toLowerCase() !== configured.resourceGroupName.toLowerCase()) {
    throw Object.assign(new Error(`Configured resource group "${configured.resourceGroupName}" was not found in subscription "${configured.subscriptionId}".`), { statusCode: 400 });
  }

  return {
    subscriptionId: configured.subscriptionId,
    subscriptionName: account.name || '',
    resourceGroupName: configured.resourceGroupName,
    location: group.location || '',
  };
}

module.exports = { resolveConfiguredScope, resolveDeployedScope, isValidGuid, isValidResourceGroupName };
