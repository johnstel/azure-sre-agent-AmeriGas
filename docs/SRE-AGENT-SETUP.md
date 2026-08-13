# Azure SRE Agent Setup Guide

This guide walks you through setting up Azure SRE Agent to work with the demo lab environment.

## What is Azure SRE Agent?

Azure SRE Agent (Preview) is an AI-powered site reliability engineering automation tool that helps you:

- **Diagnose issues** in Azure resources using natural language
- **Investigate incidents** across AKS, App Service, Container Apps, and more
- **Run remediation actions** to fix common problems
- **Create scheduled tasks** for proactive monitoring
- **Integrate with external tools** like Grafana, PagerDuty, and ServiceNow

## Prerequisites

Before creating an SRE Agent, ensure you have:

- ✅ Deployed the demo lab infrastructure (`scripts/deploy.ps1`)
- ✅ Access to a supported Azure region (East US 2, Sweden Central, Australia East)
- ✅ `Microsoft.Authorization/roleAssignments/write` permission
- ✅ Firewall allows access to `*.azuresre.ai`

## Step 1: Create an SRE Agent

### Automated via Bicep (Default)

The SRE Agent is deployed automatically as part of `scripts/deploy.ps1` using the `Microsoft.App/agents` resource type. `deploy.ps1` queries the target subscription's `Microsoft.App` resource-provider metadata (`az provider show`) and pins the deployment to the newest API version this repository's Bicep module has been validated against — currently `2026-01-01` (GA), falling back to `2025-05-01-preview` on subscriptions that haven't been rolled onto the GA version yet. If neither version is registered, `deploy.ps1` fails with an explicit error rather than silently deploying against an unvalidated schema.

The deployment:

- Creates the SRE Agent resource with `knowledgeGraphConfiguration.managedResources` set to **exactly** this lab's resource group ID (never an empty list, never a different subscription/RG)
- Binds `logConfiguration.applicationInsightsConfiguration` to this lab's Application Insights App ID and connection string
- Keeps `actionConfiguration.mode` set to `Review`
- Creates a user-assigned managed identity, scoped to **this resource group only** (least-scope RBAC — see below)
- Grants the deploying user the **SRE Agent Administrator** role
- Runs `scripts/bootstrap-sre-agent-knowledge.ps1` to upload `docs/sre-agent-knowledge.md` (see Step 3 — this used to be a manual step)

To skip SRE Agent deployment, set `deploySreAgent = false` in `infra/bicep/main.bicepparam`.

### Via Azure Portal (Alternative)

You can also create the agent manually:

1. Navigate to [Azure Portal](https://portal.azure.com)
2. Search for "SRE Agent" in the search bar
3. Click **Create SRE Agent**
4. Configure:
   - **Subscription**: Select your subscription
   - **Resource Group**: Create new or use existing (separate from demo resources)
   - **Name**: `sre-agent-demo` (or your preferred name)
   - **Region**: Must match one of: `East US 2`, `Sweden Central`, `Australia East`

5. Click **Review + Create**, then **Create**

If you create the agent this way, you are responsible for setting `knowledgeGraphConfiguration.managedResources`, the Application Insights binding, and running `scripts/bootstrap-sre-agent-knowledge.ps1` yourself — none of the automation below applies to a portal-created agent.

### What Gets Created

When you create an SRE Agent, Azure automatically provisions:
- Application Insights instance
- Log Analytics Workspace
- Managed Identity for the agent

## Step 2: Agent Permissions (automated, least-scope)

The SRE Agent needs access to your Azure resources to diagnose and **remediate** issues. When deployed via Bicep (default `accessLevel = High`), the agent's managed identity is automatically assigned Reader, Contributor, and Log Analytics Contributor roles **scoped to the deployment resource group only** — never subscription-wide. (A `Low` access level is also available for read-only diagnosis: Reader + Log Analytics Reader, no Contributor.) `scripts/configure-rbac.ps1` runs automatically from `deploy.ps1` to grant the additional AKS-specific roles below; you only need to run it manually if you skipped RBAC during deploy (`-SkipRbac`) or created the agent via the portal:

```powershell
.\scripts\configure-rbac.ps1 `
    -ResourceGroupName "rg-srelab-eastus2" `
    -SreAgentPrincipalId "<sre-agent-object-id>"
```

### Permissions Granted to SRE Agent

The script assigns these roles to enable both **diagnosis AND remediation** — all scoped to the lab resource group or a specific resource within it, never to the subscription:

| Scope | Role | What It Allows |
|-------|------|----------------|
| **Resource Group** | Contributor | Read/write access to all resources |
| **AKS Cluster** | AKS Cluster Admin Role | kubectl access to cluster |
| **AKS Cluster** | AKS RBAC Cluster Admin | Full Kubernetes RBAC permissions |
| **AKS Cluster** | AKS Contributor Role | Scale nodes, update cluster config |
| **Log Analytics** | Log Analytics Contributor | Query and analyze logs |
| **Key Vault** | Key Vault Secrets Officer | Manage secrets |
| **Container Registry** | AcrPush | Push/pull container images |

> **Note**: These are **write permissions** that allow SRE Agent to take actions like:
> - Restart pods, scale deployments, delete stuck resources
> - Query and analyze logs
> - Access/update Key Vault secrets
> - Push/pull container images
>
> There is deliberately **no subscription-wide Reader shortcut** here — `scripts/validate-deployment.ps1` fails if it ever finds a subscription-scoped role assignment for the agent's identity.

### SRE Agent User Roles

Assign these roles to **users** who will interact with SRE Agent:

| Role | Description |
|------|-------------|
| **SRE Agent Admin** | Full access - create agents, manage settings, assign roles |
| **SRE Agent Standard User** | Chat with agent, run diagnostics and remediation |
| **SRE Agent Reader** | View-only access to agent and chat history |

Assign roles to users via Azure Portal:
1. Navigate to your SRE Agent resource
2. Go to **Access control (IAM)**
3. Click **Add role assignment**
4. Select the appropriate role and assign to users/groups

## Step 3: Knowledge is bootstrapped automatically

`knowledgeGraphConfiguration.managedResources` (Step 1) and the Application Insights binding (Step 1) can be expressed declaratively in Bicep. Knowledge-file upload cannot — Azure SRE Agent only exposes it through data-plane REST endpoints (`/api/v1/agentmemory/*`), so `deploy.ps1` runs `scripts/bootstrap-sre-agent-knowledge.ps1` after the infrastructure deployment completes:

- Computes a SHA-256 hash of `docs/sre-agent-knowledge.md` and uploads it under a deterministic, hash-keyed document name.
- An unchanged rerun detects the same hash already indexed and skips the upload — **no duplication**.
- A changed file uploads a new hash-keyed document, waits for it to finish indexing, and only then removes the previous version — a failure mid-run never leaves the agent with zero current knowledge.
- If the agent-memory API isn't available on a given agent's data-plane endpoint (probed explicitly via `GET /api/v1/agentmemory/status`), the script **fails with an explicit "unsupported API" error** — it never claims success and never asks for a manual portal upload.

To run it manually (for example, after `-SkipRbac`/standalone reruns, or once the knowledge file changes):

```powershell
.\scripts\bootstrap-sre-agent-knowledge.ps1 `
    -ResourceGroupName "rg-srelab-eastus2" `
    -AgentName "sre-srelab"
```

`scripts/validate-deployment.ps1` (Step 4) verifies the current knowledge version is present and indexed before the deployment is considered demo-ready.

## Step 3.5: Native alert-to-approved-remediation response plan (demo profile only, issue #19)

For a fully automated, presenter-hands-off demo of the native diagnose → propose → approve → execute → verify flow, deploy the **demo profile** instead of the standard profile:

```powershell
.\scripts\deploy.ps1 -Location eastus2 -Demo -AcceptSubscriptionScopeMonitoringRbac
```

`-AcceptSubscriptionScopeMonitoringRbac` is required alongside `-Demo` and is deliberately independent of `-Yes`: the demo profile grants the SRE Agent's managed identity the built-in **Monitoring Contributor** role at **subscription scope**, which Microsoft documents as the minimum scope required for the Azure Monitor alert scanner to discover and manage alert lifecycle (see [docs/sre-agent-response-plans/README.md](sre-agent-response-plans/README.md#why-a-subscription-scope-grant-is-unavoidable)). Omitting the switch fails the deployment with an explanation rather than silently skipping the grant.

In exchange, the demo profile is **more** least-privilege than the standard profile at resource-group scope: the SRE identity does NOT receive resource-group Contributor in the demo profile (only Reader + Log Analytics Reader) — the exact `az aks command invoke` remediation is granted instead through a narrow, AKS-cluster-scoped custom role.

This enables a dedicated MongoDB-down alert, connects Azure Monitor as the agent's incident management platform, and bootstraps a real Azure SRE Agent **response plan** (custom agent + incident filter + incident handler, Review autonomy, semantically verified via the platform's own data-plane list APIs) that investigates and proposes exactly one approved remediation when the alert fires — with no chat prompt required. See [docs/sre-agent-response-plans/README.md](sre-agent-response-plans/README.md) for the full flow, bounded alert timing, rehearsal instructions (approve/deny/expiry — **required** before calling the demo proven), and documented Preview schema limitations. The standard profile (`main.bicepparam`, the default) is completely unaffected by this — `deployDemoResponsePlan` and `acknowledgeSubscriptionScopeMonitoringRbac` both default to `false` and are never enabled there.

## Step 4: Start Diagnosing!

Once connected, you can interact with SRE Agent using natural language:

### Starter Prompts for AKS

- "Show me the health status of my AKS cluster"
- "Why are pods crashing in the propane namespace?"
- "What's causing high CPU usage on my nodes?"
- "List all pods that have restarted in the last hour"
- "Diagnose the CrashLoopBackOff error for the tank-monitor pod"

### Starter Prompts for General Diagnosis

- "What issues are affecting my application right now?"
- "Show me errors from the last 24 hours"
- "Analyze the performance metrics and identify bottlenecks"
- "What changes were made to my resources recently?"

## Using SRE Agent with Demo Scenarios

### Example: Diagnosing OOMKilled Pods

1. **Break the application:**
   ```bash
   kubectl apply -f k8s/scenarios/oom-killed.yaml
   ```

2. **Wait for pods to crash** (1-2 minutes)

3. **Ask SRE Agent:**
   > "I'm seeing pods crash in the propane namespace. Can you diagnose the issue?"

4. **Expected Response:**
   - SRE Agent will identify OOMKilled events
   - Recommend increasing memory limits
   - May offer to create a remediation action

5. **Fix the issue:**
   ```bash
   kubectl apply -f k8s/base/application.yaml
   ```

### Example: Diagnosing Network Issues

1. **Apply network policy:**
   ```bash
   kubectl apply -f k8s/scenarios/network-block.yaml
   ```

2. **Ask SRE Agent:**
   > "The tank-monitor seems to be unreachable. What's blocking traffic?"

3. **Expected Response:**
   - Identifies blocking network policy
   - Shows affected pods
   - Recommends removing or modifying the policy

## Advanced Features

### Scheduled Tasks

This repo ships a source-controlled, idempotent scheduled task —
`daily-propane-health-report` — instead of asking you to configure one by
hand. See [docs/sre-agent-scheduled-tasks/README.md](sre-agent-scheduled-tasks/README.md)
for the full setup, capability-detection notes, and validation runbook.

```powershell
.\scripts\bootstrap-sre-agent-scheduled-task.ps1 -ResourceGroupName <rg> -AgentName <agent> -AksClusterName <cluster>
```

To create a DIFFERENT ad hoc scheduled task manually instead:

1. Go to **Subagent builder** in SRE Agent
2. Click **Create scheduled task**
3. Configure:
   - **Name**: "Daily AKS Health Check"
   - **Schedule**: "Every day at 9 AM" (or use cron: `0 9 * * *`)
   - **Prompt**: "Check the health of my AKS cluster and report any issues"

### Incident Triggers

Configure automatic diagnosis when incidents are created:

1. Go to **Subagent builder** > **Incident triggers**
2. Connect to your incident management system (PagerDuty, ServiceNow)
3. Define trigger conditions and diagnosis prompts

### MCP Integrations

Connect external tools via Model Context Protocol (MCP):

- **Grafana**: Query dashboards and metrics
- **Prometheus**: Access custom metrics
- **GitHub/Azure DevOps**: Correlate with code changes
- **ServiceNow/PagerDuty**: Bi-directional incident management

## Troubleshooting SRE Agent

### Agent Can't Access AKS Resources

**Symptom:** SRE Agent says it can't read namespaces or pods

**Cause:** AKS cluster has restricted inbound network access

**Solution:** Ensure the cluster is not a fully private cluster. SRE Agent needs network access to query Kubernetes objects.

### Permission Errors

**Symptom:** "Insufficient permissions" errors

**Solution:**
1. Verify the SRE Agent's managed identity has Contributor role on the resource group
2. Ensure you have `Microsoft.Authorization/roleAssignments/write` permission
3. Run the RBAC configuration script again

### Firewall Blocking

**Symptom:** Agent can't connect or times out

**Solution:** Ensure `*.azuresre.ai` is allowed through your firewall/proxy

### Knowledge Bootstrap Fails with "unsupported API"

**Symptom:** `scripts/bootstrap-sre-agent-knowledge.ps1` (or `deploy.ps1`) fails with a message like "The agent memory API ... responded 404/405 ... this Preview capability is not available here."

**Cause:** The agent's data-plane endpoint does not expose `/api/v1/agentmemory/*` yet. This is a genuine Preview capability gap, not a misconfiguration.

**Solution:** There is no manual portal workaround that this repository endorses — the script fails loudly on purpose rather than claiming the knowledge base is loaded. Retry later, or check the [Azure SRE Agent Documentation](https://learn.microsoft.com/azure/sre-agent/) for the current rollout status of agent memory in your region/subscription.

## Preview Limitations

- **Control-plane API version.** `Microsoft.App/agents` is validated against `2026-01-01` (GA) and `2025-05-01-preview` only. `deploy.ps1` queries the subscription's registered API versions and fails deployment explicitly if neither is available — it never silently deploys against an unvalidated schema.
- **Knowledge upload/indexing has no declarative (Bicep) form.** It is automated via `scripts/bootstrap-sre-agent-knowledge.ps1` against the documented data-plane REST endpoints (`/api/v1/agentmemory/upload`, `/status`, `/indexer-status`, `/document/{fileName}`). The exact multipart field name for `upload` is not published in the API reference beyond "multipart, max 100 MB total, 16 MB per file"; the script uses `file` as a reasonable default and surfaces the exact HTTP error from the server if that's rejected, rather than guessing silently.
- **Data-plane tokens are never persisted.** `az account get-access-token --resource https://azuresre.dev` is called in-memory for the lifetime of the bootstrap/validation process only; nothing is written to disk, logs, or console output.
- **No subscription-wide RBAC.** The agent's managed identity is only ever granted roles scoped to the lab resource group (or a specific resource within it). `scripts/validate-deployment.ps1` fails if it detects a subscription-scoped assignment for that identity.
- **Response-plan data-plane schema is not published (issue #19, demo profile only).** The custom-agent endpoint (`/api/v2/extendedAgent/agents/{name}`) is documented; the incident-filter/handler endpoints and their semantic list counterparts are capability-sensitive, unpublished Preview surface. `scripts/bootstrap-sre-agent-response-plan.ps1` never claims success from an HTTP 2xx alone — it re-reads every write through the platform's own data-plane list/get APIs and compares the INTERPRETED fields (not raw bytes). See [docs/sre-agent-response-plans/README.md](sre-agent-response-plans/README.md) for the full explanation.
- **Subscription-scope Monitoring Contributor is required for the demo profile's Azure Monitor scanner (issue #19, demo profile only).** This is documented by Microsoft as unavoidable for the scanner to function; it is gated behind an explicit `acknowledgeSubscriptionScopeMonitoringRbac` parameter and a separate `-AcceptSubscriptionScopeMonitoringRbac` deploy switch, and `scripts/validate-deployment.ps1` fails if the SRE identity holds any OTHER subscription-scope role. See [docs/sre-agent-response-plans/README.md](sre-agent-response-plans/README.md#why-a-subscription-scope-grant-is-unavoidable).

## Cost Information

SRE Agent billing is based on Azure AI Units (AAU):

| Component | Cost |
|-----------|------|
| Fixed agent cost | ~$292/month (4 AAU × 730 hours × $0.10) |
| Execution costs | Variable based on usage |

See [docs/COSTS.md](COSTS.md) for full cost breakdown including AKS and other resources.

## Additional Resources

- [Azure SRE Agent Documentation](https://learn.microsoft.com/azure/sre-agent/)
- [Azure SRE Agent API Reference](https://learn.microsoft.com/azure/sre-agent/api-reference)
- [SRE Agent FAQs](https://learn.microsoft.com/azure/sre-agent/faq)
- [Supported Azure Services](https://learn.microsoft.com/azure/sre-agent/overview#supported-services)
