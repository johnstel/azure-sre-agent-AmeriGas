# SRE Agent Prompts Guide

A curated collection of prompts to use with Azure SRE Agent when demoing the AmeriGas Propane SRE Lab. Organized by scenario and intent.

## Getting Started (Healthy Cluster)

Start here when the cluster is healthy to show SRE Agent's baseline capabilities:

| Prompt | What It Shows |
|--------|---------------|
| "Show me the health status of my AKS cluster" | Cluster overview, node status, system pods |
| "Are there any issues in the propane namespace?" | Baseline health check, confirms everything is green |
| "What workloads are running on the propane distribution platform?" | Inventory of deployments, replica counts |
| "Show me resource utilization across my propane pods" | CPU/memory usage, identifies headroom |
| "What changes were made to my cluster recently?" | Audit trail / event history |

---

## Per-Scenario Diagnosis Prompts

### OOMKilled (`break-oom`)

| Stage | Prompt |
|-------|--------|
| **Open-ended** | "Something seems wrong with the tank-monitor. Can you take a look?" |
| **Direct** | "Why is the tank-monitor pod restarting repeatedly?" |
| **Specific** | "I see OOMKilled events in the propane namespace. What's going on?" |
| **Remediation** | "What memory limits should I set for tank-monitor to handle peak IoT tank level data?" |
| **Action** | "Can you increase the memory limit for tank-monitor to 256Mi?" |

### CrashLoopBackOff (`break-crash`)

| Stage | Prompt |
|-------|--------|
| **Open-ended** | "The propane inventory catalog isn't loading. What's wrong?" |
| **Direct** | "Why is inventory-service in CrashLoopBackOff?" |
| **Specific** | "Show me the logs for the crashing inventory-service pods" |
| **Remediation** | "What's causing exit code 1 in inventory-service?" |
| **Action** | "Restart the inventory-service deployment" |

### ImagePullBackOff (`break-image`)

| Stage | Prompt |
|-------|--------|
| **Open-ended** | "The order service pods won't start. Help?" |
| **Direct** | "Why is order-service stuck in ImagePullBackOff?" |
| **Specific** | "Is there an issue with the container image for order-service?" |
| **Remediation** | "What image should order-service be using?" |

### High CPU (`break-cpu`)

| Stage | Prompt |
|-------|--------|
| **Open-ended** | "Propane services feel slow. What's going on?" |
| **Direct** | "Which pods are consuming the most CPU in the propane namespace?" |
| **Specific** | "Analyze CPU usage across all propane platform pods and identify contention" |
| **Remediation** | "What should I do about the demand-forecast-overload workload?" |
| **Action** | "Delete the demand-forecast-overload deployment" |

### Pending Pods (`break-pending`)

| Stage | Prompt |
|-------|--------|
| **Open-ended** | "I deployed a new fleet telemetry monitoring workload but it's not starting" |
| **Direct** | "Why are the fleet-telemetry-monitor pods stuck in Pending?" |
| **Specific** | "Analyze cluster capacity vs. what the fleet telemetry monitor is requesting" |
| **Remediation** | "Should I scale the node pool or reduce resource requests for the monitor?" |

### Probe Failure (`break-probe`)

| Stage | Prompt |
|-------|--------|
| **Open-ended** | "Safety compliance monitor pods keep restarting but the app looks fine" |
| **Direct** | "Diagnose the health check failures in the propane namespace" |
| **Specific** | "What's wrong with the liveness probe on safety-compliance-monitor?" |
| **Remediation** | "How should I fix the probe configuration?" |

### Network Policy Block (`break-network`)

| Stage | Prompt |
|-------|--------|
| **Open-ended** | "Tank readings aren't being processed anymore. What happened?" |
| **Direct** | "Why can't the customer portal reach tank-monitor?" |
| **Specific** | "Are there any network policies blocking traffic in the propane namespace?" |
| **Remediation** | "How do I fix the network connectivity to tank-monitor?" |
| **Action** | "Delete the deny-tank-monitor network policy" |

### Missing ConfigMap (`break-config`)

| Stage | Prompt |
|-------|--------|
| **Open-ended** | "A delivery zone configuration pod won't start — says something about missing config?" |
| **Direct** | "What configuration is missing for delivery-zone-config?" |
| **Specific** | "Check for ConfigMap or Secret reference errors in the propane namespace" |

### MongoDB Down (`break-mongodb`)

| Stage | Prompt |
|-------|--------|
| **Open-ended** | "Tank readings are accepted but never processed. What's wrong?" |
| **Direct** | "Why is order-service failing health checks?" |
| **Follow-up** | "Is MongoDB running? What depends on it?" |
| **Root cause** | "Trace the dependency chain — what broke first?" |
| **Action** | "Scale the mongodb deployment back to 1 replica" |

### Service Selector Mismatch (`break-service`)

| Stage | Prompt |
|-------|--------|
| **Open-ended** | "The customer portal loads but submitting tank readings fails. Everything looks healthy." |
| **Direct** | "Why does tank-monitor have no endpoints?" |
| **Specific** | "Compare the tank-monitor Service selector to the actual pod labels" |
| **Remediation** | "Fix the selector on the tank-monitor Service to match the pods" |

---

## Proactive & Exploratory Prompts

Use these to demo SRE Agent's ability to investigate and report without a specific incident:

| Prompt | Demonstrates |
|--------|-------------|
| "Give me a health report for the propane namespace" | Comprehensive status review |
| "Are there any pods that have restarted in the last hour?" | Proactive monitoring |
| "What's the resource utilization trend for the propane platform cluster?" | Capacity planning |
| "Check if any containers are running without resource limits" | Best practice enforcement |
| "Are there any deprecated API versions in the propane platform workloads?" | Upgrade readiness |
| "Show me error trends from the last 24 hours" | Log analysis / App Insights |
| "What are the most common exceptions in Application Insights?" | Observability integration |

---

## Remediation Prompts

Show that SRE Agent can take action, not just report:

| Prompt | Action |
|--------|--------|
| "Restart the tank-monitor pods" | Rolling restart |
| "Scale the inventory-service to 3 replicas" | Scaling |
| "Delete the demand-forecast-overload deployment" | Resource cleanup |
| "Remove the deny-tank-monitor network policy" | Policy management |
| "Scale MongoDB back to 1 replica" | Dependency restoration |

> **Note**: Remediation requires the SRE Agent to have write permissions (Contributor + AKS Cluster Admin). See [SRE-AGENT-SETUP.md](SRE-AGENT-SETUP.md) for RBAC configuration.

---

## Scheduled Tasks & Subagents

Demo proactive SRE automation:

| Prompt | What It Sets Up |
|--------|----------------|
| "Check the health of my AKS cluster every hour and alert if anything is unhealthy" | Recurring health check |
| "Monitor pod restarts in the propane namespace and notify me if any pod restarts more than 3 times" | Threshold-based alerting |
| "Run a daily capacity analysis and report if any node is above 80% utilization" | Capacity monitoring |

To set these up in the portal:
1. Go to **Subagent builder** in your SRE Agent resource
2. Click **Create scheduled task**
3. Enter the prompt and set the schedule (e.g., cron: `0 * * * *` for hourly)

---

## "What Changed?" Correlation

After applying a break scenario, instead of asking "what's wrong," try asking about changes:

| Prompt | Why It's Interesting |
|--------|---------------------|
| "What changed in my cluster in the last 10 minutes?" | Shows audit/event correlation |
| "Were any deployments modified recently?" | Traces the break to a specific change |
| "Show me the diff between the current and previous deployment of tank-monitor" | Rollback context |

---

## Tips for Effective Prompts

1. **Start vague, get specific** — Open with "something seems wrong with propane services" and let SRE Agent discover the issue, then drill down with follow-up questions
2. **Ask for root cause** — "Why?" is more powerful than "show me the status"
3. **Request action** — Don't just diagnose; ask SRE Agent to fix it
4. **Use follow-ups** — SRE Agent maintains context within a conversation, so build on previous answers
5. **Try the "naive user" approach** — Phrase prompts like someone who doesn't know Kubernetes: "customers complaining deliveries aren't being tracked" is a great starting point
6. **Combine observability** — Ask about logs, metrics, and events together: "Correlate the pod restarts with any CPU or memory spikes"
