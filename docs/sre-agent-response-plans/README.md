# Alert-to-Approved-Remediation Response Plan (MongoDB-Down Demo Scenario)

This directory holds the version-controlled artifacts for the native Azure
SRE Agent response plan implemented for [issue #19](https://github.com/johnstel/azure-sre-agent-AmeriGas/issues/19):
a genuine Azure Monitor alert, routed through a native SRE Agent **response
plan** to a **custom agent**, that investigates, proposes exactly one
approved remediation action, and verifies recovery — with a full native
audit trail. This is **not** Mission Control Copilot and **not** a generic
webhook integration.

## Files

| File | Purpose |
|------|---------|
| `mongodb-down-custom-agent-instructions.md` | Versioned `system_prompt` template for the `mongodb-down-responder` custom agent. `scripts/bootstrap-sre-agent-response-plan.ps1` renders its `{{...}}` placeholders with the actual deployed subscription/resource group/AKS cluster name before uploading. |
| `infra/bicep/main.demo.bicepparam` | Version-controlled demo deployment profile — the only place `deployDemoResponsePlan` is set to `true`. |
| `infra/bicep/modules/alerts.bicep` | Contains the dedicated `mongoDbDownDemoAlert` resource, gated by `deployMongoDbDownDemoAlert`. |
| `infra/bicep/modules/sre-agent.bicep` | Contains the declarative `incidentManagementConfiguration.type = AzMonitor` binding, gated by `enableAzureMonitorIncidents`. |
| `infra/bicep/modules/sre-agent-demo-rbac.bicep` | The least-scope custom RBAC role for the exact remediation action. |
| `scripts/bootstrap-sre-agent-response-plan.ps1` | Idempotent setup/teardown of the custom agent + response plan control-plane sub-resources. |
| `scripts/validate-deployment.ps1` | Validates the whole response plan (alert, incident connection, plan config, RBAC scope, no conflicting quickstart plan) — see its "Demo Response Plan" section. |

## Why MongoDB-down

Per the issue's scope, the canonical scenario was chosen after validating
remediation support: MongoDB-down lets the agent propose exactly one
non-delete action — `az aks command invoke` running `kubectl scale
deployment/mongodb --replicas=1 -n propane` — which matches the documented
[safety guardrails](https://learn.microsoft.com/azure/sre-agent/execute-mitigations#safety-guardrails)
(delete/remove and Key Vault commands are blocked at the platform level
regardless). Scaling a Deployment to 0 replicas removes its Pods entirely
rather than putting them into a Failed/Pending/CrashLoop/OOM state, so none
of the four existing generic alerts (`alerts.bicep`) ever fire for it —
hence the dedicated alert.

## Deploying the demo profile

```powershell
.\scripts\deploy.ps1 -Location eastus2 -Demo
```

This selects `infra/bicep/main.demo.bicepparam` instead of the standard
`main.bicepparam`, which additionally enables (on top of the same baseline):

- `deployAlerts = true` (the four baseline alerts)
- `deployDemoResponsePlan = true`, which turns on, and ONLY on:
  - the dedicated `mongoDbDownDemoAlert` (title `AmeriGas Propane Demo -
    MongoDB Down`, severity 1)
  - `incidentManagementConfiguration.type = AzMonitor` on the SRE Agent
  - the least-scope custom RBAC role (`sre-agent-demo-rbac.bicep`)

The **standard profile** (`main.bicepparam`, the default for `deploy.ps1`
without `-Demo`) is completely unaffected — `deployDemoResponsePlan`
defaults to `false` there and is asserted never to be `true` by
`scripts/tests/sre-agent-scope.tests.ps1`.

After the Bicep deployment completes, `deploy.ps1` automatically runs
`scripts/bootstrap-sre-agent-response-plan.ps1`, which:

1. Verifies the target resource group belongs to the current Azure CLI
   subscription (refuses to bootstrap against the wrong subscription).
2. Verifies the agent is `Succeeded`, in `Review` mode, and
   `AzMonitor`-connected (fails explicitly otherwise, with a pointer back to
   redeploying with the demo profile).
3. Capability-detects the `Microsoft.App/agents/subagents` and
   `.../incidentFilters` control-plane sub-resource APIs — fails with an
   explicit "unsupported API" result (never silently degrades to a
   webhook/manual fallback) if either responds 404/405.
4. Renders the custom-agent instructions template and content-hash-keys
   both the custom agent and the response plan, so a rerun with unchanged
   content makes zero write calls.
5. Writes (or skips, if unchanged) the custom agent and response plan, and
   **round-trip verifies** every write by reading it back and comparing
   against what was sent — see "Preview limitations" below for why this
   matters.
6. Detects and removes the default **quickstart** response plan Azure
   creates automatically the first time an incident platform is connected —
   or fails validation explicitly if it cannot be removed via the API,
   rather than risking duplicate/incorrect incident routing.

Rerun it manually at any time:

```powershell
.\scripts\bootstrap-sre-agent-response-plan.ps1 `
    -ResourceGroupName "rg-srelab-eastus2" `
    -AgentName "sre-srelab" `
    -AksClusterName "aks-srelab"
```

Tear it down (removes only the custom agent + response plan — never the
alert rule or the SRE Agent resource itself) with `-Teardown`:

```powershell
.\scripts\bootstrap-sre-agent-response-plan.ps1 `
    -ResourceGroupName "rg-srelab-eastus2" `
    -AgentName "sre-srelab" `
    -AksClusterName "aks-srelab" `
    -Teardown
```

`scripts/destroy.ps1` runs this teardown automatically (best-effort) before
deleting the resource group.

## Bounded alert timing

The demo alert (`Microsoft.Insights/scheduledQueryRules`, `alerts.bicep`)
uses `evaluationFrequency: PT1M` and `windowSize: PT5M`. Combined with
typical Log Analytics Container Insights ingestion latency (2-5 minutes),
the alert is expected to fire **within approximately 10 minutes** of
running:

```bash
kubectl apply -f k8s/scenarios/mongodb-down.yaml
```

To verify the bound during a rehearsal, watch for the fired alert in the
Azure Portal (Monitor > Alerts) or query directly:

```bash
az monitor scheduled-query list --resource-group <rg> --output table
```

## Rehearsal: three variants

Run the flow three times, exactly as required by issue #19's validation
section, and confirm the outcome each time:

1. **Approve.** Apply the scenario, wait for the alert and the agent's
   investigation thread, review the proposed `az aks command invoke`
   action, and approve it. Confirm: exactly one action executes, the
   `mongodb` Deployment returns to `1/1` Ready, and the agent's
   post-action verification (Kubernetes state + Application Insights
   dependency calls + alert recovery) is reported in the thread.
2. **Deny.** Repeat, but deny the proposed action. Confirm: the
   environment is unchanged (`mongodb` Deployment still at 0 replicas),
   and the thread records the denial with no execution.
3. **Expiry.** Repeat again and let the approval window lapse without a
   decision. Confirm: the same zero-action outcome as denial, with the
   thread showing an expired proposal rather than a silently-abandoned one.

After each rehearsal, restore the healthy baseline:

```bash
kubectl apply -f k8s/base/application.yaml
```

## Preview limitations

- **`Microsoft.App/agents/subagents` and `.../incidentFilters` are
  control-plane sub-resources** managed via `az rest` with normal Azure CLI
  credentials — unlike agent memory (`bootstrap-sre-agent-knowledge.ps1`),
  no data-plane `azuresre.dev` token is used or needed for this script.
- **The exact JSON schema inside the base64 envelope is not published.**
  The [API reference](https://learn.microsoft.com/azure/sre-agent/api-reference)
  documents that "other sub-resources" (skills, subagents, tools, and so
  on) use a base64-encoded `properties.value` envelope, with a worked
  example only for `tools`. This script's custom-agent and
  incident-filter payloads are a best-effort mapping from the documented
  portal UI fields ([Custom agents](https://learn.microsoft.com/azure/sre-agent/sub-agents),
  [Incident response plans](https://learn.microsoft.com/azure/sre-agent/incident-response-plans)).
  Because of this, the script **never reports success from an HTTP 2xx
  alone** — every write is read back and compared field-for-field before
  being considered successful. A silently dropped/reinterpreted field
  surfaces as an explicit `SchemaMismatch` failure with the expected vs.
  actual JSON, not a false "it's configured" claim.
- **Autonomy is always `Review`.** The response plan hard-codes
  `autonomyLevel: 'Review'` — there is no parameter path to set
  `Autonomous`, even though the platform defaults new plans to Autonomous.
- **The quickstart response plan.** Azure automatically creates a default
  "quickstart" response plan the first time an incident platform is
  connected. The bootstrap script detects and removes it (or any other
  plan whose name contains "quickstart"); if the API does not allow
  removing it, the bootstrap fails validation explicitly rather than
  risking duplicate/incorrect incident routing.
- **RBAC is additive, not a replacement.** The SRE Agent's existing
  resource-group-scope `High` access level (Reader + Contributor + Log
  Analytics Contributor) still applies; `sre-agent-demo-rbac.bicep` grants
  a narrower, AKS-cluster-scoped custom role purpose-built for this one
  remediation, so the exact action this response plan proposes does not
  depend on the broader Contributor grant.

## Mission Control / incident-timeline link (issue #17 integration)

`tools/mission-control/sre-agent-links.js` (from issue #17) already exposes
an env-var-configured, credential-free, validated link to the native SRE
Agent thread (`MISSION_CONTROL_SRE_AGENT_THREAD_URL`) and analytics view
(`MISSION_CONTROL_SRE_AGENT_ANALYTICS_URL`) in the Mission Control UI — it
never fabricates a link and never substitutes the local evidence timeline
for the native audit trail. To surface this response plan's actual thread
during a demo, set that environment variable to the specific thread URL
from the SRE Agent portal after a rehearsal run; there is no way to derive
it ahead of time since a thread only exists once an incident has actually
fired.
