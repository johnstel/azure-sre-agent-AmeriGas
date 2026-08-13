<#
.SYNOPSIS
    Validates that the Azure SRE Agent AmeriGas Propane Demo Lab deployment is healthy.

.DESCRIPTION
    This script checks:
    - Azure resources are provisioned and healthy
    - AKS cluster is reachable
    - All pods in the demo application are running
    - Services have endpoints assigned
    - Basic connectivity tests pass

.PARAMETER ResourceGroupName
    Name of the resource group containing the deployment

.PARAMETER Detailed
    Show detailed output for each check

.EXAMPLE
    .\validate-deployment.ps1 -ResourceGroupName "rg-srelab-eastus2"

.EXAMPLE
    .\validate-deployment.ps1 -ResourceGroupName "rg-srelab-eastus2" -Detailed
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ResourceGroupName,

    [Parameter()]
    [switch]$Detailed,

    [Parameter()]
    [string]$ExpectedSubscriptionId,

    [Parameter()]
    [string]$KnowledgeFilePath = (Join-Path $PSScriptRoot ".." "docs/sre-agent-knowledge.md"),

    [Parameter()]
    [ValidateRange(1, 900)]
    [int]$TelemetryTimeoutSeconds = 300
)

$ErrorActionPreference = 'Continue'

# Reuse the SRE Agent knowledge-bootstrap functions (ARM read, data-plane
# token, agent-memory status/indexer calls) instead of duplicating them here.
# Dot-sourcing runs the file's param block but not its guarded entry point
# (see bottom of that script), so a dummy AgentName is supplied only to
# satisfy mandatory parameter binding — it is never used for an actual
# bootstrap since only the function definitions are needed.
. (Join-Path $PSScriptRoot "bootstrap-sre-agent-knowledge.ps1") -ResourceGroupName $ResourceGroupName -AgentName '__validate-deployment-dot-source__' -KnowledgeFilePath $KnowledgeFilePath

# Reuse the response-plan bootstrap functions (control-plane sub-resource
# read/decode, quickstart-conflict detection) for the demo response-plan
# validation section below — same dot-sourcing pattern as above.
. (Join-Path $PSScriptRoot "bootstrap-sre-agent-response-plan.ps1") -ResourceGroupName $ResourceGroupName -AgentName '__validate-deployment-dot-source__' -AksClusterName '__validate-deployment-dot-source__'

# Colors and formatting
function Write-Check {
    param([string]$Name, [bool]$Passed, [string]$Message = "")
    if ($Passed) {
        Write-Host "  ✅ $Name" -ForegroundColor Green
        if ($Message -and $Detailed) { Write-Host "     $Message" -ForegroundColor Gray }
    }
    else {
        Write-Host "  ❌ $Name" -ForegroundColor Red
        if ($Message) { Write-Host "     $Message" -ForegroundColor Yellow }
    }
    return $Passed
}

function Write-Section {
    param([string]$Title)
    Write-Host "`n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
}

# Banner
Write-Host @"

╔══════════════════════════════════════════════════════════════════════════════╗
║                  AmeriGas Propane SRE Demo Lab - Validation                   ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  Checking deployment health and readiness...                                 ║
╚══════════════════════════════════════════════════════════════════════════════╝

"@ -ForegroundColor Cyan

$totalChecks = 0
$passedChecks = 0

# =============================================================================
# AZURE RESOURCE CHECKS
# =============================================================================
Write-Section "Azure Resources"

# Check resource group exists
$rg = az group show --name $ResourceGroupName --output json 2>$null | ConvertFrom-Json
$totalChecks++
if (Write-Check "Resource Group exists" ($null -ne $rg) "Location: $($rg.location)") {
    $passedChecks++
}

# Get all resources in RG
$resources = az resource list --resource-group $ResourceGroupName --output json 2>$null | ConvertFrom-Json

# Check AKS
$aks = $resources | Where-Object { $_.type -eq "Microsoft.ContainerService/managedClusters" }
$totalChecks++
if (Write-Check "AKS Cluster exists" ($null -ne $aks) $aks.name) {
    $passedChecks++
    
    # Get AKS details
    $aksDetails = az aks show --resource-group $ResourceGroupName --name $aks.name --output json 2>$null | ConvertFrom-Json
    
    $totalChecks++
    if (Write-Check "AKS Cluster is running" ($aksDetails.provisioningState -eq "Succeeded" -and $aksDetails.powerState.code -eq "Running") "State: $($aksDetails.powerState.code)") {
        $passedChecks++
    }
    
    # Check AKS is NOT private (required for SRE Agent)
    $totalChecks++
    $isPublic = -not $aksDetails.apiServerAccessProfile.enablePrivateCluster
    if (Write-Check "AKS API is public (required for SRE Agent)" $isPublic) {
        $passedChecks++
    }
    
    # Store AKS name for later
    $aksName = $aks.name
}

# Check Container Registry
$acr = $resources | Where-Object { $_.type -eq "Microsoft.ContainerRegistry/registries" }
$totalChecks++
if (Write-Check "Container Registry exists" ($null -ne $acr) $acr.name) {
    $passedChecks++
}

# Check Log Analytics
$la = $resources | Where-Object { $_.type -eq "Microsoft.OperationalInsights/workspaces" }
$totalChecks++
if (Write-Check "Log Analytics Workspace exists" ($null -ne $la) $la.name) {
    $passedChecks++
}

# Check App Insights
$ai = $resources | Where-Object { $_.type -eq "Microsoft.Insights/components" }
$totalChecks++
if (Write-Check "Application Insights exists" ($null -ne $ai) $ai.name) {
    $passedChecks++
}

# Check Key Vault
$kv = $resources | Where-Object { $_.type -eq "Microsoft.KeyVault/vaults" }
$totalChecks++
if (Write-Check "Key Vault exists" ($null -ne $kv) $kv.name) {
    $passedChecks++
}

# Check Grafana (optional)
$grafana = $resources | Where-Object { $_.type -eq "Microsoft.Dashboard/grafana" }
if ($grafana) {
    $totalChecks++
    if (Write-Check "Managed Grafana exists" $true $grafana.name) {
        $passedChecks++
    }
}

# =============================================================================
# AZURE SRE AGENT
# =============================================================================
$sreAgentResourceSummary = $resources | Where-Object { $_.type -eq "Microsoft.App/agents" } | Select-Object -First 1

if ($sreAgentResourceSummary) {
    Write-Section "Azure SRE Agent"

    # --- Subscription context -------------------------------------------------
    $currentSubscriptionId = az account show --query id --output tsv 2>$null
    $totalChecks++
    $subscriptionOk = -not [string]::IsNullOrWhiteSpace($currentSubscriptionId)
    if ($ExpectedSubscriptionId) {
        $subscriptionOk = $subscriptionOk -and ($currentSubscriptionId -eq $ExpectedSubscriptionId)
    }
    if (Write-Check "Subscription context matches expected" $subscriptionOk "Current: $currentSubscriptionId$(if ($ExpectedSubscriptionId) { " / Expected: $ExpectedSubscriptionId" })") {
        $passedChecks++
    }

    # --- Read the agent's control-plane state, trying supported API versions --
    $sreAgentArm = $null
    $sreAgentArmApiVersion = $null
    foreach ($candidateApiVersion in @('2026-01-01', '2025-05-01-preview')) {
        try {
            $sreAgentArm = Get-SreAgentResource -SubscriptionId $currentSubscriptionId -ResourceGroupName $ResourceGroupName -AgentName $sreAgentResourceSummary.name -ApiVersion $candidateApiVersion
            $sreAgentArmApiVersion = $candidateApiVersion
            break
        }
        catch {
            continue
        }
    }

    $totalChecks++
    if (Write-Check "SRE Agent control-plane state readable" ($null -ne $sreAgentArm) "API version: $sreAgentArmApiVersion") {
        $passedChecks++
    }

    if ($sreAgentArm) {
        # --- Exact managed resource group binding (no drift) -------------------
        $expectedManagedResourceId = "/subscriptions/$currentSubscriptionId/resourceGroups/$ResourceGroupName"
        $managedResources = @($sreAgentArm.properties.knowledgeGraphConfiguration.managedResources)
        $managedResourcesOk = ($managedResources.Count -eq 1) -and ($managedResources[0] -ieq $expectedManagedResourceId)
        $totalChecks++
        if (Write-Check "managedResources contains exactly the lab resource group" $managedResourcesOk "$($managedResources -join ', ')") {
            $passedChecks++
        }

        # --- Provisioning / running state --------------------------------------
        $totalChecks++
        if (Write-Check "Agent provisioningState is Succeeded" ($sreAgentArm.properties.provisioningState -eq 'Succeeded') "State: $($sreAgentArm.properties.provisioningState)") {
            $passedChecks++
        }

        $totalChecks++
        if (Write-Check "Agent powerState is Running" ($sreAgentArm.properties.powerState -eq 'Running') "State: $($sreAgentArm.properties.powerState)") {
            $passedChecks++
        }

        # --- Review mode (never Autonomous/Automatic for this demo lab) --------
        $totalChecks++
        if (Write-Check "actionConfiguration.mode is Review" ($sreAgentArm.properties.actionConfiguration.mode -eq 'Review') "Mode: $($sreAgentArm.properties.actionConfiguration.mode)") {
            $passedChecks++
        }

        # --- Telemetry / Application Insights consistency ----------------------
        $appInsightsResource = $resources | Where-Object { $_.type -eq "Microsoft.Insights/components" } | Select-Object -First 1
        if ($appInsightsResource) {
            $appInsightsDetails = az resource show --ids $appInsightsResource.id --api-version 2020-02-02 --query properties.AppId --output tsv 2>$null
            $telemetryOk = -not [string]::IsNullOrWhiteSpace($appInsightsDetails) -and ($sreAgentArm.properties.logConfiguration.applicationInsightsConfiguration.appId -eq $appInsightsDetails)
            $totalChecks++
            if (Write-Check "SRE Agent App Insights App ID matches deployed resource" $telemetryOk) {
                $passedChecks++
            }
        }

        # --- Least-scope RBAC (resource group only, never subscription-wide) --
        $agentPrincipalId = $null
        if ($sreAgentArm.identity.userAssignedIdentities) {
            $firstIdentity = @($sreAgentArm.identity.userAssignedIdentities.PSObject.Properties)[0]
            if ($firstIdentity) {
                $agentPrincipalId = $firstIdentity.Value.principalId
            }
        }
        if (-not $agentPrincipalId -and $sreAgentArm.identity.principalId) {
            $agentPrincipalId = $sreAgentArm.identity.principalId
        }

        # Expected role definition GUIDs per access level. Must stay in sync
        # with infra/bicep/modules/sre-agent.bicep's roleDefinitionIds/
        # roleDefinitions variables (verified against
        # `az role definition list --query "[?name=='<guid>'].{name:roleName}"`
        # — 92aaf0da-... is Log Analytics *Contributor*, not Reader; the
        # actual Log Analytics *Reader* GUID is 73c42c96-...).
        $expectedRoleGuidsByLevel = @{
            Low  = @('73c42c96-874c-492b-b04d-ab87d138a893', 'acdd72a7-3385-48ef-bd42-f606fba81ae7') # Log Analytics Reader, Reader
            High = @('92aaf0da-9dab-42b6-94a3-d43ce8d16293', 'acdd72a7-3385-48ef-bd42-f606fba81ae7', 'b24988ac-6180-42a0-ab88-20f7382dd24c') # Log Analytics Contributor, Reader, Contributor
        }
        $accessLevel = $sreAgentArm.properties.actionConfiguration.accessLevel

        if ($agentPrincipalId) {
            $rgScopeAssignments = @(az role assignment list --assignee $agentPrincipalId --scope "/subscriptions/$currentSubscriptionId/resourceGroups/$ResourceGroupName" --output json 2>$null | ConvertFrom-Json)
            $totalChecks++
            if (Write-Check "SRE Agent identity has resource-group-scoped role assignment" ($rgScopeAssignments.Count -gt 0)) {
                $passedChecks++
            }

            if ($accessLevel -and $expectedRoleGuidsByLevel.ContainsKey($accessLevel)) {
                $expectedRoleGuids = @($expectedRoleGuidsByLevel[$accessLevel] | Sort-Object)
                $actualRoleGuids = @($rgScopeAssignments | ForEach-Object { ($_.roleDefinitionId -split '/')[-1] } | Sort-Object -Unique)
                $rolesMatchExactly = (Compare-Object -ReferenceObject $expectedRoleGuids -DifferenceObject $actualRoleGuids -SyncWindow 0 | Measure-Object).Count -eq 0
                $totalChecks++
                if (Write-Check "SRE Agent RG-scope roles exactly match the '$accessLevel' access level" $rolesMatchExactly "Expected: $($expectedRoleGuids -join ', ') / Actual: $($actualRoleGuids -join ', ')") {
                    $passedChecks++
                }
            }
            else {
                Write-Host "  ⚠️  Unrecognized or missing actionConfiguration.accessLevel ('$accessLevel') — skipping exact role-set check" -ForegroundColor Yellow
            }

            $subScopeAssignments = az role assignment list --assignee $agentPrincipalId --scope "/subscriptions/$currentSubscriptionId" --output json 2>$null | ConvertFrom-Json
            $exactSubscriptionScopeAssignments = @($subScopeAssignments | Where-Object { $_.scope -ieq "/subscriptions/$currentSubscriptionId" })
            $totalChecks++
            if (Write-Check "No subscription-wide role assignment for SRE Agent identity" ($exactSubscriptionScopeAssignments.Count -eq 0) "Least-scope RBAC — RG/resource scope only") {
                $passedChecks++
            }
        }

        # --- Knowledge readiness (content hash + indexer status) ---------------
        if (Test-Path -Path $KnowledgeFilePath) {
            $expectedHash = (Get-FileHash -Path $KnowledgeFilePath -Algorithm SHA256).Hash.ToLowerInvariant()
            $expectedDocumentName = "sre-agent-knowledge.$($expectedHash.Substring(0, 12)).md"

            if ($sreAgentArm.properties.provisioningState -eq 'Succeeded' -and $sreAgentArm.properties.agentEndpoint) {
                try {
                    $dataPlaneToken = Get-DataPlaneAccessToken
                    $apiSupported = Test-AgentMemoryApiSupported -Endpoint $sreAgentArm.properties.agentEndpoint -Token $dataPlaneToken

                    $totalChecks++
                    if (Write-Check "Agent memory (knowledge) API is available" $apiSupported) {
                        $passedChecks++
                    }

                    if ($apiSupported) {
                        $documentNames = @(Get-AgentMemoryDocumentNames -Endpoint $sreAgentArm.properties.agentEndpoint -Token $dataPlaneToken)
                        $currentDocPresent = $documentNames -contains $expectedDocumentName
                        $staleDocs = @($documentNames | Where-Object { $_ -like 'sre-agent-knowledge.*' -and $_ -ne $expectedDocumentName })

                        $totalChecks++
                        if (Write-Check "Current knowledge version is present (hash $expectedHash)" $currentDocPresent "Expected document: $expectedDocumentName") {
                            $passedChecks++
                        }

                        $totalChecks++
                        if (Write-Check "No stale knowledge versions remain" ($staleDocs.Count -eq 0) "$($staleDocs -join ', ')") {
                            $passedChecks++
                        }

                        if ($currentDocPresent) {
                            $indexed = $false
                            try {
                                $indexed = Wait-KnowledgeIndexed -Endpoint $sreAgentArm.properties.agentEndpoint -Token $dataPlaneToken -DocumentName $expectedDocumentName -TimeoutSeconds 30 -PollIntervalSeconds 5
                            }
                            catch {
                                $indexed = $false
                            }
                            $totalChecks++
                            if (Write-Check "Current knowledge version is indexed" $indexed) {
                                $passedChecks++
                            }
                        }
                    }
                }
                catch {
                    $totalChecks++
                    Write-Check "Agent memory (knowledge) API is available" $false "Error probing data plane: $_" | Out-Null
                }
            }
        }
        else {
            Write-Host "  ⚠️  Knowledge file not found at $KnowledgeFilePath — skipping knowledge readiness checks" -ForegroundColor Yellow
        }

        # --- Demo alert-to-approved-remediation response plan (issue #19) ------
        # Auto-detected: only runs when the dedicated demo alert is present, so
        # a standard-profile deployment (which never creates this alert) is
        # not penalized for lacking demo-only wiring.
        $mongoDbDemoAlertResource = $resources | Where-Object { $_.type -eq 'Microsoft.Insights/scheduledQueryRules' -and $_.name -match '-demo-mongodb-down$' } | Select-Object -First 1

        if ($mongoDbDemoAlertResource) {
            Write-Section "Demo Response Plan — MongoDB-Down Alert-to-Approved-Remediation (issue #19)"

            $mongoDbDemoAlertDetails = az resource show --ids $mongoDbDemoAlertResource.id --api-version 2023-12-01 --output json 2>$null | ConvertFrom-Json
            $totalChecks++
            $alertEnabled = $mongoDbDemoAlertDetails -and $mongoDbDemoAlertDetails.properties.enabled -eq $true
            if (Write-Check "Demo MongoDB-down alert is enabled" $alertEnabled "Title: $($mongoDbDemoAlertDetails.properties.displayName) / Severity: $($mongoDbDemoAlertDetails.properties.severity)") {
                $passedChecks++
            }

            $alertTitle = if ($mongoDbDemoAlertDetails) { [string]$mongoDbDemoAlertDetails.properties.displayName } else { $null }
            $alertSeverity = if ($mongoDbDemoAlertDetails) { [int]$mongoDbDemoAlertDetails.properties.severity } else { -1 }

            $totalChecks++
            $evalBoundOk = $mongoDbDemoAlertDetails -and $mongoDbDemoAlertDetails.properties.evaluationFrequency -eq 'PT1M' -and $mongoDbDemoAlertDetails.properties.windowSize -eq 'PT5M'
            if (Write-Check "Demo alert has the documented bounded evaluation window (PT1M/PT5M)" $evalBoundOk) {
                $passedChecks++
            }

            if ($sreAgentArm) {
                # --- incidentManagementConfiguration = AzMonitor --------------------
                $incidentType = $null
                if ($sreAgentArm.properties.PSObject.Properties.Name -contains 'incidentManagementConfiguration') {
                    $incidentType = $sreAgentArm.properties.incidentManagementConfiguration.type
                }
                $totalChecks++
                if (Write-Check "Azure Monitor is connected as the incident management platform" ($incidentType -eq 'AzMonitor') "Type: $incidentType") {
                    $passedChecks++
                }

                # --- Semantic data-plane verification (issue #19 round 2) --------------
                # A response plan is only ever reported "configured" below
                # after the platform's own interpreted list/get responses
                # match what was intended — never from an opaque ARM/byte
                # write acknowledgement alone.
                $semanticallyVerified = $false
                if ([string]::IsNullOrWhiteSpace($sreAgentArm.properties.agentEndpoint)) {
                    $totalChecks++
                    Write-Check "Response plan data-plane endpoint is available" $false "SRE Agent has no agentEndpoint yet" | Out-Null
                }
                else {
                    try {
                        $dataPlaneToken = Get-ResponsePlanDataPlaneAccessToken
                        $apiSupported = Test-ResponsePlanApiSupported -Endpoint $sreAgentArm.properties.agentEndpoint -Token $dataPlaneToken

                        $totalChecks++
                        if (Write-Check "Response plan semantic list endpoints (incidentFilters/incidentHandlers) are available" $apiSupported) {
                            $passedChecks++
                        }

                        if ($apiSupported) {
                            $customAgentResult = Invoke-DataPlaneRequest -Endpoint $sreAgentArm.properties.agentEndpoint -Token $dataPlaneToken -Method GET -Path "/api/v2/extendedAgent/agents/$($script:CustomAgentName)"
                            $expectedAgentSpec = New-CustomAgentDataPlaneSpec -Name $script:CustomAgentName -RenderedInstructions ($customAgentResult.Content.system_prompt)
                            $agentSemanticMatch = $customAgentResult.Success -and (Test-CustomAgentSemanticMatch -Expected $expectedAgentSpec -Actual $customAgentResult.Content)

                            $totalChecks++
                            if (Write-Check "Custom agent '$($script:CustomAgentName)' exists (data-plane GET)" $customAgentResult.Success) {
                                $passedChecks++
                            }

                            $filtersList = Get-IncidentFiltersList -Endpoint $sreAgentArm.properties.agentEndpoint -Token $dataPlaneToken
                            $handlersList = Get-IncidentHandlersList -Endpoint $sreAgentArm.properties.agentEndpoint -Token $dataPlaneToken
                            $currentFilter = if ($filtersList.Success) { Find-ItemById -Items (Get-ListItems -Content $filtersList.Content) -Id $script:ResponsePlanName } else { $null }
                            $currentHandler = if ($handlersList.Success) { Find-ItemById -Items (Get-ListItems -Content $handlersList.Content) -Id $script:ResponsePlanName } else { $null }

                            $totalChecks++
                            if (Write-Check "Response plan '$($script:ResponsePlanName)' exists (semantic list)" ($null -ne $currentFilter)) {
                                $passedChecks++
                            }

                            $expectedFilterSpec = New-IncidentFilterDataPlaneSpec -Id $script:ResponsePlanName -CustomAgentName $script:CustomAgentName -AlertTitle $alertTitle -AlertSeverity ([Math]::Max(0, $alertSeverity))
                            $filterSemanticMatch = Test-FilterSemanticMatch -Expected $expectedFilterSpec -Actual $currentFilter

                            $totalChecks++
                            if (Write-Check "Response plan autonomy is Review (never Autonomous) — interpreted field" ($currentFilter -and $currentFilter.agentMode -eq 'Review') "agentMode: $($currentFilter.agentMode)") {
                                $passedChecks++
                            }

                            $totalChecks++
                            $severityMatches = $currentFilter -and (@($currentFilter.priorities) -contains "Sev$alertSeverity")
                            if (Write-Check "Response plan severity filter matches the demo alert's severity ($alertSeverity)" $severityMatches "Filter priorities: $(@($currentFilter.priorities) -join ', ')") {
                                $passedChecks++
                            }

                            $totalChecks++
                            $titleMatches = $currentFilter -and $currentFilter.titleContains -eq $alertTitle
                            if (Write-Check "Response plan title filter matches the demo alert's exact title" $titleMatches "Filter title: '$($currentFilter.titleContains)' / Alert title: '$alertTitle'") {
                                $passedChecks++
                            }

                            $totalChecks++
                            $customAgentBound = $currentFilter -and $currentFilter.handlingAgent -eq $script:CustomAgentName
                            if (Write-Check "Response plan routes to the '$($script:CustomAgentName)' custom agent (interpreted binding)" $customAgentBound) {
                                $passedChecks++
                            }

                            $handlerBound = $currentHandler -and (Test-HandlerSemanticMatch -Expected (New-IncidentHandlerDataPlaneSpec -Id $script:ResponsePlanName -IncidentFilterId $script:ResponsePlanName -CustomAgentName $script:CustomAgentName) -Actual $currentHandler)
                            $totalChecks++
                            if (Write-Check "Incident handler binds the filter to the custom agent (interpreted binding)" $handlerBound) {
                                $passedChecks++
                            }

                            $semanticallyVerified = $customAgentResult.Success -and $filterSemanticMatch -and $handlerBound

                            # --- No conflicting quickstart plan, verified via the same semantic list ---
                            try {
                                $conflicts = @(Find-ConflictingQuickstartFilters -Filters (Get-ListItems -Content $filtersList.Content) -OwnFilterId $script:ResponsePlanName)
                                $totalChecks++
                                if (Write-Check "No conflicting quickstart response plan is active" ($conflicts.Count -eq 0) "$($conflicts -join ', ')") {
                                    $passedChecks++
                                }
                            }
                            catch {
                                $totalChecks++
                                Write-Check "No conflicting quickstart response plan is active" $false "Error checking for quickstart plans: $_" | Out-Null
                            }
                        }
                    }
                    catch {
                        $totalChecks++
                        Write-Check "Response plan semantic list endpoints (incidentFilters/incidentHandlers) are available" $false "Error probing data plane: $_" | Out-Null
                    }
                }

                $totalChecks++
                if (Write-Check "Response plan is configured AND semantically verified (not from opaque write acknowledgement alone)" $semanticallyVerified) {
                    $passedChecks++
                }
                if (-not $semanticallyVerified) {
                    Write-Host "  ℹ️  Demo deployment is NOT demo-ready until the response plan is semantically verified. A live end-to-end alert rehearsal (approve/deny/expiry) is ALSO still required before treating this demo as proven — see docs/sre-agent-response-plans/README.md." -ForegroundColor Yellow
                }

                # --- Least-scope RBAC for the exact remediation (AKS-resource-scoped only) --
                $aksResourceId = if ($aks) { $aks.id } else { $null }
                if ($aksResourceId -and $agentPrincipalId) {
                    $aksScopeAssignments = @(az role assignment list --assignee $agentPrincipalId --scope $aksResourceId --output json 2>$null | ConvertFrom-Json)
                    $mongoDbRoleAssignments = @($aksScopeAssignments | Where-Object { $_.roleDefinitionName -match '(?i)MongoDB Remediation' -or $_.roleDefinitionName -match '(?i)MongoDB' })

                    $totalChecks++
                    if (Write-Check "SRE Agent identity has a MongoDB-remediation role scoped to the AKS resource" ($mongoDbRoleAssignments.Count -gt 0)) {
                        $passedChecks++
                    }

                    if ($mongoDbRoleAssignments.Count -gt 0) {
                        $mongoDbRoleDef = az role definition list --name $mongoDbRoleAssignments[0].roleDefinitionName --output json 2>$null | ConvertFrom-Json | Select-Object -First 1
                        if ($mongoDbRoleDef) {
                            $actualActions = @($mongoDbRoleDef.permissions[0].actions | Sort-Object)
                            $expectedActions = @(
                                'Microsoft.ContainerService/managedClusters/commandResults/read'
                                'Microsoft.ContainerService/managedClusters/read'
                                'Microsoft.ContainerService/managedClusters/runCommand/action'
                            ) | Sort-Object
                            $actionsExactMatch = (Compare-Object -ReferenceObject $expectedActions -DifferenceObject $actualActions -SyncWindow 0 | Measure-Object).Count -eq 0

                            $totalChecks++
                            if (Write-Check "MongoDB-remediation role grants EXACTLY the three az aks command invoke actions" $actionsExactMatch "$($actualActions -join ', ')") {
                                $passedChecks++
                            }

                            $totalChecks++
                            $scopesOk = (@($mongoDbRoleDef.assignableScopes).Count -eq 1) -and ($mongoDbRoleDef.assignableScopes[0] -ieq $aksResourceId)
                            if (Write-Check "MongoDB-remediation role's assignableScopes is EXACTLY the AKS cluster resource (not the resource group)" $scopesOk "$($mongoDbRoleDef.assignableScopes -join ', ')") {
                                $passedChecks++
                            }
                        }
                    }
                }
                else {
                    Write-Host "  ⚠️  AKS cluster or SRE Agent principal ID not resolved — skipping demo RBAC scope checks" -ForegroundColor Yellow
                }

                # --- Effective least-privilege RG-scope RBAC (issue #19 round 2) -------
                # In the demo profile the SRE identity must NOT hold RG-scope
                # Contributor / Log Analytics Contributor — otherwise the
                # AKS-scoped custom role above is not an actual restriction.
                if ($agentPrincipalId) {
                    $rgScopeAssignmentsForDemo = @(az role assignment list --assignee $agentPrincipalId --scope "/subscriptions/$currentSubscriptionId/resourceGroups/$ResourceGroupName" --output json 2>$null | ConvertFrom-Json)
                    $rgContributorGuids = @('b24988ac-6180-42a0-ab88-20f7382dd24c', '92aaf0da-9dab-42b6-94a3-d43ce8d16293') # Contributor, Log Analytics Contributor
                    $rgContributorAssignments = @($rgScopeAssignmentsForDemo | Where-Object { $roleGuid = ($_.roleDefinitionId -split '/')[-1]; $rgContributorGuids -contains $roleGuid })

                    $totalChecks++
                    if (Write-Check "SRE Agent identity does NOT hold resource-group-scope Contributor/Log Analytics Contributor in the demo profile" ($rgContributorAssignments.Count -eq 0) "Found: $($rgContributorAssignments.roleDefinitionName -join ', ')") {
                        $passedChecks++
                    }

                    # --- Monitoring Contributor at subscription scope (issue #19 round 2, scanner requirement) ---
                    $subScopeAssignmentsForDemo = @(az role assignment list --assignee $agentPrincipalId --scope "/subscriptions/$currentSubscriptionId" --output json 2>$null | ConvertFrom-Json)
                    $exactSubScopeAssignmentsForDemo = @($subScopeAssignmentsForDemo | Where-Object { $_.scope -ieq "/subscriptions/$currentSubscriptionId" })
                    $monitoringContributorAssignments = @($exactSubScopeAssignmentsForDemo | Where-Object { ($_.roleDefinitionId -split '/')[-1] -eq '749f88d5-cbae-40b8-bcfc-e573ddc772fa' })
                    $nonMonitoringSubScopeAssignments = @($exactSubScopeAssignmentsForDemo | Where-Object { ($_.roleDefinitionId -split '/')[-1] -ne '749f88d5-cbae-40b8-bcfc-e573ddc772fa' })

                    $totalChecks++
                    if (Write-Check "SRE Agent identity has EXACTLY the Monitoring Contributor role at subscription scope (Azure Monitor scanner requirement)" ($monitoringContributorAssignments.Count -eq 1) "$($monitoringContributorAssignments.roleDefinitionName -join ', ')") {
                        $passedChecks++
                    }

                    $totalChecks++
                    if (Write-Check "SRE Agent identity has NO OTHER subscription-scope role assignment (Monitoring Contributor is the sole, documented, unavoidable exception)" ($nonMonitoringSubScopeAssignments.Count -eq 0) "$($nonMonitoringSubScopeAssignments.roleDefinitionName -join ', ')") {
                        $passedChecks++
                    }
                }
            }
        }
    }
}

# =============================================================================
# KUBERNETES CONNECTIVITY
# =============================================================================
Write-Section "Kubernetes Connectivity"

# Get AKS credentials if needed
if ($aksName) {
    Write-Host "  Connecting to AKS cluster..." -ForegroundColor Gray
    az aks get-credentials --resource-group $ResourceGroupName --name $aksName --overwrite-existing 2>$null
}

# Test kubectl connectivity
$null = kubectl cluster-info 2>&1
$totalChecks++
if (Write-Check "kubectl can connect to cluster" ($LASTEXITCODE -eq 0)) {
    $passedChecks++
}

# Check node status
$nodes = kubectl get nodes -o json 2>$null | ConvertFrom-Json
$totalChecks++
$healthyNodes = ($nodes.items | Where-Object { 
        ($_.status.conditions | Where-Object { $_.type -eq "Ready" }).status -eq "True" 
    }).Count
$totalNodes = $nodes.items.Count
if (Write-Check "All nodes are Ready" ($healthyNodes -eq $totalNodes) "$healthyNodes/$totalNodes nodes ready") {
    $passedChecks++
}

# =============================================================================
# APPLICATION HEALTH
# =============================================================================
Write-Section "AmeriGas Propane Application (propane namespace)"

# Check if namespace exists
$namespace = kubectl get namespace propane -o json 2>$null | ConvertFrom-Json
$totalChecks++
if (Write-Check "Namespace 'propane' exists" ($null -ne $namespace)) {
    $passedChecks++
}
else {
    Write-Host "  ⚠️  Run: kubectl apply -f k8s/base/application.yaml" -ForegroundColor Yellow
}

# Check pods
if ($namespace) {
    $pods = kubectl get pods -n propane -o json 2>$null | ConvertFrom-Json
    
    if ($pods.items.Count -gt 0) {
        Write-Host "`n  Pod Status:" -ForegroundColor White
        
        foreach ($pod in $pods.items) {
            $podName = $pod.metadata.name
            $phase = $pod.status.phase
            $ready = ($pod.status.containerStatuses | Where-Object { $_.ready -eq $true }).Count
            $total = $pod.status.containerStatuses.Count
            
            $totalChecks++
            $isHealthy = ($phase -eq "Running") -and ($ready -eq $total)
            
            $statusIcon = if ($isHealthy) { "✅" } else { "❌" }
            $statusColor = if ($isHealthy) { "Green" } else { "Red" }
            
            if ($Detailed -or -not $isHealthy) {
                Write-Host "    $statusIcon $podName - $phase ($ready/$total ready)" -ForegroundColor $statusColor
            }
            
            if ($isHealthy) { $passedChecks++ }
        }
        
        # Summary
        $runningPods = ($pods.items | Where-Object { $_.status.phase -eq "Running" }).Count
        Write-Host "`n  Summary: $runningPods/$($pods.items.Count) pods running" -ForegroundColor $(if ($runningPods -eq $pods.items.Count) { "Green" } else { "Yellow" })
    }
    else {
        Write-Host "  ⚠️  No pods found in 'propane' namespace" -ForegroundColor Yellow
        Write-Host "     Run: kubectl apply -f k8s/base/application.yaml" -ForegroundColor Gray
    }
}

# Check services
Write-Host "`n  Services:" -ForegroundColor White
$services = kubectl get svc -n propane -o json 2>$null | ConvertFrom-Json

foreach ($svc in $services.items) {
    $svcName = $svc.metadata.name
    $svcType = $svc.spec.type
    $hasEndpoint = $false
    
    if ($svcType -eq "LoadBalancer") {
        $externalIP = $null
        if ($svc.status.loadBalancer.ingress -and $svc.status.loadBalancer.ingress.Count -gt 0) {
            $externalIP = $svc.status.loadBalancer.ingress[0].ip
        }
        $hasEndpoint = $null -ne $externalIP
        $endpoint = if ($hasEndpoint) { $externalIP } else { "Pending" }
    }
    elseif ($svcType -eq "ClusterIP") {
        $hasEndpoint = $true
        $endpoint = $svc.spec.clusterIP
    }
    else {
        $hasEndpoint = $true
        $endpoint = $svcType
    }
    
    $totalChecks++
    if (Write-Check "$svcName ($svcType)" $hasEndpoint $endpoint) {
        $passedChecks++
    }
}

# Check for customer-portal LoadBalancer specifically
$storeFrontSvc = $services.items | Where-Object { $_.metadata.name -eq "customer-portal" }
if ($storeFrontSvc -and $storeFrontSvc.spec.type -eq "LoadBalancer") {
    $externalIP = $null
    if ($storeFrontSvc.status.loadBalancer.ingress -and $storeFrontSvc.status.loadBalancer.ingress.Count -gt 0) {
        $externalIP = $storeFrontSvc.status.loadBalancer.ingress[0].ip
    }
    if ($externalIP) {
        Write-Host "`n  🌐 Customer Portal URL: http://$externalIP" -ForegroundColor Cyan
    }
}

# =============================================================================
# OBSERVABILITY
# =============================================================================
Write-Section "Observability"

# Check Container Insights
$ciDaemonset = kubectl get daemonset -n kube-system -l component=oms-agent -o json 2>$null | ConvertFrom-Json
if ($ciDaemonset.items.Count -gt 0) {
    $totalChecks++
    $desired = $ciDaemonset.items[0].status.desiredNumberScheduled
    $ready = $ciDaemonset.items[0].status.numberReady
    if (Write-Check "Container Insights agent running" ($ready -eq $desired) "$ready/$desired pods") {
        $passedChecks++
    }
}
else {
    # Azure Monitor Agent (newer)
    $amaDeployment = kubectl get pods -n kube-system -l app=ama-logs -o json 2>$null | ConvertFrom-Json
    if ($amaDeployment.items.Count -gt 0) {
        $totalChecks++
        $running = ($amaDeployment.items | Where-Object { $_.status.phase -eq "Running" }).Count
        if (Write-Check "Azure Monitor Agent running" ($running -gt 0) "$running pods") {
            $passedChecks++
        }
    }
    else {
        Write-Host "  ℹ️  No Container Insights agent detected" -ForegroundColor Gray
    }
}

$totalChecks++
$telemetryValidationScript = Join-Path $PSScriptRoot 'validate-telemetry.ps1'
try {
    & $telemetryValidationScript `
        -ResourceGroupName $ResourceGroupName `
        -TimeoutSeconds $TelemetryTimeoutSeconds
    if ($LASTEXITCODE -ne 0) {
        throw "Telemetry validation exited with code $LASTEXITCODE."
    }
    if (Write-Check "Fresh correlated Application Insights telemetry" $true "Requests, dependencies, traces, metrics, exception, and Kubernetes event are correlated") {
        $passedChecks++
    }
}
catch {
    Write-Check "Fresh correlated Application Insights telemetry" $false $_.Exception.Message | Out-Null
}

# =============================================================================
# SUMMARY
# =============================================================================
Write-Host "`n"
Write-Host "══════════════════════════════════════════════════════════════" -ForegroundColor $(if ($passedChecks -eq $totalChecks) { "Green" } else { "Yellow" })
Write-Host "  VALIDATION SUMMARY: $passedChecks/$totalChecks checks passed" -ForegroundColor $(if ($passedChecks -eq $totalChecks) { "Green" } else { "Yellow" })
Write-Host "══════════════════════════════════════════════════════════════" -ForegroundColor $(if ($passedChecks -eq $totalChecks) { "Green" } else { "Yellow" })

if ($passedChecks -eq $totalChecks) {
    Write-Host @"

✅ All checks passed! Your deployment is healthy.

Next steps:
1. Open SRE Agent: https://aka.ms/sreagent/portal
2. Break something: kubectl apply -f k8s/scenarios/oom-killed.yaml
3. Ask SRE Agent to diagnose!

"@ -ForegroundColor Green
}
else {
    $failedChecks = $totalChecks - $passedChecks
    Write-Host @"

⚠️  $failedChecks check(s) failed. Review the issues above.

Common fixes:
- Deploy application: kubectl apply -f k8s/base/application.yaml
- Wait for pods: kubectl get pods -n propane -w
- Check events: kubectl get events -n propane --sort-by='.lastTimestamp'

"@ -ForegroundColor Yellow
}

# Return exit code
if ($passedChecks -ne $totalChecks) {
    exit 1
}
