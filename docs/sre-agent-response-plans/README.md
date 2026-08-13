# Alert-to-Approved-Remediation Response Plan (MongoDB-Down Demo Scenario)

This directory holds the version-controlled artifacts for the native Azure
SRE Agent response plan implemented for [issue #19](https://github.com/johnstel/azure-sre-agent-AmeriGas/issues/19):
a genuine Azure Monitor alert, routed through a native SRE Agent **response
plan** to a **custom agent**, that investigates, proposes exactly one
approved remediation action, and verifies recovery — with a full native
audit trail. This is **not** Mission Control Copilot and **not** a generic
webhook integration.

> **Status: configuration is semantically verified; live end-to-end
> rehearsal is still pending.** `scripts/bootstrap-sre-agent-response-plan.ps1`
> and `scripts/validate-deployment.ps1` prove the custom agent, incident
> filter, and incident handler are written AND that the platform's own
> data-plane list/get endpoints interpret them with the correct fields
> (Review autonomy, correct severity/title filter, correct agent binding).
> **That is not the same as proving a live Azure Monitor alert actually
> flows through this exact filter to a completed, approved remediation.**
> Do not describe this demo as "proven" until the three-variant rehearsal
> below (approve / deny / expiry) has actually been run against a live
> deployment.

## Files

| File | Purpose |
|------|---------|
| `mongodb-down-custom-agent-instructions.md` | Versioned `system_prompt` template for the `mongodb-down-responder` custom agent. `scripts/bootstrap-sre-agent-response-plan.ps1` renders its `{{...}}` placeholders with the actual deployed subscription/resource group/AKS cluster name before uploading. |
| `infra/bicep/main.demo.bicepparam` | Version-controlled demo deployment profile — the only place `deployDemoResponsePlan` (and the explicit `acknowledgeSubscriptionScopeMonitoringRbac` acknowledgement) is set to `true`. |
| `infra/bicep/modules/alerts.bicep` | Contains the dedicated `mongoDbDownDemoAlert` resource, gated by `deployMongoDbDownDemoAlert`. |
| `infra/bicep/modules/sre-agent.bicep` | Contains the declarative `incidentManagementConfiguration.type = AzMonitor` binding (gated by `enableAzureMonitorIncidents`) and the `demoLeastPrivilegeRbac` switch that withholds resource-group Contributor in the demo profile. |
| `infra/bicep/modules/sre-agent-demo-rbac.bicep` | The least-scope custom RBAC role for the exact remediation action, scoped to the AKS cluster resource only. |
| `infra/bicep/modules/sre-agent-monitoring-rbac.bicep` | Subscription-scope Monitoring Contributor grant required for the Azure Monitor alert scanner — see "Why a subscription-scope grant is unavoidable" below. |
| `scripts/bootstrap-sre-agent-response-plan.ps1` | Idempotent setup/teardown of the custom agent + incident filter + incident handler through the **data-plane** endpoints, with semantic (interpreted-field) verification. |
| `scripts/validate-deployment.ps1` | Validates the whole response plan (alert, incident connection, semantically-verified plan config, RBAC scope including the subscription-scope exception, no conflicting quickstart plan) — see its "Demo Response Plan" section. |

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
.\scripts\deploy.ps1 -Location eastus2 -Demo -AcceptSubscriptionScopeMonitoringRbac
```

`-AcceptSubscriptionScopeMonitoringRbac` is **mandatory** alongside `-Demo`
and is deliberately independent of `-Yes` — see the next section for why.
Omitting it fails the deployment immediately with an explanation, rather
than silently skipping the grant and leaving the Azure Monitor scanner
non-functional.

This selects `infra/bicep/main.demo.bicepparam` instead of the standard
`main.bicepparam`, which additionally enables (on top of the same baseline):

- `deployAlerts = true` (the four baseline alerts)
- `deployDemoResponsePlan = true`, which turns on, and ONLY on:
  - the dedicated `mongoDbDownDemoAlert` (title `AmeriGas Propane Demo -
    MongoDB Down`, severity 1)
  - `incidentManagementConfiguration.type = AzMonitor` on the SRE Agent
  - `demoLeastPrivilegeRbac = true` on the SRE Agent's resource-group RBAC
    (Reader + Log Analytics Reader only — **no** Contributor / Log
    Analytics Contributor)
  - the least-scope custom RBAC role (`sre-agent-demo-rbac.bicep`), scoped
    to the AKS cluster resource only
- `acknowledgeSubscriptionScopeMonitoringRbac = true` (explicit, visible in
  source control), which turns on the subscription-scope Monitoring
  Contributor grant (`sre-agent-monitoring-rbac.bicep`)

The **standard profile** (`main.bicepparam`, the default for `deploy.ps1`
without `-Demo`) is completely unaffected — `deployDemoResponsePlan` and
`acknowledgeSubscriptionScopeMonitoringRbac` both default to `false` there,
the SRE identity keeps its existing resource-group `High` bundle (Reader +
Contributor + Log Analytics Contributor) exactly as before, and both facts
are asserted by `scripts/tests/sre-agent-scope.tests.ps1`.

### Why a subscription-scope grant is unavoidable

Microsoft's own documentation states the Azure Monitor alert scanner
requires **Monitoring Contributor at subscription scope** on the agent's
managed identity:

> "If alerts don't appear after you connect Azure Monitor, verify the
> following conditions: 1. The agent's managed identity has the
> **Monitoring Contributor** role on the subscription."
> — <https://learn.microsoft.com/azure/sre-agent/azure-monitor-alerts>

> "Preconfigured roles (always assigned) ... **Monitoring Contributor** |
> Subscription | Acknowledge and close Azure Monitor alerts and update
> monitoring settings ... Assign the Monitoring Contributor role at the
> subscription level during agent creation so your agent can manage the
> Azure Monitor alert lifecycle (acknowledge, close) out of the box."
> — <https://learn.microsoft.com/azure/sre-agent/agent-permissions>

Monitoring Contributor does **not** grant Contributor over arbitrary
resources — it cannot modify anything outside monitoring settings/alert
lifecycle (see the [built-in role reference](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles#monitor)).
There is no resource-group-scoped equivalent that lets the platform's own
alert scanner discover and manage alerts across the subscription; this is a
property of the built-in role itself, not a design choice made by this
repository. Because it is still a subscription-scope grant, this repository:

- Deploys it through its own isolated module (`sre-agent-monitoring-rbac.bicep`).
- Gates it behind `acknowledgeSubscriptionScopeMonitoringRbac`, a parameter
  that is **never implied** by `deployDemoResponsePlan` alone.
- Requires `scripts/deploy.ps1 -Demo` callers to pass a **separate**
  `-AcceptSubscriptionScopeMonitoringRbac` switch, independent of `-Yes`.
- Validates in `scripts/validate-deployment.ps1` that this is the **only**
  subscription-scope role assignment the SRE identity ever holds in the
  demo profile — any other subscription-scope assignment fails validation.

After the Bicep deployment completes, `deploy.ps1` automatically runs
`scripts/bootstrap-sre-agent-response-plan.ps1`, which:

1. Verifies the target resource group belongs to the current Azure CLI
   subscription (refuses to bootstrap against the wrong subscription).
2. Verifies the agent is `Succeeded`, in `Review` mode, and
   `AzMonitor`-connected (fails explicitly otherwise, with a pointer back to
   redeploying with the demo profile).
3. Acquires an in-memory-only data-plane token (audience
   `https://azuresre.dev`) and capability-detects the semantic list
   endpoints (`/api/v2/incidentManagement/incidentFilters`,
   `/api/v2/extendedAgent/incidentHandlers`) — fails with an explicit
   "unsupported API" result (never silently degrades to a webhook/manual
   fallback) if either responds 404/405, and makes **zero write calls at
   all** in that case, including for the custom agent.
4. Writes (or skips, if already semantically unchanged) the custom agent
   via the officially documented `PUT /api/v2/extendedAgent/agents/{name}`
   endpoint, then the incident filter and incident handler via the
   capability-sensitive `PUT /api/v1/incidentplayground/filters/{id}` and
   `.../handlers/{id}` endpoints.
5. **Semantically verifies** every write: it re-reads the resource through
   the data-plane GET/list endpoints and compares the platform's own
   INTERPRETED fields (severity/priorities, titleContains, `agentMode` =
   Review, the handling-agent binding, merge/cooldown settings) against
   what was intended — not a byte/envelope comparison. A field that was
   silently dropped or reinterpreted surfaces as an explicit
   `SchemaMismatch`, never a false "configured" claim.
6. Detects and removes the default **quickstart** incident filter Azure
   creates automatically the first time an incident platform is connected
   — and re-lists to **verify its absence**, or fails validation explicitly
   if it cannot be removed/confirmed absent, rather than risking
   duplicate/incorrect incident routing.

Rerun it manually at any time:

```powershell
.\scripts\bootstrap-sre-agent-response-plan.ps1 `
    -ResourceGroupName "rg-srelab-eastus2" `
    -AgentName "sre-srelab" `
    -AksClusterName "aks-srelab"
```

Tear it down (removes only the incident handler, incident filter, and
custom agent — never the alert rule or the SRE Agent resource itself) with
`-Teardown`:

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

## Rehearsal: three variants (REQUIRED before calling this demo proven)

`scripts/validate-deployment.ps1` and `bootstrap-sre-agent-response-plan.ps1`
prove the response plan is **configured and semantically verified** — the
platform's own APIs confirm the filter/handler/agent are wired correctly.
Neither proves that a live Azure Monitor alert actually reaches this exact
filter, triggers a real investigation, and completes an approved action
end-to-end. **Do not describe the demo as "proven" or "tested" until the
following three runs have actually been performed against a live
deployment:**

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

- **Data-plane, not control-plane, for the custom agent/filter/handler.**
  Unlike agent memory (`bootstrap-sre-agent-knowledge.ps1`, which uses ARM
  control-plane sub-resources), this script talks directly to the agent's
  own data-plane endpoint with an in-memory `https://azuresre.dev` token —
  the same plane the platform's own runtime uses to route incidents, which
  is why semantic (not opaque envelope) verification is possible here.
- **The exact filter/handler schema is not officially published.** The
  custom-agent endpoint (`PUT /api/v2/extendedAgent/agents/{name}`) is
  documented in the [API reference](https://learn.microsoft.com/azure/sre-agent/api-reference).
  The incident-filter/handler endpoints
  (`/api/v1/incidentplayground/filters/{id}`,
  `/api/v1/incidentplayground/handlers/{id}`) and their semantic list
  counterparts (`/api/v2/incidentManagement/incidentFilters`,
  `/api/v2/extendedAgent/incidentHandlers`) are capability-sensitive,
  unpublished Preview surface. This script capability-detects them via a
  safe list-endpoint probe before ever attempting a write, and — because
  the schema is unpublished — treats every 2xx write response as
  provisional until the semantic re-read confirms the interpreted fields
  actually match.
- **Autonomy is always `Review`.** The incident filter hard-codes
  `agentMode: 'Review'` — there is no parameter path to set `Autonomous`,
  even though the platform defaults new plans to Autonomous.
- **The quickstart response plan.** Azure automatically creates a default
  "quickstart" incident filter the first time an incident platform is
  connected. The bootstrap script detects and removes it (or any other
  filter whose id/name contains "quickstart"), then re-lists to confirm its
  absence; if the API does not allow removing it or the re-list still shows
  it present, the bootstrap fails validation explicitly rather than risking
  duplicate/incorrect incident routing.
- **RBAC in the demo profile is narrower than the standard profile, by
  design.** The standard profile's SRE identity still gets the existing
  resource-group `High` bundle (Reader + Contributor + Log Analytics
  Contributor) exactly as before. The **demo profile** deliberately
  withholds resource-group Contributor (`demoLeastPrivilegeRbac = true` on
  `sre-agent.bicep`, selecting Reader + Log Analytics Reader only) so that
  `sre-agent-demo-rbac.bicep`'s AKS-cluster-scoped custom role is the thing
  that actually grants write ability for this one remediation, not a
  redundant addition on top of a broader Contributor grant. The one
  documented, unavoidable exception is the subscription-scope Monitoring
  Contributor grant described above, required for the Azure Monitor
  scanner itself (not for remediation).

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
