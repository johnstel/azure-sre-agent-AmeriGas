# Azure SRE Agent AmeriGas Propane Demo Lab 🔥

A fully automated Azure environment for demonstrating **Azure SRE Agent** capabilities using an **AmeriGas Propane Distribution Platform**. Deploy a breakable multi-service propane distribution application on AKS and let SRE Agent diagnose and fix the issues!

## 🎯 What This Lab Provides

- **Azure Kubernetes Service (AKS)** with a multi-pod propane distribution platform
- **10 breakable scenarios** for demonstrating SRE Agent diagnosis
- **Azure SRE Agent** deployed automatically via Bicep for AI-powered diagnostics
- **Full observability stack**: Log Analytics, Application Insights, Managed Grafana
- **Ready-to-use scripts** for deployment and teardown
- **Dev container** for consistent development experience

## 🔥 AmeriGas Propane Architecture

The platform simulates a retail propane distributor with propane distribution and customer services:

| Service | Role | Technology |
|---------|------|------------|
| **customer-portal** | Customer portal (account, deliveries, tank levels) | Vue.js |
| **dispatch-console** | Operations console for fleet & orders | Vue.js |
| **tank-monitor** | IoT tank level monitoring & refill alerts | Node.js |
| **inventory-service** | Propane inventory, pricing, product catalog | Rust |
| **order-service** | Order fulfillment & processing | Go |
| **usage-simulator** | Customer propane usage pattern generator | Python |
| **rabbitmq** | Event bus (tank alerts, delivery orders, fulfillment updates) | RabbitMQ |
| **mongodb** | Tank readings, delivery records, customer data | MongoDB |

## 🚀 Quick Start

### Prerequisites

- Azure subscription with Owner/Contributor access
- Azure region supporting SRE Agent: `East US 2`, `Sweden Central`, or `Australia East`
- [Azure CLI](https://docs.microsoft.com/cli/azure/install-azure-cli) installed
- [VS Code](https://code.visualstudio.com/) with [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) (optional but recommended)

![Menu](media/menu.png)

### Deploy

```powershell
# 1. Login to Azure
az login --use-device-code

# 2. Deploy infrastructure (~15-25 minutes)
.\scripts\deploy.ps1 -Location eastus2 -Yes
```

> 💡 **Tip**: Type `menu` in the terminal to see all available commands including break scenarios, fix commands, and kubectl shortcuts.

## 💥 Breaking Things (The Fun Part!)

Once deployed, you can break the application using shortcut commands:

```bash
# Tank monitor memory exhaustion during winter peak
break-oom

# Inventory service crash — invalid pricing config
break-crash

# Order service deployment failure — bad image release
break-image

# See all scenarios
menu
```

To restore:
```bash
fix-all
```

## 🤖 Using SRE Agent

After deployment:

1. **Open the SRE Agent Portal** — the URL is displayed in deployment output, or visit [aka.ms/sreagent/portal](https://aka.ms/sreagent/portal)
2. **Connect it to your resources** (AKS, Log Analytics)
3. **Ask it to diagnose**:
   - "Why are pods crashing in the propane namespace?"
   - "Tank level data isn't being processed — what's wrong?"
   - "What's causing high CPU on the demand forecast pods?"

See [docs/SRE-AGENT-SETUP.md](docs/SRE-AGENT-SETUP.md) for detailed instructions, or [docs/PROMPTS-GUIDE.md](docs/PROMPTS-GUIDE.md) for a full catalog of prompts to try.

## 💰 Cost Estimate

| Configuration | Daily Cost | Monthly Cost |
|--------------|------------|--------------|
| Default deployment | ~$22-28 | ~$650-850 |
| + SRE Agent | ~$32-38 | ~$950-1,150 |

See [docs/COSTS.md](docs/COSTS.md) for detailed breakdown and optimization tips.

## 🔧 Available Scenarios

| Scenario | AmeriGas Narrative | SRE Agent Diagnoses |
|----------|-------------------|---------------------|
| OOMKilled | Tank monitor overwhelmed by winter peak readings | Memory exhaustion, limit recommendations |
| CrashLoop | Inventory service crashes — invalid pricing config | Exit codes, log analysis |
| ImagePullBackOff | Order service fails after botched image release | Registry/image troubleshooting |
| HighCPU | Demand forecast overload during peak heating season | Performance analysis |
| PendingPods | Fleet telemetry monitor pods can't schedule | Scheduling analysis |
| ProbeFailure | Safety compliance monitor misconfigured after maintenance | Probe configuration |
| NetworkBlock | Tank monitor isolated after security policy update | Connectivity analysis |
| MissingConfig | Delivery zone configuration missing after promotion | Configuration troubleshooting |
| MongoDBDown | Tank database offline — cascading order failure | Dependency tracing, root cause |
| ServiceMismatch | Tank monitor service failure after "v2 upgrade" | Endpoint/selector analysis |

## 🛠️ Commands Reference

### Deployment Scripts (PowerShell)

> **Note**: These PowerShell scripts deploy to Azure and can be run from the dev container, locally on Windows, or on any system with PowerShell Core installed.

| Command | Description |
|---------|-------------|
| `.\scripts\deploy.ps1 -Location eastus2` | Deploy all infrastructure to Azure |
| `.\scripts\deploy.ps1 -WhatIf` | Preview what would be deployed |
| `.\scripts\validate-deployment.ps1 -ResourceGroupName <rg>` | Verify resources and app are healthy |
| `.\scripts\destroy.ps1 -ResourceGroupName <rg>` | Tear down all infrastructure |

**Deploy script parameters:**
- `-Location`: Azure region (`eastus2`, `swedencentral`, `australiaeast`) - Default: `eastus2`
- `-WorkloadName`: Resource prefix - Default: `srelab`
- `-SkipRbac`: Skip RBAC assignments if subscription policies block them
- `-WhatIf`: Preview deployment without making changes
- `-Yes`: Skip confirmation prompts (non-interactive mode)

### Kubernetes Commands (kubectl)

| Command | Description |
|---------|-------------|
| `kubectl apply -f k8s/base/application.yaml` | Deploy healthy application |
| `kubectl apply -f k8s/scenarios/<scenario>.yaml` | Apply a break scenario |
| `kubectl get pods -n propane` | Check pod status |
| `kubectl get events -n propane --sort-by='.lastTimestamp'` | View recent events |

## 📚 Documentation

- [SRE Agent Setup Guide](docs/SRE-AGENT-SETUP.md)
- [Prompts Guide](docs/PROMPTS-GUIDE.md)
- [Breakable Scenarios Guide](docs/BREAKABLE-SCENARIOS.md)
- [Cost Estimation](docs/COSTS.md)

## 🤝 Contributing

Contributions welcome! Feel free to open issues or submit PRs.

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

---

**⚠️ Important Notes:**

- SRE Agent is currently in **Preview**
- Only available in **East US 2**, **Sweden Central**, and **Australia East**
- AKS cluster must **NOT** be a private cluster for SRE Agent to access
- Firewall must allow `*.azuresre.ai`