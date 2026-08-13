<#
.SYNOPSIS
    Deploys the Azure SRE Agent AmeriGas Propane Demo Lab infrastructure using Bicep.

.DESCRIPTION
    This script deploys all Azure infrastructure needed for the SRE Agent demo,
    including AKS, Container Registry, Key Vault, observability tools, and
    Azure SRE Agent (Microsoft.App/agents@2025-05-01-preview).
    It uses device code authentication by default for dev container support.

.PARAMETER Location
    Azure region for deployment. Must be an SRE Agent supported region.
    Valid values: eastus2, swedencentral, australiaeast

.PARAMETER WorkloadName
    Name prefix for resources. Default: srelab

.PARAMETER SkipRbac
    Skip RBAC role assignments (useful if subscription policies block them)

.PARAMETER SkipSreAgent
    Skip Azure SRE Agent deployment and deploy only the core lab infrastructure

.PARAMETER WhatIf
    Show what would be deployed without making changes

.EXAMPLE
    .\deploy.ps1 -Location eastus2

.EXAMPLE
    .\deploy.ps1 -Location eastus2 -WhatIf

.NOTES
    Author: Azure SRE Agent AmeriGas Propane Demo Lab
    Prerequisites: Azure CLI, Bicep CLI
#>

[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('eastus2', 'swedencentral', 'australiaeast')]
    [string]$Location = 'eastus2',

    [Parameter()]
    [ValidatePattern('^[a-z0-9](?:[a-z0-9-]{2,9})$')]
    [string]$WorkloadName = 'srelab',

    [Parameter()]
    [switch]$SkipRbac,

    [Parameter()]
    [switch]$SkipSreAgent,

    [Parameter()]
    [switch]$WhatIf,

    [Parameter()]
    [switch]$Yes,

    [Parameter()]
    [Alias('Demo')]
    [switch]$DeployDemoResponsePlan,

    [Parameter()]
    [switch]$AcceptSubscriptionScopeMonitoringRbac
)

$ErrorActionPreference = 'Stop'

function New-RandomPassword {
    <#
    .SYNOPSIS
        Generates a cryptographically random password suitable for use as a service credential.
    #>
    [CmdletBinding()]
    param(
        [int]$Length = 24
    )
    if ($Length -lt 4) {
        throw 'Password length must be at least 4 characters.'
    }

    $lower   = 'abcdefghijklmnopqrstuvwxyz'
    $upper   = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    $digits  = '0123456789'
    $special = '!@#%^&*'
    $all     = $lower + $upper + $digits + $special

    # Guarantee at least one character from each class
    $chars = New-Object char[] $Length
    $chars[0] = $lower[[System.Security.Cryptography.RandomNumberGenerator]::GetInt32($lower.Length)]
    $chars[1] = $upper[[System.Security.Cryptography.RandomNumberGenerator]::GetInt32($upper.Length)]
    $chars[2] = $digits[[System.Security.Cryptography.RandomNumberGenerator]::GetInt32($digits.Length)]
    $chars[3] = $special[[System.Security.Cryptography.RandomNumberGenerator]::GetInt32($special.Length)]

    for ($i = 4; $i -lt $Length; $i++) {
        $chars[$i] = $all[[System.Security.Cryptography.RandomNumberGenerator]::GetInt32($all.Length)]
    }

    for ($i = $chars.Length - 1; $i -gt 0; $i--) {
        $j = [System.Security.Cryptography.RandomNumberGenerator]::GetInt32($i + 1)
        $tmp = $chars[$i]
        $chars[$i] = $chars[$j]
        $chars[$j] = $tmp
    }

    return -join $chars
}

function Invoke-AzCliJson {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments
    )

    # Run command and capture all output
    $raw = & az @Arguments 2>&1 | Out-String
    $exitCode = $LASTEXITCODE

    if ($exitCode -ne 0) {
        return [pscustomobject]@{
            ExitCode = $exitCode
            Raw      = $raw
            Json     = $null
        }
    }

    # Extract JSON from output (skip any warning lines before the JSON)
    $jsonObjectStart = $raw.IndexOf('{')
    $jsonArrayStart = $raw.IndexOf('[')

    if ($jsonObjectStart -ge 0 -and $jsonArrayStart -ge 0) {
        $jsonStart = [Math]::Min($jsonObjectStart, $jsonArrayStart)
    }
    elseif ($jsonObjectStart -ge 0) {
        $jsonStart = $jsonObjectStart
    }
    elseif ($jsonArrayStart -ge 0) {
        $jsonStart = $jsonArrayStart
    }
    else {
        $jsonStart = -1
    }

    if ($jsonStart -ge 0) {
        $jsonContent = $raw.Substring($jsonStart)
    }
    else {
        $jsonContent = $raw
    }

    try {
        $json = $jsonContent | ConvertFrom-Json
    }
    catch {
        return [pscustomobject]@{
            ExitCode = $exitCode
            Raw      = $raw
            Json     = $null
        }
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Raw      = $raw
        Json     = $json
    }
}

function Get-ArmErrorMessages {
    [CmdletBinding()]
    param(
        [Parameter()]
        $ErrorObject
    )

    $messages = [System.Collections.Generic.List[string]]::new()

    function Add-ArmErrorMessage {
        param(
            [Parameter()]
            $Node
        )

        if ($null -eq $Node) {
            return
        }

        if ($Node -is [string]) {
            if (-not [string]::IsNullOrWhiteSpace($Node)) {
                [void]$messages.Add($Node.Trim())
            }
            return
        }

        if ($Node -is [System.Collections.IEnumerable] -and -not ($Node -is [string])) {
            foreach ($Item in $Node) {
                Add-ArmErrorMessage -Node $Item
            }
            return
        }

        $propertyNames = @($Node.PSObject.Properties.Name)
        if ($propertyNames -contains 'message' -and -not [string]::IsNullOrWhiteSpace($Node.message)) {
            $message = if ($propertyNames -contains 'code' -and -not [string]::IsNullOrWhiteSpace($Node.code)) {
                "[$($Node.code)] $($Node.message)"
            }
            else {
                [string]$Node.message
            }

            [void]$messages.Add($message.Trim())
        }

        if ($propertyNames -contains 'error' -and $null -ne $Node.error) {
            Add-ArmErrorMessage -Node $Node.error
        }

        if ($propertyNames -contains 'details' -and $null -ne $Node.details) {
            Add-ArmErrorMessage -Node $Node.details
        }
    }

    Add-ArmErrorMessage -Node $ErrorObject

    return @($messages | Select-Object -Unique)
}

function Write-ResourceGroupDeploymentFailureSummary {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ResourceGroupName,

        [Parameter(Mandatory)]
        [string]$DeploymentName,

        [Parameter()]
        [string]$Indent = '    '
    )

    $operations = Invoke-AzCliJson -Arguments @('deployment', 'operation', 'group', 'list', '--resource-group', $ResourceGroupName, '--name', $DeploymentName, '--output', 'json')
    if ($operations.ExitCode -ne 0 -or -not $operations.Json) {
        return
    }

    $failedOperations = @($operations.Json | Where-Object { $_.properties.provisioningState -eq 'Failed' })
    if ($failedOperations.Count -eq 0) {
        $deployment = Invoke-AzCliJson -Arguments @('deployment', 'group', 'show', '--resource-group', $ResourceGroupName, '--name', $DeploymentName, '--output', 'json')
        if ($deployment.ExitCode -ne 0 -or -not $deployment.Json -or -not $deployment.Json.properties.error) {
            return
        }

        $messages = @(Get-ArmErrorMessages -ErrorObject $deployment.Json.properties.error)
        if ($messages.Count -eq 0) {
            return
        }

        Write-Host "$Indent Nested deployment details for ${DeploymentName}:" -ForegroundColor Yellow
        foreach ($message in $messages) {
            Write-Host "$Indent   - $message" -ForegroundColor Yellow
        }
        return
    }

    Write-Host "$Indent Nested deployment failures for ${DeploymentName}:" -ForegroundColor Yellow
    foreach ($failedOperation in $failedOperations) {
        $targetResource = $failedOperation.properties.targetResource
        $targetType = if ($targetResource.resourceType) { $targetResource.resourceType } else { '<unknown-type>' }
        $targetName = if ($targetResource.resourceName) { $targetResource.resourceName } else { '<unknown-name>' }
        Write-Host "$Indent   - $targetType/$targetName" -ForegroundColor Yellow

        $messages = @(Get-ArmErrorMessages -ErrorObject $failedOperation.properties.statusMessage)
        foreach ($message in $messages) {
            Write-Host "$Indent     $message" -ForegroundColor Yellow
        }
    }
}

function Write-SubscriptionDeploymentFailureSummary {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DeploymentName,

        [Parameter()]
        [string]$ResourceGroupName
    )

    $operations = Invoke-AzCliJson -Arguments @('deployment', 'operation', 'sub', 'list', '--name', $DeploymentName, '--output', 'json')
    if ($operations.ExitCode -ne 0 -or -not $operations.Json) {
        return
    }

    $failedOperations = @($operations.Json | Where-Object { $_.properties.provisioningState -eq 'Failed' })
    if ($failedOperations.Count -eq 0) {
        return
    }

    Write-Host "`nFailed deployment operations:" -ForegroundColor Yellow
    foreach ($failedOperation in $failedOperations) {
        $targetResource = $failedOperation.properties.targetResource
        $targetType = if ($targetResource.resourceType) { $targetResource.resourceType } else { '<unknown-type>' }
        $targetName = if ($targetResource.resourceName) { $targetResource.resourceName } else { '<unknown-name>' }
        Write-Host "  • $targetType/$targetName" -ForegroundColor Yellow

        $messages = @(Get-ArmErrorMessages -ErrorObject $failedOperation.properties.statusMessage)
        foreach ($message in $messages) {
            Write-Host "    $message" -ForegroundColor Yellow
        }

        if ($ResourceGroupName -and $targetType -eq 'Microsoft.Resources/deployments' -and $targetName) {
            Write-ResourceGroupDeploymentFailureSummary -ResourceGroupName $ResourceGroupName -DeploymentName $targetName
        }
    }
}

function Get-DeletedKeyVaultConflict {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ResourceGroupName
    )

    $deployment = Invoke-AzCliJson -Arguments @('deployment', 'group', 'show', '--resource-group', $ResourceGroupName, '--name', 'deploy-keyvault', '--output', 'json')
    if ($deployment.ExitCode -ne 0 -or -not $deployment.Json -or -not $deployment.Json.properties.error) {
        return $null
    }

    $errorJson = $deployment.Json.properties.error | ConvertTo-Json -Depth 20
    if ($errorJson -notmatch 'already exists in deleted state') {
        return $null
    }

    $operations = Invoke-AzCliJson -Arguments @('deployment', 'operation', 'group', 'list', '--resource-group', $ResourceGroupName, '--name', 'deploy-keyvault', '--output', 'json')
    if ($operations.ExitCode -ne 0 -or -not $operations.Json) {
        return $null
    }

    $vaultOperation = @($operations.Json | Where-Object {
            $_.properties.targetResource.resourceType -eq 'Microsoft.KeyVault/vaults'
        } | Select-Object -First 1)

    if (-not $vaultOperation) {
        return $null
    }

    $vaultName = $vaultOperation.properties.targetResource.resourceName
    if ([string]::IsNullOrWhiteSpace($vaultName)) {
        return $null
    }

    return [pscustomobject]@{
        VaultName = $vaultName
    }
}

function Resolve-DeletedKeyVaultConflict {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$VaultName,

        [Parameter(Mandatory)]
        [string]$Location
    )

    Write-Host "`n🧹 Found soft-deleted Key Vault blocking redeploy: $VaultName" -ForegroundColor Yellow
    Write-Host "  Purging deleted Key Vault entry so the deployment can continue..." -ForegroundColor Gray

    $purgeOutput = & az keyvault purge --name $VaultName --location $Location 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        $deletedVaultCount = & az keyvault list-deleted --query "[?name=='$VaultName'] | length(@)" --output tsv 2>$null
        if ($purgeOutput -match 'DeletedVaultNotFound' -and $LASTEXITCODE -eq 0 -and $deletedVaultCount -eq '0') {
            Write-Host "  ℹ️  Deleted Key Vault entry is already gone. Waiting for Azure to release the name..." -ForegroundColor Yellow
            Start-Sleep -Seconds 20
            return $true
        }

        if (-not [string]::IsNullOrWhiteSpace($purgeOutput)) {
            Write-Host $purgeOutput.Trim() -ForegroundColor Red
        }
        return $false
    }

    $deadline = (Get-Date).AddMinutes(2)
    do {
        Start-Sleep -Seconds 5
        $deletedVaultCount = & az keyvault list-deleted --query "[?name=='$VaultName'] | length(@)" --output tsv 2>$null
        if ($LASTEXITCODE -eq 0 -and $deletedVaultCount -eq '0') {
            Write-Host "  ✅ Deleted Key Vault entry purged" -ForegroundColor Green
            Start-Sleep -Seconds 20
            return $true
        }
    } while ((Get-Date) -lt $deadline)

    Write-Host "  ⚠️  Purge request completed, but Azure has not removed the deleted vault entry yet." -ForegroundColor Yellow
    return $false
}

# API versions this repository's Bicep module (infra/bicep/modules/sre-agent.bicep)
# has been validated against, newest first. Get-SreAgentProviderStatus selects
# the first one the target subscription actually registers so the deployment
# is pinned to a specific, known-good schema rather than silently degrading
# to whatever the provider's mutable "defaultApiVersion" happens to be.
$script:SupportedSreAgentApiVersions = @('2026-01-01', '2025-05-01-preview')

function Get-SreAgentProviderStatus {
    [CmdletBinding()]
    param()

    $providerRaw = & az provider show --namespace Microsoft.App --output json 2>$null | Out-String
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($providerRaw)) {
        return [pscustomobject]@{
            RegistrationState = 'Unknown'
            HasAgentsResource = $false
            IsSupported       = $false
            SelectedApiVersion = ''
            AvailableApiVersions = @()
        }
    }

    try {
        $provider = $providerRaw | ConvertFrom-Json
    }
    catch {
        return [pscustomobject]@{
            RegistrationState = 'Unknown'
            HasAgentsResource = $false
            IsSupported       = $false
            SelectedApiVersion = ''
            AvailableApiVersions = @()
        }
    }

    $agentsResource = $provider.resourceTypes | Where-Object { $_.resourceType -eq 'agents' } | Select-Object -First 1
    $apiVersions = @()
    if ($agentsResource -and $agentsResource.apiVersions) {
        $apiVersions = @($agentsResource.apiVersions)
    }

    # Pick the newest apiVersion that BOTH the subscription registers AND this
    # module supports. Never fall back to an unvalidated apiVersion.
    $selected = $script:SupportedSreAgentApiVersions | Where-Object { $apiVersions -contains $_ } | Select-Object -First 1

    return [pscustomobject]@{
        RegistrationState     = $provider.registrationState
        HasAgentsResource     = $null -ne $agentsResource
        IsSupported           = [bool]$selected
        SelectedApiVersion    = if ($selected) { $selected } else { '' }
        AvailableApiVersions  = $apiVersions
    }
}

# Banner
Write-Host @"

╔══════════════════════════════════════════════════════════════════════════════╗
║                   AmeriGas Propane SRE Demo Lab Deployment                    ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  This script deploys:                                                        ║
║  • Azure Kubernetes Service (AKS) with propane distribution platform        ║
║  • Azure Container Registry                                                  ║
║  • Observability stack (Log Analytics, App Insights, Grafana)               ║
║  • Key Vault for secrets management                                         ║
║  • Azure SRE Agent for AI-powered diagnostics                               ║
╚══════════════════════════════════════════════════════════════════════════════╝

"@ -ForegroundColor Cyan

# Verify prerequisites
Write-Host "🔍 Checking prerequisites..." -ForegroundColor Yellow

# Check Azure CLI
try {
    $azVersion = & az version --output json | ConvertFrom-Json
    Write-Host "  ✅ Azure CLI version: $($azVersion.'azure-cli')" -ForegroundColor Green
}
catch {
    Write-Error "Azure CLI is not installed. Please install it from https://aka.ms/installazurecli"
    exit 1
}

# Check Bicep
try {
    $bicepVersion = & az bicep version 2>&1
    Write-Host "  ✅ Bicep: $bicepVersion" -ForegroundColor Green
}
catch {
    Write-Host "  ⚠️  Bicep not found, installing..." -ForegroundColor Yellow
    & az bicep install
}

# Check login status
Write-Host "`n🔐 Checking Azure authentication..." -ForegroundColor Yellow
$account = & az account show --output json 2>$null | ConvertFrom-Json

if (-not $account) {
    Write-Host "  Not logged in. Initiating device code authentication..." -ForegroundColor Yellow
    Write-Host "  This method works well in dev containers and codespaces." -ForegroundColor Gray
    & az login --use-device-code
    $account = & az account show --output json | ConvertFrom-Json
}

Write-Host "  ✅ Logged in as: $($account.user.name)" -ForegroundColor Green

Write-Host "`n🔎 Validating Azure subscription context..." -ForegroundColor Yellow
$null = & az group list --subscription $account.id --query "[0].id" --output tsv 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Error "The current Azure context is not a usable subscription. Run 'az account set --subscription <subscription-id>' and retry."
    exit 1
}

Write-Host "  ✅ Subscription context is valid for ARM deployments" -ForegroundColor Green

Write-Host "  📋 Subscription: $($account.name) ($($account.id))" -ForegroundColor Green

$deploySreAgent = -not $SkipSreAgent
$sreAgentSkipReason = ''
$sreAgentApiVersion = ''

if ($deploySreAgent) {
    Write-Host "`n🤖 Checking Azure SRE Agent availability..." -ForegroundColor Yellow
    $sreAgentProvider = Get-SreAgentProviderStatus

    if ($sreAgentProvider.RegistrationState -ne 'Registered') {
        Write-Host "  Microsoft.App provider is not registered. Attempting registration..." -ForegroundColor Yellow
        & az provider register --namespace Microsoft.App --wait --only-show-errors | Out-Null
        $sreAgentProvider = Get-SreAgentProviderStatus
    }

    if (-not $sreAgentProvider.HasAgentsResource) {
        # The Microsoft.App/agents resource type itself isn't registered for
        # this subscription at all — SRE Agent (Preview) hasn't been enabled.
        # This is a legitimate, expected condition on subscriptions without
        # access to the feature, so skip gracefully rather than failing hard.
        $deploySreAgent = $false
        $sreAgentSkipReason = 'Microsoft.App/agents is not registered for this subscription (SRE Agent Preview access not enabled).'
        Write-Host "  ⚠️  $sreAgentSkipReason" -ForegroundColor Yellow
        Write-Host "      Continuing with core infrastructure deployment." -ForegroundColor Gray
    }
    elseif (-not $sreAgentProvider.IsSupported) {
        # The resource type IS registered, but none of the apiVersions this
        # module has been validated against ($script:SupportedSreAgentApiVersions)
        # are available. Fail clearly instead of silently deploying against an
        # unvalidated schema.
        $availableList = if ($sreAgentProvider.AvailableApiVersions.Count -gt 0) { $sreAgentProvider.AvailableApiVersions -join ', ' } else { '<none>' }
        $supportedList = $script:SupportedSreAgentApiVersions -join ', '
        Write-Error "Microsoft.App/agents is registered for this subscription, but none of the API versions this module supports ($supportedList) are available. Subscription offers: $availableList. Re-run with -SkipSreAgent to deploy core infrastructure only, or update infra/bicep/modules/sre-agent.bicep to support one of the available versions."
        exit 1
    }
    else {
        $sreAgentApiVersion = $sreAgentProvider.SelectedApiVersion
        Write-Host "  ✅ Microsoft.App/agents is available (pinning API: $sreAgentApiVersion)" -ForegroundColor Green
    }
}
else {
    $sreAgentSkipReason = 'Disabled by -SkipSreAgent.'
    Write-Host "`n🤖 Skipping Azure SRE Agent deployment (-SkipSreAgent)." -ForegroundColor Yellow
}

$deploySreAgentValue = if ($deploySreAgent) { 'true' } else { 'false' }

# Confirm subscription
Write-Host "`n⚠️  Resources will be deployed to subscription: $($account.name)" -ForegroundColor Yellow
if (-not $Yes) {
    $confirm = Read-Host "Continue? (y/N)"
    if ($confirm -ne 'y' -and $confirm -ne 'Y') {
        Write-Host "Deployment cancelled." -ForegroundColor Red
        exit 0
    }
}
else {
    Write-Host "  ✅ Confirmation skipped (-Yes)" -ForegroundColor Gray
}

# Set variables
$resourceGroupName = "rg-$WorkloadName-$Location"
$deploymentName = "sre-demo-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$bicepFile = Join-Path $PSScriptRoot "..\infra\bicep\main.bicep"
$parametersFile = if ($DeployDemoResponsePlan) {
    Join-Path $PSScriptRoot "..\infra\bicep\main.demo.bicepparam"
}
else {
    Join-Path $PSScriptRoot "..\infra\bicep\main.bicepparam"
}

if ($DeployDemoResponsePlan -and $SkipSreAgent) {
    Write-Error "-DeployDemoResponsePlan (issue #19 alert-to-approved-remediation response plan) requires the SRE Agent to be deployed. Remove -SkipSreAgent or omit -DeployDemoResponsePlan."
    exit 1
}

# EXPLICIT OPERATOR ACKNOWLEDGEMENT (issue #19 round 2): the SRE Agent's
# Azure Monitor alert scanner requires the built-in Monitoring Contributor
# role (749f88d5-cbae-40b8-bcfc-e573ddc772fa) on the SRE identity at
# SUBSCRIPTION scope — documented by Microsoft as the minimum scope for the
# scanner to discover and manage alert lifecycle (see
# https://learn.microsoft.com/azure/sre-agent/azure-monitor-alerts and
# https://learn.microsoft.com/azure/sre-agent/agent-permissions). This is
# NEVER implied by -DeployDemoResponsePlan alone — -AcceptSubscriptionScopeMonitoringRbac
# must be passed explicitly, deliberately independent of -Yes, so this
# specific subscription-scope grant always requires its own conscious
# decision rather than being swept up in a general "skip prompts" flag.
if ($DeployDemoResponsePlan -and -not $AcceptSubscriptionScopeMonitoringRbac) {
    Write-Host "`n⚠️  The demo response plan requires granting 'Monitoring Contributor' to the SRE Agent's managed identity at SUBSCRIPTION scope (not resource-group scope)." -ForegroundColor Red
    Write-Host "   This is not a design choice made by this script — Microsoft documents it as the minimum scope required for the Azure Monitor alert scanner:" -ForegroundColor Yellow
    Write-Host "     https://learn.microsoft.com/azure/sre-agent/azure-monitor-alerts" -ForegroundColor Gray
    Write-Host "     https://learn.microsoft.com/azure/sre-agent/agent-permissions" -ForegroundColor Gray
    Write-Host "   Monitoring Contributor cannot modify non-monitoring resources; it is scoped to acknowledging/closing Azure Monitor alerts and managing monitoring settings." -ForegroundColor Gray
    Write-Host "   Re-run with -AcceptSubscriptionScopeMonitoringRbac to explicitly accept this subscription-scope grant, or omit -DeployDemoResponsePlan to deploy the standard profile (no subscription-scope RBAC at all)." -ForegroundColor Yellow
    Write-Error "Refusing to deploy the demo response plan without explicit subscription-scope RBAC acknowledgement."
    exit 1
}

Write-Host "`n📦 Deployment Configuration:" -ForegroundColor Cyan
Write-Host "  • Location:        $Location" -ForegroundColor White
Write-Host "  • Workload Name:   $WorkloadName" -ForegroundColor White
Write-Host "  • Resource Group:  $resourceGroupName" -ForegroundColor White
Write-Host "  • Deployment Name: $deploymentName" -ForegroundColor White
Write-Host "  • Profile:         $(if ($DeployDemoResponsePlan) { 'Demo (main.demo.bicepparam) — response plan enabled' } else { 'Standard (main.bicepparam)' })" -ForegroundColor White
if ($DeployDemoResponsePlan) {
    Write-Host "  • Subscription RBAC: Monitoring Contributor for SRE identity (ACKNOWLEDGED via -AcceptSubscriptionScopeMonitoringRbac)" -ForegroundColor Yellow
    Write-Host "  • RG-scope RBAC:   Least-privilege (Reader + Log Analytics Reader only — no Contributor)" -ForegroundColor White
}
Write-Host "  • SRE Agent:       $(if ($deploySreAgent) { 'Enabled' } else { 'Disabled' })" -ForegroundColor White
if ($sreAgentSkipReason) {
    Write-Host "  • SRE Agent Note:  $sreAgentSkipReason" -ForegroundColor Gray
}
if ($sreAgentApiVersion) {
    Write-Host "  • SRE Agent API:   $sreAgentApiVersion" -ForegroundColor White
}

# Validate template
Write-Host "`n🔍 Validating Bicep template..." -ForegroundColor Yellow

$sreAgentBicepParams = @("deploySreAgent=$deploySreAgentValue")
if ($sreAgentApiVersion) {
    $sreAgentBicepParams += "sreAgentApiVersion=$sreAgentApiVersion"
}
if ($DeployDemoResponsePlan) {
    # Explicit even though main.demo.bicepparam already sets these — belt
    # and suspenders so this behavior can never silently depend only on
    # which parameters file happens to be selected above.
    $sreAgentBicepParams += "deployDemoResponsePlan=true"
    $sreAgentBicepParams += "deployAlerts=true"
    # Only ever passed true here because the acknowledgement gate above
    # already required -AcceptSubscriptionScopeMonitoringRbac to reach this
    # point — this is not a second independent path to grant it silently.
    $sreAgentBicepParams += "acknowledgeSubscriptionScopeMonitoringRbac=true"
}

if ($WhatIf) {
    Write-Host "  Running what-if analysis..." -ForegroundColor Gray
    $whatIfArgs = @(
        'deployment', 'sub', 'what-if',
        '--location', $Location,
        '--template-file', $bicepFile,
        '--parameters', "location=$Location", "workloadName=$WorkloadName"
    ) + $sreAgentBicepParams + @(
        '--name', $deploymentName
    )
    $whatIfOutput = & az @whatIfArgs 2>&1 | Out-String

    if ($LASTEXITCODE -ne 0) {
        Write-Host $whatIfOutput.Trim() -ForegroundColor Red
        Write-Error 'What-if analysis failed.'
        exit 1
    }

    if (-not [string]::IsNullOrWhiteSpace($whatIfOutput)) {
        Write-Host $whatIfOutput.Trim()
    }
    
    Write-Host "`n✅ What-if analysis complete. No changes were made." -ForegroundColor Green
    exit 0
}

# Deploy
Write-Host "`n🚀 Starting deployment..." -ForegroundColor Yellow
Write-Host "  This will take approximately 15-25 minutes." -ForegroundColor Gray

$startTime = Get-Date

try {
    $createArgs = @(
        'deployment', 'sub', 'create',
        '--location', $Location,
        '--template-file', $bicepFile,
        '--parameters', $parametersFile,
        "location=$Location",
        "workloadName=$WorkloadName"
    ) + $sreAgentBicepParams + @(
        '--name', $deploymentName,
        '--only-show-errors',
        '--output', 'json'
    )

    $deployment = $null
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        $create = Invoke-AzCliJson -Arguments $createArgs

        if ($create.ExitCode -eq 0 -and $create.Json) {
            $deployment = $create.Json
            break
        }

        Write-Host "`nAzure CLI deployment command failed." -ForegroundColor Red
        if ($create.Raw) {
            Write-Host "Azure CLI output:`n$($create.Raw.Trim())" -ForegroundColor Red
        }

        # Best-effort: if a deployment record exists, pull structured error details.
        $showArgs = @('deployment', 'sub', 'show', '--name', $deploymentName, '--output', 'json')
        $show = Invoke-AzCliJson -Arguments $showArgs
        if ($show.ExitCode -eq 0 -and $show.Json) {
            $state = $show.Json.properties.provisioningState
            Write-Host "`nDeployment provisioningState: $state" -ForegroundColor Yellow
            if ($show.Json.properties.error) {
                Write-Host "`nDeployment error (structured):" -ForegroundColor Yellow
                Write-Host ($show.Json.properties.error | ConvertTo-Json -Depth 50) -ForegroundColor Yellow
            }
        }

        Write-SubscriptionDeploymentFailureSummary -DeploymentName $deploymentName -ResourceGroupName $resourceGroupName

        if ($attempt -eq 1) {
            $deletedKeyVaultConflict = Get-DeletedKeyVaultConflict -ResourceGroupName $resourceGroupName
            if ($deletedKeyVaultConflict) {
                $resolved = Resolve-DeletedKeyVaultConflict -VaultName $deletedKeyVaultConflict.VaultName -Location $Location
                if ($resolved) {
                    Write-Host "`n🔁 Retrying deployment after Key Vault purge..." -ForegroundColor Yellow
                    continue
                }
            }
        }

        throw "Deployment failed (see output above)."
    }

    if (-not $deployment) {
        throw "Deployment failed (see output above)."
    }

    $endTime = Get-Date
    $duration = $endTime - $startTime

    Write-Host "`n✅ Deployment completed successfully!" -ForegroundColor Green
    Write-Host "   Duration: $($duration.Minutes) minutes $($duration.Seconds) seconds" -ForegroundColor Gray

    # Output deployment results
    Write-Host "`n📋 Deployment Outputs:" -ForegroundColor Cyan
    
    $outputs = $deployment.properties.outputs
    Write-Host "  • Resource Group:   $($outputs.resourceGroupName.value)" -ForegroundColor White
    Write-Host "  • AKS Cluster:      $($outputs.aksClusterName.value)" -ForegroundColor White
    Write-Host "  • AKS FQDN:         $($outputs.aksClusterFqdn.value)" -ForegroundColor White
    Write-Host "  • ACR Login Server: $($outputs.acrLoginServer.value)" -ForegroundColor White
    Write-Host "  • Key Vault URI:    $($outputs.keyVaultUri.value)" -ForegroundColor White
    Write-Host "  • Log Analytics ID: $($outputs.logAnalyticsWorkspaceId.value)" -ForegroundColor White
    Write-Host "  • App Insights ID:  $($outputs.appInsightsId.value)" -ForegroundColor White
    Write-Host "  • App Insights CS:  retrieved securely for telemetry injection" -ForegroundColor White

    if ($outputs.grafanaDashboardUrl.value) {
        Write-Host "  • Grafana:          $($outputs.grafanaDashboardUrl.value)" -ForegroundColor White
        Write-Host "  • AMW ID:           $($outputs.azureMonitorWorkspaceId.value)" -ForegroundColor White
        Write-Host "  • Prometheus DCR:   $($outputs.prometheusDataCollectionRuleId.value)" -ForegroundColor White
    }

    if ($outputs.podRestartAlertId.value) {
        Write-Host "  • Alert (restarts): $($outputs.podRestartAlertId.value)" -ForegroundColor White
        Write-Host "  • Alert (HTTP 5xx): $($outputs.http5xxAlertId.value)" -ForegroundColor White
        Write-Host "  • Alert (failures): $($outputs.podFailureAlertId.value)" -ForegroundColor White
        Write-Host "  • Alert (crash/oom):$($outputs.crashLoopOomAlertId.value)" -ForegroundColor White
    }

    if ($outputs.defaultActionGroupId.value) {
        Write-Host "  • Action Group:     $($outputs.defaultActionGroupId.value)" -ForegroundColor White
        Write-Host "  • Incident Webhook: $($outputs.defaultActionGroupHasWebhook.value)" -ForegroundColor White
    }

    $appInsightsConnStr = $null
    if ($outputs.appInsightsId.value) {
        $appInsightsConnStr = az resource show --ids $outputs.appInsightsId.value --api-version 2020-02-02 --query properties.ConnectionString --output tsv 2>$null
    }

    if ($outputs.sreAgentId.value) {
        Write-Host "  • SRE Agent:        $($outputs.sreAgentName.value)" -ForegroundColor White
        Write-Host "  • SRE Agent Portal: $($outputs.sreAgentPortalUrl.value)" -ForegroundColor White
    }
    elseif ($sreAgentSkipReason) {
        Write-Host "  • SRE Agent:        Skipped" -ForegroundColor Yellow
        Write-Host "  • Reason:           $sreAgentSkipReason" -ForegroundColor Gray
    }

    if ($outputs.adxClusterUri.value) {
        Write-Host "  • ADX Cluster:      $($outputs.adxClusterUri.value)" -ForegroundColor White
        Write-Host "  • ADX Database:     $($outputs.adxDatabaseName.value)" -ForegroundColor White
    }

    # Save outputs to file
    $outputsFile = Join-Path $PSScriptRoot "deployment-outputs.json"
    $deployment.properties.outputs | ConvertTo-Json -Depth 10 | Set-Content $outputsFile
    Write-Host "`n  📄 Outputs saved to: $outputsFile" -ForegroundColor Gray

}
catch {
    Write-Host "`n❌ Deployment failed!" -ForegroundColor Red
    Write-Host "   Error: $_" -ForegroundColor Red
    exit 1
}

# Get AKS credentials
Write-Host "`n🔑 Getting AKS credentials..." -ForegroundColor Yellow
az aks get-credentials `
    --resource-group $resourceGroupName `
    --name $outputs.aksClusterName.value `
    --overwrite-existing

# Convert kubeconfig to use Azure CLI auth so kubelogin doesn't prompt for a client ID
kubelogin convert-kubeconfig -l azurecli

Write-Host "  ✅ kubectl configured for cluster: $($outputs.aksClusterName.value)" -ForegroundColor Green

$sreAgentManagedIdentityPrincipalId = ''
if ($outputs.PSObject.Properties.Name -contains 'sreAgentManagedIdentityPrincipalId') {
    $sreAgentManagedIdentityPrincipalId = $outputs.sreAgentManagedIdentityPrincipalId.value
}

# Apply RBAC if not skipped
if (-not $SkipRbac) {
    Write-Host "`n🔐 Applying RBAC assignments..." -ForegroundColor Yellow
    Write-Host "  ⚠️  Note: If this fails due to subscription policies, run with -SkipRbac" -ForegroundColor Gray
    
    $rbacScript = Join-Path $PSScriptRoot "configure-rbac.ps1"
    if (Test-Path $rbacScript) {
        $rbacParams = @{
            ResourceGroupName = $resourceGroupName
        }

        if ($sreAgentManagedIdentityPrincipalId) {
            $rbacParams.SreAgentPrincipalId = $sreAgentManagedIdentityPrincipalId
            Write-Host "  ✅ Auto-detected SRE Agent managed identity principal ID" -ForegroundColor Green
        }
        elseif ($deploySreAgent) {
            Write-Host "  ⚠️  SRE Agent principal ID was not returned by the deployment. Agent-specific RBAC was skipped." -ForegroundColor Yellow
        }

        & $rbacScript @rbacParams
    }
    else {
        Write-Host "  ⚠️  RBAC script not found, skipping..." -ForegroundColor Yellow
    }
}

# Bootstrap SRE Agent knowledge (idempotent, content-hash keyed) if the agent was deployed
$sreAgentKnowledgeReady = $true
if ($outputs.sreAgentId.value) {
    Write-Host "`n📚 Bootstrapping SRE Agent knowledge..." -ForegroundColor Yellow
    $knowledgeScript = Join-Path $PSScriptRoot "bootstrap-sre-agent-knowledge.ps1"
    if (Test-Path $knowledgeScript) {
        & pwsh -NoLogo -NoProfile -File $knowledgeScript `
            -ResourceGroupName $resourceGroupName `
            -AgentName $outputs.sreAgentName.value `
            -ApiVersion $outputs.sreAgentApiVersionUsed.value
        if ($LASTEXITCODE -ne 0) {
            $sreAgentKnowledgeReady = $false
            Write-Host "  ❌ SRE Agent knowledge bootstrap failed. See output above for the explicit error." -ForegroundColor Red
        }
        else {
            Write-Host "  ✅ SRE Agent knowledge is bootstrapped and indexed" -ForegroundColor Green
        }
    }
    else {
        $sreAgentKnowledgeReady = $false
        Write-Host "  ❌ Knowledge bootstrap script not found: $knowledgeScript" -ForegroundColor Red
    }
}

# Bootstrap the proactive daily-propane-health-report scheduled task (issue
# #24) — read-only and Autonomous, so unlike the response plan this is safe
# to bootstrap for BOTH the standard and demo profiles whenever the agent
# was actually deployed.
$sreAgentScheduledTaskReady = $true
if ($outputs.sreAgentId.value) {
    Write-Host "`n🗓️  Bootstrapping SRE Agent scheduled task (daily-propane-health-report)..." -ForegroundColor Yellow
    $scheduledTaskScript = Join-Path $PSScriptRoot "bootstrap-sre-agent-scheduled-task.ps1"
    if (Test-Path $scheduledTaskScript) {
        & pwsh -NoLogo -NoProfile -File $scheduledTaskScript `
            -ResourceGroupName $resourceGroupName `
            -AgentName $outputs.sreAgentName.value `
            -AksClusterName $outputs.aksClusterName.value `
            -ApiVersion $outputs.sreAgentApiVersionUsed.value
        if ($LASTEXITCODE -ne 0) {
            $sreAgentScheduledTaskReady = $false
            Write-Host "  ❌ SRE Agent scheduled task bootstrap failed. See output above for the explicit error." -ForegroundColor Red
        }
        else {
            Write-Host "  ✅ SRE Agent scheduled task is configured (Daily, Autonomous)" -ForegroundColor Green
        }
    }
    else {
        $sreAgentScheduledTaskReady = $false
        Write-Host "  ❌ Scheduled task bootstrap script not found: $scheduledTaskScript" -ForegroundColor Red
    }
}

# Bootstrap the demo alert-to-approved-remediation response plan (issue #19)
# — only when the demo profile is active and the agent was actually deployed.
$sreAgentResponsePlanReady = $true
if ($DeployDemoResponsePlan -and $outputs.sreAgentId.value) {
    Write-Host "`n🧭 Bootstrapping SRE Agent response plan (MongoDB-down demo scenario)..." -ForegroundColor Yellow
    $responsePlanScript = Join-Path $PSScriptRoot "bootstrap-sre-agent-response-plan.ps1"
    if (Test-Path $responsePlanScript) {
        $responsePlanParams = @(
            '-ResourceGroupName', $resourceGroupName,
            '-AgentName', $outputs.sreAgentName.value,
            '-AksClusterName', $outputs.aksClusterName.value,
            '-ApiVersion', $outputs.sreAgentApiVersionUsed.value
        )
        if ($outputs.mongoDbDownDemoAlertTitle.value) {
            $responsePlanParams += @('-AlertTitle', $outputs.mongoDbDownDemoAlertTitle.value)
        }
        if ($null -ne $outputs.mongoDbDownDemoAlertSeverity.value -and [int]$outputs.mongoDbDownDemoAlertSeverity.value -ge 0) {
            $responsePlanParams += @('-AlertSeverity', [string]$outputs.mongoDbDownDemoAlertSeverity.value)
        }

        & pwsh -NoLogo -NoProfile -File $responsePlanScript @responsePlanParams
        if ($LASTEXITCODE -ne 0) {
            $sreAgentResponsePlanReady = $false
            Write-Host "  ❌ SRE Agent response plan bootstrap failed. See output above for the explicit error." -ForegroundColor Red
        }
        else {
            Write-Host "  ✅ SRE Agent response plan is configured (Review autonomy)" -ForegroundColor Green
        }
    }
    else {
        $sreAgentResponsePlanReady = $false
        Write-Host "  ❌ Response plan bootstrap script not found: $responsePlanScript" -ForegroundColor Red
    }
}

# Deploy application
Write-Host "`n📦 Deploying demo application to AKS..." -ForegroundColor Yellow
$k8sPath = Join-Path $PSScriptRoot "..\k8s\base\application.yaml"

if (Test-Path $k8sPath) {
    # Ensure the propane namespace exists before creating Secrets
    kubectl create namespace propane --dry-run=client -o yaml | kubectl apply -f - 2>$null

    # Generate and apply RabbitMQ credentials as a Kubernetes Secret
    Write-Host "`n🔐 Generating RabbitMQ credentials..." -ForegroundColor Yellow
    $rabbitMqUser     = 'amerigas-rmq'
    $rabbitMqPassword = New-RandomPassword -Length 24
    $rabbitMqUserEscaped = [System.Uri]::EscapeDataString($rabbitMqUser)
    $rabbitMqPasswordEscaped = [System.Uri]::EscapeDataString($rabbitMqPassword)
    $rabbitMqUri      = "amqp://${rabbitMqUserEscaped}:${rabbitMqPasswordEscaped}@rabbitmq:5672/"

    kubectl create secret generic rabbitmq-credentials `
        --namespace propane `
        --from-literal="username=${rabbitMqUser}" `
        --from-literal="password=${rabbitMqPassword}" `
        --from-literal="uri=${rabbitMqUri}" `
        --dry-run=client -o yaml | kubectl apply -f -
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ✅ RabbitMQ credentials secret created/updated" -ForegroundColor Green
    }
    else {
        Write-Host "  ⚠️  Could not create RabbitMQ credentials secret" -ForegroundColor Yellow
    }

    $telemetryProbePath = Join-Path $PSScriptRoot "../tools/telemetry-probe/probe.js"
    if (-not (Test-Path -LiteralPath $telemetryProbePath -PathType Leaf)) {
        throw "Telemetry probe source not found at: $telemetryProbePath"
    }

    kubectl create configmap telemetry-probe-source `
        --namespace propane `
        "--from-file=probe.js=$telemetryProbePath" `
        --dry-run=client -o yaml | kubectl apply -f -
    if ($LASTEXITCODE -ne 0) {
        throw "Could not create the telemetry probe ConfigMap."
    }

    # Store the connection string only in a Kubernetes Secret. The generated
    # YAML is piped directly to kubectl and is never written to host output.
    Write-Host "`n🔗 Configuring Application Insights telemetry..." -ForegroundColor Yellow
    if ($appInsightsConnStr) {
        $connectionStringBytes = [System.Text.Encoding]::UTF8.GetBytes($appInsightsConnStr)
        $telemetrySecret = [ordered]@{
            apiVersion = 'v1'
            kind       = 'Secret'
            metadata   = [ordered]@{
                name      = 'application-insights-connection'
                namespace = 'propane'
            }
            type       = 'Opaque'
            data       = [ordered]@{
                'connection-string' = [Convert]::ToBase64String($connectionStringBytes)
            }
        }
        $telemetrySecret | ConvertTo-Json -Depth 10 -Compress | kubectl apply -f - | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Could not create the Application Insights connection Secret."
        }
        [Array]::Clear($connectionStringBytes, 0, $connectionStringBytes.Length)
        $telemetrySecret = $null
        $appInsightsConnStr = $null
        Write-Host "  ✅ Application Insights telemetry Secret created/updated" -ForegroundColor Green
    }
    else {
        throw "Application Insights connection string is unavailable; telemetry cannot be configured."
    }

    kubectl apply -f $k8sPath
    if ($LASTEXITCODE -ne 0) {
        throw "Could not deploy the demo application manifests."
    }
    Write-Host "  ✅ Demo application deployed" -ForegroundColor Green

    kubectl rollout restart deployment/otel-collector -n propane 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not restart the OpenTelemetry Collector after Secret rotation."
    }

    Write-Host "`n⏳ Waiting for workloads to roll out..." -ForegroundColor Yellow
    $deploymentNamesRaw = kubectl get deployment -n propane -o jsonpath='{.items[*].metadata.name}' 2>$null
    $deploymentNames = @()
    if ($deploymentNamesRaw) {
        $deploymentNames = $deploymentNamesRaw -split '\s+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    }

    foreach ($deploymentName in $deploymentNames) {
        kubectl rollout status "deployment/$deploymentName" -n propane --timeout=300s 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  ⚠️  Rollout still in progress for deployment/$deploymentName" -ForegroundColor Yellow
        }
    }
    
    # Wait for LoadBalancer IP
    Write-Host "⏳ Waiting for customer-portal external IP..." -ForegroundColor Yellow
    $maxWait = 120
    $waited = 0
    $storeUrl = $null
    while ($waited -lt $maxWait) {
        $externalIp = kubectl get svc customer-portal -n propane -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>$null
        if ($externalIp) {
            $storeUrl = "http://$externalIp"
            break
        }
        Start-Sleep -Seconds 5
        $waited += 5
    }
    
    if ($storeUrl) {
        Write-Host "  ✅ Customer Portal URL: $storeUrl" -ForegroundColor Green
    }
    else {
        Write-Host "  ⚠️  Customer Portal external IP is still pending. Check again with: kubectl get svc customer-portal -n propane" -ForegroundColor Yellow
    }
}
else {
    Write-Host "  ⚠️  Application manifest not found at: $k8sPath" -ForegroundColor Yellow
}

# Run validation
Write-Host "`n🔍 Running deployment validation..." -ForegroundColor Yellow
$validateScript = Join-Path $PSScriptRoot "validate-deployment.ps1"

if (Test-Path $validateScript) {
    & pwsh -NoLogo -NoProfile -File $validateScript -ResourceGroupName $resourceGroupName
    if ($LASTEXITCODE -ne 0) {
        throw "Deployment validation failed. Review the validation output above."
    }
}
else {
    Write-Host "  ⚠️  Validation script not found, skipping..." -ForegroundColor Yellow
}

if ($sreAgentSkipReason -and -not $outputs.sreAgentId.value) {
    Write-Host "`nℹ️  Azure SRE Agent was not deployed: $sreAgentSkipReason" -ForegroundColor Yellow
    Write-Host "   Re-run without -SkipSreAgent once Microsoft.App/agents is available in the subscription." -ForegroundColor Gray
}

if ($outputs.sreAgentId.value -and -not $sreAgentKnowledgeReady) {
    Write-Host "`n❌ Deployment did not reach demo-ready state." -ForegroundColor Red
    Write-Host "   The SRE Agent was created, but its knowledge base could not be bootstrapped or verified." -ForegroundColor Red
    Write-Host "   Do not mark this deployment demo-ready until the knowledge bootstrap error above is resolved and re-run succeeds." -ForegroundColor Red
    exit 1
}

# The daily-propane-health-report scheduled task (issue #24) is bootstrapped
# unconditionally whenever the SRE Agent is deployed — for BOTH the standard
# and demo profiles, exactly like the knowledge bootstrap above (it is NOT
# opt-in behind -DeployDemoResponsePlan the way the response plan is). A
# failed/unsupported/schema-mismatched bootstrap must therefore gate
# demo-ready status the same way knowledge readiness does, not just print a
# warning that a caller could miss.
if ($outputs.sreAgentId.value -and -not $sreAgentScheduledTaskReady) {
    Write-Host "`n❌ Deployment did not reach demo-ready state." -ForegroundColor Red
    Write-Host "   The SRE Agent was created, but its proactive daily-propane-health-report scheduled task could not be bootstrapped or verified." -ForegroundColor Red
    Write-Host "   Do not mark this deployment demo-ready until the scheduled task bootstrap error above is resolved and re-run succeeds." -ForegroundColor Red
    exit 1
}

if ($DeployDemoResponsePlan -and $outputs.sreAgentId.value -and -not $sreAgentResponsePlanReady) {
    Write-Host "`n❌ Deployment did not reach demo-ready state." -ForegroundColor Red
    Write-Host "   The SRE Agent was created, but its alert-to-approved-remediation response plan could not be bootstrapped or verified." -ForegroundColor Red
    Write-Host "   Do not mark this deployment demo-ready until the response plan bootstrap error above is resolved and re-run succeeds." -ForegroundColor Red
    exit 1
}

# Final instructions
$aksName = if ($outputs.aksClusterName.value) { $outputs.aksClusterName.value } else { "<check Azure Portal>" }
$siteUrlDisplay = if ($storeUrl) { $storeUrl } else { "kubectl get svc customer-portal -n propane" }

Write-Host @"

╔══════════════════════════════════════════════════════════════════════════════╗
║                         Deployment Complete! 🎉                              ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  Resources Deployed:                                                         ║
║    • AKS Cluster:    $($aksName.PadRight(44))║
║    • Customer Portal: $($siteUrlDisplay.PadRight(43))║
║                                                                              ║
║  ℹ️  SRE Agent: See deployment output above for status                       ║
║    Portal: https://aka.ms/sreagent/portal                                    ║
║                                                                              ║
║  Quick Start (after SRE Agent setup):                                        ║
║    1. Open the dashboard: $siteUrlDisplay
║    2. Break something: break-oom                                             ║
║    3. Refresh dashboard to see failure                                       ║
║    4. Ask SRE Agent: "Why are pods crashing in the propane namespace?"      ║
║    5. Fix it: fix-all                                                        ║
╚══════════════════════════════════════════════════════════════════════════════╝

"@ -ForegroundColor Cyan
