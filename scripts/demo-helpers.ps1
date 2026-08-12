<#
.SYNOPSIS
    AmeriGas Propane SRE Demo Lab - PowerShell helper functions.

.DESCRIPTION
    Dot-source this script to load all demo shortcut commands into your
    current PowerShell session:  . .\scripts\demo-helpers.ps1

.EXAMPLE
    . .\scripts\demo-helpers.ps1
    menu
    break-oom
    fix-all
#>

# Kubernetes shortcuts (default namespace: propane)
function kgp { kubectl get pods -n propane @args }
function kgs { kubectl get svc -n propane @args }
function kgd { kubectl get deployments -n propane @args }
function kgn { kubectl get namespaces @args }
function kge { kubectl get events -n propane --sort-by='.lastTimestamp' @args }
function kwatch { kubectl get pods -n propane -w @args }

# Deploy / destroy
function deploy {
    param([string]$Location = "eastus2")
    & pwsh -NoLogo -File "$PSScriptRoot\deploy.ps1" -Location $Location @args
}

function destroy {
    param([string]$ResourceGroupName)
    if ($ResourceGroupName) {
        & pwsh -NoLogo -File "$PSScriptRoot\destroy.ps1" -ResourceGroupName $ResourceGroupName @args
    } else {
        & pwsh -NoLogo -File "$PSScriptRoot\destroy.ps1" @args
    }
}

# Break scenarios
function break-oom { kubectl apply -f "$PSScriptRoot\..\k8s\scenarios\oom-killed.yaml" }
function break-crash { kubectl apply -f "$PSScriptRoot\..\k8s\scenarios\crash-loop.yaml" }
function break-image { kubectl apply -f "$PSScriptRoot\..\k8s\scenarios\image-pull-backoff.yaml" }
function break-cpu { kubectl apply -f "$PSScriptRoot\..\k8s\scenarios\high-cpu.yaml" }
function break-pending { kubectl apply -f "$PSScriptRoot\..\k8s\scenarios\pending-pods.yaml" }
function break-probe { kubectl apply -f "$PSScriptRoot\..\k8s\scenarios\probe-failure.yaml" }
function break-network { kubectl apply -f "$PSScriptRoot\..\k8s\scenarios\network-block.yaml" }
function break-config { kubectl apply -f "$PSScriptRoot\..\k8s\scenarios\missing-config.yaml" }
function break-mongodb { kubectl apply -f "$PSScriptRoot\..\k8s\scenarios\mongodb-down.yaml" }
function break-service { kubectl apply -f "$PSScriptRoot\..\k8s\scenarios\service-mismatch.yaml" }

# Fix commands
function ensure-credentials {
    <#
    .SYNOPSIS
        Ensures the rabbitmq-credentials Kubernetes Secret exists in the propane namespace.
        Creates the secret with demo defaults if it does not already exist.
        For production-grade randomized credentials, use deploy.ps1 instead.
    #>
    $null = kubectl get secret rabbitmq-credentials -n propane --output=name 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  🔐 Creating demo RabbitMQ credentials secret..." -ForegroundColor Yellow
        Write-Host "     ⚠️  Using default DEMO credentials. Run deploy.ps1 for randomized credentials." -ForegroundColor Gray
        $demoUser = 'amerigas-rmq'
        $demoPass = 'Amg!P3#rMQ@xDm09'
        $demoUserEscaped = [System.Uri]::EscapeDataString($demoUser)
        $demoPassEscaped = [System.Uri]::EscapeDataString($demoPass)
        $demoUri  = "amqp://${demoUserEscaped}:${demoPassEscaped}@rabbitmq:5672/"
        kubectl create secret generic rabbitmq-credentials `
            --namespace propane `
            --from-literal="username=${demoUser}" `
            --from-literal="password=${demoPass}" `
            --from-literal="uri=${demoUri}" 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  ✅ RabbitMQ credentials secret created" -ForegroundColor Green
        }
        else {
            Write-Host "  ⚠️  Could not create credentials secret (namespace may not exist yet — it will be created by application.yaml)" -ForegroundColor Yellow
        }
    }
}

function fix-all {
    # Ensure the propane namespace exists so the Secret can be created before pods start
    kubectl create namespace propane --dry-run=client -o yaml | kubectl apply -f - 2>$null
    # Ensure credentials secret exists (preserves any generated credentials from deploy.ps1)
    ensure-credentials
    # Apply the full application manifest
    kubectl apply -f "$PSScriptRoot\..\k8s\base\application.yaml"
}
function fix-network { kubectl delete networkpolicy deny-tank-monitor -n propane 2>$null }
function fix-extras { kubectl delete deployment demand-forecast-overload fleet-telemetry-monitor safety-compliance-monitor delivery-zone-config -n propane 2>$null }

# Site URL
function site {
    $ip = kubectl get svc customer-portal -n propane -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>$null
    if ($ip) { Write-Host "Customer Portal: http://$ip" -ForegroundColor Green }
    else { Write-Host "Customer Portal IP not ready yet..." -ForegroundColor Yellow }
}

# SRE Agent portal
function sre-agent {
    Write-Host "SRE Agent Portal: https://aka.ms/sreagent/portal" -ForegroundColor Cyan
}

# Mission Control — local operations dashboard with Copilot SDK
function mission-control {
    param([int]$Port = 3000)
    Push-Location "$PSScriptRoot\..\tools\mission-control"
    try {
        if (-not (Test-Path "node_modules")) {
            Write-Host "  📦 Installing dependencies..." -ForegroundColor Yellow
            npm install --quiet 2>$null
        }
        Write-Host "  🔥 Starting Mission Control on port $Port..." -ForegroundColor Cyan
        $env:PORT = $Port
        node server.js
    } finally {
        Pop-Location
    }
}

# Menu / help
function menu {
    Write-Host @"

╔══════════════════════════════════════════════════════════════════════════════╗
║                    AmeriGas Propane SRE Demo Lab                             ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  Commands:                                                                   ║
║    az login --use-device-code  - Login to Azure                              ║
║    deploy                      - Deploy the infrastructure                   ║
║    destroy                     - Tear down the infrastructure                ║
║    site                        - Show the customer portal URL                ║
║    sre-agent                   - Show SRE Agent portal URL                   ║
║    mission-control             - Launch Mission Control + Copilot AI         ║
║    menu                        - Show this help menu                         ║
║                                                                              ║
║  Kubernetes Shortcuts (default namespace: propane):                           ║
║    kgp, kgs, kgd               - Get pods/services/deployments               ║
║    kge                         - Get recent events                           ║
║    kwatch                      - Watch pods live                             ║
║                                                                              ║
║  Break Scenarios:                                                            ║
║    break-oom                   - OOMKilled (tank-monitor)                    ║
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

# Show menu on load
menu
