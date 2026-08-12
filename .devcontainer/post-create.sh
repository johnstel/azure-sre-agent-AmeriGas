#!/bin/bash
# =============================================================================
# Post-Create Script for Dev Container
# =============================================================================
# This script runs once when the dev container is created.
# It sets up the environment for Azure SRE Agent demo development.
# =============================================================================

set -e

echo "🔧 Setting up AmeriGas Propane SRE Demo Lab dev container..."

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

# AmeriGas Propane SRE Demo Lab aliases
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

# Break scenarios
alias break-oom='kubectl apply -f k8s/scenarios/oom-killed.yaml'
alias break-crash='kubectl apply -f k8s/scenarios/crash-loop.yaml'
alias break-image='kubectl apply -f k8s/scenarios/image-pull-backoff.yaml'
alias break-cpu='kubectl apply -f k8s/scenarios/high-cpu.yaml'
alias break-pending='kubectl apply -f k8s/scenarios/pending-pods.yaml'
alias break-probe='kubectl apply -f k8s/scenarios/probe-failure.yaml'
alias break-network='kubectl apply -f k8s/scenarios/network-block.yaml'
alias break-config='kubectl apply -f k8s/scenarios/missing-config.yaml'
alias break-mongodb='kubectl apply -f k8s/scenarios/mongodb-down.yaml'
alias break-service='kubectl apply -f k8s/scenarios/service-mismatch.yaml'

# Fix commands
alias fix-all='kubectl delete deployment safety-compliance-monitor -n propane --ignore-not-found 2>/dev/null || true; kubectl delete configmap tank-safety-alarm-config -n propane --ignore-not-found 2>/dev/null || true; kubectl apply -f k8s/base/application.yaml'
alias fix-network='kubectl delete networkpolicy deny-tank-monitor -n propane 2>/dev/null'
alias fix-extras='kubectl delete deployment demand-forecast-overload fleet-telemetry-monitor safety-compliance-monitor delivery-zone-config -n propane --ignore-not-found 2>/dev/null || true; kubectl delete configmap tank-safety-alarm-config -n propane --ignore-not-found 2>/dev/null || true'

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
# AmeriGas Propane SRE Demo Lab PowerShell Profile

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

function break-oom { kubectl apply -f k8s/scenarios/oom-killed.yaml }
function break-crash { kubectl apply -f k8s/scenarios/crash-loop.yaml }
function break-image { kubectl apply -f k8s/scenarios/image-pull-backoff.yaml }
function break-cpu { kubectl apply -f k8s/scenarios/high-cpu.yaml }
function break-pending { kubectl apply -f k8s/scenarios/pending-pods.yaml }
function break-probe { kubectl apply -f k8s/scenarios/probe-failure.yaml }
function break-network { kubectl apply -f k8s/scenarios/network-block.yaml }
function break-config { kubectl apply -f k8s/scenarios/missing-config.yaml }
function break-mongodb { kubectl apply -f k8s/scenarios/mongodb-down.yaml }
function break-service { kubectl apply -f k8s/scenarios/service-mismatch.yaml }
function fix-all {
    kubectl delete deployment safety-compliance-monitor -n propane --ignore-not-found 2>$null
    kubectl delete configmap tank-safety-alarm-config -n propane --ignore-not-found 2>$null
    kubectl apply -f k8s/base/application.yaml
}
function fix-network { kubectl delete networkpolicy deny-tank-monitor -n propane 2>$null }
function fix-extras {
    kubectl delete deployment demand-forecast-overload fleet-telemetry-monitor safety-compliance-monitor delivery-zone-config -n propane --ignore-not-found 2>$null
    kubectl delete configmap tank-safety-alarm-config -n propane --ignore-not-found 2>$null
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
║                    AmeriGas Propane SRE Demo Lab                                ║
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
