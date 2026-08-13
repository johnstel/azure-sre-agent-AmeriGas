# AmeriGas Propane Operations Platform — SRE Knowledge Base

## Overview

This is the AmeriGas Propane Operations Platform running on Azure Kubernetes Service (AKS). AmeriGas is the largest retail propane distributor in the United States, serving over 1.5 million residential, commercial, and industrial customers. This platform manages propane tank monitoring, inventory management, order fulfillment, and customer-facing operations.

**Kubernetes Namespace:** `propane`
**Observability:** Azure Log Analytics (Container Insights), Application Insights (workspace-based), OpenTelemetry Collector (in-cluster), Azure Monitor (Prometheus), Managed Grafana

## Domain Model

AmeriGas operates **two distinct propane business domains** in this platform. Every simulator, service, UI screen, operational metric, event, and breakable scenario belongs to exactly one of these domains (or is explicitly Shared infrastructure used by both). Vocabulary must never cross domains — gallons/percentage readings belong only to Bulk Tank, and full/empty/reserved counts belong only to Cylinder Exchange.

### Bulk Tank Domain

Residential and commercial customers who own or lease a bulk propane tank on their property, refilled by delivery truck.

- **Vocabulary:** gallons, tank fill percentage, consumption rate (gal/day), estimated days until empty, refill recommendation, delivery scheduling, price per gallon, leak detection.
- **Forecasting model:** deterministic tank profile calculations use capacity, reserve gallons, refill threshold, lead time, and weather-sensitive demand; the default values are simulated operational defaults that require AmeriGas SME validation before they are treated as production policy. Demand inputs are validated: baseDemandGalPerDay must be greater than zero, weatherSensitivity may be zero but cannot be negative or non-finite, and all values must stay finite to avoid invalid demand or date calculations.
- **Owning UI:** Customer Portal → **"My Bulk Tank"** section (tank gauge, days until empty, next delivery, price/gal, usage history in gallons).
- **Owning service:** `tank-monitor` — IoT ingestion from smart sensors on customer bulk tanks (tank level %, leak detection, usage patterns). Publishes to the `tank-events` RabbitMQ queue and persists to the MongoDB `tank_readings` collection.
- **Simulator:** `usage-simulator` — generates simulated residential/commercial bulk-tank consumption against `tank-monitor` only.
- **Scenarios:** `oom-killed.yaml`, `network-block.yaml`, `service-mismatch.yaml` (all act on `tank-monitor`).

### Cylinder Exchange Domain

Retail propane cylinder exchange cages hosted at partner stores (Home Depot, Walmart, Lowe's, etc.), stocked with full/empty/reserved cylinders for walk-up exchange.

- **Vocabulary:** full/empty/reserved cylinder counts, cage capacity, cage replenishment/restock, exchange-location terminology, cylinders-in-field, daily cylinder turnover.
- **Owning UI:** Dispatch Console → **"Retail Cage Operations Center"** (cage grid, delivery/restock priority queue, demand forecast in cylinders needed) and Customer Portal → **"Nearby Exchange Locations"** section (cage inventory dots, cylinder counts).
- **Owning services:** none dedicated — cage inventory is simulated client-side in the portals; cage catalog/pricing is served by `inventory-service` (Shared) and restock orders flow through `order-service` (Shared).
- **Scenarios:** `high-cpu.yaml` (`demand-forecast-overload` — cage restock demand forecasting).

### Shared Infrastructure

Services and scenarios used by both domains: `inventory-service` (Bulk Tank pricing + Cylinder Exchange cage catalog), `order-service` and `order-worker` (Bulk Tank delivery orders + Cylinder Exchange restock orders), `order-pricing-dependency` and `order-checkout-probe` (synthetic order-checkout dependency hop + traffic generator for the dependency-latency scenario, issue #22), `rabbitmq` (tank alerts + order events), `mongodb` (tank readings + delivery/order + customer records), `otel-collector`, plus the `crash-loop.yaml`, `image-pull-backoff.yaml`, `pending-pods.yaml`, `probe-failure.yaml`, `missing-config.yaml`, `mongodb-down.yaml`, and `dependency-latency.yaml` scenarios.

## Architecture

### Services

| Service | Deployment Name | Port | Role | Domain | Technology |
|---------|----------------|------|------|--------|------------|
| Customer Portal | `customer-portal` | 8080 | Consumer-facing portal — billing, bulk tank status, delivery scheduling, cylinder exchange location browsing | Bulk Tank + Cylinder Exchange | Vue.js / nginx |
| Dispatch Console | `dispatch-console` | 8081 | Retail Cage Operations Center for dispatchers and field service coordinators | Cylinder Exchange | Vue.js / nginx |
| Tank Monitor | `tank-monitor` | 3000 | IoT data ingestion from smart sensors on customer bulk propane tanks — reports tank levels, leak detection, usage patterns | Bulk Tank | Node.js |
| Inventory Service | `inventory-service` | 3002 | Propane inventory catalog — bulk delivery pricing tiers and retail cylinder exchange cage catalog | Shared | Rust |
| Order Service | `order-service` | 3001 | Order fulfillment — processes bulk tank delivery orders and cylinder exchange cage restock orders | Shared | Go |
| Usage Simulator | `usage-simulator` | — | Generates simulated residential bulk propane tank consumption patterns (background, no port) | Bulk Tank | Python |
| Order Worker | `order-worker` | — | Processes order fulfillment queue messages (disabled by default, 0 replicas) | Shared | Python |
| Order Pricing Dependency | `order-pricing-dependency` | 4000 | Synthetic order-checkout pricing-lookup dependency hop for the dependency-latency scenario (issue #22) | Shared | Node.js |
| Order Checkout Probe | `order-checkout-probe` | 4100 | Synthetic order-checkout traffic generator with deterministic transaction/run correlation ids (issue #22) | Shared | Node.js |
| OTel Collector | `otel-collector` | 4317 / 4318 | OpenTelemetry Collector — receives OTLP telemetry and exports through the Azure Monitor exporter | Shared | OTel Contrib 0.158.0 |
| Telemetry Baseline | `telemetry-baseline` | — | Repo-owned probe that observes real HTTP responses from the three service APIs and emits correlated OTLP signals | Shared | Node.js 22.14 |
| RabbitMQ | `rabbitmq` | 5672 / 15672 | Event bus for bulk tank events, order alerts, dispatch coordination | Shared | RabbitMQ 3.13 |
| MongoDB | `mongodb` | 27017 | Stores bulk tank readings, delivery/order records, customer accounts | Shared | MongoDB 7.0 |

### Service Dependencies

```
Customer Portal ──→ Inventory Service, Tank Monitor, Order Service (via nginx proxy)
Dispatch Console ──→ Inventory Service, Tank Monitor, Order Service (via nginx proxy)
Tank Monitor ──→ RabbitMQ (publishes tank-events)
Order Service ──→ RabbitMQ (consumes tank-events) ──→ MongoDB (persists readings)
Inventory Service ──→ (standalone catalog, no DB dependency)
Usage Simulator ──→ Tank Monitor (HTTP, generates load)
Order Worker ──→ Order Service (disabled, 0 replicas)
Telemetry Baseline ──→ Tank Monitor, Inventory Service, Order Service (real HTTP health requests with W3C trace context)
Telemetry Baseline ──→ OTel Collector ──→ workspace-based Application Insights (traces/metrics/logs)
```

**Critical dependency chain:** Usage Simulator → Tank Monitor → RabbitMQ → Order Service → MongoDB. If MongoDB goes down, Order Service fails, causing cascading failures visible in Customer Portal and Dispatch Console.

### Telemetry & Instrumentation

- The third-party service images are not represented as natively instrumented. Their `OTEL_*` environment variables alone do not prove SDK instrumentation.
- The repo-owned `telemetry-baseline` probe makes real in-cluster HTTP calls and emits telemetry based on the actual responses and measured latency.
- The probe propagates a W3C `traceparent` header and emits server/request plus child client/dependency spans with the same trace ID.
- Probe resources include `service.name`, `service.namespace=propane`, `deployment.environment=demo`, `scenario.id`, `run.correlation_id`, and `transaction.id`.
- An **OpenTelemetry Collector** (`otel-collector`) runs in-cluster receiving OTLP (gRPC:4317, HTTP:4318) and scraping Prometheus metrics from services
- The collector's `azuremonitor` exporter sends traces, metrics, and logs to workspace-based Application Insights. A `debug` exporter is defined for opt-in diagnostics but is not enabled in baseline pipelines.
- The connection string comes only from the `application-insights-connection` Kubernetes Secret. It is never stored in a ConfigMap.

### Storage

- **MongoDB** uses an Azure Managed Disk (PersistentVolumeClaim `mongodb-data`, 8Gi, managed-csi StorageClass)
- **RabbitMQ** uses an Azure Managed Disk (PersistentVolumeClaim `rabbitmq-data`, 2Gi, managed-csi StorageClass)

### Networking

- **Customer Portal** is exposed via a Kubernetes `LoadBalancer` service (external IP)
- All other services are `ClusterIP` (internal only)
- **RabbitMQ management UI** is internal on port 15672

## Where Logs Are Stored

- **Container logs:** Azure Log Analytics workspace via Container Insights (AKS monitoring addon). Tables: `ContainerLogV2`, `KubeEvents`, `KubePodInventory`, `KubeNodeInventory`, `Perf`
- **Application telemetry:** Application Insights (workspace-based, ingests into the same Log Analytics workspace). Tables: `AppRequests`, `AppDependencies`, `AppExceptions`, `AppTraces`, `AppMetrics`
- **AKS control plane logs:** Sent to Log Analytics via diagnostic settings (kube-apiserver, kube-controller-manager, kube-scheduler, kube-audit-admin, guard, cloud-controller-manager)
- **Prometheus metrics:** Azure Monitor Workspace, viewable in Managed Grafana
- **In-cluster telemetry pipeline:** OpenTelemetry Collector receives the probe's OTLP signals and exports them through `azuremonitor`; the defined `debug` exporter is disabled in baseline pipelines.

### Proving Fresh Correlation

Run `scripts/validate-telemetry.ps1`. It creates a known transaction ID, makes real calls to all three APIs, records one controlled HTTP failure and a Kubernetes event, then polls for at most five minutes. It fails on timeout, stale/no data, a missing service, or an operation-ID mismatch.

```kql
let transactionId = "<32-lowercase-hex-id-from-validation>";
let cutoff = ago(5m);
let requests = AppRequests
| where TimeGenerated >= cutoff
| where tostring(Properties["transaction.id"]) == transactionId;
let dependencies = AppDependencies
| where TimeGenerated >= cutoff
| where tostring(Properties["transaction.id"]) == transactionId;
requests
| project RequestTime=TimeGenerated, OperationId, RequestName=Name, RequestRole=AppRoleName
| join kind=inner (
    dependencies
    | project DependencyTime=TimeGenerated, OperationId, DependencyName=Name, Target, DependencyRole=AppRoleName
) on OperationId
```

```kql
let transactionId = "<32-lowercase-hex-id-from-validation>";
union
    (AppExceptions | project TimeGenerated, Signal="exception", OperationId, Properties),
    (AppTraces | project TimeGenerated, Signal="trace", OperationId, Properties)
| where TimeGenerated >= ago(5m)
| where tostring(Properties["transaction.id"]) == transactionId
| union (
    KubeEvents
    | where TimeGenerated >= ago(5m)
    | where Namespace == "propane" and Reason == "ControlledTelemetryFailure"
    | where Message has transactionId
    | project TimeGenerated, Signal="kubernetes-event", OperationId="", Properties=pack("message", Message)
)
| order by TimeGenerated asc
```

### Querying Logs in Log Analytics

Use KQL in the Azure Portal (Log Analytics workspace) or via SRE Agent:

```kql
// Container logs from propane namespace — recent errors
ContainerLogV2
| where PodNamespace == "propane"
| where LogLevel == "error" or LogMessage has "error" or LogMessage has "exception"
| order by TimeGenerated desc
| take 50

// Container logs for a specific service
ContainerLogV2
| where PodNamespace == "propane"
| where PodName startswith "tank-monitor"
| order by TimeGenerated desc
| take 100

// Pod events — restarts, failures, OOM kills
KubeEvents
| where Namespace == "propane"
| where Reason in ("BackOff", "Killing", "OOMKilling", "Failed", "FailedScheduling", "Unhealthy")
| project TimeGenerated, Name, Reason, Message
| order by TimeGenerated desc

// Pod inventory — current state of all pods
KubePodInventory
| where Namespace == "propane"
| summarize arg_max(TimeGenerated, *) by Name
| project Name, PodStatus, ContainerStatus, RestartCount, PodCreationTimeStamp

// Memory and CPU usage by container
Perf
| where ObjectName == "K8SContainer"
| where InstanceName contains "propane"
| summarize avg(CounterValue) by CounterName, InstanceName, bin(TimeGenerated, 5m)

// Application Insights — request failures
requests
| where cloud_RoleName has "propane" or cloud_RoleName in ("tank-monitor", "order-service", "inventory-service")
| where success == false
| summarize failCount=count() by cloud_RoleName, resultCode, bin(timestamp, 5m)
| order by timestamp desc

// Application Insights — dependency failures (MongoDB, RabbitMQ calls)
dependencies
| where cloud_RoleName has "propane" or cloud_RoleName in ("tank-monitor", "order-service")
| where success == false
| summarize failCount=count() by cloud_RoleName, target, type, bin(timestamp, 5m)
| order by timestamp desc
```

## Healthy State

When the platform is healthy, you should see these pods running in the `propane` namespace:

| Pod (prefix) | Expected Status | Expected Restarts | Replicas |
|--------------|----------------|-------------------|----------|
| customer-portal-* | Running | 0 | 2 |
| dispatch-console-* | Running | 0 | 1 |
| tank-monitor-* | Running | 0 | 2 |
| inventory-service-* | Running | 0 | 2 |
| order-service-* | Running | 0 | 2 |
| usage-simulator-* | Running | 0 | 1 |
| order-pricing-dependency-* | Running | 0 | 1 |
| order-checkout-probe-* | Running | 0 | 1 |
| otel-collector-* | Running | 0 | 1 |
| rabbitmq-* | Running | 0 | 1 |
| mongodb-* | Running | 0 | 1 |

**order-worker** has 0 replicas by default and will not have a running pod.

Total expected healthy pods: **15** (across 11 deployments)

## Known Failure Scenarios and Runbooks

### 1. OOMKilled — Tank Monitor Memory Exhaustion

**Domain:** Bulk Tank

**Symptoms:** tank-monitor pod restarting repeatedly, status shows OOMKilled
**Root cause:** Memory limit set too low (16Mi) — IoT tank level data spike during winter peak overwhelms the service
**Resolution:** Restore proper memory limits by reapplying the base manifest:
```
kubectl apply -f k8s/base/application.yaml
```
**Investigate with:**
```
kubectl describe pod -l app=tank-monitor -n propane | grep -A 5 "Last State"
```

### 2. CrashLoopBackOff — Inventory Service Configuration Failure

**Domain:** Shared (Bulk Tank pricing & Cylinder Exchange cage catalog)

**Symptoms:** inventory-service in CrashLoopBackOff, exit code 1
**Root cause:** Invalid pricing configuration — container starts, runs invalid command, exits immediately
**Resolution:** Restore proper configuration:
```
kubectl apply -f k8s/base/application.yaml
```
**Investigate with:**
```
kubectl logs -l app=inventory-service -n propane --previous
```

### 3. ImagePullBackOff — Failed Order Service Deployment

**Domain:** Shared (Bulk Tank delivery orders & Cylinder Exchange restock orders)

**Symptoms:** order-service pods in ImagePullBackOff or ErrImagePull
**Root cause:** Deployment references non-existent image tag (simulates botched release)
**Resolution:** Restore correct image tag:
```
kubectl apply -f k8s/base/application.yaml
```

### 4. High CPU — Demand Forecast Overload

**Domain:** Cylinder Exchange (cage restock demand forecasting)

**Symptoms:** Extra pods named `demand-forecast-overload-*` consuming high CPU, other workloads may slow down
**Root cause:** Peak heating season triggering intensive demand forecasting calculations (CPU stress pod)
**Resolution:** Remove the extra deployment:
```
kubectl delete deployment demand-forecast-overload -n propane
```

### 5. Pending Pods — Fleet Telemetry Monitor Scheduling Failure

**Domain:** Shared (delivery fleet telemetry)

**Symptoms:** Pods named `fleet-telemetry-monitor-*` stuck in Pending state
**Root cause:** Pod requests excessive CPU/memory resources that no node can satisfy
**Resolution:** Remove the extra deployment:
```
kubectl delete deployment fleet-telemetry-monitor -n propane
```

### 6. Bulk Tank Safety Alarm — Simulated Abnormal Reading Suppressed by Processing Delay

**Domain:** Bulk Tank

**Symptoms:** `tank-monitor` continues running normally, but a simulated bulk tank safety alarm stays pending or delayed in the Dispatch Console and telemetry stream. Workload pods remain healthy while the alarm is suppressed.
**Root cause:** The scenario creates a deterministic abnormal tank-level reading, then deliberately delays and suppresses alarm processing in `safety-compliance-monitor` to mimic a healthy-but-suppressed safety failure. The alert is explicitly labeled as simulated and requires AmeriGas safety SME validation before acting on it as production policy.
**Resolution:** Remove the scenario deployment and config, then restore the base environment:
```
kubectl delete deployment safety-compliance-monitor -n propane --ignore-not-found
kubectl delete configmap tank-safety-alarm-config -n propane --ignore-not-found
kubectl apply -f k8s/base/application.yaml
```

### 7. Network Block — Tank Monitor Isolation

**Domain:** Bulk Tank

**Symptoms:** tank-monitor pod is Running but cannot communicate with other services (no data flowing)
**Root cause:** A NetworkPolicy named `deny-tank-monitor` blocks all ingress and egress for tank-monitor pods
**Resolution:** Remove the network policy:
```
kubectl delete networkpolicy deny-tank-monitor -n propane
```
**Investigate with:**
```
kubectl get networkpolicy -n propane
kubectl describe networkpolicy deny-tank-monitor -n propane
```

### 8. Missing Config — Delivery Zone Configuration

**Domain:** Shared (delivery routing for both domains)

**Symptoms:** Pods named `delivery-zone-config-*` stuck in ContainerCreating or CrashLoopBackOff
**Root cause:** Deployment references ConfigMaps that don't exist
**Resolution:** Remove the extra deployment:
```
kubectl delete deployment delivery-zone-config -n propane
```

### 9. MongoDB Down — Cascading Database Failure

**Domain:** Shared (Bulk Tank readings & delivery/order records)

**Symptoms:** mongodb pod not running (0 replicas), tank-monitor and order-service may show errors or restarts
**Root cause:** MongoDB deployment scaled to 0 replicas, simulating database outage
**Impact:** Cascading failure — services that depend on MongoDB (tank-monitor, order-service) will fail to process data, leading to customer portal and dispatch console showing errors
**Resolution:** Restore MongoDB:
```
kubectl apply -f k8s/base/application.yaml
```
**This is the most impactful scenario** — it demonstrates cascading failures and root cause analysis.

### 10. Service Mismatch — Tank Monitor Routing Failure

**Domain:** Bulk Tank

**Symptoms:** tank-monitor pod is Running and healthy, but the Service has no endpoints (traffic doesn't reach it)
**Root cause:** Service selector changed to `app: tank-monitor-v2` which doesn't match the pod label `app: tank-monitor`
**Resolution:** Restore correct service selector:
```
kubectl apply -f k8s/base/application.yaml
```
**Investigate with:**
```
kubectl get endpoints tank-monitor -n propane
kubectl describe svc tank-monitor -n propane
```

## General Fix Commands

- **Fix everything:** `kubectl apply -f k8s/base/application.yaml`
- **Fix network policy only:** `kubectl delete networkpolicy deny-tank-monitor -n propane`
- **Fix extra deployments only:** `kubectl delete deployment demand-forecast-overload fleet-telemetry-monitor safety-compliance-monitor delivery-zone-config -n propane`

## Azure Infrastructure

- **Resource group naming:** `rg-srelab-{region}` (e.g., `rg-srelab-eastus2`)
- **AKS cluster naming:** `aks-srelab-{suffix}`
- **Resources deployed:** AKS, Azure Container Registry, Key Vault, Log Analytics, Application Insights, OpenTelemetry Collector (in-cluster), Azure Monitor Workspace, Managed Grafana, SRE Agent
- **Telemetry configuration:** `propane-telemetry-config` contains only non-secret OTLP endpoint and sampling settings. `application-insights-connection` is a Kubernetes Secret containing the collector connection string.
- **Tags on all resources:** `workload=amerigas-propane-demo`, `environment=demo`, `SecurityControl=Ignore`
- **Supported regions:** East US 2, Sweden Central, Australia East

## Alert Rules

| Alert | Fires When |
|-------|------------|
| Propane Pod Restart Alert | Pod restarts > 3 in 5 minutes |
| Propane HTTP 5xx Alert | HTTP 500 errors exceed threshold |
| Propane Pod Failure Alert | Pods in Failed state |
| Propane CrashLoop/OOM Alert | CrashLoopBackOff or OOMKilled events detected |
| AmeriGas Propane Demo - MongoDB Down (demo profile only) | Zero Running mongodb pods in the propane namespace — routed to a native SRE Agent response plan (custom agent `mongodb-down-responder`, Review autonomy). See `docs/sre-agent-response-plans/README.md`. |
