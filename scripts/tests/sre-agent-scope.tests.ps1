#Requires -Modules Pester

<#
.SYNOPSIS
    Regression guards for issue #18: SRE Agent must be bound to the exact lab
    resource group (no drift), pinned to a validated API version, kept in
    Review mode, and never granted subscription-wide RBAC.

.DESCRIPTION
    These are static content assertions (not live Azure calls) so they run
    anywhere without credentials, and they fail loudly if a future edit
    reintroduces:
      - an empty/removed knowledgeGraphConfiguration.managedResources binding
      - a subscription-wide Reader/Contributor shortcut for the SRE Agent's
        managed identity in scripts/configure-rbac.ps1
      - a non-Review actionConfiguration.mode default
      - an unpinned / unvalidated Microsoft.App/agents API version

.EXAMPLE
    Invoke-Pester -Path scripts/tests/sre-agent-scope.tests.ps1
#>

BeforeAll {
    $script:RepoRoot = Join-Path $PSScriptRoot ".." ".."
    $script:BicepPath = Join-Path $script:RepoRoot "infra/bicep/modules/sre-agent.bicep"
    $script:RbacScriptPath = Join-Path $script:RepoRoot "scripts/configure-rbac.ps1"
    $script:BicepContent = Get-Content -Path $script:BicepPath -Raw
    $script:RbacContent = Get-Content -Path $script:RbacScriptPath -Raw
}

Describe "infra/bicep/modules/sre-agent.bicep — exact resource group binding" {
    It "binds managedResources to resourceGroup().id, not an empty array" {
        $script:BicepContent | Should -Match 'managedResources:\s*\[\s*managedResourceGroupId\s*\]'
        $script:BicepContent | Should -Match "var managedResourceGroupId = resourceGroup\(\)\.id"
    }

    It "never declares an empty managedResources array" {
        $script:BicepContent | Should -Not -Match 'managedResources:\s*\[\s*\]'
    }

    It "defaults actionConfiguration.mode to Review" {
        $script:BicepContent | Should -Match "mode:\s*'Review'"
    }

    It "pins the API version to an explicit allowed list rather than an unvalidated default" {
        $script:BicepContent | Should -Match "@allowed\(\[\s*'2026-01-01'\s*'2025-05-01-preview'\s*\]\)"
    }

    It "role assignments are scoped to this resource group, not the subscription" {
        # The only roleAssignments resource in this module must use
        # resourceGroup().id as its guid seed / scope anchor, never
        # subscription().id.
        $script:BicepContent | Should -Not -Match "subscription\(\)\.id"
    }
}

Describe "scripts/configure-rbac.ps1 — least-scope RBAC for the SRE Agent identity" {
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
