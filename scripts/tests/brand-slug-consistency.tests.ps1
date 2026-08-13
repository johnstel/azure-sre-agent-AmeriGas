#Requires -Modules Pester

<#
.SYNOPSIS
    Pester regression test guarding against ZavaGas slug/workload drift
    (issue #27 follow-up): catches any file that uses a
    "zavagas-propane"/"zavagas_propane"-style value that is NOT exactly the
    canonical slug `zavagas-propane-demo`, and any Mission Control package
    name that is not exactly `zavagas-mission-control`.

.DESCRIPTION
    This is a narrow, mechanical drift guard, distinct from the broader
    scripts/audit-brand-policy.ps1 real-brand-name audit: it does not care
    whether "AmeriGas" appears, only whether every occurrence of the
    "zavagas-propane" family of slugs is byte-for-byte consistent with the
    one canonical value used across Bicep tags, Kubernetes labels, and
    package metadata. A prior review found `infra/bicep/modules/alerts.bicep`
    using `zavagas-propane` (missing the `-demo` suffix) while every other
    file used `zavagas-propane-demo` — this test fails loudly if that ever
    regresses or reappears elsewhere.

    Scans:
      - infra/bicep/**/*.bicep and *.bicepparam
      - infra/terraform/**/*.tf (present in this repo; scanned for
        completeness even though its default tags currently use an
        unrelated, pre-existing "energy-grid-demo" theme with no
        zavagas-propane reference at all — see the dedicated It block
        below documenting that finding)
      - k8s/base/application.yaml and k8s/scenarios/*.yaml
      - tools/mission-control/package.json

.EXAMPLE
    Invoke-Pester -Path scripts/tests/brand-slug-consistency.tests.ps1
#>

BeforeAll {
    $script:RepoRoot = Join-Path $PSScriptRoot ".." ".."
    $script:CanonicalSlug = 'zavagas-propane-demo'
    $script:CanonicalPackageName = 'zavagas-mission-control'

    # Matches "zavagas-propane" / "zavagas_propane" (any case) NOT
    # immediately followed by "-demo" (case-insensitive) or "_demo" — i.e.
    # any drifted/incomplete variant of the canonical slug.
    $script:DriftPattern = '(?i)zavagas[-_]propane(?!-demo|_demo)\b'

    function Get-BrandSlugDriftHits {
        [CmdletBinding()]
        param(
            [Parameter(Mandatory = $true)][string[]]$Paths
        )

        $hits = @()
        foreach ($path in $Paths) {
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
            $lines = Get-Content -LiteralPath $path
            for ($i = 0; $i -lt $lines.Count; $i++) {
                if ($lines[$i] -match $script:DriftPattern) {
                    $hits += [pscustomobject]@{
                        File = (Resolve-Path -LiteralPath $path -Relative -RelativeBasePath $script:RepoRoot).TrimStart('.', '/', '\')
                        Line = $i + 1
                        Text = $lines[$i].Trim()
                    }
                }
            }
        }
        return $hits
    }

    $script:BicepFiles = @(Get-ChildItem -Path (Join-Path $script:RepoRoot 'infra' 'bicep') -Recurse -Include '*.bicep', '*.bicepparam' -File | Select-Object -ExpandProperty FullName)
    $script:TerraformFiles = @(Get-ChildItem -Path (Join-Path $script:RepoRoot 'infra' 'terraform') -Recurse -Include '*.tf' -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
    $script:K8sFiles = @(
        (Join-Path $script:RepoRoot 'k8s' 'base' 'application.yaml')
    ) + @(Get-ChildItem -Path (Join-Path $script:RepoRoot 'k8s' 'scenarios') -Filter '*.yaml' -File | Select-Object -ExpandProperty FullName)
    $script:PackageJsonPath = Join-Path $script:RepoRoot 'tools' 'mission-control' 'package.json'
}

Describe "ZavaGas slug/workload consistency (drift guard)" {
    It "found Bicep files to scan (sanity check that the scan isn't silently empty)" {
        $script:BicepFiles.Count | Should -BeGreaterThan 0
    }

    It "found k8s manifest files to scan" {
        $script:K8sFiles.Count | Should -BeGreaterThan 0
    }

    It "every 'zavagas-propane'/'zavagas_propane' occurrence in Bicep files is exactly the canonical slug 'zavagas-propane-demo'" {
        $hits = Get-BrandSlugDriftHits -Paths $script:BicepFiles
        if ($hits.Count -gt 0) {
            $details = ($hits | ForEach-Object { "$($_.File):$($_.Line): $($_.Text)" }) -join "`n"
            throw "Found $($hits.Count) drifted zavagas-propane slug reference(s) in Bicep files (expected exactly '$($script:CanonicalSlug)'):`n$details"
        }
        $hits.Count | Should -Be 0
    }

    It "every 'zavagas-propane'/'zavagas_propane' occurrence in k8s manifests is exactly the canonical slug 'zavagas-propane-demo'" {
        $hits = Get-BrandSlugDriftHits -Paths $script:K8sFiles
        if ($hits.Count -gt 0) {
            $details = ($hits | ForEach-Object { "$($_.File):$($_.Line): $($_.Text)" }) -join "`n"
            throw "Found $($hits.Count) drifted zavagas-propane slug reference(s) in k8s manifests (expected exactly '$($script:CanonicalSlug)'):`n$details"
        }
        $hits.Count | Should -Be 0
    }

    It "every 'zavagas-propane'/'zavagas_propane' occurrence in Terraform files (if any) is exactly the canonical slug 'zavagas-propane-demo'" {
        if ($script:TerraformFiles.Count -eq 0) {
            Set-ItResult -Skipped -Because "no *.tf files found under infra/terraform"
            return
        }
        $hits = Get-BrandSlugDriftHits -Paths $script:TerraformFiles
        if ($hits.Count -gt 0) {
            $details = ($hits | ForEach-Object { "$($_.File):$($_.Line): $($_.Text)" }) -join "`n"
            throw "Found $($hits.Count) drifted zavagas-propane slug reference(s) in Terraform files (expected exactly '$($script:CanonicalSlug)'):`n$details"
        }
        $hits.Count | Should -Be 0
    }

    It "documents that infra/terraform currently uses an unrelated, pre-existing 'energy-grid-demo' tag theme (out of scope for issue #27 -- it never said AmeriGas or ZavaGas at all)" {
        $variablesPath = Join-Path $script:RepoRoot 'infra' 'terraform' 'variables.tf'
        if (-not (Test-Path -LiteralPath $variablesPath)) {
            Set-ItResult -Skipped -Because "infra/terraform/variables.tf not found"
            return
        }
        $content = Get-Content -Raw -LiteralPath $variablesPath
        # This assertion exists purely to document the finding for future
        # readers; it is NOT a rebrand requirement for issue #27 (this
        # Terraform stack predates the AmeriGas theme entirely per git
        # history: 'Re-theme from Energy Grid to AmeriGas Propane
        # Distribution Platform' never touched infra/terraform/variables.tf).
        $content | Should -Match 'energy-grid-demo'
        $content | Should -Not -Match '(?i)amerigas'
        $content | Should -Not -Match '(?i)zavagas'
    }

    It "the Mission Control package name is exactly 'zavagas-mission-control'" {
        Test-Path -LiteralPath $script:PackageJsonPath -PathType Leaf | Should -Be $true
        $package = Get-Content -Raw -LiteralPath $script:PackageJsonPath | ConvertFrom-Json
        $package.name | Should -Be $script:CanonicalPackageName
    }

    It "negative control: the drift pattern actually detects an injected incomplete slug (proves this test isn't vacuously passing)" {
        $syntheticLines = @("    workload: 'zavagas-propane'")
        $matched = $syntheticLines[0] -match $script:DriftPattern
        $matched | Should -Be $true

        $canonicalLine = "    workload: 'zavagas-propane-demo'"
        ($canonicalLine -match $script:DriftPattern) | Should -Be $false
    }
}
