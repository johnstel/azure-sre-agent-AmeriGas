'use strict';

/**
 * Deterministic Azure subscription/resource-group discovery for the ZavaGas
 * demo lab. Shared by server.js (HTTP request handlers) and copilot-tools.js
 * (the get_cluster_info Copilot tool) so there is exactly one discovery
 * algorithm, not two independently drifting copies.
 *
 * Resolution order — this NEVER silently falls back to "whichever resource
 * group happens to exist":
 *
 *   1. Explicit override (e.g. an HTTP request query parameter, or an
 *      explicit readiness request parameter).
 *   2. Explicit environment variable (MISSION_CONTROL_SUBSCRIPTION_ID /
 *      MISSION_CONTROL_RESOURCE_GROUP), typically set from deployment
 *      output (see scripts/deploy.ps1).
 *   3. Only when neither of the above is configured: the single resource
 *      group tagged workload=<DEPLOYMENT_WORKLOAD_TAG>, applied by
 *      infra/bicep/main.bicep. If zero or more than one resource group
 *      matches that tag, this throws instead of guessing.
 *
 * An explicitly configured resource group is always verified to exist
 * (via `az group exists` + `az group show`) before being trusted, so a
 * stale or mistyped value fails loudly rather than silently reporting a
 * broken scope as "ready". This remains deterministic across a tag
 * migration (scripts/migrate-brand-tags.ps1): an explicit resource group
 * override is checked first and does not depend on the tag value at all,
 * and the tag-based fallback always re-reads the live tag rather than any
 * cached value.
 */

const DEPLOYMENT_WORKLOAD_TAG = 'zavagas-propane-demo';

function firstTrimmed(...values) {
  for (const value of values) {
    const trimmed = String(value === undefined || value === null ? '' : value).trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/**
 * @param {object} options
 * @param {(...args: string[]) => Promise<string>} options.az - executes the
 *   `az` CLI and resolves with stdout (or rejects/throws). Injected so this
 *   module never spawns a process itself and can be exercised with mocks in
 *   tests — no live Azure calls are made by this module or its tests.
 * @param {string} [options.subscriptionId] - explicit subscription override,
 *   e.g. from an HTTP request query parameter.
 * @param {string} [options.resourceGroupName] - explicit resource group
 *   override, e.g. from an HTTP request query parameter.
 * @param {NodeJS.ProcessEnv} [options.env] - defaults to process.env.
 * @returns {Promise<{subscriptionId: string, subscriptionName: string, resourceGroupName: string, location: string, discoveredBy: 'explicit'|'tag'}>}
 */
async function resolveDeployedScope({ az, subscriptionId, resourceGroupName, env = process.env } = {}) {
  if (typeof az !== 'function') {
    throw new TypeError('resolveDeployedScope requires an injected az(...) function');
  }

  const explicitSubscriptionId = firstTrimmed(subscriptionId, env.MISSION_CONTROL_SUBSCRIPTION_ID);
  const explicitResourceGroupName = firstTrimmed(resourceGroupName, env.MISSION_CONTROL_RESOURCE_GROUP);

  const accountRaw = await az('account', 'show', '-o', 'json').catch(() => '{}');
  const account = JSON.parse(accountRaw || '{}');
  const resolvedSubscriptionId = explicitSubscriptionId || account.id || '';
  if (!resolvedSubscriptionId) {
    throw new Error('Could not determine an Azure subscription. Run "az login" or set MISSION_CONTROL_SUBSCRIPTION_ID explicitly.');
  }

  if (explicitResourceGroupName) {
    const existsRaw = await az('group', 'exists', '--name', explicitResourceGroupName, '--subscription', resolvedSubscriptionId, '-o', 'json').catch(() => 'false');
    if (String(existsRaw).trim().toLowerCase() !== 'true') {
      throw new Error(`Configured resource group '${explicitResourceGroupName}' was not found in subscription '${resolvedSubscriptionId}'. Verify MISSION_CONTROL_RESOURCE_GROUP (or the resourceGroupName parameter) and the deployed lab.`);
    }
    const rgShowRaw = await az('group', 'show', '--name', explicitResourceGroupName, '--subscription', resolvedSubscriptionId, '-o', 'json').catch(() => '{}');
    const rgShow = JSON.parse(rgShowRaw || '{}');
    return {
      subscriptionId: resolvedSubscriptionId,
      subscriptionName: account.name || '',
      resourceGroupName: explicitResourceGroupName,
      location: rgShow.location || '',
      discoveredBy: 'explicit',
    };
  }

  // No explicit resource group configured — deterministically discover the
  // single tagged resource group. This is the ONLY place a lookup by tag is
  // allowed, and it deliberately fails loudly instead of picking rgs[0].
  const rgRaw = await az('group', 'list', '--tag', `workload=${DEPLOYMENT_WORKLOAD_TAG}`, '--subscription', resolvedSubscriptionId, '-o', 'json').catch(() => '[]');
  const rgs = JSON.parse(rgRaw || '[]');
  if (rgs.length === 0) {
    throw new Error(`No resource group in subscription '${resolvedSubscriptionId}' is tagged workload=${DEPLOYMENT_WORKLOAD_TAG}. Set MISSION_CONTROL_RESOURCE_GROUP (or pass resourceGroupName) explicitly to point Mission Control at the deployed lab.`);
  }
  if (rgs.length > 1) {
    const names = rgs.map((g) => g.name).join(', ');
    throw new Error(`Multiple resource groups are tagged workload=${DEPLOYMENT_WORKLOAD_TAG} (${names}). Set MISSION_CONTROL_RESOURCE_GROUP (or pass resourceGroupName) explicitly to disambiguate.`);
  }

  return {
    subscriptionId: resolvedSubscriptionId,
    subscriptionName: account.name || '',
    resourceGroupName: rgs[0].name,
    location: rgs[0].location || '',
    discoveredBy: 'tag',
  };
}

module.exports = { resolveDeployedScope, DEPLOYMENT_WORKLOAD_TAG };
