<#
.SYNOPSIS
    Non-destructively migrates an already-deployed ZavaGas demo lab's
    mutable Azure tags and Kubernetes labels/catalog from the former
    "amerigas-propane-demo" brand slug to "zavagas-propane-demo" (issue #27).

.DESCRIPTION
    This script does NOT delete, rename, or recreate any Azure resource or
    Kubernetes object identity. It only:

      1. Updates the `workload` tag (Merge operation — other tags are left
         alone) on the resource group itself and on every child resource in
         it that currently carries the old `workload=amerigas-propane-demo`
         tag, to `workload=zavagas-propane-demo`. After each update it
         re-reads the resource to verify the new tag actually took effect,
         and throws with a clear message if verification fails.
      2. Regenerates the `partner-catalog-config` ConfigMap from the
         repo-owned tools/mission-control/data/partner-catalog.json (the
         single source of truth for the shared fictional partner catalog)
         and reapplies k8s/base/application.yaml, exactly like
         scripts/deploy.ps1 does for a fresh deployment. `kubectl apply` is
         inherently non-destructive here: it updates in place any object
         whose name/namespace already matches (labels, ConfigMap content,
         image tags, etc.) and does not delete anything, because this
         script never passes `--prune`.

    Mission Control's resource-group discovery
    (tools/mission-control/deployment-scope.js) remains deterministic
    across this migration: it resolves ONLY from explicit configuration —
    the MISSION_CONTROL_SUBSCRIPTION_ID/MISSION_CONTROL_RESOURCE_GROUP
    environment variables (or their AZURE_SUBSCRIPTION_ID/
    AZURE_RESOURCE_GROUP/MISSION_CONTROL_RESOURCE_GROUP_NAME aliases), or an
    explicit readiness request parameter that must match that configuration
    exactly. It never reads or depends on any Azure resource tag value, and
    has no tag-based fallback of any kind, so migrating the mutable
    `workload` tag with this script can never change which
    subscription/resource group Mission Control considers "the" deployed
    lab.

    Requires an EXPLICIT -SubscriptionId and -ResourceGroupName — there is
    no default and no "find the resource group by searching for the old
    brand string" behavior. You must know which subscription/resource
    group you are migrating.

.PARAMETER SubscriptionId
    REQUIRED. The exact Azure subscription ID containing the deployed lab.

.PARAMETER ResourceGroupName
    REQUIRED. The exact resource group name of the deployed lab (e.g.
    rg-srelab-eastus2). This script never renames it — only its tags (and
    its child resources' tags) are updated.

.PARAMETER Namespace
    Kubernetes namespace the deployed manifests live in. Defaults to
    'propane' (the namespace name is brand-neutral and is never migrated).

.PARAMETER SkipKubernetesApply
    Skip the ConfigMap regeneration / kubectl re-apply step entirely — use
    this to migrate only the Azure tags (e.g. when no kubeconfig is
    configured for this cluster from the current machine).

.PARAMETER RepoRoot
    Root of this repository. Defaults to the parent of this script's
    directory. Used to locate k8s/base/application.yaml and
    tools/mission-control/data/partner-catalog.json.

.OUTPUTS
    Writes progress/verification to the host. Throws (non-zero exit) on
    any failure — this script never silently swallows an error.

.EXAMPLE
    # Dry run: show exactly what would change without touching anything.
    pwsh scripts/migrate-brand-tags.ps1 -SubscriptionId 00000000-0000-0000-0000-000000000000 -ResourceGroupName rg-srelab-eastus2 -WhatIf

.EXAMPLE
    # Apply the migration for real.
    pwsh scripts/migrate-brand-tags.ps1 -SubscriptionId 00000000-0000-0000-0000-000000000000 -ResourceGroupName rg-srelab-eastus2

.EXAMPLE
    # Migrate only Azure tags, skip the Kubernetes manifest reapply.
    pwsh scripts/migrate-brand-tags.ps1 -SubscriptionId 00000000-0000-0000-0000-000000000000 -ResourceGroupName rg-srelab-eastus2 -SkipKubernetesApply

.NOTES
    There is no live Azure environment available while this script was
    authored and tested (no rg-srelab* resource group exists in the target
    subscription) — see scripts/tests/migrate-brand-tags.tests.ps1, which
    validates this script's logic entirely with mocked `az`/`kubectl` calls
    and -WhatIf, never against a real deployment.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$SubscriptionId,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ResourceGroupName,

    [string]$Namespace = 'propane',

    [switch]$SkipKubernetesApply,

    [string]$RepoRoot = (Join-Path $PSScriptRoot "..")
)

$ErrorActionPreference = 'Stop'

$script:OldWorkloadTag = 'amerigas-propane-demo'
$script:NewWorkloadTag = 'zavagas-propane-demo'

function Get-MigrationResourceGroup {
    <#
    .SYNOPSIS
        Reads the resource group via `az group show`. Throws a clear,
        specific error if it does not exist rather than treating a missing
        resource group as "nothing to migrate".
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$SubscriptionId,
        [Parameter(Mandatory = $true)][string]$ResourceGroupName
    )

    $rgJson = az group show --name $ResourceGroupName --subscription $SubscriptionId -o json 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($rgJson)) {
        throw "Resource group '$ResourceGroupName' was not found in subscription '$SubscriptionId'. Verify -SubscriptionId/-ResourceGroupName and that you are logged in ('az login')."
    }

    return $rgJson | ConvertFrom-Json -Depth 20
}

function Update-BrandWorkloadTag {
    <#
    .SYNOPSIS
        Merges workload=zavagas-propane-demo onto a single resource (by
        exact Azure resource ID) and verifies the change by re-reading the
        resource. Throws on any az/verification failure — never swallows
        an error silently. No-ops (with a message) if the tag already
        matches, and never touches a resource with no workload tag at all
        (that resource is simply out of scope for this migration).
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)][string]$SubscriptionId,
        [Parameter(Mandatory = $true)][string]$ResourceId,
        [Parameter(Mandatory = $true)][string]$DisplayName,
        [AllowNull()][AllowEmptyString()][string]$CurrentWorkloadTag
    )

    if ([string]::IsNullOrEmpty($CurrentWorkloadTag)) {
        Write-Verbose "Skipping '$DisplayName' — no workload tag present (out of scope for this migration)."
        return $false
    }

    if ($CurrentWorkloadTag -eq $script:NewWorkloadTag) {
        Write-Host "  '$DisplayName' is already tagged workload=$script:NewWorkloadTag — nothing to do." -ForegroundColor DarkGray
        return $false
    }

    $actionDescription = "tag workload=$CurrentWorkloadTag -> workload=$script:NewWorkloadTag"
    if (-not $PSCmdlet.ShouldProcess($DisplayName, $actionDescription)) {
        return $false
    }

    az tag update --resource-id $ResourceId --operation Merge --tags "workload=$script:NewWorkloadTag" --subscription $SubscriptionId --output none | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to update tags on '$DisplayName' ($ResourceId) — 'az tag update' exited with code $LASTEXITCODE."
    }

    # Verify: re-read the live tag value rather than trusting the write.
    $verifyJson = az resource show --ids $ResourceId --subscription $SubscriptionId -o json
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($verifyJson)) {
        throw "Updated tags on '$DisplayName' but could not re-read it to verify the change (exit code $LASTEXITCODE)."
    }

    $verifiedWorkload = ($verifyJson | ConvertFrom-Json -Depth 20).tags.workload
    if ($verifiedWorkload -ne $script:NewWorkloadTag) {
        throw "Tag verification FAILED for '$DisplayName': expected workload='$script:NewWorkloadTag' but the resource now reports workload='$verifiedWorkload'."
    }

    Write-Host "  ✅ '$DisplayName' confirmed as workload=$script:NewWorkloadTag." -ForegroundColor Green
    return $true
}

function Update-BrandWorkloadTagsInResourceGroup {
    <#
    .SYNOPSIS
        Migrates the workload tag on the resource group itself and on
        every child resource that currently carries the old tag value.
        Returns a summary object; throws immediately on the first failure
        (no broad catch-and-swallow — a partially migrated resource group
        must be surfaced, not hidden).
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)][string]$SubscriptionId,
        [Parameter(Mandatory = $true)][string]$ResourceGroupName
    )

    $resourceGroup = Get-MigrationResourceGroup -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName
    $rgWorkloadTag = if ($resourceGroup.tags) { $resourceGroup.tags.workload } else { $null }

    Write-Host "Migrating resource group '$ResourceGroupName' (current workload tag: '$rgWorkloadTag')..." -ForegroundColor Cyan
    $rgUpdated = Update-BrandWorkloadTag -SubscriptionId $SubscriptionId -ResourceId $resourceGroup.id -DisplayName "resource group $ResourceGroupName" -CurrentWorkloadTag $rgWorkloadTag

    $childJson = az resource list --resource-group $ResourceGroupName --subscription $SubscriptionId -o json
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to list resources in resource group '$ResourceGroupName' (exit code $LASTEXITCODE)."
    }
    $childResources = @($childJson | ConvertFrom-Json -Depth 20)

    Write-Host "Migrating $($childResources.Count) child resource(s) in '$ResourceGroupName'..." -ForegroundColor Cyan
    $childUpdatedCount = 0
    foreach ($resource in $childResources) {
        $currentWorkloadTag = if ($resource.tags) { $resource.tags.workload } else { $null }
        $wasUpdated = Update-BrandWorkloadTag -SubscriptionId $SubscriptionId -ResourceId $resource.id -DisplayName $resource.name -CurrentWorkloadTag $currentWorkloadTag
        if ($wasUpdated) { $childUpdatedCount++ }
    }

    return [pscustomobject]@{
        ResourceGroupUpdated = $rgUpdated
        ChildResourcesTotal   = $childResources.Count
        ChildResourcesUpdated = $childUpdatedCount
    }
}

function Invoke-BrandKubernetesReapply {
    <#
    .SYNOPSIS
        Regenerates the partner-catalog-config ConfigMap from the
        repo-owned partner-catalog.json (the same generation step
        scripts/deploy.ps1 performs for a fresh deployment) and reapplies
        k8s/base/application.yaml. Non-destructive: `kubectl apply` without
        `--prune` never deletes objects that are absent from the file, and
        every object it touches keeps its existing name/namespace identity.
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$Namespace
    )

    $partnerCatalogPath = Join-Path $RepoRoot 'tools/mission-control/data/partner-catalog.json'
    if (-not (Test-Path -LiteralPath $partnerCatalogPath -PathType Leaf)) {
        throw "Shared partner catalog not found at: $partnerCatalogPath"
    }

    $manifestPath = Join-Path $RepoRoot 'k8s/base/application.yaml'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Base application manifest not found at: $manifestPath"
    }

    if ($PSCmdlet.ShouldProcess("ConfigMap 'partner-catalog-config' in namespace '$Namespace'", 'kubectl apply (regenerate from partner-catalog.json)')) {
        kubectl create configmap partner-catalog-config --namespace $Namespace "--from-file=partner-catalog.json=$partnerCatalogPath" --dry-run=client -o yaml | kubectl apply -f -
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to reapply the partner-catalog-config ConfigMap (exit code $LASTEXITCODE)."
        }
        Write-Host "  ✅ partner-catalog-config ConfigMap reapplied from $partnerCatalogPath." -ForegroundColor Green
    }

    if ($PSCmdlet.ShouldProcess("k8s/base/application.yaml (customer-portal, dispatch-console, and all other base resources) in namespace '$Namespace'", 'kubectl apply')) {
        kubectl apply -f $manifestPath
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to reapply $manifestPath (exit code $LASTEXITCODE)."
        }
        Write-Host "  ✅ $manifestPath reapplied — customer-portal, dispatch-console, and the shared catalog mount are up to date in namespace '$Namespace'." -ForegroundColor Green
    }
}

# Only run the migration when this file is executed directly (not
# dot-sourced for its functions by Pester tests).
if ($MyInvocation.InvocationName -ne '.') {
    Write-Host "ZavaGas brand tag/label migration" -ForegroundColor Cyan
    Write-Host "  Subscription:    $SubscriptionId"
    Write-Host "  Resource Group:  $ResourceGroupName"
    Write-Host "  Namespace:       $Namespace"
    Write-Host ""

    $tagSummary = Update-BrandWorkloadTagsInResourceGroup -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName

    if ($SkipKubernetesApply) {
        Write-Host "`n-SkipKubernetesApply set — skipping ConfigMap regeneration / kubectl reapply." -ForegroundColor Yellow
    }
    else {
        Write-Host ""
        Invoke-BrandKubernetesReapply -RepoRoot $RepoRoot -Namespace $Namespace
    }

    Write-Host "`nMigration summary:" -ForegroundColor Cyan
    Write-Host "  Resource group tag updated: $($tagSummary.ResourceGroupUpdated)"
    Write-Host "  Child resources tagged workload=$script:NewWorkloadTag: $($tagSummary.ChildResourcesUpdated) / $($tagSummary.ChildResourcesTotal)"
    Write-Host "`nNo Azure resource or Kubernetes object was deleted, renamed, or recreated." -ForegroundColor Green
}
