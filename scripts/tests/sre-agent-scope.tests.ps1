#Requires -Modules Pester

<#
.SYNOPSIS
    Regression guards for issue #18: SRE Agent must be bound to the exact lab
    resource group (no drift), pinned to a validated API version, kept in
    Review mode, granted correctly-labeled least-scope RBAC (never
    subscription-wide), and consistent between the Bicep and Terraform IaC
    surfaces.

.DESCRIPTION
    Where the compiler can prove it, these tests run the REAL `az bicep
    build` on the production templates and inspect the compiled ARM JSON —
    the actual deployed variable values, resource properties, and role
    definition GUIDs — rather than only pattern-matching source text (a
    comment next to a GUID cannot make these tests pass; only the compiled
    template's variable values can). This fails loudly if a future edit
    reintroduces:
      - an empty/removed knowledgeGraphConfiguration.managedResources binding
      - a mislabeled or swapped role GUID (e.g. Log Analytics Contributor
        mislabeled as "Reader") for either access level
      - a subscription-wide Reader/Contributor shortcut for the SRE Agent's
        managed identity, in either Bicep or scripts/configure-rbac.ps1
      - a non-Review actionConfiguration.mode default
      - an unpinned / unvalidated Microsoft.App/agents API version
      - drift between the Bicep and Terraform role mappings / managedResources
        binding

    A handful of source-text guards remain (clearly labeled) only for things
    the ARM compiler cannot distinguish from ordinary strings — PowerShell
    control flow in configure-rbac.ps1, and Terraform's HCL locals (which
    `az bicep build` cannot compile; `terraform validate`/`fmt` are run
    separately as part of this PR's verification, not from this suite).

.EXAMPLE
    Invoke-Pester -Path scripts/tests/sre-agent-scope.tests.ps1
#>

# Cheap, side-effect-free check computed at Pester's discovery time (top-level
# script body) purely to drive the Describe -Skip conditions below — Describe
# -Skip is evaluated during discovery, before any BeforeAll block runs, so it
# cannot read variables set inside BeforeAll. The real setup (paths, file
# content, `az bicep build` output) is computed once in the top-level
# BeforeAll below, which runs during the Run phase and is visible to every
# Describe/It in this file — the same pattern already used successfully in
# bootstrap-sre-agent-knowledge.tests.ps1.
$script:AzAvailableForSkip = $null -ne (Get-Command az -ErrorAction SilentlyContinue)

BeforeAll {
    $script:RepoRoot = Join-Path $PSScriptRoot ".." ".."
    $script:BicepModulePath = Join-Path $script:RepoRoot "infra/bicep/modules/sre-agent.bicep"
    $script:MainBicepPath = Join-Path $script:RepoRoot "infra/bicep/main.bicep"
    $script:AlertsModulePath = Join-Path $script:RepoRoot "infra/bicep/modules/alerts.bicep"
    $script:DemoRbacModulePath = Join-Path $script:RepoRoot "infra/bicep/modules/sre-agent-demo-rbac.bicep"
    $script:MonitoringRbacModulePath = Join-Path $script:RepoRoot "infra/bicep/modules/sre-agent-monitoring-rbac.bicep"
    $script:DemoParamsPath = Join-Path $script:RepoRoot "infra/bicep/main.demo.bicepparam"
    $script:StandardParamsPath = Join-Path $script:RepoRoot "infra/bicep/main.bicepparam"
    $script:RbacScriptPath = Join-Path $script:RepoRoot "scripts/configure-rbac.ps1"
    $script:DeployScriptPath = Join-Path $script:RepoRoot "scripts/deploy.ps1"
    $script:TerraformModulePath = Join-Path $script:RepoRoot "infra/terraform/modules/sre-agent/main.tf"
    $script:BicepContent = Get-Content -Path $script:BicepModulePath -Raw
    $script:RbacContent = Get-Content -Path $script:RbacScriptPath -Raw
    $script:DeployScriptContent = Get-Content -Path $script:DeployScriptPath -Raw
    $script:TerraformContent = Get-Content -Path $script:TerraformModulePath -Raw
    $script:DemoParamsContent = Get-Content -Path $script:DemoParamsPath -Raw
    $script:StandardParamsContent = Get-Content -Path $script:StandardParamsPath -Raw

    # Ground truth for the built-in Azure RBAC role definitions this module
    # assigns, independent of any comment in the source (comments can lie; the
    # compiled ARM template and these GUIDs cannot). Names verified via
    # `az role definition list --query "[?name=='<guid>'].{name:roleName}"`.
    $script:ExpectedRoleGuids = @{
        LogAnalyticsReader      = '73c42c96-874c-492b-b04d-ab87d138a893' # Log Analytics Reader
        LogAnalyticsContributor = '92aaf0da-9dab-42b6-94a3-d43ce8d16293' # Log Analytics Contributor
        Reader                  = 'acdd72a7-3385-48ef-bd42-f606fba81ae7' # Reader
        Contributor             = 'b24988ac-6180-42a0-ab88-20f7382dd24c' # Contributor
    }

    # Verified via `az role definition list --name "Monitoring Contributor"`
    # on 2026-08-12.
    $script:MonitoringContributorRoleId = '749f88d5-cbae-40b8-bcfc-e573ddc772fa'

    # Ground truth for the exact AKS actions `az aks command invoke` requires
    # (see https://learn.microsoft.com/troubleshoot/azure/azure-kubernetes/monitoring/aks-diagnostics-command-invoke-run-fail),
    # confirmed against this subscription's Microsoft.ContainerService
    # provider operations on 2026-08-12.
    $script:ExpectedMongoDbRemediationActions = @(
        'Microsoft.ContainerService/managedClusters/read'
        'Microsoft.ContainerService/managedClusters/runCommand/action'
        'Microsoft.ContainerService/managedClusters/commandResults/read'
    )

    $script:AzAvailable = $null -ne (Get-Command az -ErrorAction SilentlyContinue)
    $script:CompiledModule = $null
    $script:CompiledMain = $null
    $script:CompiledAlerts = $null
    $script:CompiledDemoRbac = $null
    $script:CompiledMonitoringRbac = $null

    if ($script:AzAvailable) {
        # Compile the REAL module with `az bicep build` (the same tool the
        # deploy pipeline uses) rather than relying only on source-text
        # assertions. Bicep resolves variable references, so this proves the
        # actual deployed template — not just a comment next to a GUID.
        $moduleJson = & az bicep build --file $script:BicepModulePath --stdout 2>$null
        if ($LASTEXITCODE -eq 0 -and $moduleJson) {
            try { $script:CompiledModule = $moduleJson | ConvertFrom-Json -Depth 100 } catch { $script:CompiledModule = $null }
        }

        $mainJson = & az bicep build --file $script:MainBicepPath --stdout 2>$null
        if ($LASTEXITCODE -eq 0 -and $mainJson) {
            try { $script:CompiledMain = $mainJson | ConvertFrom-Json -Depth 100 } catch { $script:CompiledMain = $null }
        }

        $alertsJson = & az bicep build --file $script:AlertsModulePath --stdout 2>$null
        if ($LASTEXITCODE -eq 0 -and $alertsJson) {
            try { $script:CompiledAlerts = $alertsJson | ConvertFrom-Json -Depth 100 } catch { $script:CompiledAlerts = $null }
        }

        $demoRbacJson = & az bicep build --file $script:DemoRbacModulePath --stdout 2>$null
        if ($LASTEXITCODE -eq 0 -and $demoRbacJson) {
            try { $script:CompiledDemoRbac = $demoRbacJson | ConvertFrom-Json -Depth 100 } catch { $script:CompiledDemoRbac = $null }
        }

        $monitoringRbacJson = & az bicep build --file $script:MonitoringRbacModulePath --stdout 2>$null
        if ($LASTEXITCODE -eq 0 -and $monitoringRbacJson) {
            try { $script:CompiledMonitoringRbac = $monitoringRbacJson | ConvertFrom-Json -Depth 100 } catch { $script:CompiledMonitoringRbac = $null }
        }
    }
}


Describe "infra/bicep/modules/sre-agent.bicep — compiled template (az bicep build)" -Skip:(-not $script:AzAvailableForSkip) {
    BeforeAll {
        if (-not $script:CompiledModule) {
            throw "az bicep build did not produce a valid compiled template for $script:BicepModulePath — cannot verify the compiled contract. Run 'az bicep build --file $script:BicepModulePath' manually to see the error."
        }
    }

    It "compiles cleanly with az bicep build" {
        $script:CompiledModule | Should -Not -BeNullOrEmpty
    }

    It "the compiled roleDefinitionIds variable maps each name to the verified GUID (not a mislabeled one)" {
        $ids = $script:CompiledModule.variables.roleDefinitionIds
        $ids | Should -Not -BeNullOrEmpty
        $ids.logAnalyticsReader | Should -Be $script:ExpectedRoleGuids.LogAnalyticsReader
        $ids.logAnalyticsContributor | Should -Be $script:ExpectedRoleGuids.LogAnalyticsContributor
        $ids.reader | Should -Be $script:ExpectedRoleGuids.Reader
        $ids.contributor | Should -Be $script:ExpectedRoleGuids.Contributor
    }

    It "the compiled Low role set is exactly [Log Analytics Reader, Reader]" {
        $low = @($script:CompiledModule.variables.roleDefinitions.Low)
        $low.Count | Should -Be 2
        $low | Should -Contain "[variables('roleDefinitionIds').logAnalyticsReader]"
        $low | Should -Contain "[variables('roleDefinitionIds').reader]"
        $low | Should -Not -Contain "[variables('roleDefinitionIds').logAnalyticsContributor]"
    }

    It "the compiled High role set is exactly [Log Analytics Contributor, Reader, Contributor]" {
        $high = @($script:CompiledModule.variables.roleDefinitions.High)
        $high.Count | Should -Be 3
        $high | Should -Contain "[variables('roleDefinitionIds').logAnalyticsContributor]"
        $high | Should -Contain "[variables('roleDefinitionIds').reader]"
        $high | Should -Contain "[variables('roleDefinitionIds').contributor]"
        $high | Should -Not -Contain "[variables('roleDefinitionIds').logAnalyticsReader]"
    }

    It "the compiled managedResourceGroupId variable resolves to the resourceGroup().id ARM function" {
        $script:CompiledModule.variables.managedResourceGroupId | Should -Be "[resourceGroup().id]"
    }

    It "every compiled Microsoft.App/agents resource binds managedResources to managedResourceGroupId only" {
        $agentResources = @($script:CompiledModule.resources | Where-Object { $_.type -eq 'Microsoft.App/agents' })
        $agentResources.Count | Should -BeGreaterThan 0

        # This module expresses `properties` as a shared variable reference
        # (`properties: agentProperties`), so every conditional agent
        # resource must reference that exact variable...
        foreach ($agentResource in $agentResources) {
            $agentResource.properties | Should -Be "[variables('agentProperties')]"
        }

        # ...and that variable's actual (compiled) value must bind
        # managedResources to exactly the resourceGroupId variable.
        $managedResources = @($script:CompiledModule.variables.agentProperties.knowledgeGraphConfiguration.managedResources)
        $managedResources.Count | Should -Be 1
        $managedResources[0] | Should -Be "[variables('managedResourceGroupId')]"
    }

    It "the shared agentProperties variable has actionConfiguration.mode literally 'Review'" {
        $script:CompiledModule.variables.agentProperties.actionConfiguration.mode | Should -Be 'Review'

        # And every conditional agent resource actually uses that variable.
        $agentResources = @($script:CompiledModule.resources | Where-Object { $_.type -eq 'Microsoft.App/agents' })
        $agentResources.Count | Should -BeGreaterThan 0
        foreach ($agentResource in $agentResources) {
            $agentResource.properties | Should -Be "[variables('agentProperties')]"
        }
    }

    It "roleAssignments resources are scoped by resourceGroup().id, never subscription().id" {
        $roleAssignments = @($script:CompiledModule.resources | Where-Object { $_.type -eq 'Microsoft.Authorization/roleAssignments' -and $_.copy })
        $roleAssignments.Count | Should -BeGreaterThan 0
        foreach ($assignment in $roleAssignments) {
            $assignment.name | Should -Match "resourceGroup\(\)\.id"
            $assignment.name | Should -Not -Match "subscription\(\)\.id"
        }
    }

    It "pins apiVersion to exactly the two validated allowed values" {
        $allowed = @($script:CompiledModule.parameters.apiVersion.allowedValues)
        $allowed | Should -Be @('2026-01-01', '2025-05-01-preview')
    }
}

Describe "infra/bicep/main.bicep — compiled template (az bicep build)" -Skip:(-not $script:AzAvailableForSkip) {
    BeforeAll {
        if (-not $script:CompiledMain) {
            throw "az bicep build did not produce a valid compiled template for $script:MainBicepPath."
        }
    }

    It "wires sreAgentApiVersion through to the sre-agent module" {
        # main.bicep is a subscription-scope template, which Bicep compiles
        # using the symbolic-name resource format (an object keyed by
        # symbolic name, e.g. "sreAgent"), not a plain array.
        $sreAgentModule = $script:CompiledMain.resources.sreAgent
        $sreAgentModule | Should -Not -BeNullOrEmpty
        $sreAgentModule.properties.parameters.apiVersion.value | Should -Be "[parameters('sreAgentApiVersion')]"
    }

    It "exposes the assigned role definition IDs and access level as top-level outputs" {
        $script:CompiledMain.outputs.sreAgentAccessLevel | Should -Not -BeNullOrEmpty
        $script:CompiledMain.outputs.sreAgentAssignedRoleDefinitionIds | Should -Not -BeNullOrEmpty
    }
}

Describe "infra/bicep/modules/sre-agent.bicep — source guards for what the compiler cannot prove" {
    # These remain as source-text assertions only for properties the ARM
    # compiler doesn't surface distinctly from ordinary strings (e.g. there is
    # no compiled signal that would distinguish "an empty array happens to be
    # correct" from "someone reintroduced managedResources: []" other than
    # reading the source — the compiled-template tests above already prove
    # the *deployed* value is never empty using the real variable reference).
    It "never declares a bare empty managedResources array literal in source" {
        $script:BicepContent | Should -Not -Match 'managedResources:\s*\[\s*\]'
    }
}

Describe "scripts/configure-rbac.ps1 — least-scope RBAC for the SRE Agent identity" {
    # PowerShell control flow (which -Scope string is actually used per call)
    # is not something `az bicep build` can prove — this script isn't Bicep —
    # so this stays a source guard.
    It "never assigns a subscription-scoped role to the SRE Agent principal" {
        # Regression guard for the "no subscription-wide Reader shortcut"
        # requirement in issue #18. Grafana's subscription-scoped Monitoring
        # Reader assignment is unrelated and intentionally out of scope.
        $script:RbacContent | Should -Not -Match 'PrincipalId\s+\$SreAgentPrincipalId[\s\S]{0,400}?-Scope\s+"/subscriptions/\$subscriptionId"\s'
    }

    It "still assigns Contributor to the SRE Agent principal scoped to the resource group" {
        $script:RbacContent | Should -Match '-Scope\s+"/subscriptions/\$subscriptionId/resourceGroups/\$ResourceGroupName"[\s\S]{0,200}?PrincipalId\s+\$SreAgentPrincipalId'
    }
}

Describe "infra/terraform/modules/sre-agent/main.tf — mirrors the corrected Bicep role mapping" {
    It "maps log_analytics_reader and log_analytics_contributor to the verified, distinct GUIDs" {
        $script:TerraformContent | Should -Match ([regex]::Escape('log_analytics_reader'))
        $script:TerraformContent | Should -Match ([regex]::Escape($script:ExpectedRoleGuids.LogAnalyticsReader))
        $script:TerraformContent | Should -Match ([regex]::Escape($script:ExpectedRoleGuids.LogAnalyticsContributor))
    }

    It "Low uses Log Analytics Reader (not Contributor) plus Reader" {
        if ($script:TerraformContent -match '(?s)Low\s*=\s*\[(.*?)\]') {
            $lowBlock = $Matches[1]
            $lowBlock | Should -Match ([regex]::Escape('local.role_definition_ids.log_analytics_reader'))
            $lowBlock | Should -Match ([regex]::Escape('local.role_definition_ids.reader'))
            $lowBlock | Should -Not -Match ([regex]::Escape('local.role_definition_ids.log_analytics_contributor'))
        }
        else {
            throw "Could not locate the Low role_definitions block in $script:TerraformModulePath"
        }
    }

    It "High uses Log Analytics Contributor plus Reader and Contributor" {
        if ($script:TerraformContent -match '(?s)High\s*=\s*\[(.*?)\]') {
            $highBlock = $Matches[1]
            $highBlock | Should -Match ([regex]::Escape('local.role_definition_ids.log_analytics_contributor'))
            $highBlock | Should -Match ([regex]::Escape('local.role_definition_ids.reader'))
            $highBlock | Should -Match ([regex]::Escape('local.role_definition_ids.contributor'))
        }
        else {
            throw "Could not locate the High role_definitions block in $script:TerraformModulePath"
        }
    }

    It "binds managedResources to the actual resource group, not an empty array" {
        $script:TerraformContent | Should -Match 'managedResources\s*=\s*\[data\.azurerm_resource_group\.main\.id\]'
        $script:TerraformContent | Should -Not -Match 'managedResources\s*=\s*\[\]'
    }
}

Describe "infra/bicep/modules/sre-agent-demo-rbac.bicep — compiled template (issue #19 least-scope RBAC)" -Skip:(-not $script:AzAvailableForSkip) {
    BeforeAll {
        if (-not $script:CompiledDemoRbac) {
            throw "az bicep build did not produce a valid compiled template for $script:DemoRbacModulePath."
        }
    }

    It "compiles cleanly with az bicep build" {
        $script:CompiledDemoRbac | Should -Not -BeNullOrEmpty
    }

    It "the custom role's actions are EXACTLY the three actions `az aks command invoke` requires — no more, no less" {
        $roleResource = $script:CompiledDemoRbac.resources | Where-Object { $_.type -eq 'Microsoft.Authorization/roleDefinitions' } | Select-Object -First 1
        $roleResource | Should -Not -BeNullOrEmpty
        $actions = @($roleResource.properties.permissions[0].actions)
        $actions.Count | Should -Be $script:ExpectedMongoDbRemediationActions.Count
        foreach ($expectedAction in $script:ExpectedMongoDbRemediationActions) {
            $actions | Should -Contain $expectedAction
        }
    }

    It "never grants managedClusters/write, credential-listing, or any delete action" {
        $roleResource = $script:CompiledDemoRbac.resources | Where-Object { $_.type -eq 'Microsoft.Authorization/roleDefinitions' } | Select-Object -First 1
        $actions = @($roleResource.properties.permissions[0].actions)
        $actions | Should -Not -Contain 'Microsoft.ContainerService/managedClusters/write'
        $actions | Should -Not -Contain 'Microsoft.ContainerService/managedClusters/listClusterUserCredential/action'
        $actions | Should -Not -Contain 'Microsoft.ContainerService/managedClusters/listClusterAdminCredential/action'
        foreach ($action in $actions) {
            $action | Should -Not -Match '(?i)delete'
        }
    }

    It "the role definition has no wildcard action" {
        $roleResource = $script:CompiledDemoRbac.resources | Where-Object { $_.type -eq 'Microsoft.Authorization/roleDefinitions' } | Select-Object -First 1
        $actions = @($roleResource.properties.permissions[0].actions)
        $actions | Should -Not -Contain '*'
        foreach ($action in $actions) {
            $action | Should -Not -Match '\*'
        }
    }

    It "assignableScopes is EXACTLY the AKS cluster resource ID parameter — never resourceGroup().id or subscription().id" {
        $roleResource = $script:CompiledDemoRbac.resources | Where-Object { $_.type -eq 'Microsoft.Authorization/roleDefinitions' } | Select-Object -First 1
        $scopes = @($roleResource.properties.assignableScopes)
        $scopes.Count | Should -Be 1
        $scopes[0] | Should -Be "[parameters('aksId')]"
    }

    It "the role assignment is scoped to the AKS cluster resource (existing reference), not the role definition or resource group" {
        $assignment = $script:CompiledDemoRbac.resources | Where-Object { $_.type -eq 'Microsoft.Authorization/roleAssignments' } | Select-Object -First 1
        $assignment | Should -Not -BeNullOrEmpty
        $assignment.scope | Should -Match "resourceId\('Microsoft.ContainerService/managedClusters'"
    }
}

Describe "infra/bicep/main.bicep — demo response plan wiring (issue #19)" -Skip:(-not $script:AzAvailableForSkip) {
    BeforeAll {
        if (-not $script:CompiledMain) {
            throw "az bicep build did not produce a valid compiled template for $script:MainBicepPath."
        }
    }

    It "deployDemoResponsePlan defaults to false" {
        $script:CompiledMain.parameters.deployDemoResponsePlan.defaultValue | Should -Be $false
    }

    It "wires deployDemoResponsePlan through to sreAgent.enableAzureMonitorIncidents" {
        $sreAgentModule = $script:CompiledMain.resources.sreAgent
        $sreAgentModule.properties.parameters.enableAzureMonitorIncidents.value | Should -Be "[parameters('deployDemoResponsePlan')]"
    }

    It "the demo RBAC module is conditioned on BOTH deploySreAgent AND deployDemoResponsePlan" {
        $demoRbacModule = $script:CompiledMain.resources.sreAgentDemoRbac
        $demoRbacModule | Should -Not -BeNullOrEmpty
        $demoRbacModule.condition | Should -Be "[and(parameters('deploySreAgent'), parameters('deployDemoResponsePlan'))]"
    }

    It "the alerts module deploys when EITHER deployAlerts OR deployDemoResponsePlan is true (so the demo alert can exist independent of the standard alert set)" {
        $alertsModule = $script:CompiledMain.resources.alerts
        $alertsModule | Should -Not -BeNullOrEmpty
        $alertsModule.condition | Should -Be "[or(parameters('deployAlerts'), parameters('deployDemoResponsePlan'))]"
    }

    It "passes deployStandardAlerts=deployAlerts and deployMongoDbDownDemoAlert=deployDemoResponsePlan independently to the alerts module" {
        $alertsModule = $script:CompiledMain.resources.alerts
        $alertsModule.properties.parameters.deployStandardAlerts.value | Should -Be "[parameters('deployAlerts')]"
        $alertsModule.properties.parameters.deployMongoDbDownDemoAlert.value | Should -Be "[parameters('deployDemoResponsePlan')]"
    }
}

Describe "infra/bicep/modules/sre-agent.bicep — incidentManagementConfiguration (issue #19)" -Skip:(-not $script:AzAvailableForSkip) {
    BeforeAll {
        if (-not $script:CompiledModule) {
            throw "az bicep build did not produce a valid compiled template for $script:BicepModulePath."
        }
    }

    It "incidentManagementConfiguration is conditional on enableAzureMonitorIncidents and resolves to type AzMonitor when enabled" {
        $expr = $script:CompiledModule.variables.agentProperties.incidentManagementConfiguration
        $expr | Should -Match "if\(parameters\('enableAzureMonitorIncidents'\)"
        $expr | Should -Match "createObject\('type', 'AzMonitor'\)"
    }

    It "actionConfiguration.mode and knowledgeGraphConfiguration remain plain (non-conditional) literals regardless of incidentManagementConfiguration (regression: must not break existing compiled-template assertions)" {
        $script:CompiledModule.variables.agentProperties.actionConfiguration.mode | Should -Be 'Review'
        $managedResources = @($script:CompiledModule.variables.agentProperties.knowledgeGraphConfiguration.managedResources)
        $managedResources.Count | Should -Be 1
        $managedResources[0] | Should -Be "[variables('managedResourceGroupId')]"
    }

    It "enableAzureMonitorIncidents defaults to false" {
        $script:CompiledModule.parameters.enableAzureMonitorIncidents.defaultValue | Should -Be $false
    }
}

Describe "infra/bicep/modules/alerts.bicep — MongoDB-down demo alert (issue #19)" -Skip:(-not $script:AzAvailableForSkip) {
    BeforeAll {
        if (-not $script:CompiledAlerts) {
            throw "az bicep build did not produce a valid compiled template for $script:AlertsModulePath."
        }
    }

    It "deployMongoDbDownDemoAlert and deployStandardAlerts both default appropriately (demo alert off, standard alerts on)" {
        $script:CompiledAlerts.parameters.deployMongoDbDownDemoAlert.defaultValue | Should -Be $false
        $script:CompiledAlerts.parameters.deployStandardAlerts.defaultValue | Should -Be $true
    }

    It "the four standard alerts are each conditioned on deployStandardAlerts, and the demo alert is conditioned on deployMongoDbDownDemoAlert (independent switches)" {
        # alerts.bicep is a resource-group-scoped module, so az bicep build
        # emits `resources` as a plain array (unlike main.bicep's
        # subscription-scope symbolic-name object) — match by resource name.
        foreach ($nameFragment in @('-pod-restarts', '-http-5xx', '-pod-failures', '-crashloop-oom')) {
            $resource = $script:CompiledAlerts.resources | Where-Object { $_.name -match [regex]::Escape($nameFragment) } | Select-Object -First 1
            $resource | Should -Not -BeNullOrEmpty
            $resource.condition | Should -Be "[parameters('deployStandardAlerts')]"
        }
        $demoAlert = $script:CompiledAlerts.resources | Where-Object { $_.name -match '-demo-mongodb-down' } | Select-Object -First 1
        $demoAlert | Should -Not -BeNullOrEmpty
        $demoAlert.condition | Should -Be "[parameters('deployMongoDbDownDemoAlert')]"
    }

    It "the demo alert's query counts Running mongodb pods and fires on zero (not on Failed/Pending, which the existing pod-failure alert already covers)" {
        $demoAlert = $script:CompiledAlerts.resources | Where-Object { $_.name -match '-demo-mongodb-down' } | Select-Object -First 1
        $query = $demoAlert.properties.criteria.allOf[0].query
        $query | Should -Match 'PodStatus == "Running"'
        $query | Should -Match 'RunningCount == 0'
    }

    It "the demo alert uses a bounded, deterministic evaluation window (PT1M frequency / PT5M window)" {
        $demoAlert = $script:CompiledAlerts.resources | Where-Object { $_.name -match '-demo-mongodb-down' } | Select-Object -First 1
        $demoAlert.properties.evaluationFrequency | Should -Be 'PT1M'
        $demoAlert.properties.windowSize | Should -Be 'PT5M'
    }
}

Describe "Version-controlled deployment profiles (issue #19)" {
    It "main.bicepparam (standard profile) never sets deployDemoResponsePlan=true" {
        $script:StandardParamsContent | Should -Not -Match 'deployDemoResponsePlan\s*=\s*true'
    }

    It "main.demo.bicepparam explicitly enables deployAlerts and deployDemoResponsePlan" {
        $script:DemoParamsContent | Should -Match 'deployAlerts\s*=\s*true'
        $script:DemoParamsContent | Should -Match 'deployDemoResponsePlan\s*=\s*true'
    }

    It "main.demo.bicepparam still uses 'main.bicep' (not a forked template)" {
        $script:DemoParamsContent | Should -Match "using\s+'main\.bicep'"
    }
}

Describe "infra/bicep/modules/sre-agent-monitoring-rbac.bicep — compiled template (issue #19 round 2: Azure Monitor scanner RBAC)" -Skip:(-not $script:AzAvailableForSkip) {
    BeforeAll {
        if (-not $script:CompiledMonitoringRbac) {
            throw "az bicep build did not produce a valid compiled template for $script:MonitoringRbacModulePath."
        }
    }

    It "compiles cleanly with az bicep build" {
        $script:CompiledMonitoringRbac | Should -Not -BeNullOrEmpty
    }

    It "targets subscription scope (not resourceGroup)" {
        $script:CompiledMonitoringRbac.'$schema' | Should -Match 'subscriptionDeploymentTemplate'
    }

    It "grants EXACTLY the Monitoring Contributor role (749f88d5-cbae-40b8-bcfc-e573ddc772fa) — not Contributor/Owner" {
        $assignment = $script:CompiledMonitoringRbac.resources | Where-Object { $_.type -eq 'Microsoft.Authorization/roleAssignments' } | Select-Object -First 1
        $assignment | Should -Not -BeNullOrEmpty
        $script:CompiledMonitoringRbac.variables.monitoringContributorRoleId | Should -Be $script:MonitoringContributorRoleId
        $assignment.properties.roleDefinitionId | Should -Match "variables\('monitoringContributorRoleId'\)"
    }

    It "the role assignment resource has no explicit 'scope' property (deploys at the module's own subscription targetScope, not resourceGroup-scoped)" {
        $assignment = $script:CompiledMonitoringRbac.resources | Where-Object { $_.type -eq 'Microsoft.Authorization/roleAssignments' } | Select-Object -First 1
        $assignment.PSObject.Properties.Name | Should -Not -Contain 'scope'
    }
}

Describe "infra/bicep/main.bicep — Monitoring Contributor wiring requires explicit acknowledgement (issue #19 round 2)" -Skip:(-not $script:AzAvailableForSkip) {
    BeforeAll {
        if (-not $script:CompiledMain) {
            throw "az bicep build did not produce a valid compiled template for $script:MainBicepPath."
        }
    }

    It "acknowledgeSubscriptionScopeMonitoringRbac defaults to false" {
        $script:CompiledMain.parameters.acknowledgeSubscriptionScopeMonitoringRbac.defaultValue | Should -Be $false
    }

    It "the monitoring-rbac module is conditioned on deploySreAgent AND deployDemoResponsePlan AND the explicit acknowledgement flag — never on deployDemoResponsePlan alone" {
        $monitoringRbacModule = $script:CompiledMain.resources.sreAgentMonitoringRbac
        $monitoringRbacModule | Should -Not -BeNullOrEmpty
        $condition = $monitoringRbacModule.condition
        $condition | Should -Match "parameters\('deploySreAgent'\)"
        $condition | Should -Match "parameters\('deployDemoResponsePlan'\)"
        $condition | Should -Match "parameters\('acknowledgeSubscriptionScopeMonitoringRbac'\)"
    }

    It "the monitoring-rbac module has no explicit resourceGroup scope (deploys at subscription scope, matching main.bicep's own targetScope)" {
        $monitoringRbacModule = $script:CompiledMain.resources.sreAgentMonitoringRbac
        $monitoringRbacModule.properties.PSObject.Properties.Name | Should -Not -Contain 'scope'
    }
}

Describe "main.demo.bicepparam — explicit Monitoring Contributor acknowledgement (issue #19 round 2)" {
    It "explicitly sets acknowledgeSubscriptionScopeMonitoringRbac = true, visibly in source control" {
        $script:DemoParamsContent | Should -Match 'acknowledgeSubscriptionScopeMonitoringRbac\s*=\s*true'
    }
}

Describe "main.bicepparam (standard profile) — never acknowledges subscription-scope Monitoring RBAC" {
    It "never sets acknowledgeSubscriptionScopeMonitoringRbac = true" {
        $script:StandardParamsContent | Should -Not -Match 'acknowledgeSubscriptionScopeMonitoringRbac\s*=\s*true'
    }
}

Describe "scripts/deploy.ps1 — explicit operator acknowledgement gate for subscription-scope Monitoring RBAC (issue #19 round 2)" {
    It "requires -AcceptSubscriptionScopeMonitoringRbac before passing acknowledgeSubscriptionScopeMonitoringRbac=true, and this is never implied by -Yes alone" {
        $script:DeployScriptContent | Should -Match 'AcceptSubscriptionScopeMonitoringRbac'
        $script:DeployScriptContent | Should -Match 'DeployDemoResponsePlan\s+-and\s+-not\s+\$AcceptSubscriptionScopeMonitoringRbac'
    }

    It "exits with an error when the demo response plan is requested without explicit subscription-scope acknowledgement" {
        $script:DeployScriptContent | Should -Match 'Refusing to deploy the demo response plan without explicit subscription-scope RBAC acknowledgement'
    }
}

Describe "infra/bicep/modules/sre-agent.bicep — demoLeastPrivilegeRbac (issue #19 round 2: least-scope remediation)" -Skip:(-not $script:AzAvailableForSkip) {
    BeforeAll {
        if (-not $script:CompiledModule) {
            throw "az bicep build did not produce a valid compiled template for $script:BicepModulePath."
        }
    }

    It "demoLeastPrivilegeRbac defaults to false (standard-profile behavior unchanged)" {
        $script:CompiledModule.parameters.demoLeastPrivilegeRbac.defaultValue | Should -Be $false
    }

    It "effectiveRoleDefinitions is conditional: demoLeastPrivilegeRbac selects [Reader, Log Analytics Reader] ONLY (no Contributor), else falls back to roleDefinitions[accessLevel] exactly as before" {
        $expr = $script:CompiledModule.variables.effectiveRoleDefinitions
        $expr | Should -Match "if\(parameters\('demoLeastPrivilegeRbac'\)"
        $expr | Should -Match "variables\('roleDefinitionIds'\)\.reader"
        $expr | Should -Match "variables\('roleDefinitionIds'\)\.logAnalyticsReader"
        $expr | Should -Match "variables\('roleDefinitions'\)\[parameters\('accessLevel'\)\]"
    }

    It "the roleAssignments for-loop iterates over effectiveRoleDefinitions, not the raw roleDefinitions[accessLevel] (regression: must stay wired to the demo-aware selection)" {
        $roleAssignmentsResource = $script:CompiledModule.resources | Where-Object { $_.type -eq 'Microsoft.Authorization/roleAssignments' -and $_.copy } | Select-Object -First 1
        $roleAssignmentsResource | Should -Not -BeNullOrEmpty
        $roleAssignmentsResource.copy.count | Should -Be "[length(variables('effectiveRoleDefinitions'))]"
    }

    It "outputs demoLeastPrivilegeRbacApplied reflecting the parameter" {
        $script:CompiledModule.outputs.demoLeastPrivilegeRbacApplied.value | Should -Be "[parameters('demoLeastPrivilegeRbac')]"
    }
}

Describe "infra/bicep/main.bicep — demoLeastPrivilegeRbac wired from deployDemoResponsePlan (issue #19 round 2)" -Skip:(-not $script:AzAvailableForSkip) {
    BeforeAll {
        if (-not $script:CompiledMain) {
            throw "az bicep build did not produce a valid compiled template for $script:MainBicepPath."
        }
    }

    It "passes demoLeastPrivilegeRbac=deployDemoResponsePlan to the sreAgent module (so demo profile forces least-privilege RG RBAC, standard profile is unaffected)" {
        $sreAgentModule = $script:CompiledMain.resources.sreAgent
        $sreAgentModule.properties.parameters.demoLeastPrivilegeRbac.value | Should -Be "[parameters('deployDemoResponsePlan')]"
    }
}
