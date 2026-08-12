# Azure SRE Agent AmeriGas Propane Demo Lab - Copilot Instructions

## Project Overview

This repository contains a fully automated Azure SRE Agent demo lab environment themed as an **AmeriGas Propane Distribution Platform**. It deploys:

- **Azure Kubernetes Service (AKS)** with a multi-pod propane distribution platform
- **Azure Container Registry** for container images
- **Azure Key Vault** for secrets management
- **Observability stack**: Log Analytics, Application Insights, Managed Grafana
- **Breakable scenarios** for demonstrating SRE Agent diagnosis capabilities

The platform simulates a retail propane distributor with propane distribution and customer services using in-cluster MongoDB and RabbitMQ with Azure Managed Disk storage.

## Domain Model

This platform supports **two distinct propane business domains**. Every simulator, service, UI section, metric, event, and breakable scenario belongs to exactly one domain (or is explicitly Shared). Never mix vocabulary across domains — see `docs/sre-agent-knowledge.md` for the full model.

- **Bulk Tank** — residential/commercial bulk propane tanks & deliveries. Vocabulary: gallons, tank percentage, consumption, refill recommendation, delivery scheduling. Owned by `tank-monitor`, `usage-simulator`, and the Customer Portal "My Bulk Tank" section.
- **Cylinder Exchange** — retail cylinder exchange cages at partner stores. Vocabulary: full/empty/reserved cylinder counts, cage replenishment, exchange-location terminology. Owned by `dispatch-console` (Retail Cage Operations Center) and the Customer Portal "Nearby Exchange Locations" section.
- **Shared** — `inventory-service`, `order-service`, `order-worker`, `rabbitmq`, `mongodb`, `otel-collector` serve both domains.

## AmeriGas Propane Architecture

| Service | Role | Domain | Technology |
|---------|------|--------|------------|
| `customer-portal` | Customer portal (bulk tank account, deliveries, cylinder exchange locations) | Bulk Tank + Cylinder Exchange | Vue.js |
| `dispatch-console` | Retail Cage Operations Center for fleet & cage restock orders | Cylinder Exchange | Vue.js |
| `tank-monitor` | IoT bulk tank level monitoring & refill alerts | Bulk Tank | Node.js |
| `inventory-service` | Propane inventory, pricing, product catalog (bulk delivery + cylinder exchange) | Shared | Rust |
| `order-service` | Order fulfillment & processing | Shared | Go |
| `usage-simulator` | Customer bulk tank propane usage pattern generator | Bulk Tank | Python |
| `order-worker` | Order processing worker (disabled) | Shared | Python |
| `rabbitmq` | Event bus (tank alerts, delivery orders, fulfillment updates) | Shared | RabbitMQ |
| `mongodb` | Tank readings, delivery records, customer data | Shared | MongoDB |

## Technology Stack

- **Infrastructure as Code**: Bicep (modular templates in `infra/bicep/`)
- **Container Orchestration**: Kubernetes (manifests in `k8s/`)
- **Scripting**: PowerShell (deployment scripts in `scripts/`)
- **Dev Environment**: Dev Containers with Azure CLI, kubectl, azd

## Key Directories

```
├── infra/bicep/           # Bicep IaC templates
│   ├── main.bicep         # Main deployment orchestration
│   ├── main.bicepparam    # Parameters file
│   └── modules/           # Modular Bicep templates
├── k8s/
│   ├── base/              # Healthy application manifests
│   └── scenarios/         # Breakable failure scenarios
├── scripts/               # Deployment and management scripts
├── docs/                  # Documentation
└── .devcontainer/         # Dev container configuration
```

## Azure SRE Agent Context

Azure SRE Agent is a Preview feature that provides AI-powered site reliability engineering automation:

- **Supported Regions**: East US 2, Sweden Central, Australia East
- **Firewall Requirement**: Allow `*.azuresre.ai`
- **RBAC Roles**: SRE Agent Admin, Standard User, Reader
- **Key Feature**: Natural language diagnosis and remediation

### SRE Agent Starter Prompts

For AKS issues:
- "Why are pods crashing in the propane namespace?"
- "Show me the health status of my AKS cluster"
- "What's causing high CPU usage on the demand forecast pods?"

For general diagnosis:
- "Tank level data isn't being processed — what's wrong?"
- "Analyze performance metrics and identify bottlenecks"

## Breakable Scenarios

Located in `k8s/scenarios/`:

| File | Domain | AmeriGas Narrative | SRE Agent Can Diagnose |
|------|--------|-------------------|----------------------|
| `oom-killed.yaml` | Bulk Tank | Tank monitor overwhelmed by winter peak readings | OOMKilled events, memory limits |
| `crash-loop.yaml` | Shared | Inventory service crash — invalid pricing config | CrashLoopBackOff, exit codes |
| `image-pull-backoff.yaml` | Shared | Order service fails after botched image release | Registry/image issues |
| `high-cpu.yaml` | Cylinder Exchange | Demand forecast overload during peak heating season | CPU contention |
| `pending-pods.yaml` | Shared | Fleet telemetry monitor can't schedule | Scheduling issues |
| `probe-failure.yaml` | Bulk Tank | Simulated rapid tank-level drop with suppressed alarm processing | Healthy workload + delayed safety alarm |
| `network-block.yaml` | Bulk Tank | Tank monitor isolated by bad security policy | Network policies |
| `missing-config.yaml` | Shared | Delivery zone configuration missing | Configuration issues |
| `mongodb-down.yaml` | Shared | Tank database outage — cascading failure | Dependency tracing, root cause |
| `service-mismatch.yaml` | Bulk Tank | Tank monitor service failure after "v2 upgrade" | Endpoint/selector analysis |

## Common Operations

### Dev Container Commands
Type `menu` in the terminal to see all available commands. Key shortcuts:
- `deploy` - Deploy infrastructure
- `destroy` - Tear down infrastructure  
- `site` - Show customer portal URL
- `kgp` - Get pods in propane namespace
- `break-oom`, `break-crash`, `break-image` - Apply scenarios
- `break-mongodb` - Cascading database failure
- `break-service` - Silent networking failure
- `fix-all` - Restore healthy state

### Deploy Infrastructure
```powershell
.\scripts\deploy.ps1 -Location eastus2 -Yes
```

### SRE Agent Deployment
SRE Agent is now deployed automatically via Bicep (`Microsoft.App/agents@2025-05-01-preview`).
Set `deploySreAgent = true` in parameters (default). To manage the agent after deployment:
- Portal: https://aka.ms/sreagent/portal
- The deploying user is automatically assigned SRE Agent Administrator role

### Apply Breakable Scenario
```bash
kubectl apply -f k8s/scenarios/oom-killed.yaml
```

### Restore Healthy State
```bash
kubectl apply -f k8s/base/application.yaml
```

### Destroy Infrastructure
```powershell
.\scripts\destroy.ps1 -ResourceGroupName "rg-srelab-eastus2"
```

## Important Constraints

1. **SRE Agent Regions**: Only deploy to eastus2, swedencentral, or australiaeast
2. **AKS Networking**: Must NOT be private cluster for SRE Agent access
3. **Authentication**: Use device code auth in dev containers (`az login --use-device-code`)
4. **RBAC**: Some role assignments may fail due to subscription policies - use scripts
5. **No SAS Tokens**: Use Workload Identity instead of connection strings where possible

## Cost Considerations

- **Full deployment**: ~$22-28/day (~$650-850/month)
- **With SRE Agent**: ~$32-38/day (~$950-1,150/month)
- **See**: `docs/COSTS.md` for detailed breakdown

## When Helping with This Project

1. **For Bicep changes**: Follow best practices in `infra/bicep/` patterns
2. **For K8s manifests**: Use namespace `propane`, label with `sre-demo: breakable`
3. **For scripts**: Use PowerShell, include error handling, support `-WhatIf`
4. **For docs**: Keep formatting consistent, include code examples
5. **For new scenarios**: Add to `k8s/scenarios/` and update `docs/BREAKABLE-SCENARIOS.md`
6. **For domain vocabulary**: Never mix Bulk Tank terms (gallons, tank percentage) with Cylinder Exchange terms (full/empty/reserved cylinder counts, cage) in the same UI section or metric. Tag new content with an explicit `Domain:` marker and run `scripts/validate-domain-terminology.ps1` before committing.
