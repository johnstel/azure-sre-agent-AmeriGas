#Requires -Modules Pester

<#
.SYNOPSIS
    Pester tests for scripts/validate-domain-terminology.ps1

.DESCRIPTION
    Covers:
      - Positive fixture (correctly separated domain vocabulary) reports
        zero violations.
      - Negative fixture (deliberately mixed vocabulary) reports the
        expected violations.
      - The real repository target files (k8s manifests + docs) pass with
        zero violations, acting as a regression guard for issue #4.

.EXAMPLE
    Invoke-Pester -Path scripts/tests/validate-domain-terminology.tests.ps1
#>

BeforeAll {
    $script:ValidatorPath = Join-Path $PSScriptRoot ".." "validate-domain-terminology.ps1"
    $script:FixturesDir = Join-Path $PSScriptRoot "fixtures" "domain-terms"
    $script:RepoRoot = Join-Path $PSScriptRoot ".." ".."

    # Dot-source with an empty -Paths so the file's own top-level execution
    # block (guarded by $MyInvocation.InvocationName -ne '.') is a no-op,
    # and only the reusable functions are defined in this scope.
    . $script:ValidatorPath -Paths @()
}

Describe "Get-DomainTerminologyViolations" {
    Context "Positive fixture — correctly separated domain vocabulary" {
        It "reports zero violations" {
            $lines = Get-Content -Path (Join-Path $script:FixturesDir "valid.md")
            $violations = Get-DomainTerminologyViolations -Lines $lines -FileName "valid.md"
            $violations.Count | Should -Be 0
        }
    }

    Context "Negative fixture — deliberately mixed domain vocabulary" {
        BeforeAll {
            $script:invalidLines = Get-Content -Path (Join-Path $script:FixturesDir "invalid.md")
            $script:invalidViolations = Get-DomainTerminologyViolations -Lines $script:invalidLines -FileName "invalid.md"
        }

        It "reports at least one violation" {
            $script:invalidViolations.Count | Should -BeGreaterThan 0
        }

        It "flags Cylinder Exchange-only terms found inside a Bulk Tank zone" {
            $bulkZoneHits = $script:invalidViolations | Where-Object { $_.Zone -eq 'Bulk Tank' }
            $bulkZoneHits.Count | Should -BeGreaterThan 0
            ($bulkZoneHits | ForEach-Object { $_.ForbiddenDomain }) | Should -Contain 'Cylinder Exchange'
        }

        It "flags Bulk Tank-only terms found inside a Cylinder Exchange zone" {
            $cylinderZoneHits = $script:invalidViolations | Where-Object { $_.Zone -eq 'Cylinder Exchange' }
            $cylinderZoneHits.Count | Should -BeGreaterThan 0
            ($cylinderZoneHits | ForEach-Object { $_.ForbiddenDomain }) | Should -Contain 'Bulk Tank'
        }

        It "does not flag anything inside the Shared zone" {
            $script:invalidViolations | Where-Object { $_.Zone -eq 'Shared' } | Should -BeNullOrEmpty
        }
    }

    Context "Marker parsing" {
        It "recognizes YAML, HTML comment, JS comment, and Markdown bold marker styles" {
            $lines = @(
                "# Domain: Bulk Tank",
                "gallons only here",
                "<!-- Domain: Cylinder Exchange -->",
                "full cylinders only here",
                "// Domain: Shared",
                "full cylinders and gallons can coexist here",
                "**Domain:** Bulk Tank",
                "tank percentage only here"
            )
            $violations = Get-DomainTerminologyViolations -Lines $lines -FileName "marker-styles.txt"
            $violations.Count | Should -Be 0
        }

        It "excludes the multi-line YAML comment paragraph following a marker from scanning" {
            $lines = @(
                "# Domain: Bulk Tank — contrasted with retail cylinder exchange cage",
                "# inventory, which is a different domain entirely.",
                "apiVersion: v1",
                "gallons and tank percentage only"
            )
            $violations = Get-DomainTerminologyViolations -Lines $lines -FileName "comment-paragraph.yaml"
            $violations.Count | Should -Be 0
        }

        It "treats content before the first marker as unmarked and skips it" {
            $lines = @(
                "full cylinders and gallons mentioned before any marker",
                "# Domain: Bulk Tank",
                "gallons only here"
            )
            $violations = Get-DomainTerminologyViolations -Lines $lines -FileName "unmarked-prefix.yaml"
            $violations.Count | Should -Be 0
        }
    }
}

Describe "Repository domain terminology (regression guard for issue #4)" {
    It "reports zero violations across the real repository target files" {
        $result = & $script:ValidatorPath -PassThru
        if ($result.Count -gt 0) {
            $details = ($result | ForEach-Object { "$($_.File):$($_.Line) [$($_.Zone)] '$($_.ForbiddenTerm)'" }) -join "`n"
            throw "Domain terminology violations found in repository files:`n$details"
        }
        $result.Count | Should -Be 0
    }
}
