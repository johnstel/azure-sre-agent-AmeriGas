#!/bin/bash
# =============================================================================
# Post-Create Script for Dev Container
# =============================================================================
# This script runs once when the dev container is created.
# It sets up the environment for Azure SRE Agent demo development.
# =============================================================================

set -e

echo "🔧 Setting up ZavaGas Propane SRE Demo Lab dev container..."

# Install additional tools
echo "📦 Installing additional tools..."

# kubelogin for Azure AD authentication to AKS
curl -LO "https://github.com/Azure/kubelogin/releases/latest/download/kubelogin-linux-amd64.zip"
unzip -o kubelogin-linux-amd64.zip -d /tmp
sudo mv /tmp/bin/linux_amd64/kubelogin /usr/local/bin/
rm -f kubelogin-linux-amd64.zip

# k9s - Kubernetes CLI dashboard
curl -LO https://github.com/derailed/k9s/releases/latest/download/k9s_Linux_amd64.tar.gz
tar xzf k9s_Linux_amd64.tar.gz -C /tmp
sudo mv /tmp/k9s /usr/local/bin/
rm -f k9s_Linux_amd64.tar.gz

# kubectx and kubens for context switching
sudo git clone https://github.com/ahmetb/kubectx /opt/kubectx 2>/dev/null || true
sudo ln -sf /opt/kubectx/kubectx /usr/local/bin/kubectx
sudo ln -sf /opt/kubectx/kubens /usr/local/bin/kubens

# Configure Git
echo "⚙️ Configuring Git..."
git config --global init.defaultBranch main
git config --global core.autocrlf input

# Set up Azure CLI defaults for device code authentication
echo "🔐 Configuring Azure CLI for device code authentication..."
mkdir -p ~/.azure
cat > ~/.azure/config << 'EOF'
[core]
collect_telemetry = yes
first_run = no

[defaults]
# Use device code authentication by default (works in containers/codespaces)
# Set AZURE_CLI_USE_DEVICE_CODE=true in environment or use --use-device-code flag

[cloud]
name = AzureCloud
EOF

# Create helpful aliases
echo "📝 Setting up shell aliases..."
cat >> ~/.bashrc << 'EOF'

# ZavaGas Propane SRE Demo Lab aliases
alias k='kubectl'
alias kgp='kubectl get pods -n propane'
alias kgs='kubectl get svc -n propane'
alias kgd='kubectl get deployments -n propane'
alias kgn='kubectl get namespaces'
alias kd='kubectl describe'
alias kl='kubectl logs'
alias ke='kubectl exec -it'
alias kctx='kubectx'
alias kns='kubens'

# Azure aliases
alias azlogin='az login --use-device-code'
alias azwho='az account show'
alias azsub='az account list -o table'

# Demo shortcuts
alias deploy='pwsh ./scripts/deploy.ps1'
alias destroy='pwsh ./scripts/destroy.ps1'

# Break scenarios / start/reset lifecycle
alias break-oom='pwsh -NoLogo -NoProfile -Command ". ./scripts/demo-helpers.ps1; Start-DemoScenario -Id oom"'
alias break-crash='pwsh -NoLogo -NoProfile -Command ". ./scripts/demo-helpers.ps1; Start-DemoScenario -Id crash"'
alias break-image='pwsh -NoLogo -NoProfile -Command ". ./scripts/demo-helpers.ps1; Start-DemoScenario -Id image"'
alias break-cpu='pwsh -NoLogo -NoProfile -Command ". ./scripts/demo-helpers.ps1; Start-DemoScenario -Id cpu"'
alias break-pending='pwsh -NoLogo -NoProfile -Command ". ./scripts/demo-helpers.ps1; Start-DemoScenario -Id pending"'
alias break-probe='pwsh -NoLogo -NoProfile -Command ". ./scripts/demo-helpers.ps1; Start-DemoScenario -Id probe"'
alias break-backlog='pwsh -NoLogo -NoProfile -Command ". ./scripts/demo-helpers.ps1; Start-DemoScenario -Id backlog"'
alias break-network='pwsh -NoLogo -NoProfile -Command ". ./scripts/demo-helpers.ps1; Start-DemoScenario -Id network"'
alias break-config='pwsh -NoLogo -NoProfile -Command ". ./scripts/demo-helpers.ps1; Start-DemoScenario -Id config"'
alias break-mongodb='pwsh -NoLogo -NoProfile -Command ". ./scripts/demo-helpers.ps1; Start-DemoScenario -Id mongodb"'
alias break-service='pwsh -NoLogo -NoProfile -Command ". ./scripts/demo-helpers.ps1; Start-DemoScenario -Id service"'

# Fix commands / reset workflow
alias fix-all='pwsh -NoLogo -NoProfile -Command ". ./scripts/demo-helpers.ps1; Reset-DemoBaseline -Scope all"'
alias fix-network='pwsh -NoLogo -NoProfile -Command ". ./scripts/demo-helpers.ps1; Reset-DemoBaseline -Scope network"'
alias fix-extras='pwsh -NoLogo -NoProfile -Command ". ./scripts/demo-helpers.ps1; Reset-DemoBaseline -Scope extras"'

# Site URL command
alias site='echo "Customer Portal: http://$(kubectl get svc customer-portal -n propane -o jsonpath="{.status.loadBalancer.ingress[0].ip}" 2>/dev/null || echo "pending...")"'
# SRE Agent portal
alias sre-agent='echo "SRE Agent Portal: https://aka.ms/sreagent/portal"'
# Helpful functions
function kwatch() {
    kubectl get pods -n ${1:-propane} -w
}

function klogs() {
    kubectl logs -n ${2:-propane} -l app=$1 -f
}
EOF

# Same for PowerShell
mkdir -p ~/.config/powershell
cat > ~/.config/powershell/Microsoft.PowerShell_profile.ps1 << 'EOF'
# ZavaGas Propane SRE Demo Lab PowerShell Profile

# Aliases
Set-Alias -Name k -Value kubectl

# Functions
function kgp { kubectl get pods -n propane @args }
function kgs { kubectl get svc -n propane @args }
function kgd { kubectl get deployments -n propane @args }
function kgn { kubectl get namespaces @args }

# Demo commands
function deploy { 
    param([string]$Location = "eastus2")
    & pwsh -File "./scripts/deploy.ps1" -Location $Location @args 
}

function destroy {
    param([string]$ResourceGroupName)
    if ($ResourceGroupName) {
        & pwsh -File "./scripts/destroy.ps1" -ResourceGroupName $ResourceGroupName @args
    } else {
        & pwsh -File "./scripts/destroy.ps1" @args
    }
}

function break-oom { . ./scripts/demo-helpers.ps1; Start-DemoScenario -Id oom }
function break-crash { . ./scripts/demo-helpers.ps1; Start-DemoScenario -Id crash }
function break-image { . ./scripts/demo-helpers.ps1; Start-DemoScenario -Id image }
function break-cpu { . ./scripts/demo-helpers.ps1; Start-DemoScenario -Id cpu }
function break-pending { . ./scripts/demo-helpers.ps1; Start-DemoScenario -Id pending }
function break-probe { . ./scripts/demo-helpers.ps1; Start-DemoScenario -Id probe }
function break-backlog { . ./scripts/demo-helpers.ps1; Start-DemoScenario -Id backlog }
function break-network { . ./scripts/demo-helpers.ps1; Start-DemoScenario -Id network }
function break-config { . ./scripts/demo-helpers.ps1; Start-DemoScenario -Id config }
function break-mongodb { . ./scripts/demo-helpers.ps1; Start-DemoScenario -Id mongodb }
function break-service { . ./scripts/demo-helpers.ps1; Start-DemoScenario -Id service }
function fix-all {
    . ./scripts/demo-helpers.ps1; Reset-DemoBaseline -Scope all
}
function fix-network { . ./scripts/demo-helpers.ps1; Reset-DemoBaseline -Scope network }
function fix-extras {
    . ./scripts/demo-helpers.ps1; Reset-DemoBaseline -Scope extras
}

# Site URL command  
function site { 
    $ip = kubectl get svc customer-portal -n propane -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>$null
    if ($ip) { Write-Host "Customer Portal: http://$ip" -ForegroundColor Green } 
    else { Write-Host "Customer Portal IP not ready yet..." -ForegroundColor Yellow }
}

# SRE Agent portal
function sre-agent {
    Write-Host "SRE Agent Portal: https://aka.ms/sreagent/portal" -ForegroundColor Cyan
}

# Menu/help function
function menu {
    Write-Host @"

╔══════════════════════════════════════════════════════════════════════════════╗
║                    ZavaGas Propane SRE Demo Lab                                 ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  Commands:                                                                   ║
║    az login --use-device-code  - Login to Azure                              ║
║    deploy                      - Deploy the infrastructure                   ║
║    destroy                     - Tear down the infrastructure                ║
║    site                        - Show the customer portal URL                 ║
║    sre-agent                   - Show SRE Agent portal URL                   ║
║    menu                        - Show this help menu                         ║
║                                                                              ║
║  Kubernetes Shortcuts (default namespace: propane):                            ║
║    kgp, kgs, kgd               - Get pods/services/deployments               ║
║                                                                              ║
║  Break Scenarios:                                                            ║
║    break-oom                   - OOMKilled (tank-monitor)                     ║
║    break-crash                 - CrashLoopBackOff (inventory-service)        ║
║    break-image                 - ImagePullBackOff (order-service)            ║
║    break-cpu                   - High CPU (demand forecast overload)         ║
║    break-pending               - Pending pods (fleet telemetry monitor)      ║
║    break-probe                 - Bulk Tank safety alarm                     ║
║    break-backlog               - RabbitMQ refill backlog + DLQ             ║
║    break-network               - Network policy blocking                     ║
║    break-config                - Missing ConfigMap                           ║
║    break-mongodb               - MongoDB down (cascading failure)            ║
║    break-service               - Service selector mismatch                   ║
║                                                                              ║
║  Fix Commands:                                                               ║
║    fix-all                     - Restore all services to healthy state       ║
║    fix-network                 - Remove network policy                       ║
║    fix-extras                  - Delete extra broken deployments             ║
║                                                                              ║
║  Documentation: docs/                                                        ║
╚══════════════════════════════════════════════════════════════════════════════╝

"@ -ForegroundColor Cyan
}

# Welcome message (calls menu)
menu
EOF

# Create kubectl completion
kubectl completion bash | sudo tee /etc/bash_completion.d/kubectl > /dev/null

echo "✅ Dev container setup complete!"
echo ""
echo "📋 Next steps:"
echo "   1. Run 'azlogin' to authenticate to Azure"
echo "   2. Run 'deploy' to deploy the infrastructure"
echo "   3. See docs/SRE-AGENT-SETUP.md for SRE Agent configuration"
