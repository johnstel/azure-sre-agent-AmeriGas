<#
.SYNOPSIS
    ZavaGas Propane SRE Demo Lab - PowerShell helper functions.

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

# Shared lifecycle implementation: use the same deterministic scenario engine
# that Mission Control calls instead of duplicating ad hoc cleanup logic here.
function Invoke-ScenarioLifecycle {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('start', 'reset')][string]$Operation,
        [string]$ScenarioId,
        [string]$Scope = 'all',
        [switch]$AllowStacking,
        [switch]$WhatIf,
        [string]$Namespace = 'propane'
    )

    $lifecycleScript = Join-Path $PSScriptRoot '..\tools\mission-control\scenario-lifecycle.js'
    $args = @($lifecycleScript, $Operation)
    if ($ScenarioId) { $args += @('--scenario-id', $ScenarioId) }
    if ($AllowStacking) { $args += '--allow-stacking' }
    if ($WhatIf) { $args += '--what-if' }
    if ($Namespace) { $args += @('--namespace', $Namespace) }
    if ($Scope) { $args += @('--scope', $Scope) }

    $raw = & node @args 2>&1
    $exitCode = $LASTEXITCODE
    if ($null -eq $raw) { $raw = @() }

    $jsonText = ($raw | Out-String).Trim()
    if (-not $jsonText) {
        throw "No JSON output received from scenario lifecycle: $Operation"
    }

    try {
        $result = $jsonText | ConvertFrom-Json -Depth 100
    }
    catch {
        throw "Scenario lifecycle returned invalid JSON for ${Operation}: ${jsonText}"
    }

    if ($exitCode -ne 0 -and -not $result.ok) {
        $result | Add-Member -NotePropertyName exitCode -NotePropertyValue $exitCode -Force
    }

    return $result
}

function Start-DemoScenario {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('oom','crash','image','cpu','pending','probe','backlog','latency','network','config','mongodb','service')]
        [string]$Id,
        [switch]$AllowStacking,
        [switch]$WhatIf
    )

    if ($WhatIfPreference) { $WhatIf = $true }
    $result = Invoke-ScenarioLifecycle -Operation 'start' -ScenarioId $Id -AllowStacking:$AllowStacking -WhatIf:$WhatIf

    if ($result.ok) {
        Write-Host "  ✅ Scenario '$($result.scenarioId)' activated successfully." -ForegroundColor Green
        if ($result.correlationId) { Write-Host "     Correlation ID: $($result.correlationId)" -ForegroundColor DarkGray }
        return $result
    }

    Write-Error $result.message
    return $result
}

function Reset-DemoBaseline {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [ValidateSet('all','network','extras')]
        [string]$Scope = 'all',
        [switch]$WhatIf
    )

    if ($WhatIfPreference) { $WhatIf = $true }
    $result = Invoke-ScenarioLifecycle -Operation 'reset' -Scope $Scope -WhatIf:$WhatIf

    if ($result.ok) {
        Write-Host "  ✅ Baseline reset verified (fingerprint: $($result.fingerprint.Substring(0,12)))." -ForegroundColor Green
        return $result
    }

    Write-Error $result.message
    return $result
}

# Break scenarios
function break-oom { Start-DemoScenario -Id 'oom' @args }
function break-crash { Start-DemoScenario -Id 'crash' @args }
function break-image { Start-DemoScenario -Id 'image' @args }
function break-cpu { Start-DemoScenario -Id 'cpu' @args }
function break-pending { Start-DemoScenario -Id 'pending' @args }
function break-probe { Start-DemoScenario -Id 'probe' @args }
function break-backlog { Start-DemoScenario -Id 'backlog' @args }
function break-latency { Start-DemoScenario -Id 'latency' @args }
function break-network { Start-DemoScenario -Id 'network' @args }
function break-config { Start-DemoScenario -Id 'config' @args }
function break-mongodb { Start-DemoScenario -Id 'mongodb' @args }
function break-service { Start-DemoScenario -Id 'service' @args }

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
        $demoUser = 'zavagas-rmq'
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
    [CmdletBinding(SupportsShouldProcess = $true)]
    param()
    Reset-DemoBaseline -Scope 'all' -WhatIf:$WhatIfPreference
}

function fix-network {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param()
    Reset-DemoBaseline -Scope 'network' -WhatIf:$WhatIfPreference
}

function fix-extras {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param()
    Reset-DemoBaseline -Scope 'extras' -WhatIf:$WhatIfPreference
}

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
║                    ZavaGas Propane SRE Demo Lab                              ║
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
║    break-backlog               - RabbitMQ refill backlog + DLQ             ║
║    break-network               - Network policy blocking                     ║
║    break-config                - Missing ConfigMap                           ║
║    break-mongodb               - MongoDB down (cascading failure)            ║
║    break-service               - Service selector mismatch                   ║
║    break-latency               - Dependency latency (SLO breach)             ║
║                                                                              ║
║  Scenario lifecycle:                                                         ║
║    Start-DemoScenario -Id <id> - Run a known scenario with baseline checks   ║
║    Reset-DemoBaseline          - Restore the healthy baseline deterministically ║
║    fix-all                     - Compatibility alias for Reset-DemoBaseline   ║
║    fix-network                 - Compatibility alias for reset scope network ║
║    fix-extras                  - Compatibility alias for reset scope extras  ║
║                                                                              ║
║  Documentation: docs/                                                        ║
╚══════════════════════════════════════════════════════════════════════════════╝

"@ -ForegroundColor Cyan
}

# Show menu on load
menu
