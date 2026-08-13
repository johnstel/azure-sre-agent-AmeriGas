# Breakable Scenarios Guide

This guide explains each failure scenario available in the AmeriGas Propane SRE Demo Lab and how to use them for demonstrating Azure SRE Agent capabilities.

## Quick Reference

| Scenario | File | Domain | AmeriGas Narrative | SRE Agent Diagnosis |
|----------|------|--------|-------------------|---------------------|
| OOMKilled | `oom-killed.yaml` | Bulk Tank | Tank monitor overwhelmed by winter peak readings | Identifies OOM events, recommends memory limits |
| CrashLoop | `crash-loop.yaml` | Shared | Inventory service crash — invalid pricing config | Shows exit codes, logs analysis |
| ImagePullBackOff | `image-pull-backoff.yaml` | Shared | Order service fails after botched image release | Registry/image troubleshooting |
| High CPU | `high-cpu.yaml` | Cylinder Exchange | Demand forecast overload during peak heating season | Performance analysis |
| Pending Pods | `pending-pods.yaml` | Shared | Fleet telemetry monitor pods can't schedule | Scheduling analysis |
| Probe Failure | `probe-failure.yaml` | Bulk Tank | Simulated rapid tank-level drop with suppressed alarm processing | Healthy workload + delayed safety alarm |
| Dependency Latency | `dependency-latency.yaml` | Shared | Pricing lookup dependency slows gradually from 45ms toward 950ms while pods remain Running/Ready and p95 breaches the SLO | Genuine latency-led incident, ConfigMap drift, HTTP/SLO evidence |
| Refill Order Backlog | `refill-order-backlog.yaml` | Shared | RabbitMQ refill backlog grows while producers stay healthy and a poisoned refill event is retried before landing in the DLQ | Queue age, DLQ evidence, paused consumer correlation |
| Network Block | `network-block.yaml` | Bulk Tank | Tank monitor isolated by bad security policy | Network policy analysis |
| Missing Config | `missing-config.yaml` | Shared | Delivery zone configuration missing | Configuration troubleshooting |
| MongoDB Down | `mongodb-down.yaml` | Shared | Tank database outage — cascading order failure | Dependency tracing, root cause; native alert-to-approved-remediation response plan in the demo profile (see [sre-agent-response-plans/README.md](sre-agent-response-plans/README.md)) |
| Service Mismatch | `service-mismatch.yaml` | Bulk Tank | Tank monitor service failure after "v2 upgrade" | Endpoint/selector analysis |
| Dependency Latency | `dependency-latency.yaml` | Shared | Order checkout pricing-lookup dependency gradually slows down after an emergency config change while all pods stay Ready | SLO/trace/metric correlation, config-change clue |

## Scenario Details

---

### 1. OOMKilled — Tank Monitor Memory Exhaustion

**Domain:** Bulk Tank

**File:** `k8s/scenarios/oom-killed.yaml`

**Portal behavior:**
- The Customer Portal and Dispatch Console present a degraded banner with the last known values and timestamp instead of a falsely healthy dashboard.
- Service cards surface the dependency state for MongoDB and RabbitMQ so the outage reads as operationally real without exposing raw platform details to customers.

**What happens:**
- Deploys tank-monitor with extremely low memory limits (16Mi)
- IoT tank level data spike during winter peak overwhelms the service
- Pod starts, runs for a few seconds, then gets killed by OOM Killer
- Kubernetes restarts the pod, cycle repeats

**How to break:**
```bash
kubectl apply -f k8s/scenarios/oom-killed.yaml
```

**What to observe:**
```bash
# Watch pods restart
kubectl get pods -n propane -w

# See OOMKilled status
kubectl describe pod -l app=tank-monitor -n propane | grep -A 5 "Last State"
```

**SRE Agent prompts:**
- "Why is the tank-monitor pod restarting repeatedly?"
- "I see OOMKilled events. What memory should I allocate for tank level data processing?"
- "Diagnose the memory issues in the propane namespace"

**How to fix:**
```bash
kubectl apply -f k8s/base/application.yaml
```

---

### 2. CrashLoopBackOff — Inventory Service Configuration Failure

**Domain:** Shared (Bulk Tank pricing & Cylinder Exchange cage catalog)

**File:** `k8s/scenarios/crash-loop.yaml`

**What happens:**
- Deploys inventory-service with invalid pricing configuration
- Container starts, runs invalid command, exits with code 1
- Kubernetes keeps restarting, enters CrashLoopBackOff

**How to break:**
```bash
kubectl apply -f k8s/scenarios/crash-loop.yaml
```

**What to observe:**
```bash
# See CrashLoopBackOff status
kubectl get pods -n propane | grep inventory-service

# Check container logs
kubectl logs -l app=inventory-service -n propane --previous
```

**SRE Agent prompts:**
- "Why is inventory-service in CrashLoopBackOff?"
- "Show me the logs for the crashing inventory service pods"
- "What's causing exit code 1 in the propane inventory service?"

**How to fix:**
```bash
kubectl apply -f k8s/base/application.yaml
```

---

### 3. ImagePullBackOff — Failed Order Service Deployment

**Domain:** Shared (Bulk Tank delivery orders & Cylinder Exchange restock orders)

**File:** `k8s/scenarios/image-pull-backoff.yaml`

**What happens:**
- Deploys order-service referencing a non-existent image tag
- Kubelet can't pull the image from registry
- Pod stays in ImagePullBackOff state

**How to break:**
```bash
kubectl apply -f k8s/scenarios/image-pull-backoff.yaml
```

**What to observe:**
```bash
# See ImagePullBackOff status
kubectl get pods -n propane | grep order-service

# Check events
kubectl describe pod -l app=order-service -n propane | grep -A 10 Events
```

**SRE Agent prompts:**
- "Why can't my order-service pods start? I see ImagePullBackOff"
- "Help me troubleshoot the container image issue for order fulfillment"
- "What's wrong with the order-service deployment?"

**How to fix:**
```bash
kubectl apply -f k8s/base/application.yaml
```

---

### 4. High CPU — Demand Forecast Overload

**Domain:** Cylinder Exchange (cage restock demand forecasting)

**File:** `k8s/scenarios/high-cpu.yaml`

**What happens:**
- Deploys demand-forecast-overload pods that consume excessive CPU
- Simulates peak heating season triggering intensive demand forecasting calculations
- Other workloads may slow down due to resource contention

**How to break:**
```bash
kubectl apply -f k8s/scenarios/high-cpu.yaml
```

**What to observe:**
```bash
# Watch CPU usage
kubectl top pods -n propane

# Check node pressure
kubectl top nodes
```

**SRE Agent prompts:**
- "Propane services are slow. What's consuming all the CPU?"
- "Analyze CPU usage across pods in the propane namespace"
- "Which pods are causing resource contention on the propane platform?"

**How to fix:**
```bash
kubectl delete deployment demand-forecast-overload -n propane
```

---

### 5. Pending Pods — Fleet Telemetry Monitor Can't Schedule

**Domain:** Shared (delivery fleet telemetry)

**File:** `k8s/scenarios/pending-pods.yaml`

**What happens:**
- Deploys fleet-telemetry-monitor pods requesting 32Gi memory and 8 CPUs each
- No nodes can satisfy these requests — cluster capacity exhausted
- Pods stay in Pending state indefinitely

**How to break:**
```bash
kubectl apply -f k8s/scenarios/pending-pods.yaml
```

**What to observe:**
```bash
# See pending pods
kubectl get pods -n propane | grep fleet-telemetry-monitor

# Check events
kubectl describe pod -l app=fleet-telemetry-monitor -n propane | grep -A 10 Events
```

**SRE Agent prompts:**
- "Why are the fleet telemetry monitoring pods stuck in Pending?"
- "I can't schedule new fleet monitoring workloads. What's wrong?"
- "Analyze cluster capacity for the propane platform"

**How to fix:**
```bash
kubectl delete deployment fleet-telemetry-monitor -n propane
```

---

### 6. Bulk Tank Safety Alarm — Simulated Abnormal Reading Suppressed by Processing Delay

**Domain:** Bulk Tank

**File:** `k8s/scenarios/probe-failure.yaml`

**What happens:**
- Simulates a bulk tank reading that drops from ~71% to ~12% within a short window.
- The alarm is generated with a deterministic asset ID, reading age, simulated severity, acknowledgement state, and timestamps.
- The workload pods remain healthy while the alarm-processing component delays and suppresses the incoming safety event.
- The scenario is clearly labeled as simulated and requires AmeriGas safety SME validation before acting as production policy.

**How to break:**
```bash
kubectl apply -f k8s/scenarios/probe-failure.yaml
```

**What to observe:**
```bash
# View the alarm in the Dispatch Console or logs
kubectl logs -n propane deploy/tank-monitor --tail 50
kubectl logs -n propane deploy/dispatch-console --tail 50

# Check the pending alarm in the app runtime or telemetry stream
kubectl get pods -n propane | grep -E 'tank-monitor|dispatch-console'
```

**SRE Agent prompts:**
- "A bulk tank safety alarm is pending but the workload looks healthy — what's wrong?"
- "Why is the alarm still suppressed even though tank-monitor is reporting normally?"
- "Trace the safety telemetry delay in the propane namespace and identify the processing component causing the backlog."

**How to fix:**
```bash
kubectl delete deployment safety-compliance-monitor -n propane --ignore-not-found
kubectl delete configmap tank-safety-alarm-config -n propane --ignore-not-found
kubectl apply -f k8s/base/application.yaml
```

---

### 7. Refill Order Backlog — Paused Consumer + Poison Message

**Domain:** Shared

**File:** `k8s/scenarios/refill-order-backlog.yaml`

**What happens:**
- RabbitMQ keeps accepting refill-order messages from healthy producers while the consumer remains paused.
- The queue depth rises and the oldest queued refill message ages upward without any producer outage.
- A deterministic malformed refill event (`EV-REFILL-2047`) is retried a bounded number of times before it is written to the `refill-orders-dlq` dead-letter queue.
- Recovery processes the valid refill orders exactly once while the poison message remains visible in the DLQ for forensics.

**How to break:**
```bash
kubectl apply -f k8s/scenarios/refill-order-backlog.yaml
```

**What to observe:**
```bash
# Queue state and backlog telemetry
kubectl logs -n propane deploy/refill-order-backlog-simulator --tail 20

# Check broker-backed backlog values in the Dispatch Console or app state
kubectl get configmap refill-order-backlog-config -n propane -o yaml
```

**SRE Agent prompts:**
- "Why is the RabbitMQ refill-orders queue growing even though producers are healthy?"
- "Trace the paused consumer and malformed refill event that are driving queue age and retry backoff."
- "Which refill order IDs were affected, and which event landed in the DLQ?"

**How to fix:**
```bash
kubectl delete deployment refill-order-backlog-simulator -n propane --ignore-not-found
kubectl delete configmap refill-order-backlog-config -n propane --ignore-not-found
kubectl apply -f k8s/base/application.yaml
```

---

### 8. Network Policy Blocking — Tank Monitor Isolated

**Domain:** Bulk Tank

**File:** `k8s/scenarios/network-block.yaml`

**What happens:**
- Applies NetworkPolicy that blocks all traffic to tank-monitor
- Tank monitor becomes isolated after a bad security policy update
- Customer portal can't submit tank readings

**How to break:**
```bash
kubectl apply -f k8s/scenarios/network-block.yaml
```

**What to observe:**
```bash
# Test connectivity from customer-portal
kubectl exec -n propane deploy/customer-portal -- curl -s tank-monitor:3000/health
# Should timeout or fail
```

**SRE Agent prompts:**
- "Why can't the customer portal reach tank-monitor?"
- "Diagnose network connectivity issues in the propane namespace"
- "What network policies are blocking tank level data ingestion?"

**How to fix:**
```bash
kubectl delete networkpolicy deny-tank-monitor -n propane
```

---

### 8. Missing ConfigMap — Delivery Zone Configuration Missing

**Domain:** Shared (delivery routing for both domains)

**File:** `k8s/scenarios/missing-config.yaml`

**What happens:**
- Deploys delivery-zone-config service referencing non-existent ConfigMaps
- Configuration was lost during environment promotion
- Pod can't start — shows ContainerCreateError

**How to break:**
```bash
kubectl apply -f k8s/scenarios/missing-config.yaml
```

**What to observe:**
```bash
# See the error
kubectl get pods -n propane | grep delivery-zone-config

# Check events
kubectl describe pod -l app=delivery-zone-config -n propane | grep -A 10 Events
```

**SRE Agent prompts:**
- "Delivery zone configuration pod won't start. Something about ConfigMap?"
- "What configuration is missing for the delivery zone deployment?"
- "Troubleshoot the ConfigMap reference error in the propane namespace"

**How to fix:**
```bash
kubectl delete deployment delivery-zone-config -n propane
```

---

### 9. MongoDB Down — Tank Database Outage (Cascading Failure)

**Domain:** Shared (Bulk Tank readings & delivery/order records)

**File:** `k8s/scenarios/mongodb-down.yaml`

**What happens:**
- Scales MongoDB deployment to 0 replicas (tank database goes offline)
- order-service can't connect to MongoDB, starts failing health checks
- Tank readings can still be submitted (queued in RabbitMQ) but never processed
- This is the most realistic scenario: requires tracing a dependency chain

**How to break:**
```bash
kubectl apply -f k8s/scenarios/mongodb-down.yaml
```

**What to observe:**
```bash
# MongoDB has 0 replicas
kubectl get deployment mongodb -n propane

# order-service becomes unhealthy
kubectl get pods -n propane -l app=order-service

# Tank events queue up in RabbitMQ but never get processed
kubectl exec -n propane deploy/rabbitmq -- rabbitmqctl list_queues
```

**SRE Agent prompts (manual/chat-driven — standard profile):**
- "Tank readings are being accepted but never processed. What's wrong?"
- "Why is order-service failing health checks?"
- "Trace the dependency chain — what broke first?"
- "Scale the mongodb deployment back to 1 replica"

**How to fix:**
```bash
kubectl apply -f k8s/base/application.yaml
```

**Native alert-to-approved-remediation response plan (demo profile, issue #19):**

This is the only scenario wired to a native Azure SRE Agent response plan — a genuine Azure Monitor alert routed to a custom agent, not Mission Control Copilot and not a generic webhook. Deploy with the demo profile (`.\scripts\deploy.ps1 -Location eastus2 -Demo -AcceptSubscriptionScopeMonitoringRbac`, or `infra/bicep/main.demo.bicepparam` directly) to enable it. See [docs/sre-agent-response-plans/README.md](sre-agent-response-plans/README.md) for the full flow, bounded alert timing, the required subscription-scope Monitoring Contributor acknowledgement, and the three rehearsal variants (approve / deny / expiry — required before calling this demo proven). With the demo profile active:

1. Applying `k8s/scenarios/mongodb-down.yaml` is the only step required — no chat prompt needed.
2. A dedicated Azure Monitor alert (`AmeriGas Propane Demo - MongoDB Down`, severity 1) fires within a documented bounded time (~10 minutes: PT1M evaluation + Log Analytics ingestion latency).
3. The alert routes to the `mongodb-down-responder` custom agent via the `mongodb-down-response-plan` response plan (Review autonomy).
4. The agent gathers Kubernetes + Application Insights/Log Analytics evidence, proposes exactly one action (`az aks command invoke` scaling `propane/mongodb` back to 1 replica), and waits for an SRE Agent Administrator to approve it.
5. Approval executes the action once; denial or expiry leaves the environment unchanged. The agent verifies recovery and closes out the thread.

---

### 10. Service Selector Mismatch — Tank Monitor Service Failure

**Domain:** Bulk Tank

**File:** `k8s/scenarios/service-mismatch.yaml`

**What happens:**
- Replaces the tank-monitor Service with a wrong selector (`app: tank-monitor-v2`)
- The tank-monitor pods are perfectly healthy (Running, Ready)
- But the Service has zero endpoints — traffic doesn't reach any pod
- The customer portal loads fine, but submitting tank readings fails silently

**Why this is interesting:**
- All pods show green — no crashes, no restarts, no OOM
- `kubectl get pods` looks completely healthy
- SRE Agent must check Service endpoints and selector labels, not just pod status
- This mimics a common real-world misconfiguration after a "v2 upgrade"

**How to break:**
```bash
kubectl apply -f k8s/scenarios/service-mismatch.yaml
```

**What to observe:**
```bash
# Pods are healthy!
kubectl get pods -n propane -l app=tank-monitor

# But the Service has no endpoints
kubectl get endpoints tank-monitor -n propane

# Compare selector vs. pod labels
kubectl get svc tank-monitor -n propane -o jsonpath='{.spec.selector}'
kubectl get pods -n propane -l app=tank-monitor --show-labels
```

**SRE Agent prompts:**
- "The customer portal loads but tank readings fail. Everything looks healthy."
- "Why does tank-monitor have no endpoints?"
- "Compare the tank-monitor Service selector to the actual pod labels"
- "Fix the selector on the tank-monitor Service to match the pods"

**How to fix:**
```bash
kubectl apply -f k8s/base/application.yaml
```

---

### 11. Dependency Latency — Gradual Order Pricing-Lookup Slowdown

**Domain:** Shared

**File:** `k8s/scenarios/dependency-latency.yaml`

**Business narrative:** Order checkout calls a synthetic pricing/tax lookup dependency (`order-pricing-dependency`) during fulfillment. An on-call engineer pushes an "emergency" config change that raises the pricing-lookup timeout from 45ms to 950ms to work around a vendor rate limit. Every order-service pod, the dependency pod, and the synthetic traffic generator (`order-checkout-probe`) stay Running and Ready the entire time — there is no crash, no restart, no scheduling failure. The only symptom is that checkout gets slower and slower over about 75 seconds, exactly the kind of subtle, application-level incident that a pure Kubernetes pod-status view will miss.

**Documented SLO / error ceiling:** p95 checkout latency must stay at or below **500ms**; the synthetic error rate must stay at or below **2%**. Baseline p95 is ~58ms. During the incident p95 ramps from ~45ms toward ~950ms over ~75 seconds while the error rate stays under 0.5% — the incident is genuinely latency-led, not error-led.

**Config-change clue:** the scenario overrides the `order-pricing-dependency-config` ConfigMap (the very same ConfigMap `k8s/base/application.yaml` defines with healthy defaults) with `config_version: "incident-v2"`, `config_change_reason: "Emergency change: pricing-lookup dependency timeout raised from 45ms to 950ms in order-pricing-dependency-config to accommodate a vendor rate-limit workaround."`, and `config_changed_by: "platform-ops-oncall"`. The `order-pricing-dependency` pod detects this change on its next poll of the mounted ConfigMap (no restart required) and logs a `config_change_detected` structured JSON event with the before/after config version — the single clearest artifact tying the SLO breach to a recent change.

**What happens:**
- `order-checkout-probe` issues one synthetic order-checkout request per second against `order-pricing-dependency`, each with a deterministic `TX-<run-id>-<sequence>` transaction id and a W3C `traceparent` header.
- `order-pricing-dependency` computes its delay from the mounted `order-pricing-dependency-config` ConfigMap only — it never proxies to, or accepts, any caller-supplied or external target (no SSRF surface). Readiness/liveness probes hit a separate `/healthz` route that is never delayed, so the pod stays Ready throughout.
- Baseline config is `delay_mode: fixed`, `fixed_delay_ms: 45` (p95 well under the 500ms SLO). The scenario config is `delay_mode: ramp`, ramping from 45ms to 950ms over 75 seconds, then holding at the ceiling.
- Both pods emit standards-compliant OTLP spans (root `order.checkout` + child `dependency.pricing-lookup`, sharing one W3C trace id) to the existing `otel-collector` OTLP/HTTP receiver, plus a Prometheus-scrapeable `/metrics` endpoint (`order_dependency_request_duration_ms_p50/p95/p99`, `order_checkout_duration_ms_p50/p95/p99`, request/error counters, and a `order_dependency_config_change_timestamp_seconds` gauge) and structured JSON stdout logs correlating `trace_id`/`span_id`/`transaction_id`/`run_id`.
- Recovery (reset) restores the original `order-pricing-dependency-config` ConfigMap (via the shared scenario lifecycle's delete-by-kind+name-then-reapply-base flow, same as every other scenario) — no scenario-only Deployment is left behind.

**Evidence — what is proven locally vs. what is still pending (issue #25):**
- **Proven now, locally, in this PR:** OTLP/HTTP trace export to the existing `otel-collector` receiver (`/v1/traces`), Prometheus-scrapeable p50/p95/p99 histograms and error counters on both pods, structured JSON logs with full trace/transaction/run correlation, and a deterministic Node.js harness (`tools/mission-control/order-dependency-latency.js` + its tests) that runs 5 reproducible baseline/failure/recovery cycles and asserts the SLO/error/readiness contract in fake/local mode with no cluster required.
- **Not claimed here:** this repo's `otlp/appinsights` exporter in the `otel-collector` config is not currently wired into the collector's active pipelines (see the collector's `service.pipelines` block — only the `logging` exporter is attached), and its endpoint/header shape does not match Azure Monitor's actual OTLP ingestion contract. **This PR does not claim Application Insights contains these records.** Issue #25 is expected to correct/finalize the end-to-end OTel → Application Insights pipeline; once that lands, this scenario's existing OTLP spans and Prometheus metrics should flow through unchanged — no scenario-side changes should be required.

**How to break:**
```bash
kubectl apply -f k8s/scenarios/dependency-latency.yaml
```

**What to observe:**
```bash
# All targeted pods stay Running and Ready throughout
kubectl get pods -n propane -l 'app in (order-pricing-dependency,order-checkout-probe,order-service)'

# Structured request/dependency logs with trace/transaction/run correlation
kubectl logs -n propane deploy/order-pricing-dependency --tail 20
kubectl logs -n propane deploy/order-checkout-probe --tail 20

# Live p50/p95/p99 + error rate + current config version
kubectl exec -n propane deploy/order-checkout-probe -- wget -qO- http://localhost:4100/status
kubectl exec -n propane deploy/order-pricing-dependency -- wget -qO- http://localhost:4000/status

# Prometheus-format latency histogram (scraped by otel-collector; also curl-able directly)
kubectl exec -n propane deploy/order-pricing-dependency -- wget -qO- http://localhost:4000/metrics

# The config-change clue
kubectl get configmap order-pricing-dependency-config -n propane -o yaml
```

**SRE Agent prompts (vague to specific):**
- "Order checkout feels slow, can you take a look?"
- "Why is p95 checkout latency above our SLO even though every pod looks healthy?"
- "Which dependency is adding latency to the order-checkout transaction, and is it a genuine latency incident or errors in disguise?"
- "Correlate the p95 SLO breach on order-pricing-dependency with any recent configuration change and the affected trace/transaction ids."

**Safe remediation / reset:**
```bash
kubectl delete configmap order-pricing-dependency-config -n propane --ignore-not-found
kubectl apply -f k8s/base/application.yaml
```
Or via the shared lifecycle: `break-latency` to activate, `fix-all` / `Reset-DemoBaseline` to recover deterministically (same lifecycle used by every other scenario in this repo).

---

## Demo Flow Suggestions

### Quick Demo (5 minutes)

1. Apply OOMKilled scenario (tank monitor memory exhaustion)
2. Show pods crashing in kubectl
3. Ask SRE Agent to diagnose
4. Apply fix and show recovery

### Comprehensive Demo (20 minutes)

1. **Introduction** - Show healthy propane distribution platform
2. **Break #1** - OOMKilled (tank monitor memory exhaustion)
3. **Break #2** - Network Policy (tank monitor isolated)
4. **Break #3** - CrashLoopBackOff (inventory service config failure)
5. **Advanced** - Show scheduled monitoring task
6. **Cleanup** - Restore all scenarios

### "Baking" for Advisor Recommendations

Some scenarios benefit from running longer to gather metrics:

1. Deploy demand forecast overload scenario
2. Wait 30-60 minutes
3. Check Azure Advisor for right-sizing recommendations
4. Use SRE Agent to analyze historical patterns

## Best Practices

- ✅ Always test scenarios in dev environment first
- ✅ Have baseline metrics before breaking things
- ✅ Document what you did and when for demos
- ✅ Keep fix commands ready
- ❌ Don't apply multiple breaking scenarios simultaneously
- ❌ Don't leave scenarios running unattended
