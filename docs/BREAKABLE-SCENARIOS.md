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
| Refill Order Backlog | `refill-order-backlog.yaml` | Shared | RabbitMQ refill backlog grows while producers stay healthy and a poisoned refill event is retried before landing in the DLQ | Queue age, DLQ evidence, paused consumer correlation |
| Network Block | `network-block.yaml` | Bulk Tank | Tank monitor isolated by bad security policy | Network policy analysis |
| Missing Config | `missing-config.yaml` | Shared | Delivery zone configuration missing | Configuration troubleshooting |
| MongoDB Down | `mongodb-down.yaml` | Shared | Tank database outage — cascading order failure | Dependency tracing, root cause |
| Service Mismatch | `service-mismatch.yaml` | Bulk Tank | Tank monitor service failure after "v2 upgrade" | Endpoint/selector analysis |

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

**SRE Agent prompts:**
- "Tank readings are being accepted but never processed. What's wrong?"
- "Why is order-service failing health checks?"
- "Trace the dependency chain — what broke first?"
- "Scale the mongodb deployment back to 1 replica"

**How to fix:**
```bash
kubectl apply -f k8s/base/application.yaml
```

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
