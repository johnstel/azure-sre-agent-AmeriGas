# AmeriGas Propane — Azure SRE Agent Demo Script

> **Audience:** AmeriGas IT / Operations leadership
> **Duration:** ~30–45 minutes (rehearsal pacing; see note below)
> **Primary flow:** Presenter mode (Fast Wow or Deep Dive) is the default guided demo path; operator mode remains available for ad hoc exploration.
> **Prerequisites:** Infrastructure already deployed (`deploy`), all 9 services running in the `propane` namespace

> **Important:** These timings are simulated presentation budgets for a rehearsal script. They are not measured from a live `rg-srelab` environment, and no live rehearsal cluster is implied by the current repo state.

---

## Readiness Gate (authoritative, read-only)

Do not use the old manual pre-demo checklist for a presentation. Run the single, server-authoritative readiness gate before you open the presenter flow:

```powershell
pwsh ./scripts/test-demo-readiness.ps1 -Subscription "<subscription-id-or-name>" -ResourceGroup "<resource-group-name>" -Format Human
pwsh ./scripts/test-demo-readiness.ps1 -Subscription "<subscription-id-or-name>" -ResourceGroup "<resource-group-name>" -Format Json
```

This check is intentionally read-only and fail-closed:

- It requires the exact Azure auth context and the target resource group; mismatches or stale context block readiness.
- It validates AKS health, node/pool status, lifecycle baseline, DRY fingerprint, locks, rollout endpoints, and scenario artifacts.
- It verifies customer and dispatch HTTP endpoints, the OTel collector, and fresh correlated telemetry from the current run.
- It requires fresh SRE Agent scope evidence, App Insights/Review/knowledge/RBAC/state proof, and the scheduled-task evidence from the current run.
- It never mutates or repairs the environment, and every check returns a stable `id/category/status/blocking/observedAt/duration/evidence/remediation` record.
- Mission Control only renders the server-bound result; the client cannot inject or override readiness.

If the gate returns `blocking: true`, do not present the live demo. Stop and fix the underlying issue or reschedule the briefing.

---

## Act 1 — Set the Stage (5–7 min)

### Talking Points

> "We've built a full simulation of AmeriGas propane operations running on Azure Kubernetes Service. This isn't a generic demo — it models **two distinct propane business domains**: residential/commercial **bulk tank** delivery accounts (gallons, tank percentage, refill scheduling) and retail **cylinder exchange** cage locations across PA and NJ (full/empty/reserved cylinder counts, cage replenishment). The customer-facing portal shows both; the dispatch console runs the Retail Cage Operations Center. A repo-owned probe observes real service responses and sends correlated OpenTelemetry to workspace-based Application Insights."

> "The platform has **9 demo services** — including an OpenTelemetry Collector that exports traces, logs, and metrics into Azure Monitor — backed by MongoDB for bulk tank readings and order/delivery data, and RabbitMQ for tank alerts and dispatch events."

### Show: Customer Portal

> The portal now surfaces degraded conditions with a banner, the last-known values stamped with a timestamp, and customer-safe messaging instead of blank failures. The same applies to the Dispatch Console when MongoDB, RabbitMQ, or the underlying service chain is disrupted.

1. Open the **Customer Portal** via Mission Control or its external IP

**Domain:** Bulk Tank

2. Walk through the **"My Bulk Tank"** section:
   - **Tank fill gauge** — the CSS conic-gradient gauge shows the customer's current tank level (gallons/percentage) with color-coded fill (green → yellow → red)
   - Est. days until empty, next delivery window, current price per gallon, seasonal demand, and account balance
3. Point out the usage history table (gallons used, tank level, daily average)

**Domain:** Cylinder Exchange

4. Walk through the **"Nearby Exchange Locations"** section:
   - Point out the 8 real PA/NJ retail locations: Home Depot King of Prussia, Walmart Collegeville, Lowe's Exton, ACE Hardware Lansdale, Wawa Wayne, ShopRite Norristown, Giant Pottstown, and Costco Plymouth Meeting
   - **Cage inventory visualization** — each location shows colored cylinder dots: 🔵 blue = full, ⚪ grey = empty, 🟠 orange = reserved
   - **Stock status badges** — "In Stock" (green), "Low Stock" (yellow), "Out of Stock" (red)

### Show: Dispatch Console — Retail Cage Operations Center

**Domain:** Cylinder Exchange

1. Open the **Dispatch Console** (ops-console) — this console is entirely Cylinder Exchange domain
2. Highlight the **12-location cage monitor grid**:
   - Each location card shows a 4×5 grid of cylinder circles (20 cylinders per cage)
   - Cylinders are color-coded: blue (full), grey (empty), orange (in transit)
   - **Critical locations pulse red** when they have ≤3 full cylinders — point this out: "See how this card is flashing? That location is about to run out."
3. Show the **Delivery Priority Queue**:
   - Sorted by estimated stockout time
   - Priority labels: URGENT / HIGH / NORMAL
   - "This is what the dispatch team would use to decide which trucks to send first."
4. Show the **7-day demand forecast**:
   - Temperature-based demand projections (High / Normal / Low) and estimated cylinders needed for each day
   - "The system correlates weather forecasts with historical consumption to predict when cages will need restocking."
5. Point out the **operations log** showing real-time cage restock events

**Domain:** Shared

### Show: Telemetry Pipeline

1. Briefly explain: "The third-party service images are not instrumented by this lab. The repo-owned `telemetry-probe` makes real HTTP calls to tank-monitor, inventory-service, and order-service, propagates W3C `traceparent`, and emits only telemetry it owns: INTERNAL transaction spans and CLIENT dependency spans with `peer.service`, target address, route, status, and measured latency. It never impersonates a target service."
2. Show the non-secret collector ConfigMap: `kubectl get configmap otel-collector-config -n propane -o yaml`. The Application Insights connection string is read from the `application-insights-connection` Secret and must not be displayed.
3. Run `.\scripts\validate-telemetry.ps1 -ResourceGroupName <rg>` and use its transaction ID to query `AppDependencies`, `AppExceptions`, `AppTraces`, `AppMetrics`, and `KubeEvents`. `AppRequests` is used only for the truthful server span emitted by the repo-owned `order-pricing-dependency` `GET /controlled-failure` route, which returns HTTP 503 deterministically.

### Show: SRE Agent Portal

1. Open **SRE Agent Portal** (https://aka.ms/sreagent/portal)
2. Explain: "This is Azure SRE Agent — an AI-powered site reliability engineer that has access to your cluster, your logs in Log Analytics, Application Insights telemetry, and the knowledge base we provided about your environment."

### Show: Mission Control Copilot

1. Click the **Copilot button** (or the status banner) in Mission Control to open the chat panel
2. Point out the **"Ready"** status badge — "This is our local AI assistant powered by the GitHub Copilot SDK. Unlike SRE Agent which runs in the cloud, this one runs right here on the operator's machine and has direct kubectl access to the cluster."
3. Show the **quick prompts** at the bottom of the chat for one-click operations
4. Explain: "This assistant has 20 custom tools — it can inspect pods, read logs, apply break scenarios, fix issues, and even deploy or destroy infrastructure, all through natural conversation."

### Baseline Health Check

In Mission Control Copilot, ask:

> **"Give me a full health check of the cluster"**

The Copilot will use its `get_cluster_health` tool to show pods, deployments, services, endpoints, warnings, and network policies in one go.

Then in SRE Agent, ask:

> **"Give me a health report for the propane namespace. Are all services reporting telemetry to Application Insights?"**

Advance only after `validate-telemetry.ps1` succeeds. A running collector pod alone does not establish a telemetry baseline.

---

## Act 2 — "Something Breaks in Production" (15–20 min)

> "Now let's simulate what happens when things go wrong — and how SRE Agent can diagnose issues faster than a human paging through dashboards."

Pick **2–3 scenarios** from the options below. Recommended flow for maximum impact:

Every scenario you break here is captured live in Mission Control's **🎯 Incident Evidence Timeline** panel — activation, first observed impact, evidence gathered, the proposed fix, and recovery, each with a server timestamp and a single correlation id for the run. Point this out to the audience: it's the measured record Act 4 draws its closing numbers from, not narration.

---

### Scenario A: MongoDB Outage — Cascading Failure ⭐ (Recommended first)

**Domain:** Shared

**Why this one:** Shows cascading failures and root cause analysis — the most impressive SRE Agent capability.

**1. Set the scene:**
> "Imagine the operations team at AmeriGas HQ notices the Retail Cage Operations Center dashboard suddenly shows stale data — cage inventory isn't updating, the delivery priority queue is frozen, and the operations log has stopped scrolling. Something is very wrong."

**2. Break it** — click **"MongoDB Down"** in Mission Control, or run:
```bash
kubectl apply -f k8s/scenarios/mongodb-down.yaml
```

**3. Watch the cascade:**
- MongoDB pod disappears (0 replicas)
- Tank-monitor and order-service start showing errors/restarts
- On the **Dispatch Console** — the operations log shows MongoDB connection errors cascading across services
- On the **Customer Portal** — cage inventory dots stop updating, stock status badges go stale
- Unhealthy pod count goes red in Mission Control
- The **Incident Evidence Timeline** panel records activation immediately, then a server-detected "first impact" milestone once the poll observes the unhealthy pod state

**4. Ask SRE Agent** (start vague, like a real operator would):

> **"Something is wrong with our propane platform. Cage inventory isn't updating and the dispatch queue is frozen. What's going on?"**

Let the agent investigate. It should trace the dependency chain:
- Services failing → can't connect to database → MongoDB has 0 replicas

**5. Follow up:**

> **"What depends on MongoDB? How many services are affected?"**

> **"Can you check Application Insights for error rate spikes across the propane services?"**

> **"What's the fastest way to restore service?"**

**6. Fix it** — click **🔧 Fix All** in Mission Control, or run:
```bash
kubectl apply -f k8s/base/application.yaml
```

**7. Show recovery** — pods come back to green within 30–60 seconds. Cage inventory resumes updating. The Incident Evidence Timeline panel records the proposed/executed fix, a post-action assertion re-checking the scenario's health signal, and the recovery milestone — and only then reports a measured time-to-recover. If the assertion doesn't confirm recovery, the panel truthfully shows "partial recovery," never a fabricated success.

> **Presenting the native flow instead:** Steps 1–7 above use Mission Control Copilot as an operator-driven walkthrough. If you deployed the **demo profile** (`.\scripts\deploy.ps1 -Location eastus2 -Demo -AcceptSubscriptionScopeMonitoringRbac`), this exact scenario is also wired to a genuine native Azure SRE Agent response plan — applying the scenario alone (no chat prompt) triggers a real Azure Monitor alert, which the SRE Agent investigates and proposes one approved remediation for in its own portal. See [docs/sre-agent-response-plans/README.md](sre-agent-response-plans/README.md) for that flow's script and timing, and present whichever matches your audience: Mission Control for a fast, narrated walkthrough, or the native SRE Agent portal thread for proof of the fully automated platform capability. A live approve/deny/expiry rehearsal is required before presenting this as a proven capability rather than a configured one.

---

### Scenario B: OOMKilled — Tank Monitor Memory Exhaustion

**Domain:** Bulk Tank

**Why this one:** Very common in production. Easy to understand.

**1. Set the scene:**
> "Winter peak season hits. Smart sensors on residential and commercial **bulk propane tanks** are reporting at higher frequency as customers consume more propane for heating. The tank-monitor service can't keep up with the data volume."

**2. Break it** — click **"OOMKilled"** in Mission Control, or run:
```bash
kubectl apply -f k8s/scenarios/oom-killed.yaml
```

**3. Watch it:**
- Tank-monitor pod cycles between Running and OOMKilled, restart count climbs
- On the **Customer Portal** — the **"My Bulk Tank"** section stops refreshing tank-level data.
- Stock status badges may flip to "Out of Stock" while data is marked stale

<!-- Domain: Shared -->
> Because portal health is a shared signal across both domains, the **"Nearby Exchange Locations"** (Cylinder Exchange) section also shows a stale/degraded banner even though its own cage inventory data is unaffected — a good talking point on shared health-check design.

**Domain:** Bulk Tank

**4. Ask SRE Agent:**

> **"The tank-monitor pod keeps restarting. Can you figure out why?"**

Agent should identify OOMKilled events and the insufficient memory limit (16Mi).

**5. Follow up:**

> **"What memory limit should we set to handle peak IoT data volume?"**

**6. Fix it** — click **🔧 Fix All**, or run:
```bash
kubectl apply -f k8s/base/application.yaml
```

---

### Scenario C: Network Policy — Silent Failure

**Domain:** Bulk Tank

**Why this one:** Demonstrates a "silent" failure — everything looks healthy but nothing works. Shows SRE Agent's ability to investigate beyond pod status.

**1. Set the scene:**
> "After a security review, someone applied a network policy to isolate the tank monitor. But they blocked too much traffic — now tank data isn't flowing anywhere."

**2. Break it** — click **"Network Block"** in Mission Control, or run:
```bash
kubectl apply -f k8s/scenarios/network-block.yaml
```

**3. Point out the silent failure:**
> "The tank-monitor pod is Running and green — a human checking pod status would think everything is fine. But no new tank readings are reaching MongoDB, and the customer's tank-level data has quietly stopped updating. This is the kind of failure that can go unnoticed for hours."

The pod is Running and green. A human looking at pod status would think everything is fine.

**4. Ask SRE Agent:**

> **"Tank readings are being accepted but never appear in the system. The pod looks healthy. What could be wrong?"**

Agent should discover the `deny-tank-monitor` NetworkPolicy blocking all traffic.

**5. Follow up:**

> **"Show me the network policies in the propane namespace"**

**6. Fix it** — click **🌐 Fix Network** in Mission Control, or run:
```bash
kubectl apply -f k8s/base/application.yaml
```

---

### Scenario D: Service Mismatch — Post-Upgrade Failure (Alternative)

**Domain:** Bulk Tank

**Why this one:** Shows a subtle Kubernetes misconfiguration that's hard to spot manually.

**1. Set the scene:**
> "The team pushed a 'v2 upgrade' of the tank monitor. The deployment went fine, but suddenly the Customer Portal's bulk tank readings have gone dark."

**2. Break it** — click **"Service Mismatch"**, or run:
```bash
kubectl apply -f k8s/scenarios/service-mismatch.yaml
```

**3. Ask SRE Agent:**

> **"The customer portal can't connect to tank-monitor, but the pod is running fine. What's happening?"**

Agent should find the Service selector (`app: tank-monitor-v2`) doesn't match the pod label (`app: tank-monitor`).

**4. Fix it** — click **🔧 Fix All**, or run:
```bash
kubectl apply -f k8s/base/application.yaml
```

---

### Scenario E: Dependency Latency — Gradual Order Slowdown (Alternative)

**Domain:** Shared

**Why this one:** The strongest "application-level reasoning" scenario in the catalog — every pod stays Running/Ready, so a naive pod-status check tells you nothing. It demonstrates SLO/trace/metric correlation and root-causing a recent config change.

**1. Set the scene:**
> "An on-call engineer just pushed an emergency config change to the pricing-lookup dependency. Nothing crashed — but checkout is getting slower by the second."

**2. Break it** — click **"Dependency Latency"**, or run:
```bash
kubectl apply -f k8s/scenarios/dependency-latency.yaml
```

**3. Ask SRE Agent (vague to specific):**

> **"Order checkout feels slow, can you take a look?"**

> **"Why is p95 checkout latency above our SLO even though every pod looks healthy?"**

> **"Correlate the p95 SLO breach on order-pricing-dependency with any recent configuration change."**

Agent should identify the `order-pricing-dependency-config` config-version change, the delayed `dependency.pricing-lookup` span, and that pods remain Ready throughout (a genuinely latency-led incident, not a crash).

**4. Fix it** — click **🔧 Fix All**, or run:
```bash
kubectl apply -f k8s/base/application.yaml
```

---

**Domain:** Shared

## Act 3 — Proactive + Observability (7 min)

> "SRE Agent isn't just reactive. It can proactively monitor your environment — and it has deep visibility into your entire telemetry stack."

### Show: Application Insights

1. Open **Azure Portal → Application Insights** for the propane resource
2. Navigate to **Application Map** or **Live Metrics**
3. Explain: "This trace is the repo-owned probe's INTERNAL transaction and child CLIENT dependency span for a real service response. `peer.service` identifies the target; the resource role remains `telemetry-probe`. It does not imply that the third-party image emits spans."
4. Show a sample transaction end-to-end trace if available

### Show: Azure Data Explorer

1. Open **Azure Portal → Azure Data Explorer** (or use the ADX cluster URI shown during deploy)
2. Navigate to the **PropaneLogs** database
3. Run a sample query:
   ```kusto
   ContainerLog
   | where TimeGenerated > ago(1h)
   | where ContainerName_s has "tank-monitor"
   | take 20
   ```
4. Explain: "And here in Azure Data Explorer, we have the PropaneLogs database with container logs, pod events, and inventory data available for deep analysis. This is the kind of long-term analytical data that SRE Agent can query when diagnosing intermittent issues."

### SRE Agent Proactive Prompts

In SRE Agent, demonstrate these capabilities:

> **"Query Application Insights for the p95 response time of the tank-monitor service over the last hour"**

> **"Are there any error patterns in the propane namespace logs in the last 30 minutes?"**

> **"Check the health of my AKS cluster every hour and alert me if any pods are unhealthy"**

Show how SRE Agent can set up a recurring scheduled task for the last prompt.

### Best Practice Analysis

> **"Are there any pods running without resource limits in the propane namespace?"**

> **"Check if any containers are using deprecated API versions"**

---

## Act 4 — The Value Proposition (5 min)

### Show: This Run's Measured Outcome

> "Let's not take my word for it — here's exactly what Mission Control observed during the scenario we just ran."

1. Open the **🎯 Incident Evidence Timeline** panel in Mission Control and point at the scorecard for the scenario you just broke and fixed in Act 2.
2. Read the actual displayed values aloud — correlation id, impacted service, root cause (if the agent identified one during the session), the approved action and its run mode, and the **measured** time-to-detect / time-to-root-cause / time-to-recover for *this specific run*. If a value shows "not observed in this run" (for example, no root cause was asked for), say so plainly — don't round it up or guess.
3. Walk through the chronological timeline underneath the scorecard: activation → first impact → evidence gathered → proposed action → approval → result → post-action assertion → recovery. Point out that every entry has a server timestamp, and that a failed post-action assertion would show "partial recovery" rather than a fabricated success.
4. Click **Export Markdown** (or **Export JSON**) to show the redacted evidence pack that could be attached to a real postmortem — same numbers, no secrets, reproducible.

> No two runs are identical — timings vary with cluster warm-up, network conditions, and how long the audience discussion took before the fix was applied. That's the point: these are this run's numbers, not a script.

### Key Messages

1. **A truthful, per-run record** — "Every scenario run gets a single correlation id and a server-timestamped timeline, from activation through recovery. We just showed you the real numbers for the run we did together — not an industry benchmark, not a guess."

2. **Verified Observability Pipeline** — "The repo-owned probe sends truthful INTERNAL transaction and CLIENT dependency spans, logs, exceptions, and metrics through OpenTelemetry to workspace-based Application Insights. The bounded validation proves freshness, parent/child correlation, all three required dependency targets, and zero target-service impersonation. ADX remains optional."

3. **24/7 Coverage** — "SRE Agent doesn't sleep, doesn't go on vacation, and doesn't need to be paged at 3am. It can run scheduled health checks and alert when something deviates."

4. **Safe Remediation, verified** — "SRE Agent can suggest AND execute fixes — with configurable access levels — and Mission Control's timeline records approval, denial, or expiry with the approver's identity when available, plus a post-action assertion so a fix is never marked successful without checking."

5. **Azure-Native with OTel + ADX** — "The OpenTelemetry Collector feeds into Application Insights and Azure Data Explorer, giving SRE Agent comprehensive visibility. Combined with Log Analytics and Azure Monitor, there are no blind spots — and no new third-party tools to deploy."

### Cost Context

> "The full demo environment including SRE Agent runs at about $32–38/day. In production, teams can compare that against their own measured incident response time using the same Incident Evidence Timeline exports — we're not asserting an ROI figure here, only showing you how to measure your own."

---

## Troubleshooting During Demo

| Issue | Quick Fix |
|-------|-----------|
| Pods stuck after fix | Wait 30–60 seconds; pods need time to pull images and start |
| Customer portal IP shows "Pending" | LoadBalancer takes 1–2 minutes after initial deploy |
| SRE Agent is slow to respond | Normal for complex queries — it's analyzing logs and metrics in real-time |
| Mission Control shows connection error | Verify kubectl context: `kubectl config current-context` |
| Mission Control Copilot shows "Error" | Ensure GitHub Copilot license is active and VS Code Copilot extension is installed |
| Copilot chat returns 503 | Copilot SDK failed to initialize — restart Mission Control and check terminal for errors |
| Copilot takes a long time to respond | Multi-tool queries can take up to 180 seconds — the agent is chaining kubectl calls |
| SRE Agent says "no data" | Run `.\scripts\validate-deployment.ps1 -ResourceGroupName <rg>` to confirm knowledge is indexed and Log Analytics has had time to ingest data (allow 5–10 min after deploy) |
| App Insights shows no data | Run `validate-telemetry.ps1`; inspect collector status and confirm its Deployment references Secret `application-insights-connection` without displaying the Secret value |
| ADX PropaneLogs empty | Log Analytics data export may take 5–10 min to start flowing after initial deploy |
| OTel Collector crashing | Check resource limits; verify the `otel-collector-config` ConfigMap is valid YAML: `kubectl describe configmap otel-collector-config -n propane` |

---

## Post-Demo Cleanup

1. Click **🔧 Fix All** in Mission Control to restore healthy state, or run:
   ```bash
   kubectl apply -f k8s/base/application.yaml
   ```
2. Optionally run **Destroy** from the Infrastructure panel to tear down Azure resources
3. Resources cost ~$32–38/day while running — destroy if not needed

---

## Appendix: All Available Scenarios

| Mission Control Button | What Breaks | Business Story |
|----------------------|-------------|---------------|
| OOMKilled | tank-monitor memory exhaustion | Winter peak bulk-tank sensor data spike overwhelms the service |
| CrashLoopBackOff | inventory-service bad config | Invalid pricing configuration |
| ImagePullBackOff | order-service wrong image | Botched image release |
| High CPU | CPU stress pod added | Peak season cylinder-exchange demand forecasting overload |
| Pending Pods | Unschedulable pods | Fleet telemetry over-provisioned |
| Probe Failure | Simulated tank-level drop with delayed safety alarm processing | Healthy workload + suppressed safety event |
| Network Block | NetworkPolicy blocks traffic | Overly restrictive security policy — silent data pipeline failure |
| Missing Config | Missing ConfigMaps | Delivery zone config not deployed |
| MongoDB Down | Database scaled to 0 | Database outage — cascading failure across bulk tank readings and order processing |
| Service Mismatch | Selector label drift | Silent routing failure after "v2 upgrade" |
| Dependency Latency | Pricing-lookup config ramped from 45ms to 950ms | Gradual checkout slowdown after an emergency config change; all pods stay Ready |

### Platform Services (11 active)

| Service | Role | Domain | Replicas |
|---------|------|--------|----------|
| `customer-portal` | Consumer portal — bulk tank gauge, cylinder exchange cage inventory, exchange locations | Bulk Tank + Cylinder Exchange | 2 |
| `dispatch-console` | Retail Cage Operations Center — cage grid, delivery queue, forecast | Cylinder Exchange | 1 |
| `tank-monitor` | Smart bulk propane tank sensor data ingestion & processing | Bulk Tank | 2 |
| `inventory-service` | Bulk delivery pricing & retail cylinder exchange cage catalog | Shared | 2 |
| `order-service` | Order fulfillment & delivery scheduling (bulk tank + cylinder exchange) | Shared | 2 |
| `usage-simulator` | Residential/commercial bulk propane tank usage pattern generator | Bulk Tank | 1 |
| `order-pricing-dependency` | Synthetic order-checkout pricing-lookup dependency (issue #22) | Shared | 1 |
| `order-checkout-probe` | Synthetic order-checkout traffic generator with correlation ids (issue #22) | Shared | 1 |
| `otel-collector` | OpenTelemetry Collector — receives OTLP + Prometheus scrape | Shared | 1 |
| `rabbitmq` | Event bus — bulk tank alerts, order events, dispatch coordination | Shared | 1 |
| `mongodb` | Bulk tank readings, delivery/order records, customer data | Shared | 1 |

> **Note:** `order-worker` exists in the manifests but is disabled (`replicas: 0`). The OTel Collector is a platform component that receives OTLP traces/metrics and scrapes Prometheus targets from every instrumented service. Its current pipeline exporters only include the `logging` exporter — the `otlp/appinsights` exporter is defined but not yet wired into an active pipeline, so treat Application Insights ingestion as pending (issue #25) rather than proven, until that pipeline is corrected/finalized.
