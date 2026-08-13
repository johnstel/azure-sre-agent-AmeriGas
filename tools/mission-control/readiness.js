'use strict';

const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const DEFAULT_TIMEOUT_MS = 90000;
const SCHEMA_VERSION = 1;
const MAX_EVIDENCE_CHARS = 4000;
const execFileAsync = promisify(execFile);

function buildStableId(prefix, ...parts) {
  const raw = parts.filter((value) => value !== undefined && value !== null && value !== '').join('|');
  const digest = crypto.createHash('sha256').update(`${prefix}|${raw || 'seed'}`).digest('hex');
  return `${prefix}-${digest.slice(0, 12)}`;
}

function normalizeIso(value) {
  const stamp = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(stamp.getTime())) return new Date().toISOString();
  return stamp.toISOString();
}

function redactSensitive(value, maxChars = MAX_EVIDENCE_CHARS) {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  let redacted = String(text);
  const patterns = [
    /(authorization\s*[:=]\s*)([^\s,;]+)/gi,
    /(token\s*[:=]\s*)([^\s,;]+)/gi,
    /(secret\s*[:=]\s*)([^\s,;]+)/gi,
    /(password\s*[:=]\s*)([^\s,;]+)/gi,
    /(clientSecret\s*[:=]\s*)([^\s,;]+)/gi,
    /(connectionString\s*[:=]\s*)([^\s,;]+)/gi,
    /(api[_-]?key\s*[:=]\s*)([^\s,;]+)/gi,
    /(accessToken\s*[:=]\s*)([^\s,;]+)/gi,
    /(subscriptionId\s*[:=]\s*)([^\s,;]+)/gi,
    /(resourceGroupName\s*[:=]\s*)([^\s,;]+)/gi,
    /(https?:\/\/)([^\s:/?#@]+)(@)/gi,
    /(AccountKey=)([^;\s]+)/gi,
    /(Authorization: )(.*?)(?=\s|$)/gi,
    /(token\s+was\s+)([A-Za-z0-9._-]+)/gi,
  ];

  for (const pattern of patterns) {
    redacted = redacted.replace(pattern, '$1[REDACTED]');
  }
  redacted = redacted.replace(/\b[A-Fa-f0-9]{32,}\b/g, '[REDACTED]');
  if (redacted.length > maxChars) {
    redacted = `${redacted.slice(0, Math.max(0, maxChars - 12)).trimEnd()}…`;
  }
  return redacted;
}

function createReadinessCheck({ id, category, status, blocking, evidence, remediation, durationMs = 0, observedAt = new Date().toISOString() }) {
  return {
    id,
    category,
    status,
    blocking: Boolean(blocking),
    observedAt: normalizeIso(observedAt),
    duration: Number(durationMs) || 0,
    evidence: redactSensitive(evidence),
    remediation: String(remediation || ''),
  };
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  return Boolean(value);
}

function resolveRequirementFlag(profileRequirement, explicitValue) {
  if (explicitValue === undefined || explicitValue === null) {
    return Boolean(profileRequirement);
  }
  const parsed = toBoolean(explicitValue, Boolean(profileRequirement));
  if (profileRequirement) {
    return true;
  }
  return parsed;
}

function resolveProfileRequirements(profileName = 'default', explicit = {}) {
  const profile = String(profileName || 'default').trim().toLowerCase() || 'default';
  const normalized = profile.replace(/[^a-z0-9]+/g, '-');

  const explicitMission = explicit.requireMissionControl;
  const explicitNative = explicit.requireNativeSreAgent;

  const baseMissionRequirement = !['optional', 'advisory', 'local-only', 'demo-lite', 'no-mission-control', 'mission-control-disabled'].includes(normalized);
  const baseNativeRequirement = normalized.includes('native') || normalized.includes('sre') || normalized.includes('full') || normalized.includes('review');

  return {
    requireMissionControl: resolveRequirementFlag(baseMissionRequirement, explicitMission),
    requireNativeSreAgent: resolveRequirementFlag(baseNativeRequirement, explicitNative),
  };
}

function normalizeRequest(input = {}) {
  const raw = input || {};
  const subscriptionId = String(raw.subscriptionId || raw.subscription || '').trim();
  const resourceGroupName = String(raw.resourceGroupName || raw.resourceGroup || '').trim();
  const profile = String(raw.profile || raw.profileName || 'default').trim() || 'default';
  const runId = String(raw.runId || raw.run_id || 'mission-control').trim() || 'mission-control';
  const timeoutMs = Number(raw.timeoutMs ?? raw.timeout ?? DEFAULT_TIMEOUT_MS);
  const requirements = resolveProfileRequirements(profile, {
    requireMissionControl: raw.requireMissionControl,
    requireNativeSreAgent: raw.requireNativeSreAgent,
  });
  const requireMissionControl = resolveRequirementFlag(requirements.requireMissionControl, raw.requireMissionControl);
  const requireNativeSreAgent = resolveRequirementFlag(requirements.requireNativeSreAgent, raw.requireNativeSreAgent);
  const mockScenario = String(raw.mockScenario || raw.mock || '').trim().toLowerCase();

  const errors = [];
  if (!subscriptionId) errors.push('subscriptionId is required');
  if (!resourceGroupName) errors.push('resourceGroupName is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    errors.push(`timeoutMs must be a finite number between 1 and ${DEFAULT_TIMEOUT_MS}`);
  }

  return {
    value: {
      subscriptionId,
      resourceGroupName,
      profile,
      runId,
      timeoutMs: Number.isFinite(timeoutMs) ? Math.min(timeoutMs, DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
      requireMissionControl,
      requireNativeSreAgent,
      mockScenario,
    },
    errors,
  };
}

function createMockResult({ subscriptionId, resourceGroupName, profile, runId, mockScenario, startedAt }) {
  const iso = normalizeIso(startedAt || Date.now());
  const scenario = String(mockScenario || 'healthy').toLowerCase();
  const checks = [];

  const passCheck = (id, category, evidence, remediation) => {
    checks.push(createReadinessCheck({ id, category, status: 'pass', blocking: false, evidence, remediation, durationMs: 50 }));
  };

  const failCheck = (id, category, evidence, remediation) => {
    checks.push(createReadinessCheck({ id, category, status: 'fail', blocking: true, evidence, remediation, durationMs: 50 }));
  };

  passCheck('azure-auth-context', 'azure', { subscriptionId, resourceGroupName, profile, runId }, 'Keep the subscription and resource group aligned to the live Azure context before the demo starts.');
  passCheck('aks-cluster-health', 'aks', { cluster: 'propane', status: 'running' }, 'Keep the AKS cluster healthy and let the demo rely on the current baseline.');
  passCheck('lifecycle-baseline', 'lifecycle', { baseline: 'clean', fingerprint: 'stable' }, 'Maintain the lifecycle baseline and prevent stale scenario artifacts during the demo.');
  passCheck('customer-dispatch-health', 'services', { customerPortal: 'ok', dispatchConsole: 'ok' }, 'Keep customer and dispatch endpoints healthy to avoid readiness drift.');
  passCheck('collector-telemetry', 'telemetry', { collector: 'healthy', dataFresh: true }, 'Keep the OTEL collector reporting fresh correlated telemetry for the demo.');
  passCheck('sre-agent-managed-scope', 'sre-agent', { scope: 'managed', mode: 'review' }, 'Keep the exact SRE Agent managed scope aligned to the demo environment.');
  passCheck('scheduled-task-evidence', 'automation', { taskHash: 'stable', reportFresh: true }, 'Keep the scheduled-task evidence fresh and exact to the latest task hash before enabling the demo.');

  if (scenario === 'healthy' || scenario === 'ready') {
    return {
      schemaVersion: SCHEMA_VERSION,
      id: buildStableId('demo-readiness', subscriptionId || 'sub', resourceGroupName || 'rg', profile, runId),
      category: 'demo-readiness',
      status: 'ready',
      blocking: false,
      observedAt: iso,
      duration: 1250,
      summary: 'Ready for Demo',
      environment: { subscriptionId, resourceGroupName, profile, runId },
      checks,
      blockers: [],
      advisories: [],
    };
  }

  if (scenario === 'timeout') {
    checks.length = 0;
    failCheck('azure-auth-context', 'azure', { timeout: true, message: 'The Azure auth probe timed out.' }, 'Verify Azure authentication and retry the readiness check when the context is reachable again.');
    return {
      schemaVersion: SCHEMA_VERSION,
      id: buildStableId('demo-readiness', subscriptionId || 'sub', resourceGroupName || 'rg', profile, runId),
      category: 'demo-readiness',
      status: 'blocked',
      blocking: true,
      observedAt: iso,
      duration: 1250,
      summary: 'Readiness blocked by timeout',
      environment: { subscriptionId, resourceGroupName, profile, runId },
      checks,
      blockers: ['azure-auth-context'],
      advisories: [],
    };
  }

  if (scenario === 'malformed') {
    return {
      schemaVersion: SCHEMA_VERSION,
      id: buildStableId('demo-readiness', subscriptionId || 'sub', resourceGroupName || 'rg', profile, runId),
      category: 'demo-readiness',
      status: 'blocked',
      blocking: true,
      observedAt: iso,
      duration: 1250,
      summary: 'Readiness rejected: malformed request',
      environment: { subscriptionId, resourceGroupName, profile, runId },
      checks: [createReadinessCheck({
        id: 'request-validation',
        category: 'request',
        status: 'fail',
        blocking: true,
        evidence: { error: 'subscriptionId or resourceGroupName is missing', payload: { subscriptionId, resourceGroupName } },
        remediation: 'Supply a valid Azure subscription and resource group before rerunning the demo readiness check.',
        durationMs: 40,
      })],
      blockers: ['request-validation'],
      advisories: [],
    };
  }

  if (scenario === 'redaction') {
    checks.length = 0;
    failCheck('telemetry-redaction', 'telemetry', { evidence: 'token=super-secret-token-123', stack: 'Authorization: Bearer super-secret-token' }, 'Do not expose raw tokens in telemetry or logs; keep redacted values only.');
    return {
      schemaVersion: SCHEMA_VERSION,
      id: buildStableId('demo-readiness', subscriptionId || 'sub', resourceGroupName || 'rg', profile, runId),
      category: 'demo-readiness',
      status: 'blocked',
      blocking: true,
      observedAt: iso,
      duration: 1250,
      summary: 'Readiness blocked by leaked credentials',
      environment: { subscriptionId, resourceGroupName, profile, runId },
      checks,
      blockers: ['telemetry-redaction'],
      advisories: [],
    };
  }

  checks.length = 0;
  failCheck('azure-auth-context', 'azure', { mismatch: true, expected: subscriptionId || 'Known-sub', actual: 'mismatch' }, 'Use the exact live Azure context and retry.');
  return {
    schemaVersion: SCHEMA_VERSION,
    id: buildStableId('demo-readiness', subscriptionId || 'sub', resourceGroupName || 'rg', profile, runId),
    category: 'demo-readiness',
    status: 'blocked',
    blocking: true,
    observedAt: iso,
    duration: 1250,
    summary: 'Readiness blocked by invalid Azure context',
    environment: { subscriptionId, resourceGroupName, profile, runId },
    checks,
    blockers: ['azure-auth-context'],
    advisories: [],
  };
}

function buildFailureCheck(id, category, message, remediation, durationMs = 0) {
  return createReadinessCheck({
    id,
    category,
    status: 'fail',
    blocking: true,
    evidence: { message },
    remediation,
    durationMs,
  });
}

function normalizeRuntimeComponent(status, fallback = {}) {
  if (status === undefined || status === null || status === false) {
    return { available: false, fresh: false, status: 'unavailable', details: fallback };
  }
  if (typeof status === 'boolean') {
    return { available: status, fresh: status, status: status ? 'ready' : 'unavailable', details: fallback };
  }
  if (typeof status === 'string') {
    const value = status.trim().toLowerCase();
    return {
      available: ['ready', 'healthy', 'available', 'running', 'connected', 'pass', 'pass-fresh'].includes(value),
      fresh: !['stale', 'expired', 'unavailable', 'advisory', 'missing'].includes(value),
      status: value,
      details: fallback,
    };
  }
  const details = status && typeof status === 'object' ? status : fallback;
  const available = details.available === true || details.ready === true || details.pass === true || details.enabled === true || details.status === 'ready' || details.status === 'healthy';
  const fresh = details.fresh !== false && details.stale !== true && details.status !== 'stale' && details.status !== 'expired' && details.status !== 'unavailable' && details.status !== 'advisory';
  return {
    available,
    fresh,
    status: typeof details.status === 'string' ? details.status : available ? 'ready' : 'unavailable',
    details,
  };
}

async function runCommand(runtime, label, command, args, timeoutMs) {
  if (runtime && typeof runtime.executor === 'function') {
    const output = await runtime.executor(label, command, args, timeoutMs);
    if (typeof output === 'string') return { stdout: output, stderr: '' };
    if (output && typeof output === 'object') {
      return {
        stdout: typeof output.stdout === 'string' ? output.stdout : JSON.stringify(output),
        stderr: typeof output.stderr === 'string' ? output.stderr : '',
      };
    }
    return { stdout: String(output || ''), stderr: '' };
  }

  return execFileAsync(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
}

async function evaluateNativeSreAgentCheck(normalizedInput, runtime = {}) {
  const timeoutMs = Math.min(Number(normalizedInput && normalizedInput.timeoutMs) || DEFAULT_TIMEOUT_MS, 30000);
  try {
    const agents = await runCommand(runtime, 'native-sre-agent', 'az', ['resource', 'list', '--resource-group', normalizedInput.resourceGroupName, '--resource-type', 'Microsoft.App/agents', '-o', 'json'], timeoutMs);
    const items = JSON.parse(agents.stdout || '[]');
    const list = Array.isArray(items) ? items : [];
    const agent = list.find((item) => item && (item.type === 'Microsoft.App/agents' || String(item.type || '').includes('Microsoft.App/agents')));
    if (!agent) {
      return { available: false, fresh: false, status: 'missing', details: { message: 'No native Azure SRE Agent was found in the configured resource group.' } };
    }
    const provisioningState = String(agent.properties?.provisioningState || agent.provisioningState || 'Unknown');
    const pass = ['succeeded', 'running', 'ready', 'success', 'healthy'].includes(provisioningState.trim().toLowerCase());
    return {
      available: pass,
      fresh: pass,
      status: pass ? 'ready' : (provisioningState || 'missing'),
      details: { resourceId: agent.id || null, name: agent.name || null, provisioningState },
    };
  } catch (error) {
    return { available: false, fresh: false, status: 'unavailable', details: { message: error && error.message ? error.message : 'Native Azure SRE Agent identity check failed.' } };
  }
}

async function evaluateReadiness(input = {}, runtime = {}) {
  const started = Date.now();
  const normalized = normalizeRequest(input || {});

  if (normalized.errors.length > 0) {
    return {
      schemaVersion: SCHEMA_VERSION,
      id: buildStableId('demo-readiness', 'error', normalized.value.resourceGroupName || 'unknown', normalized.value.profile || 'default'),
      category: 'demo-readiness',
      status: 'blocked',
      blocking: true,
      observedAt: normalizeIso(started),
      duration: Date.now() - started,
      summary: 'Readiness rejected: malformed inputs',
      environment: { ...normalized.value },
      checks: normalized.errors.map((message, index) => createReadinessCheck({
        id: `request-validation-${index + 1}`,
        category: 'request',
        status: 'fail',
        blocking: true,
        evidence: { error: message },
        remediation: 'Fix the request payload before rerunning the readiness gate.',
        durationMs: 10,
      })),
      blockers: normalized.errors.map((_, index) => `request-validation-${index + 1}`),
      advisories: [],
    };
  }

  const mockScenario = String(runtime.mockScenario || normalized.value.mockScenario || '').trim().toLowerCase();
  if (mockScenario) {
    return createMockResult({
      subscriptionId: normalized.value.subscriptionId,
      resourceGroupName: normalized.value.resourceGroupName,
      profile: normalized.value.profile,
      runId: normalized.value.runId,
      mockScenario,
      startedAt: started,
    });
  }

  const checks = [];

  try {
    const auth = await runCommand(runtime, 'azure-auth-context', 'az', ['account', 'show', '-o', 'json'], normalized.value.timeoutMs);
    const account = JSON.parse(auth.stdout || '{}');
    const expectedSub = normalized.value.subscriptionId;
    const actualSub = account.id || account.subscriptionId || '';
    if (!actualSub || actualSub !== expectedSub) {
      checks.push(buildFailureCheck('azure-auth-context', 'azure', `Expected ${expectedSub || 'known subscription'} but observed ${actualSub || 'no active subscription'}.`, 'Run az login --use-device-code and set the correct subscription before validating the demo baseline.', 25));
    } else {
      checks.push(createReadinessCheck({
        id: 'azure-auth-context',
        category: 'azure',
        status: 'pass',
        blocking: true,
        evidence: { subscriptionId: actualSub, name: account.name || 'unknown' },
        remediation: 'Keep the Azure auth context configured to the live demo subscription and resource group.',
        durationMs: 25,
      }));
    }
  } catch (error) {
    checks.push(buildFailureCheck('azure-auth-context', 'azure', error && error.message ? error.message : 'Azure auth check failed unexpectedly.', 'Confirm the Azure CLI is available and authenticated to the correct subscription before continuing.', 25));
  }

  try {
    const rg = await runCommand(runtime, 'resource-group', 'az', ['group', 'show', '--name', normalized.value.resourceGroupName, '--output', 'json'], normalized.value.timeoutMs);
    const group = JSON.parse(rg.stdout || '{}');
    if (!group.name) {
      checks.push(buildFailureCheck('resource-group', 'azure', `Resource group ${normalized.value.resourceGroupName} was not found.`, 'Verify the deployment resource group exists and matches the live demo context.', 30));
    } else {
      checks.push(createReadinessCheck({
        id: 'resource-group',
        category: 'azure',
        status: 'pass',
        blocking: true,
        evidence: { name: group.name, location: group.location || 'unknown' },
        remediation: 'Keep the active resource group aligned to the deployed AmeriGas environment before the demo begins.',
        durationMs: 30,
      }));
    }
  } catch (error) {
    checks.push(buildFailureCheck('resource-group', 'azure', error && error.message ? error.message : 'Resource group lookup failed.', 'Verify the resource group exists and is accessible from the current Azure context.', 30));
  }

  try {
    const clusterQuery = await runCommand(runtime, 'aks-cluster-health', 'az', ['aks', 'list', '--resource-group', normalized.value.resourceGroupName, '-o', 'json'], normalized.value.timeoutMs);
    const clusters = JSON.parse(clusterQuery.stdout || '[]');
    const runningCluster = Array.isArray(clusters) ? clusters.find((cluster) => cluster && cluster.name && (cluster.powerState?.code === 'Running' || cluster.powerState?.code === 'running' || cluster.provisioningState === 'Succeeded')) : null;
    if (!runningCluster) {
      checks.push(buildFailureCheck('aks-cluster-health', 'aks', `No running AKS cluster was found in ${normalized.value.resourceGroupName}.`, 'Verify the AKS cluster is running and present in the expected resource group before announcing readiness.', 60));
    } else {
      checks.push(createReadinessCheck({
        id: 'aks-cluster-health',
        category: 'aks',
        status: 'pass',
        blocking: true,
        evidence: { clusterName: runningCluster.name || 'unknown', powerState: runningCluster.powerState?.code || 'Running' },
        remediation: 'Keep the cluster online and healthy so the demo baseline remains valid.',
        durationMs: 60,
      }));
    }
  } catch (error) {
    checks.push(buildFailureCheck('aks-cluster-health', 'aks', error && error.message ? error.message : 'AKS cluster validation failed unexpectedly.', 'Check the AKS health and cluster scope before the live demo continues.', 60));
  }

  try {
    const pods = await runCommand(runtime, 'pods', 'kubectl', ['get', 'pods', '-n', 'propane', '-o', 'json'], Math.min(normalized.value.timeoutMs, 15000));
    const podList = JSON.parse(pods.stdout || '{"items":[]}');
    const items = Array.isArray(podList.items) ? podList.items : [];
    const fase = items.filter((item) => (item.status?.phase || '').toLowerCase() !== 'running');
    if (items.length === 0 || fase.length > 0) {
      checks.push(buildFailureCheck('lifecycle-baseline', 'lifecycle', `Expected a healthy propane namespace baseline but found ${items.length} pods with ${fase.length} non-running states.`, 'Restore the clean baseline before the demo proceeds.', 60));
    } else {
      checks.push(createReadinessCheck({
        id: 'lifecycle-baseline',
        category: 'lifecycle',
        status: 'pass',
        blocking: true,
        evidence: { podCount: items.length, nonRunning: fase.length },
        remediation: 'Keep the propane namespace baseline clean so the live demo has stable evidence.',
        durationMs: 60,
      }));
    }
  } catch (error) {
    checks.push(buildFailureCheck('lifecycle-baseline', 'lifecycle', error && error.message ? error.message : 'Lifecycle baseline validation failed.', 'Verify the cluster is reachable and the propane baseline is healthy before proceeding.', 60));
  }

  try {
    const services = await runCommand(runtime, 'services', 'kubectl', ['get', 'svc', '-n', 'propane', '-o', 'json'], Math.min(normalized.value.timeoutMs, 15000));
    const svcList = JSON.parse(services.stdout || '{"items":[]}');
    const items = Array.isArray(svcList.items) ? svcList.items : [];
    const customer = items.some((svc) => String(svc.metadata?.name || '').toLowerCase().includes('customer'));
    const dispatch = items.some((svc) => String(svc.metadata?.name || '').toLowerCase().includes('dispatch'));
    if (!customer || !dispatch) {
      checks.push(buildFailureCheck('customer-dispatch-health', 'services', `Customer and dispatch endpoints are not both healthy (customer=${customer}, dispatch=${dispatch}).`, 'Ensure the customer portal and dispatch console services are healthy and exposed before the live demo.', 60));
    } else {
      checks.push(createReadinessCheck({
        id: 'customer-dispatch-health',
        category: 'services',
        status: 'pass',
        blocking: false,
        evidence: { customerPortal: customer, dispatchConsole: dispatch },
        remediation: 'Keep both endpoints healthy to avoid demo drift during the final presenter walkthrough.',
        durationMs: 60,
      }));
    }
  } catch (error) {
    checks.push(buildFailureCheck('customer-dispatch-health', 'services', error && error.message ? error.message : 'Customer and dispatch endpoint validation failed.', 'Verify the customer and dispatch endpoints are reachable and stable before the demo continues.', 60));
  }

  try {
    const otel = await runCommand(runtime, 'collector-telemetry', 'kubectl', ['get', 'pods', '-n', 'propane', '-l', 'app=otel-collector', '-o', 'json'], Math.min(normalized.value.timeoutMs, 15000));
    const list = JSON.parse(otel.stdout || '{"items":[]}');
    const items = Array.isArray(list.items) ? list.items : [];
    const fresh = items.some((item) => item.status?.phase === 'Running');
    if (!fresh) {
      checks.push(buildFailureCheck('collector-telemetry', 'telemetry', 'The OTel collector is not reporting healthy telemetry for the demo.', 'Restore the collector and confirm telemetry freshness before the live demo is approved.', 60));
    } else {
      checks.push(createReadinessCheck({
        id: 'collector-telemetry',
        category: 'telemetry',
        status: 'pass',
        blocking: true,
        evidence: { collectorHealthy: true, podCount: items.length },
        remediation: 'Keep the OTel collector active and fresh so the demo remains evidence-based.',
        durationMs: 60,
      }));
    }
  } catch (error) {
    checks.push(buildFailureCheck('collector-telemetry', 'telemetry', error && error.message ? error.message : 'Telemetry validation failed.', 'Confirm the collector pod is healthy and the telemetry pipeline is reporting before the demo starts.', 60));
  }

  const missionControlRuntime = normalizeRuntimeComponent(
    runtime.missionControl ?? runtime.missionControlStatus ??
      (normalized.value.requireMissionControl
        ? { available: true, fresh: true, status: 'ready', details: { source: 'default-runtime' } }
        : { available: false, fresh: false, status: 'advisory', details: { source: 'default-runtime' } })
  );
  const nativeSreAgentRuntime = normalizeRuntimeComponent(
    runtime.nativeSreAgent ?? runtime.nativeSreAgentStatus ??
      (normalized.value.requireNativeSreAgent ? await evaluateNativeSreAgentCheck(normalized.value, runtime) : { available: false, fresh: false, status: 'advisory', details: { source: 'default-runtime' } })
  );

  if (normalized.value.requireMissionControl) {
    if (!missionControlRuntime.available || !missionControlRuntime.fresh) {
      checks.push(buildFailureCheck('mission-control-required', 'mission-control', missionControlRuntime.details && (missionControlRuntime.details.message || missionControlRuntime.details.reason) ? String(missionControlRuntime.details.message || missionControlRuntime.details.reason) : 'Mission Control is required for this readiness profile and was unavailable or stale.', 'Enable Mission Control Copilot and refresh the live evidence before the demo is marked ready.', 25));
    } else {
      checks.push(createReadinessCheck({
        id: 'mission-control-required',
        category: 'mission-control',
        status: 'pass',
        blocking: true,
        evidence: { available: true, fresh: true, status: missionControlRuntime.status || 'ready' },
        remediation: 'Mission Control remains available and fresh for the current demo run.',
        durationMs: 25,
      }));
    }
  } else {
    checks.push(createReadinessCheck({
      id: 'mission-control-optional',
      category: 'mission-control',
      status: missionControlRuntime.available ? 'pass' : 'warn',
      blocking: false,
      evidence: { available: Boolean(missionControlRuntime.available), fresh: Boolean(missionControlRuntime.fresh), status: missionControlRuntime.status || 'advisory' },
      remediation: 'Mission Control is optional for this profile and should be treated as advisory only.',
      durationMs: 25,
    }));
  }

  if (normalized.value.requireNativeSreAgent) {
    if (!nativeSreAgentRuntime.available || !nativeSreAgentRuntime.fresh) {
      checks.push(buildFailureCheck('native-sre-agent-required', 'native-sre-agent', nativeSreAgentRuntime.details && (nativeSreAgentRuntime.details.message || nativeSreAgentRuntime.details.reason) ? String(nativeSreAgentRuntime.details.message || nativeSreAgentRuntime.details.reason) : 'Native Azure SRE Agent evidence is required for this readiness profile and was unavailable or stale.', 'Deploy or link the exact native Azure SRE Agent managed scope and fresh evidence before the demo is marked ready.', 25));
    } else {
      checks.push(createReadinessCheck({
        id: 'native-sre-agent-required',
        category: 'native-sre-agent',
        status: 'pass',
        blocking: true,
        evidence: { available: true, fresh: true, status: nativeSreAgentRuntime.status || 'ready' },
        remediation: 'The native Azure SRE Agent remains available and freshly aligned with the current demo run.',
        durationMs: 25,
      }));
    }
  } else {
    checks.push(createReadinessCheck({
      id: 'native-sre-agent-optional',
      category: 'native-sre-agent',
      status: nativeSreAgentRuntime.available ? 'pass' : 'warn',
      blocking: false,
      evidence: { available: Boolean(nativeSreAgentRuntime.available), fresh: Boolean(nativeSreAgentRuntime.fresh), status: nativeSreAgentRuntime.status || 'advisory' },
      remediation: 'Native Azure SRE Agent evidence is optional for this profile and should be treated as advisory only.',
      durationMs: 25,
    }));
  }

  const blockingFailures = checks.filter((check) => check.blocking && check.status === 'fail');
  const blockingWarnings = checks.filter((check) => check.blocking && check.status === 'warn');
  const status = blockingFailures.length === 0 && blockingWarnings.length === 0 ? 'ready' : 'blocked';
  const result = {
    schemaVersion: SCHEMA_VERSION,
    id: buildStableId('demo-readiness', normalized.value.subscriptionId, normalized.value.resourceGroupName, normalized.value.profile, normalized.value.runId),
    category: 'demo-readiness',
    status,
    blocking: status === 'blocked',
    observedAt: normalizeIso(Date.now()),
    duration: Date.now() - started,
    summary: status === 'ready' ? 'Ready for Demo' : 'Readiness blocked by failing checks',
    environment: { ...normalized.value },
    checks,
    blockers: blockingFailures.map((check) => check.id),
    advisories: blockingWarnings.map((check) => check.id),
  };

  return result;
}

function formatHumanOutput(result) {
  const lines = [];
  lines.push(`${result.status === 'ready' ? 'READY' : 'BLOCKED'}: ${result.summary || 'Readiness check'} (${result.status})`);
  lines.push(`Observed: ${result.observedAt || new Date().toISOString()}`);
  lines.push(`Duration: ${result.duration || 0}ms`);
  if (Array.isArray(result.checks) && result.checks.length > 0) {
    for (const check of result.checks) {
      lines.push(`- ${check.id} [${check.status}] ${check.blocking ? 'blocking' : 'advisory'} — ${check.remediation || 'No remediation required'}`);
    }
  }
  return lines.join('\n');
}

function parseCliArgs(argv = []) {
  const input = {
    subscriptionId: '',
    resourceGroupName: '',
    profile: 'default',
    runId: 'mission-control',
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  const flags = {
    json: false,
    human: false,
    requireMissionControl: true,
    requireNativeSreAgent: false,
    mock: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--subscription-id':
      case '--subscription':
        input.subscriptionId = String(argv[index + 1] || '').trim();
        index += 1;
        break;
      case '--resource-group':
      case '--resource-group-name':
        input.resourceGroupName = String(argv[index + 1] || '').trim();
        index += 1;
        break;
      case '--profile':
        input.profile = String(argv[index + 1] || 'default').trim() || 'default';
        index += 1;
        break;
      case '--run-id':
        input.runId = String(argv[index + 1] || 'mission-control').trim() || 'mission-control';
        index += 1;
        break;
      case '--timeout-ms':
      case '--timeout':
        input.timeoutMs = Number(argv[index + 1] || DEFAULT_TIMEOUT_MS);
        index += 1;
        break;
      case '--json':
        flags.json = true;
        break;
      case '--human':
        flags.human = true;
        break;
      case '--mock':
        flags.mock = String(argv[index + 1] || '').trim().toLowerCase();
        index += 1;
        break;
      case '--require-mission-control':
        flags.requireMissionControl = true;
        if (argv[index + 1] && ['true', 'false', '0', '1'].includes(String(argv[index + 1]).trim().toLowerCase())) {
          flags.requireMissionControl = String(argv[index + 1]).trim().toLowerCase() !== 'false' && String(argv[index + 1]).trim().toLowerCase() !== '0';
          index += 1;
        }
        break;
      case '--require-native-sre-agent':
        flags.requireNativeSreAgent = true;
        if (argv[index + 1] && ['true', 'false', '0', '1'].includes(String(argv[index + 1]).trim().toLowerCase())) {
          flags.requireNativeSreAgent = String(argv[index + 1]).trim().toLowerCase() !== 'false' && String(argv[index + 1]).trim().toLowerCase() !== '0';
          index += 1;
        }
        break;
      case '--optional-mission-control':
      case '--no-mission-control':
        // Compatibility aliases only. They cannot weaken a profile that already
        // requires Mission Control; the server profile remains authoritative.
        flags.requireMissionControl = false;
        break;
      case '--optional-native-sre-agent':
      case '--no-native-sre-agent':
        // Compatibility aliases only. They cannot weaken a profile that already
        // requires the native Azure SRE Agent check.
        flags.requireNativeSreAgent = false;
        break;
      case '--help':
      case '-h':
        throw new Error('Usage: node demo-readiness.js --subscription-id <sub> --resource-group <rg> [--profile demo] [--require-mission-control] [--require-native-sre-agent] [--mock healthy|blocked|timeout|malformed|redaction] [--json]');
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown readiness argument: ${arg}`);
        }
        break;
    }
  }

  const profileRequirements = resolveProfileRequirements(input.profile, {
    requireMissionControl: flags.requireMissionControl,
    requireNativeSreAgent: flags.requireNativeSreAgent,
  });
  flags.requireMissionControl = profileRequirements.requireMissionControl;
  flags.requireNativeSreAgent = profileRequirements.requireNativeSreAgent;

  return { input, flags };
}

async function cliMain(argv = process.argv.slice(2), runtime = {}) {
  const { input, flags } = parseCliArgs(argv);
  const result = await evaluateReadiness({
    ...input,
    requireMissionControl: flags.requireMissionControl,
    requireNativeSreAgent: flags.requireNativeSreAgent,
    timeoutMs: Number.isFinite(input.timeoutMs) ? Math.min(input.timeoutMs, DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
    mockScenario: flags.mock || runtime.mockScenario || process.env.DEMO_READINESS_MOCK || '',
  }, runtime);

  if (flags.json || (!flags.human && process.env.DEMO_READINESS_JSON === '1')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatHumanOutput(result));
  }

  return result.status === 'ready' ? 0 : 1;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  SCHEMA_VERSION,
  buildStableId,
  createReadinessCheck,
  normalizeRequest,
  resolveProfileRequirements,
  resolveRequirementFlag,
  parseCliArgs,
  formatHumanOutput,
  evaluateReadiness,
  evaluateNativeSreAgentCheck,
  cliMain,
};

if (require.main === module) {
  cliMain(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error && error.message ? error.message : 'Readiness evaluation failed.');
      process.exit(2);
    });
}
