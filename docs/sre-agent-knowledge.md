# AmeriGas Propane Operations Platform — SRE Knowledge Base

## Overview

This is the AmeriGas Propane Operations Platform running on Azure Kubernetes Service (AKS). AmeriGas is the largest retail propane distributor in the United States, serving over 1.5 million residential, commercial, and industrial customers. This platform manages propane tank monitoring, inventory management, order fulfillment, and customer-facing operations.

**Kubernetes Namespace:** `propane`
**Observability:** Azure Log Analytics (Container Insights via omsagent), Application Insights, Azure Data Explorer (PropaneLogs database), Azure Monitor (Prometheus), Managed Grafana

## Architecture

### Services

| Service | Deployment Name | Port | Role | Technology |
|---------|----------------|------|------|------------|
| Customer Portal | `customer-portal` | 8080 | Consumer-facing portal — billing, tank status, delivery scheduling, outage maps | Vue.js / nginx |
| Dispatch Console | `dispatch-console` | 8081 | Internal operations console for dispatchers and field service coordinators | Vue.js / nginx |
| Tank Monitor | `tank-monitor` | 3000 | IoT data ingestion from smart tank sensors — reports tank levels, leak detection, usage patterns | Node.js |
| Inventory Service | `inventory-service` | 3002 | Propane inventory catalog — depot stock levels, pricing tiers, product grades | Rust |
| Order Service | `order-service` | 3001 | Order fulfillment — processes delivery orders, manages scheduling queues | Go |
| Usage Simulator | `usage-simulator` | — | Generates simulated residential propane consumption patterns (background, no port) | Python |
| Order Worker | `order-worker` | — | Processes order fulfillment queue messages (disabled by default, 0 replicas) | Python |
| OTel Collector | `otel-collector` | 4317 / 4318 | OpenTelemetry Collector — receives OTLP telemetry, scrapes Prometheus, exports to App Insights | OTel Contrib |
| RabbitMQ | `rabbitmq` | 5672 / 15672 | Event bus for tank events, order alerts, dispatch coordination | RabbitMQ 3.13 |
| MongoDB | `mongodb` | 27017 | Stores tank readings, delivery records, customer accounts, inventory state | MongoDB 7.0 |

### Service Dependencies

```
Customer Portal ──→ Inventory Service, Tank Monitor, Order Service (via nginx proxy)
Dispatch Console ──→ Inventory Service, Tank Monitor, Order Service (via nginx proxy)
Tank Monitor ──→ RabbitMQ (publishes tank-events)
Order Service ──→ RabbitMQ (consumes tank-events) ──→ MongoDB (persists readings)
Inventory Service ──→ (standalone catalog, no DB dependency)
Usage Simulator ──→ Tank Monitor (HTTP, generates load)
Order Worker ──→ Order Service (disabled, 0 replicas)
OTel Collector ──→ App Insights (exports traces/metrics/logs)
All services ──→ OTel Collector (OTLP endpoint for telemetry)
```

**Critical dependency chain:** Usage Simulator → Tank Monitor → RabbitMQ → Order Service → MongoDB. If MongoDB goes down, Order Service fails, causing cascading failures visible in Customer Portal and Dispatch Console.

### Telemetry & Instrumentation

- All application pods have `APPLICATIONINSIGHTS_CONNECTION_STRING` via `propane-telemetry-config` ConfigMap
- Each service has `OTEL_SERVICE_NAME` set for distributed tracing identity
- An **OpenTelemetry Collector** (`otel-collector`) runs in-cluster receiving OTLP (gRPC:4317, HTTP:4318) and scraping Prometheus metrics from services
- The OTel Collector exports traces/metrics/logs to Application Insights and stdout (captured by Container Insights → Log Analytics → ADX)
- The deploy script injects the real App Insights connection string post-deployment via `kubectl create configmap --dry-run=client | kubectl apply`

### Storage

- **MongoDB** uses an Azure Managed Disk (PersistentVolumeClaim `mongodb-data`, 8Gi, managed-csi StorageClass)
- **RabbitMQ** uses an Azure Managed Disk (PersistentVolumeClaim `rabbitmq-data`, 2Gi, managed-csi StorageClass)

### Networking

- **Customer Portal** is exposed via a Kubernetes `LoadBalancer` service (external IP)
- All other services are `ClusterIP` (internal only)
- **RabbitMQ management UI** is internal on port 15672

## Where Logs Are Stored

- **Container logs:** Azure Log Analytics workspace via Container Insights (AKS omsagent addon)
- **Application telemetry:** Application Insights (connected to the same Log Analytics workspace, IngestionMode: LogAnalytics)
- **Azure Data Explorer:** An ADX cluster with a `PropaneLogs` database receives continuous data export from Log Analytics (ContainerLogV2, KubeEvents, KubePodInventory tables). Use ADX for high-performance ad-hoc queries and long-term analytics.
- **AKS control plane logs:** Sent to Log Analytics via diagnostic settings (kube-apiserver, kube-controller-manager, kube-scheduler, kube-audit-admin, guard, cloud-controller-manager)
- **Prometheus metrics:** Azure Monitor Workspace, viewable in Managed Grafana

### Querying Logs in Azure Data Explorer

Connect to the ADX cluster URI (output from deployment) and query the `PropaneLogs` database:

```kql
// Container logs from propane namespace
ContainerLogV2
| where PodNamespace == "propane"
| order by TimeGenerated desc
| take 100

// Pod events — restarts, failures, OOM
KubeEvents
| where Namespace == "propane"
| where Reason in ("BackOff", "Killing", "OOMKilling", "Failed")
| order by TimeGenerated desc

// Pod inventory — current state of all pods
KubePodInventory
| where Namespace == "propane"
| summarize arg_max(TimeGenerated, *) by Name
| project Name, PodStatus, ContainerStatus, RestartCount
```

## Healthy State

When the platform is healthy, you should see these pods running in the `propane` namespace:

| Pod (prefix) | Expected Status | Expected Restarts | Replicas |
|--------------|----------------|-------------------|----------|
| customer-portal-* | Running | 0 | 1 |
| dispatch-console-* | Running | 0 | 1 |
| tank-monitor-* | Running | 0 | 1 |
| inventory-service-* | Running | 0 | 1 |
| order-service-* | Running | 0 | 1 |
| usage-simulator-* | Running | 0 | 1 |
| rabbitmq-* | Running | 0 | 1 |
| mongodb-* | Running | 0 | 1 |

**order-worker** has 0 replicas by default and will not have a running pod.

Total expected healthy pods: **8**

## Known Failure Scenarios and Runbooks

### 1. OOMKilled — Tank Monitor Memory Exhaustion

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

**Symptoms:** order-service pods in ImagePullBackOff or ErrImagePull
**Root cause:** Deployment references non-existent image tag (simulates botched release)
**Resolution:** Restore correct image tag:
```
kubectl apply -f k8s/base/application.yaml
```

### 4. High CPU — Demand Forecast Overload

**Symptoms:** Extra pods named `demand-forecast-overload-*` consuming high CPU, other workloads may slow down
**Root cause:** Peak heating season triggering intensive demand forecasting calculations (CPU stress pod)
**Resolution:** Remove the extra deployment:
```
kubectl delete deployment demand-forecast-overload -n propane
```

### 5. Pending Pods — Fleet Telemetry Monitor Scheduling Failure

**Symptoms:** Pods named `fleet-telemetry-monitor-*` stuck in Pending state
**Root cause:** Pod requests excessive CPU/memory resources that no node can satisfy
**Resolution:** Remove the extra deployment:
```
kubectl delete deployment fleet-telemetry-monitor -n propane
```

### 6. Probe Failure — Safety Compliance Monitor

**Symptoms:** Pods named `safety-compliance-monitor-*` failing readiness/liveness probes, frequent restarts
**Root cause:** Liveness and readiness probes point at a non-existent endpoint after maintenance update
**Resolution:** Remove the extra deployment:
```
kubectl delete deployment safety-compliance-monitor -n propane
```

### 7. Network Block — Tank Monitor Isolation

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

**Symptoms:** Pods named `delivery-zone-config-*` stuck in ContainerCreating or CrashLoopBackOff
**Root cause:** Deployment references ConfigMaps that don't exist
**Resolution:** Remove the extra deployment:
```
kubectl delete deployment delivery-zone-config -n propane
```

### 9. MongoDB Down — Cascading Database Failure

**Symptoms:** mongodb pod not running (0 replicas), tank-monitor and order-service may show errors or restarts
**Root cause:** MongoDB deployment scaled to 0 replicas, simulating database outage
**Impact:** Cascading failure — services that depend on MongoDB (tank-monitor, order-service) will fail to process data, leading to customer portal and dispatch console showing errors
**Resolution:** Restore MongoDB:
```
kubectl apply -f k8s/base/application.yaml
```
**This is the most impactful scenario** — it demonstrates cascading failures and root cause analysis.

### 10. Service Mismatch — Tank Monitor Routing Failure

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
- **Resources deployed:** AKS, Azure Container Registry, Key Vault, Log Analytics, Application Insights, Azure Monitor Workspace, Managed Grafana, Alert Rules
- **Tags on all resources:** `workload=amerigas-propane-demo`, `environment=demo`, `SecurityControl=Ignore`
- **Supported regions:** East US 2, Sweden Central, Australia East

## Alert Rules

| Alert | Fires When |
|-------|------------|
| Propane Pod Restart Alert | Pod restarts > 3 in 5 minutes |
| Propane HTTP 5xx Alert | HTTP 500 errors exceed threshold |
| Propane Pod Failure Alert | Pods in Failed state |
| Propane CrashLoop/OOM Alert | CrashLoopBackOff or OOMKilled events detected |
