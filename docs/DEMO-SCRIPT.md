# AmeriGas Propane — Azure SRE Agent Demo Script

> **Audience:** AmeriGas IT / Operations leadership
> **Duration:** ~30–45 minutes
> **Prerequisites:** Infrastructure already deployed (`deploy`), Mission Control running (`npm start` in `tools/mission-control`)

---

## Pre-Demo Checklist

- [ ] Infrastructure deployed and healthy (`kgp` shows 8 running pods)
- [ ] Mission Control running at http://localhost:3000
- [ ] SRE Agent portal open at https://aka.ms/sreagent/portal
- [ ] Browser tabs ready: Mission Control, SRE Agent Portal, Azure Portal (resource group)
- [ ] Upload `docs/sre-agent-knowledge.md` as SRE Agent knowledge file
- [ ] Confirm customer portal external IP is active (check Mission Control status card)

---

## Act 1 — Set the Stage (5 min)

### Talking Points

> "We've built a simulation of an AmeriGas-style propane operations platform running on Azure Kubernetes Service. It includes the services you'd recognize — tank monitoring from smart sensors, inventory management across depots, order fulfillment, and customer-facing portals."

> "The platform has **8 microservices** in production, backed by MongoDB for data persistence and RabbitMQ for event processing — much like the architecture patterns you'd see in a real IoT-connected propane distribution system."

### Show: Mission Control Dashboard

1. Open **Mission Control** (http://localhost:3000)
2. Walk through the status cards: "8 healthy pods, all green"
3. Point out the service architecture in the pod table
4. Click the **Customer Portal** link to show the consumer-facing app
5. Show the **Deployments** panel — all replicas healthy (1/1)

### Show: SRE Agent Portal

1. Open **SRE Agent Portal** (https://aka.ms/sreagent/portal)
2. Explain: "This is Azure SRE Agent — an AI-powered site reliability engineer that has access to your cluster, your logs in Log Analytics, your metrics, and the knowledge base we provided about your environment."

### Baseline Health Check

In SRE Agent, ask:

> **"Give me a health report for the propane namespace"**

Let the agent show that everything is healthy. This establishes the baseline.

---

## Act 2 — "Something Breaks in Production" (15–20 min)

> "Now let's simulate what happens when things go wrong — and how SRE Agent can diagnose issues faster than a human paging through dashboards."

Pick **2–3 scenarios** from the options below. Recommended flow for maximum impact:

---

### Scenario A: MongoDB Outage — Cascading Failure ⭐ (Recommended first)

**Why this one:** Shows cascading failures and root cause analysis — the most impressive SRE Agent capability.

**1. Set the scene:**
> "Imagine it's Tuesday morning. The operations team starts getting alerts — tank readings aren't being processed, orders aren't going through. Multiple services seem affected. Let's see what SRE Agent can figure out."

**2. Break it** — click **"MongoDB Down"** in Mission Control's Break Scenarios panel

**3. Watch the cascade** — Mission Control will show:
- mongodb pod disappears (0 replicas)
- tank-monitor and order-service may start showing errors/restarts
- Unhealthy pod count goes red

**4. Ask SRE Agent** (start vague, like a real operator would):

> **"Something is wrong with our propane platform. Tank readings aren't being processed and orders are failing. What's going on?"**

Let the agent investigate. It should trace the dependency chain:
- Services failing → can't connect to database → MongoDB has 0 replicas

**5. Follow up:**

> **"What depends on MongoDB? How many services are affected?"**

> **"What's the fastest way to restore service?"**

**6. Fix it** — click **🔧 Fix All** in Mission Control

**7. Show recovery** — pods come back to green within 30–60 seconds

---

### Scenario B: OOMKilled — Tank Monitor Memory Exhaustion

**Why this one:** Very common in production. Easy to understand.

**1. Set the scene:**
> "Winter peak season hits. Smart tank sensors are reporting at higher frequency as customers consume more propane. The tank monitor service can't keep up."

**2. Break it** — click **"OOMKilled"** in Mission Control

**3. Watch it** — tank-monitor pod cycles between Running and OOMKilled, restart count climbs

**4. Ask SRE Agent:**

> **"The tank-monitor pod keeps restarting. Can you figure out why?"**

Agent should identify OOMKilled events and the insufficient memory limit (16Mi).

**5. Follow up:**

> **"What memory limit should we set to handle peak IoT data volume?"**

**6. Fix it** — click **🔧 Fix All**

---

### Scenario C: Network Policy — Silent Failure

**Why this one:** Demonstrates a "silent" failure — everything looks healthy but nothing works. Shows SRE Agent's ability to investigate beyond pod status.

**1. Set the scene:**
> "After a security review, someone applied a network policy to isolate the tank monitor. But they blocked too much traffic — now tank data isn't flowing anywhere."

**2. Break it** — click **"Network Block"** in Mission Control

**3. Point out:** "Look — the pod is Running and green. A human looking at this dashboard would think everything is fine. But data isn't flowing."

**4. Ask SRE Agent:**

> **"Tank readings are being accepted but never appear in the system. The pod looks healthy. What could be wrong?"**

Agent should discover the `deny-tank-monitor` NetworkPolicy blocking all traffic.

**5. Follow up:**

> **"Show me the network policies in the propane namespace"**

**6. Fix it** — click **🌐 Fix Network** in Mission Control

---

### Scenario D: Service Mismatch — Post-Upgrade Failure (Alternative)

**Why this one:** Shows a subtle Kubernetes misconfiguration that's hard to spot manually.

**1. Set the scene:**
> "The team pushed a 'v2 upgrade' of the tank monitor. The deployment went fine, but suddenly nothing can reach it."

**2. Break it** — click **"Service Mismatch"**

**3. Ask SRE Agent:**

> **"The customer portal can't connect to tank-monitor, but the pod is running fine. What's happening?"**

Agent should find the Service selector (`app: tank-monitor-v2`) doesn't match the pod label (`app: tank-monitor`).

**4. Fix it** — click **🔧 Fix All**

---

## Act 3 — Proactive Capabilities (5 min)

> "SRE Agent isn't just reactive. It can proactively monitor your environment."

### Scheduled Health Checks

In SRE Agent, ask:

> **"Check the health of my AKS cluster every hour and alert me if any pods are unhealthy"**

Show how SRE Agent can set up a recurring scheduled task.

### Best Practice Analysis

> **"Are there any pods running without resource limits in the propane namespace?"**

> **"Check if any containers are using deprecated API versions"**

---

## Act 4 — The Value Proposition (5 min)

### Key Messages

1. **Mean Time to Diagnosis** — "What took a 3-person war room 45 minutes, SRE Agent diagnosed in under 30 seconds. It correlated logs, metrics, events, and configuration automatically."

2. **Institutional Knowledge** — "We uploaded a knowledge file with your architecture and runbooks. SRE Agent uses this context to give answers specific to your environment, not generic Kubernetes advice."

3. **24/7 Coverage** — "SRE Agent doesn't sleep, doesn't go on vacation, and doesn't need to be paged at 3am. It can run scheduled health checks and alert when something deviates."

4. **Safe Remediation** — "SRE Agent can suggest AND execute fixes — with configurable access levels. Set it to 'Review' mode to require approval, or 'High' access for trusted automation."

5. **Azure-Native** — "This integrates with your existing Azure stack — Log Analytics, Application Insights, Azure Monitor, Grafana. No new tools to deploy."

### Cost Context

> "The full demo environment including SRE Agent runs at about $32–38/day. In production, the SRE Agent cost is a fraction of a single on-call engineer's time."

---

## Troubleshooting During Demo

| Issue | Quick Fix |
|-------|-----------|
| Pods stuck after fix | Wait 30–60 seconds, pods need time to pull images and start |
| Customer portal IP shows "Pending" | LoadBalancer takes 1–2 minutes after initial deploy |
| SRE Agent is slow to respond | Normal for complex queries — it's analyzing logs and metrics in real-time |
| Mission Control shows connection error | Verify kubectl context: `kubectl config current-context` |
| SRE Agent says "no data" | Ensure the knowledge file was uploaded and Log Analytics has had time to ingest data (allow 5–10 min after deploy) |

---

## Post-Demo Cleanup

1. Click **🔧 Fix All** in Mission Control to restore healthy state
2. Optionally run **Destroy** from the Infrastructure panel to tear down Azure resources
3. Resources cost ~$32–38/day while running — destroy if not needed

---

## Appendix: All Available Scenarios

| Mission Control Button | What Breaks | Business Story |
|----------------------|-------------|---------------|
| OOMKilled | tank-monitor memory exhaustion | Winter peak IoT data spike |
| CrashLoopBackOff | inventory-service bad config | Invalid pricing configuration |
| ImagePullBackOff | order-service wrong image | Botched image release |
| High CPU | CPU stress pod added | Peak season demand forecasting overload |
| Pending Pods | Unschedulable pods | Fleet telemetry over-provisioned |
| Probe Failure | Bad health check endpoints | Post-maintenance misconfiguration |
| Network Block | NetworkPolicy blocks traffic | Overly restrictive security policy |
| Missing Config | Missing ConfigMaps | Delivery zone config not deployed |
| MongoDB Down | Database scaled to 0 | Database outage — cascading failure |
| Service Mismatch | Selector label drift | Silent routing failure after "v2 upgrade" |
