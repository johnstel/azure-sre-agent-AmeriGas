# ZavaGas Propane Platform — Helpdesk Supportability Guide

> **Audience**: L1/L2 support staff, on-call engineers, helpdesk operators
> **Platform**: Azure Kubernetes Service (AKS) · Namespace: `propane`
> **Last updated**: April 2026

---

## Table of Contents

1. [Platform Overview](#1-platform-overview)
2. [Architecture & Service Map](#2-architecture--service-map)
3. [Service Reference](#3-service-reference)
4. [Essential Commands](#4-essential-commands)
5. [Health Check Procedures](#5-health-check-procedures)
6. [Troubleshooting Runbook](#6-troubleshooting-runbook)
7. [Known Failure Scenarios](#7-known-failure-scenarios)
8. [Escalation Procedures](#8-escalation-procedures)
9. [Azure Infrastructure](#9-azure-infrastructure)
10. [Mission Control & Copilot AI Assistant](#10-mission-control--copilot-ai-assistant)
11. [Useful Links & Tools](#11-useful-links--tools)

---

## 1. Platform Overview

The ZavaGas Propane Platform is a retail propane distribution system running on AKS. It manages:

- **Customer self-service** — account management, delivery scheduling, tank level viewing
- **Dispatch operations** — fleet management, order fulfillment tracking
- **Tank monitoring** — IoT-style tank level readings and refill alerts
- **Order processing** — propane delivery order lifecycle management
- **Inventory management** — propane product catalog and pricing

### Key Facts

| Item | Value |
|------|-------|
| **AKS Cluster** | `aks-srelab` |
| **Resource Group** | `rg-srelab-<region>` |
| **Namespace** | `propane` |
| **Expected Pod Count** | 12–13 (order-worker is disabled) |
| **External Endpoints** | Customer Portal (port 80), Dispatch Console (port 80) |
| **Data Store** | In-cluster MongoDB (persistent disk) |
| **Message Bus** | In-cluster RabbitMQ |

---

## 2. Architecture & Service Map

```
                    ┌─────────────────┐     ┌──────────────────┐
                    │ Customer Portal │     │ Dispatch Console │
        Internet    │  (LoadBalancer) │     │  (LoadBalancer)  │
                    │   nginx:alpine  │     │   nginx:alpine   │
                    └───────┬─────────┘     └────────┬─────────┘
                            │    Reverse Proxy        │
                 ┌──────────┼─────────────────────────┤
                 ▼          ▼                         ▼
        ┌────────────┐ ┌────────────┐        ┌──────────────┐
        │  Inventory  │ │    Tank    │        │    Order     │
        │  Service    │ │  Monitor   │        │   Service    │
        │  :3002      │ │  :3000     │        │   :3001      │
        └────────────┘ └──────┬─────┘        └───┬──────┬───┘
                              │                   │      │
                              ▼                   │      ▼
                       ┌────────────┐             │ ┌─────────┐
                       │  RabbitMQ  │◄────────────┘ │ MongoDB │
                       │  :5672     │               │ :27017  │
                       └────────────┘               └─────────┘
                                                         │
                                                   8Gi PVC
                                                  (managed-csi)

        ┌─────────────────┐         ┌──────────────┐
        │ Usage Simulator │ ──────► │ OTel Collect. │ ──► App Insights
        │ (generates load)│         │ :4317 / :4318 │
        └─────────────────┘         └──────────────┘
```

### Service Dependency Chain

```
Customer Portal ──► Inventory Service (catalog)
                ──► Tank Monitor (tank data)
                ──► Order Service (orders)

Tank Monitor    ──► RabbitMQ (publishes tank events)
Order Service   ──► RabbitMQ (consumes tank events)
                ──► MongoDB (persists orders/readings)

Usage Simulator ──► Tank Monitor (generates synthetic load)
```

> **Critical dependency**: If MongoDB goes down, order-service degrades and tank readings stop being persisted. If RabbitMQ goes down, the tank-monitor-to-order-service pipeline breaks.

---

## 3. Service Reference

### 3.1 Customer Portal

| Property | Value |
|----------|-------|
| **Deployment** | `customer-portal` |
| **Image** | `nginx:alpine` |
| **Replicas** | 2 |
| **Port** | 8080 (container) → 80 (LoadBalancer) |
| **Liveness** | `GET /health` on 8080 (delay: 5s, period: 10s) |
| **Readiness** | `GET /health` on 8080 (delay: 3s, period: 5s) |
| **Resources** | 64Mi–128Mi memory, 50m–100m CPU |
| **Dependencies** | inventory-service, tank-monitor, order-service (via reverse proxy) |

### 3.2 Dispatch Console

| Property | Value |
|----------|-------|
| **Deployment** | `dispatch-console` |
| **Image** | `nginx:alpine` |
| **Replicas** | 1 |
| **Port** | 8081 (container) → 80 (LoadBalancer) |
| **Liveness** | `GET /health` on 8081 (delay: 5s, period: 10s) |
| **Readiness** | `GET /health` on 8081 (delay: 3s, period: 5s) |
| **Resources** | 64Mi–128Mi memory, 50m–100m CPU |
| **Dependencies** | inventory-service, tank-monitor, order-service (via reverse proxy) |

### 3.3 Tank Monitor

| Property | Value |
|----------|-------|
| **Deployment** | `tank-monitor` |
| **Image** | `ghcr.io/azure-samples/aks-store-demo/order-service:latest` |
| **Replicas** | 2 |
| **Port** | 3000 |
| **Liveness** | `GET /health` on 3000 (delay: 10s, period: 10s) |
| **Readiness** | `GET /health` on 3000 (delay: 5s, period: 5s) |
| **Resources** | 128Mi–256Mi memory, 100m–200m CPU |
| **Dependencies** | RabbitMQ (queue: `tank-events`) |
| **Key Env Vars** | `ORDER_QUEUE_HOSTNAME`, `ORDER_QUEUE_PORT`, `ORDER_QUEUE_NAME` |

### 3.4 Order Service

| Property | Value |
|----------|-------|
| **Deployment** | `order-service` |
| **Image** | `ghcr.io/azure-samples/aks-store-demo/makeline-service:latest` |
| **Replicas** | 2 |
| **Port** | 3001 |
| **Liveness** | `GET /health` on 3001 (delay: 10s, period: 10s) |
| **Readiness** | `GET /health` on 3001 (delay: 5s, period: 5s) |
| **Resources** | 64Mi–128Mi memory, 50m–100m CPU |
| **Dependencies** | RabbitMQ, MongoDB |
| **Key Env Vars** | `ORDER_QUEUE_URI`, `ORDER_DB_URI`, `ORDER_DB_NAME` |

### 3.5 Inventory Service

| Property | Value |
|----------|-------|
| **Deployment** | `inventory-service` |
| **Image** | `ghcr.io/azure-samples/aks-store-demo/product-service:latest` |
| **Replicas** | 2 |
| **Port** | 3002 |
| **Liveness** | `GET /health` on 3002 (delay: 10s, period: 10s) |
| **Readiness** | `GET /health` on 3002 (delay: 5s, period: 5s) |
| **Resources** | 64Mi–128Mi memory, 50m–100m CPU |
| **Dependencies** | Standalone (no DB/queue dependency) |

### 3.6 RabbitMQ

| Property | Value |
|----------|-------|
| **Deployment** | `rabbitmq` |
| **Image** | `rabbitmq:3.11-management-alpine` |
| **Replicas** | 1 |
| **Ports** | 5672 (AMQP), 15672 (management UI) |
| **Liveness** | exec `rabbitmq-diagnostics check_port_connectivity` (delay: 90s) |
| **Readiness** | exec `rabbitmq-diagnostics check_port_connectivity` (delay: 30s) |
| **Resources** | 256Mi–512Mi memory, 200m–500m CPU |
| **Credentials** | `guest` / `guest` |

### 3.7 MongoDB

| Property | Value |
|----------|-------|
| **Deployment** | `mongodb` |
| **Image** | `mongo:4.4` |
| **Replicas** | 1 |
| **Port** | 27017 |
| **Health Probes** | None configured |
| **Resources** | 256Mi–512Mi memory, 100m–500m CPU |
| **Storage** | PVC `mongodb-data-pvc` — 8Gi, `managed-csi` StorageClass |
| **Database** | `propanedb`, collection: `tank_readings` |

> ⚠️ MongoDB has no liveness/readiness probes. Kubernetes will not automatically detect or restart it if the process hangs without crashing.

### 3.8 OTel Collector

| Property | Value |
|----------|-------|
| **Deployment** | `otel-collector` |
| **Image** | `otel/opentelemetry-collector-contrib:0.158.0` |
| **Replicas** | 1 |
| **Ports** | 4317 (gRPC), 4318 (HTTP) |
| **Resources** | 128Mi–256Mi memory, 100m–200m CPU |
| **Role** | Exports traces, metrics, and logs through the `azuremonitor` exporter to workspace-based Application Insights. The connection string is sourced from a Kubernetes Secret. |

The service images are third-party demo images and are not claimed to emit OTLP merely because `OTEL_*` variables are present. The repo-owned `telemetry-baseline` CronJob makes real HTTP calls to the three APIs and emits observed request/dependency spans, logs, exceptions, and latency metrics. Validate freshness and correlation with `scripts/validate-telemetry.ps1`; a healthy collector pod is insufficient proof.

### 3.9 Usage Simulator

| Property | Value |
|----------|-------|
| **Deployment** | `usage-simulator` |
| **Image** | `ghcr.io/azure-samples/aks-store-demo/virtual-customer:latest` |
| **Replicas** | 1 |
| **Ports** | None |
| **Resources** | 32Mi–64Mi memory, 25m–50m CPU |
| **Key Env Vars** | `ORDER_SERVICE_URL=http://tank-monitor:3000/`, `ORDERS_PER_HOUR=100` |
| **Role** | Generates synthetic propane usage/ordering load |

### 3.10 Order Worker (Disabled)

### 3.11 Public proxy access model

The public `customer-portal` and `dispatch-console` LoadBalancer services now expose only the health probes that the demo UI needs: `GET /api/inventory/health`, `GET /api/tanks/health`, and `GET /api/orders/health`. All other `/api/` requests are rejected with `404`, so write-capable order APIs are not reachable from the public entry points.

For direct access to the internal APIs, use an in-cluster workflow such as `kubectl exec -n propane deploy/customer-portal -- wget -qO- http://inventory-service:3002/health` or `kubectl port-forward -n propane svc/order-service 3001:3001` from a workstation. This demo does not deploy an ingress controller or automatic TLS termination, so the baseline deployment uses the public LoadBalancer on HTTP only. If you need HTTPS for a real deployment, add an ingress controller or Application Gateway in front of these services and terminate TLS there.

| Property | Value |
|----------|-------|
| **Deployment** | `order-worker` |
| **Replicas** | **0** (intentionally disabled — AMQP protocol mismatch with RabbitMQ 3.11) |

---

## 4. Essential Commands

### Cluster Access

```bash
# Get AKS credentials
az aks get-credentials --resource-group rg-srelab-eastus2 --name aks-srelab --overwrite-existing

# Verify connectivity
kubectl cluster-info
```

### Pod & Service Status

```bash
# All pods in propane namespace
kubectl get pods -n propane -o wide

# All services (check external IPs)
kubectl get svc -n propane

# All deployments (check replica counts)
kubectl get deployments -n propane

# Watch pods in real-time
kubectl get pods -n propane -w
```

### Logs & Events

```bash
# Pod logs (current)
kubectl logs <pod-name> -n propane

# Pod logs (previous crashed container)
kubectl logs <pod-name> -n propane --previous

# Follow logs in real-time
kubectl logs -f <pod-name> -n propane

# Recent events (sorted by time)
kubectl get events -n propane --sort-by='.lastTimestamp'

# Events for a specific pod
kubectl describe pod <pod-name> -n propane
```

### Quick Diagnostics

```bash
# Check node health
kubectl get nodes -o wide

# Resource usage by pod
kubectl top pods -n propane

# Resource usage by node
kubectl top nodes

# Check endpoints (are services routing to pods?)
kubectl get endpoints -n propane
```

### Recovery Commands

```bash
# Restore ALL services to healthy baseline
kubectl apply -f k8s/base/application.yaml

# Restart a specific deployment
kubectl rollout restart deployment/<name> -n propane

# Scale a deployment
kubectl scale deployment/<name> -n propane --replicas=<count>

# Delete a rogue/test deployment
kubectl delete deployment <name> -n propane

# Delete a network policy
kubectl delete networkpolicy <name> -n propane
```

---

## 5. Health Check Procedures

### Quick Health Check (2 minutes)

Run these in order:

```bash
# 1. Are all pods running?
kubectl get pods -n propane
# Expected: 12-13 pods, all Running, low restart counts

# 2. Are services reachable?
kubectl get svc -n propane
# Expected: customer-portal and dispatch-console have EXTERNAL-IP

# 3. Any recent errors?
kubectl get events -n propane --sort-by='.lastTimestamp' --field-selector type=Warning
# Expected: No recent warnings

# 4. Are endpoints populated?
kubectl get endpoints -n propane
# Expected: All services have at least one endpoint IP
```

### Service-Level Health Checks

| Service | How to Check | Healthy Response |
|---------|-------------|-----------------|
| Customer Portal | `curl http://<EXTERNAL-IP>/health` | 200 OK |
| Dispatch Console | `curl http://<EXTERNAL-IP>/health` | 200 OK |
| Tank Monitor | `kubectl exec -n propane deploy/customer-portal -- wget -qO- http://tank-monitor:3000/health` | 200 OK |
| Order Service | `kubectl exec -n propane deploy/customer-portal -- wget -qO- http://order-service:3001/health` | 200 OK |
| Inventory Service | `kubectl exec -n propane deploy/customer-portal -- wget -qO- http://inventory-service:3002/health` | 200 OK |
| RabbitMQ | `kubectl exec -n propane deploy/rabbitmq -- rabbitmq-diagnostics check_port_connectivity` | Exit code 0 |
| MongoDB | `kubectl exec -n propane deploy/mongodb -- mongo --eval "db.adminCommand('ping')"` | `{ "ok" : 1 }` |

### Healthy Baseline Checklist

| Check | Expected |
|-------|----------|
| customer-portal pods | 2/2 Running |
| dispatch-console pods | 1/1 Running |
| tank-monitor pods | 2/2 Running |
| order-service pods | 2/2 Running |
| inventory-service pods | 2/2 Running |
| rabbitmq pods | 1/1 Running |
| mongodb pods | 1/1 Running |
| otel-collector pods | 1/1 Running |
| usage-simulator pods | 1/1 Running |
| order-worker pods | 0/0 (disabled) |
| customer-portal EXTERNAL-IP | Assigned |
| dispatch-console EXTERNAL-IP | Assigned |
| Node status | All Ready |

---

## 6. Troubleshooting Runbook

### Symptom → Cause → Fix

#### Pod is `CrashLoopBackOff`

1. **Check logs**: `kubectl logs <pod> -n propane --previous`
2. **Check events**: `kubectl describe pod <pod> -n propane`
3. **Common causes**:
   - Bad configuration (env var, config map)
   - Dependency unavailable (MongoDB, RabbitMQ)
   - Out of memory (check `OOMKilled` in last state)
   - Bad image or entrypoint
4. **Fix**: Restore baseline — `kubectl apply -f k8s/base/application.yaml`

#### Pod is `OOMKilled`

1. **Confirm**: `kubectl describe pod <pod> -n propane | Select-String "OOMKilled"`
2. **Check resource limits**: `kubectl get pod <pod> -n propane -o jsonpath='{.spec.containers[0].resources}'`
3. **Fix**: Restore baseline or increase memory limits

#### Pod is `ImagePullBackOff`

1. **Check events**: `kubectl describe pod <pod> -n propane | Select-String "Failed to pull"`
2. **Verify image exists**: Check the image tag in the deployment spec
3. **Fix**: Correct the image tag or restore baseline

#### Pod is `Pending`

1. **Check events**: `kubectl describe pod <pod> -n propane`
2. **Common causes**:
   - Insufficient CPU/memory on nodes
   - Node selector doesn't match any node
   - PVC cannot be bound
3. **Fix**: Check resource requests, scale node pool, or delete over-provisioned deployment

#### Pod is `ContainerCreateError`

1. **Check events**: `kubectl describe pod <pod> -n propane`
2. **Common causes**:
   - Missing ConfigMap or Secret referenced in the spec
   - Volume mount issues
3. **Fix**: Create the missing config or restore baseline

#### Service returns errors but pods look healthy

1. **Check endpoints**: `kubectl get endpoints <service-name> -n propane`
   - If endpoints list is **empty**: service selector doesn't match pod labels
2. **Check network policies**: `kubectl get networkpolicies -n propane`
   - If a deny policy exists: it may be blocking traffic
3. **Fix**:
   - Selector mismatch → `kubectl apply -f k8s/base/application.yaml`
   - Network policy → `kubectl delete networkpolicy <name> -n propane`

#### Customer Portal / Dispatch Console loads but shows errors

1. **Check which backend is failing**: Open browser DevTools → Network tab
   - `/api/inventory/` → inventory-service
   - `/api/tanks/` → tank-monitor
   - `/api/orders/` → order-service
2. **Check backend pod health**: `kubectl get pods -n propane -l app=<service>`
3. **Check backend service endpoints**: `kubectl get endpoints <service> -n propane`

#### MongoDB is down — cascading failures

1. **Symptoms**: order-service restarts, tank readings not persisted, RabbitMQ queue grows
2. **Verify**: `kubectl get pods -n propane -l app=mongodb`
3. **Fix**: `kubectl scale deployment mongodb -n propane --replicas=1`
4. **Wait for rollout**: `kubectl rollout status deployment/mongodb -n propane`
5. **Verify recovery**: Check order-service stops restarting

#### RabbitMQ is down — pipeline breaks

1. **Symptoms**: Tank monitor can't publish events, order-service can't consume
2. **Verify**: `kubectl get pods -n propane -l app=rabbitmq`
3. **Fix**: `kubectl scale deployment rabbitmq -n propane --replicas=1`
4. **Restart dependents**: `kubectl rollout restart deployment/tank-monitor deployment/order-service -n propane`

#### High CPU / Cluster Slow

1. **Check node utilization**: `kubectl top nodes`
2. **Check pod utilization**: `kubectl top pods -n propane --sort-by=cpu`
3. **Look for rogue pods**: Check for unexpected deployments — `kubectl get deployments -n propane`
4. **Fix**: Delete any rogue high-CPU deployments

#### No external IP on portal/console

1. **Check service**: `kubectl get svc customer-portal -n propane`
2. If `EXTERNAL-IP` shows `<pending>`:
   - Wait 2–3 minutes (Azure LB provisioning)
   - Check for Azure Load Balancer quota issues
   - Check node pool has outbound connectivity

---

## 7. Known Failure Scenarios

This platform includes pre-built breakable scenarios for training and testing. If you see one of these patterns, it may have been intentionally applied.

| Scenario | Symptom | Affected Service | How to Identify | Fix Command |
|----------|---------|-----------------|-----------------|-------------|
| **OOM Kill** | Pod restarts, `OOMKilled` status | tank-monitor | `kubectl describe pod` shows OOMKilled | `kubectl apply -f k8s/base/application.yaml` |
| **Crash Loop** | `CrashLoopBackOff` | inventory-service | Logs show exit code 1 | `kubectl apply -f k8s/base/application.yaml` |
| **Image Pull** | `ImagePullBackOff` | order-service | Events show image not found | `kubectl apply -f k8s/base/application.yaml` |
| **High CPU** | Cluster-wide slowness | demand-forecast-overload | `kubectl top pods` shows extreme CPU | `kubectl delete deploy demand-forecast-overload -n propane` |
| **Pending Pods** | Pods stuck `Pending` | fleet-telemetry-monitor | Events show insufficient resources | `kubectl delete deploy fleet-telemetry-monitor -n propane` |
| **Probe Failure** | Healthy workload, delayed safety alarm | safety-compliance-monitor | Simulated alarm remains pending while workload stays healthy | `kubectl delete deployment safety-compliance-monitor -n propane --ignore-not-found; kubectl delete configmap tank-safety-alarm-config -n propane --ignore-not-found` |
| **Network Block** | Tank data timeouts | tank-monitor (NetworkPolicy) | `kubectl get networkpolicies -n propane` | `kubectl delete networkpolicy deny-tank-monitor -n propane` |
| **Missing Config** | `ContainerCreateError` | delivery-zone-config | Events show missing ConfigMap | `kubectl delete deploy delivery-zone-config -n propane` |
| **MongoDB Down** | Order service restarts, data loss | mongodb (scaled to 0) | `kubectl get deploy mongodb -n propane` shows 0/0 | `kubectl apply -f k8s/base/application.yaml` |
| **Service Mismatch** | Pods healthy but service unreachable | tank-monitor (selector wrong) | `kubectl get endpoints tank-monitor -n propane` shows empty | `kubectl apply -f k8s/base/application.yaml` |

### Universal Fix

To restore **all** services to a known-good state:

```bash
kubectl apply -f k8s/base/application.yaml
```

To also clean up rogue deployments, scenario config, and network policies from scenarios:

```bash
kubectl delete deployment demand-forecast-overload fleet-telemetry-monitor safety-compliance-monitor delivery-zone-config -n propane --ignore-not-found
kubectl delete configmap tank-safety-alarm-config -n propane --ignore-not-found
kubectl delete networkpolicy deny-tank-monitor -n propane --ignore-not-found
kubectl apply -f k8s/base/application.yaml
```

---

## 8. Escalation Procedures

### L1 Support (Helpdesk)

**Can handle**:
- Checking pod status and service health
- Using **Mission Control Copilot** to diagnose issues conversationally (e.g., "What's wrong with the cluster?")
- Restarting individual deployments (via kubectl or Mission Control Copilot)
- Applying the baseline manifest to restore healthy state
- Removing known breakable scenario resources
- Collecting logs for escalation

> **💡 Tip**: L1 operators can use the Mission Control Copilot at http://localhost:3000 to diagnose and fix many issues without needing to know kubectl commands. Open the chat panel and describe the symptoms in plain language.

**Escalate to L2 when**:
- Baseline restore doesn't fix the issue
- Node-level problems (nodes NotReady, disk pressure)
- Persistent volume issues (PVC stuck, data corruption)
- Azure infrastructure issues (AKS control plane, networking)
- Unknown deployments or configurations not in this guide

### L2 Support (Platform Engineering)

**Can handle**:
- AKS cluster-level troubleshooting
- Node pool scaling and management
- Azure networking and load balancer issues
- Infrastructure redeployment via `scripts/deploy.ps1`
- RBAC and access control changes

**Escalate to L3 when**:
- AKS control plane is unresponsive
- Azure region-level issues
- Security incidents
- Data recovery needed from MongoDB

### Collecting Information for Escalation

When escalating, gather:

```bash
# Cluster state snapshot
kubectl get pods -n propane -o wide > /tmp/pods.txt
kubectl get events -n propane --sort-by='.lastTimestamp' > /tmp/events.txt
kubectl get nodes -o wide > /tmp/nodes.txt
kubectl top pods -n propane > /tmp/pod-resources.txt
kubectl top nodes > /tmp/node-resources.txt

# Logs for affected pods
kubectl logs <pod-name> -n propane > /tmp/<pod-name>-logs.txt
kubectl logs <pod-name> -n propane --previous > /tmp/<pod-name>-previous-logs.txt

# Full pod description
kubectl describe pod <pod-name> -n propane > /tmp/<pod-name>-describe.txt
```

---

## 9. Azure Infrastructure

### Resources

| Resource | Type | Purpose |
|----------|------|---------|
| `aks-srelab` | AKS Cluster | Container orchestration |
| ACR | Container Registry | Image storage |
| Key Vault | Secrets | Secrets management |
| Log Analytics | Monitoring | Log aggregation |
| Application Insights | APM | Application telemetry |
| Managed Grafana | Dashboards | Visualization |

### Infrastructure Management

```powershell
# Full deployment (creates everything)
.\scripts\deploy.ps1 -Location eastus2 -Yes

# Validate deployment health
.\scripts\validate-deployment.ps1

# Destroy all resources (⚠️ destructive)
.\scripts\destroy.ps1 -ResourceGroupName "rg-srelab-eastus2"
```

### Azure SRE Agent

If Azure SRE Agent is enabled, it provides AI-powered diagnosis:

- **Portal**: https://aka.ms/sreagent/portal
- **Supported regions**: East US 2, Sweden Central, Australia East
- **Firewall**: Must allow `*.azuresre.ai`
- **Requirement**: AKS cluster must be public (not private)

---

## 10. Mission Control & Copilot AI Assistant

### Overview

Mission Control is a local Node.js/Express dashboard (`tools/mission-control/`) that provides a web-based operations center with a built-in **GitHub Copilot SDK** AI assistant. It runs at **http://localhost:3000** and connects directly to the AKS cluster via kubectl. Cluster telemetry is treated as untrusted data, and remediation or infrastructure actions require explicit approval before they run.

### Prerequisites

| Requirement | Details |
|-------------|---------|
| **GitHub Copilot license** | Individual, Business, or Enterprise plan |
| **VS Code Copilot extension** | `GitHub.copilot` and `GitHub.copilot-chat` (included in the dev container) |
| **kubectl** | Configured with AKS credentials (`az aks get-credentials`) |
| **az CLI** | Authenticated (`az login`) |
| **Node.js** | v18+ (included in the dev container) |

### Starting Mission Control

```bash
# From the dev container terminal (recommended)
mission-control

# Or manually
cd tools/mission-control
npm install
npm start
```

### What Mission Control Provides

1. **Dashboard** — real-time pod status, service health, external IPs
2. **Break Scenario Buttons** — one-click to apply any of the 10 breakable scenarios
3. **Fix Buttons** — one-click Fix All, Fix Network, Fix Extras
4. **Infrastructure Panel** — deploy, validate, and destroy Azure infrastructure
5. **AI Chat Panel** — GitHub Copilot SDK-powered assistant (see below)

### Copilot AI Assistant

The chat panel (accessed via the Copilot button or top banner) provides a conversational AI assistant with direct cluster access through 19 custom tools:

#### Diagnostic Tools

| Tool | Description |
|------|-------------|
| `get_pods` | List all pods in the propane namespace with status, readiness, restarts |
| `get_pod_logs` | Get recent logs from a specific pod (supports `--previous` for crashed containers) |
| `describe_pod` | Detailed pod information including events, conditions, container state |
| `get_events` | Recent Kubernetes events sorted by time (can filter warnings only) |
| `get_deployments` | All deployments with replica status |
| `get_services` | Services and their endpoints |
| `get_nodes` | Node status, capacity, and resource usage |
| `get_cluster_health` | Comprehensive health check: pods, deployments, services, endpoints, warnings, network policies |

#### Remediation Tools

| Tool | Description |
|------|-------------|
| `fix_all` | Restore all services to healthy baseline (`k8s/base/application.yaml`) |
| `fix_network` | Remove the `deny-tank-monitor` network policy |
| `fix_extras` | Delete rogue deployments from break scenarios |
| `scale_deployment` | Scale a deployment to a specified replica count |
| `restart_deployment` | Trigger a rolling restart of a deployment |

#### Scenario & Infrastructure Tools

| Tool | Description |
|------|-------------|
| `apply_break_scenario` | Apply a breakable scenario (oom, crash, image, cpu, pending, probe, network, config, mongodb, service) |
| `deploy_infrastructure` | Deploy full Azure infrastructure via `scripts/deploy.ps1` (approval required) |
| `destroy_infrastructure` | Destroy all Azure resources via `scripts/destroy.ps1` (approval required) |
| `validate_deployment` | Run the deployment validation script |
| `get_cluster_info` | Get Azure context: subscription, resource group, region |
| `kubectl_readonly` | Run a safe, read-only kubectl allowlist (get/describe/logs/top/config current-context) |

#### Chat API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/copilot/status` | GET | Check Copilot SDK connection status |
| `/api/chat` | POST | Send a message — body: `{ "message": "..." }` |
| `/api/chat/history` | GET | Retrieve full conversation history |
| `/api/chat/reset` | POST | Reset conversation and create a new Copilot session |

#### Example Prompts for Mission Control Copilot

**Diagnosis:**
- "What's the health of the cluster?"
- "Why is tank-monitor restarting?"
- "Show me warning events in the propane namespace"
- "Are there any pods with high restart counts?"

**Remediation:**
- "Fix all broken services"
- "Scale mongodb back to 1 replica"
- "Restart the order-service deployment"
- "Delete the deny-tank-monitor network policy"

**Scenarios:**
- "Apply the OOM scenario"
- "Break the MongoDB scenario and then diagnose what went wrong"

**Infrastructure:**
- "Deploy the infrastructure to eastus2"
- "What resource group is this cluster in?"
- "Validate the deployment"
- "Destroy the infrastructure for rg-srelab-eastus2"

### Troubleshooting Mission Control

| Issue | Resolution |
|-------|-----------|
| "Copilot SDK failed" on startup | Verify GitHub Copilot license and VS Code Copilot extension are active |
| Chat returns 503 error | Copilot SDK didn't initialize — check terminal output for error details |
| Tools return kubectl errors | Verify kubectl context: `kubectl config current-context` and `kubectl get pods -n propane` |
| Session expired mid-conversation | The assistant auto-reconnects on the next message; retry your prompt |
| Responses take a long time | Complex multi-tool queries (e.g., full health check) can take up to 180 seconds — this is normal |
| Port 3000 already in use | Set a different port: `PORT=3001 npm start` |
| Infrastructure deploy/destroy timeout | These are long-running operations (up to 10 minutes); the tool has a 600-second timeout |

### Mission Control vs. Azure SRE Agent

| Feature | Mission Control Copilot | Azure SRE Agent |
|---------|------------------------|-----------------|
| **Runs** | Locally (Node.js) | Cloud (Azure) |
| **Cluster Access** | Via local kubectl | Via Azure control plane |
| **Authentication** | GitHub Copilot license | Azure RBAC |
| **Log Analysis** | kubectl logs only | Log Analytics, App Insights, full telemetry |
| **Scheduled Tasks** | No | Yes (subagents, cron) |
| **Break Scenarios** | Can apply and diagnose | Diagnose only |
| **Infrastructure Ops** | Deploy/destroy via scripts | Read-only diagnostics |
| **Best For** | Interactive demos, local troubleshooting | Production monitoring, deep observability |

---

## 11. Useful Links & Tools

| Resource | Location |
|----------|----------|
| **Mission Control** | `tools/mission-control/` (start with `mission-control` command) |
| **Breakable Scenarios Guide** | `docs/BREAKABLE-SCENARIOS.md` |
| **Cost Estimates** | `docs/COSTS.md` |
| **SRE Agent Setup** | `docs/SRE-AGENT-SETUP.md` |
| **Response Plan (issue #19)** | `docs/sre-agent-response-plans/README.md` |
| **Demo Script** | `docs/DEMO-SCRIPT.md` |
| **Prompt Guide** | `docs/PROMPTS-GUIDE.md` |
| **Supportability Guide** | `docs/SUPPORTABILITY.md` |
| **Base Manifest** | `k8s/base/application.yaml` |
| **Scenario Manifests** | `k8s/scenarios/*.yaml` |
| **Deploy Script** | `scripts/deploy.ps1` |
| **Validate Script** | `scripts/validate-deployment.ps1` |
| **RBAC Config** | `scripts/configure-rbac.ps1` |

### Dev Container Shortcuts

If using the dev container, type `menu` for a list of helper commands:

| Command | Action |
|---------|--------|
| `kgp` | Get pods in propane namespace |
| `kgs` | Get services |
| `kgd` | Get deployments |
| `kge` | Get events |
| `kwatch` | Watch pods in real-time |
| `deploy` | Deploy infrastructure |
| `destroy` | Tear down infrastructure |
| `site` | Show customer portal URL |
| `fix-all` | Restore healthy baseline |
| `break-oom` | Apply OOM scenario |
| `break-crash` | Apply crash loop scenario |
| `break-image` | Apply image pull scenario |
| `break-mongodb` | Apply MongoDB down scenario |
| `break-service` | Apply service mismatch scenario |
