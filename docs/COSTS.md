# Cost Estimation Guide

This document provides estimated costs for running the Azure SRE Agent ZavaGas Propane Demo Lab.

> **Note:** Costs are estimates based on US East 2 region pay-as-you-go pricing as of April 2026. Actual costs may vary based on region, usage patterns, and Azure pricing changes. All resources are tagged with `SecurityControl=Ignore`.

## Quick Cost Summary

| Component | SKU / Size | Daily Cost | Monthly Cost |
|-----------|-----------|------------|--------------|
| **AKS Control Plane** | Standard tier (Uptime SLA) | ~$2.40 | ~$73 |
| **AKS System Nodes** | 2× Standard_D2s_v5 | ~$4.61 | ~$140 |
| **AKS User Nodes** | 3× Standard_D2s_v5 | ~$6.91 | ~$210 |
| **Container Registry** | Basic | ~$0.17 | ~$5 |
| **Log Analytics + Container Insights** | PerGB2018, ~2–4 GB/day | ~$5.50–11.00 | ~$165–330 |
| **Application Insights** | Workspace-based (included in LA) | — | — |
| **Managed Grafana** | Standard | ~$2.40 | ~$73 |
| **Azure Monitor / Prometheus** | Ingestion-based | ~$1–2 | ~$30–60 |
| **Azure Data Explorer** | Dev(No SLA)_E2a_v4, auto-stop | ~$2–7 | ~$60–210 |
| **Key Vault** | Standard | ~$0.01 | ~$0.30 |
| **Managed Disks** | MongoDB 8Gi + RabbitMQ 2Gi (SSD) | ~$0.10 | ~$3 |
| **VNet** | — | Free | Free |
| **SRE Agent** | Preview (AAU-based) | ~$10–15 | ~$300–450 |
| | | | |
| **Total (without SRE Agent)** | | **~$25–35** | **~$750–1,050** |
| **Total (with SRE Agent)** | | **~$35–50** | **~$1,050–1,500** |

## What Gets Deployed

### Always Deployed (core infrastructure)

| Resource | Type | Bicep Module |
|----------|------|-------------|
| Resource Group | Microsoft.Resources/resourceGroups | main.bicep |
| Virtual Network | Microsoft.Network/virtualNetworks | modules/network.bicep |
| AKS Cluster | Microsoft.ContainerService/managedClusters | modules/aks.bicep |
| Container Registry | Microsoft.ContainerRegistry/registries | modules/container-registry.bicep |
| Log Analytics Workspace | Microsoft.OperationalInsights/workspaces | modules/log-analytics.bicep |
| Application Insights | Microsoft.Insights/components | modules/app-insights.bicep |
| Key Vault | Microsoft.KeyVault/vaults | modules/key-vault.bicep |

### Conditionally Deployed (default ON)

| Resource | Param | Default | Bicep Module |
|----------|-------|---------|-------------|
| Managed Grafana + Prometheus | `deployObservability` | `true` | modules/observability.bicep |
| Azure Data Explorer | `deployDataExplorer` | `true` | modules/data-explorer.bicep |
| SRE Agent | `deploySreAgent` | `true` | modules/sre-agent.bicep |

### Conditionally Deployed (default OFF)

| Resource | Param | Default | Bicep Module |
|----------|-------|---------|-------------|
| Alert Rules | `deployAlerts` | `false` | modules/alerts.bicep |
| Action Group | `deployActionGroup` | `false` | modules/action-group.bicep |

## Detailed Cost Breakdown

### Azure Kubernetes Service (AKS)

#### Control Plane

| Tier | Cost | Notes |
|------|------|-------|
| Free | $0/month | No SLA, limited features |
| **Standard** | **$73/month** | **Deployed by default** — Uptime SLA |
| Premium | $438/month | LTS support |

#### Node Pools

| Pool | VM Size | vCPU | RAM | Count | Autoscale | Cost/VM/month | Pool Total |
|------|---------|------|-----|-------|-----------|---------------|------------|
| System | Standard_D2s_v5 | 2 | 8 GB | 2 | 1–5 | ~$70 | ~$140 |
| User (workload) | Standard_D2s_v5 | 2 | 8 GB | 3 | 1–10 | ~$70 | ~$210 |

System pool has `CriticalAddonsOnly=true:NoSchedule` taint. All application pods schedule on the user pool.

### Log Analytics + Container Insights

| Component | Pricing |
|-----------|---------|
| Data ingestion | $2.76/GB (PerGB2018) |
| First 5 GB/day | Free (per-subscription allowance) |
| Retention | 30 days included, additional $0.10/GB/month |

**Expected ingestion:** 2–4 GB/day from Container Insights (ContainerLogV2, KubeEvents, KubePodInventory, perf counters) + OTel Collector stdout.

### Application Insights

Workspace-based — ingestion is billed through the Log Analytics workspace above. The 90-day retention is included. No separate charge beyond LA ingestion.

### Azure Data Explorer (ADX)

| Component | Detail | Cost |
|-----------|--------|------|
| Cluster SKU | Dev(No SLA)_Standard_E2a_v4 | ~$0.294/hr when running |
| Auto-stop | Enabled (stops after 1hr idle) | Saves ~70% if used only during demos |
| Database | PropaneLogs (10-day retention, 5-day hot cache) | Included |
| Data source | Log Analytics export (ContainerLogV2, KubeEvents, KubePodInventory) | Included |

**Daily cost:** ~$2/day (demo use with auto-stop) to ~$7/day (always running).

### Managed Grafana + Prometheus

| Component | Cost |
|-----------|------|
| Azure Managed Grafana (Standard) | ~$0.10/hr = ~$73/month |
| Azure Monitor Workspace | Free (workspace itself) |
| Prometheus metrics ingestion | ~$0.18/million samples |

**Expected:** ~$3–4/day combined.

### Azure SRE Agent

SRE Agent is billed via Azure AI Units (AAU):

| Component | Calculation | Cost |
|-----------|-------------|------|
| Base compute | 4 AAU × 730 hours × $0.10 | ~$292/month |
| Execution tasks | Variable based on prompts/diagnosis | ~$30–150/month |

**Note:** SRE Agent is in Preview. Pricing may change. Mode is set to `Review` (requires approval for actions). Access level is `High` (full read + limited write).

### Key Vault

| Operation | Price |
|-----------|-------|
| Secrets operations | $0.03/10,000 |
| Soft delete retention | 7 days |

Negligible cost for demo workloads (~$0.30/month).

### Container Registry

| SKU | Storage | Cost |
|-----|---------|------|
| **Basic** (deployed) | 10 GB included | $5/month |
| Standard | 100 GB | $20/month |

Basic is sufficient — demo uses public images from `ghcr.io/azure-samples/aks-store-demo`.

## Cost by Configuration

### Minimal (~$18–22/day, ~$540–660/month)

```
deployObservability = false
deployDataExplorer  = false
deploySreAgent      = false
```

AKS + ACR + Log Analytics + App Insights + Key Vault only.

### Standard (~$25–35/day, ~$750–1,050/month)

```
deployObservability = true
deployDataExplorer  = true
deploySreAgent      = false
```

Full observability stack without SRE Agent.

### Full Demo (~$35–50/day, ~$1,050–1,500/month)

```
deployObservability = true   (default)
deployDataExplorer  = true   (default)
deploySreAgent      = true   (default)
```

Everything enabled — recommended for customer demos.

## Cost Optimization Strategies

### Deploy/Destroy Pattern (Recommended for Demos)

Deploy before a demo, destroy after. A 4-hour demo session costs ~$6–8.

```powershell
# Deploy
.\scripts\deploy.ps1 -Location eastus2 -Yes

# Destroy after demo
.\scripts\destroy.ps1 -ResourceGroupName "rg-srelab-eastus2"
```

### Scale Down Between Demos

```powershell
# Scale user pool to 1 node
az aks nodepool scale --resource-group rg-srelab-eastus2 `
    --cluster-name aks-srelab --name workload --node-count 1

# ADX auto-stops after 1 hour idle (no action needed)
```

### Disable Optional Components

```
deployObservability = false   # saves ~$3–4/day
deployDataExplorer  = false   # saves ~$2–7/day
deploySreAgent      = false   # saves ~$10–15/day
```

### For Sustained Usage

| Strategy | Savings |
|----------|---------|
| 1-year Reserved Instances (VMs) | ~31% |
| 3-year Reserved Instances (VMs) | ~53% |
| Azure Savings Plans | 15–30% on compute |
| AMD VMs (Standard_D2as_v5) | ~10% vs Intel |

## Monitoring Costs

1. Go to **Cost Management + Billing** in Azure Portal
2. Filter by resource group `rg-srelab-*`
3. Set up a **Budget** with email alerts at 50%, 75%, 100%

```powershell
az consumption budget create `
    --budget-name "sre-demo-budget" `
    --amount 500 `
    --time-grain Monthly `
    --category Cost `
    --resource-group rg-srelab-eastus2
```

## Biggest Cost Drivers

1. **AKS Nodes** (~$11.50/day) — 5 VMs running 24/7
2. **SRE Agent** (~$10–15/day) — AAU-based billing
3. **Log Analytics ingestion** (~$5.50–11/day) — Container Insights volume
4. **ADX Cluster** (~$2–7/day) — Dev SKU, mitigated by auto-stop
5. **Managed Grafana** (~$2.40/day) — Standard tier

**Bottom line:** Destroy resources when not demoing. A single demo day costs ~$35–50. Leaving it running for a month costs ~$1,050–1,500.
