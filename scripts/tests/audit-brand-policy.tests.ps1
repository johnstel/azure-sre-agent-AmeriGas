#Requires -Modules Pester

<#
.SYNOPSIS
    Pester tests for scripts/audit-brand-policy.ps1

.DESCRIPTION
    Covers:
      - Positive fixture (correctly fictional ZavaGas content, legitimate
        vendor terms) reports zero violations.
      - Negative fixture (deliberately reintroduced AmeriGas + real
        retailer/location terms) reports the expected violations.
      - Legitimate vendor/product names (Microsoft, Azure, Kubernetes, ...)
        are never flagged — the audit only searches for denylist terms, so
        anything not on the denylist (including everything on the
        allowlist) is implicitly safe.
      - Path exclusion / binary detection helpers behave as documented.
      - Running the full audit against the real repository tree returns
        zero violations, acting as a regression guard for issue #27.

.EXAMPLE
    Invoke-Pester -Path scripts/tests/audit-brand-policy.tests.ps1
#>

BeforeAll {
    $script:AuditScriptPath = Join-Path $PSScriptRoot ".." "audit-brand-policy.ps1"
    $script:FixturesDir = Join-Path $PSScriptRoot "fixtures" "brand-policy"
    $script:RepoRoot = Join-Path $PSScriptRoot ".." ".."
    $script:PolicyPath = Join-Path $script:RepoRoot "governance" "brand-policy.json"

    # Dot-source with an empty -Paths so the file's own top-level execution
    # block (guarded by $MyInvocation.InvocationName -ne '.') is a no-op,
    # and only the reusable functions are defined in this scope.
    . $script:AuditScriptPath -Paths @()

    $script:Policy = Get-BrandPolicy -Path $script:PolicyPath
}

Describe "Get-BrandPolicy" {
    It "loads the real governance/brand-policy.json with the expected shape" {
        $script:Policy.displayName | Should -Be 'ZavaGas'
        $script:Policy.slug | Should -Be 'zavagas-propane-demo'
        $script:Policy.denylist | Should -Contain 'AmeriGas'
        $script:Policy.allowlist | Should -Contain 'Microsoft'
    }

    It "throws a clear error when the policy file does not exist" {
        { Get-BrandPolicy -Path (Join-Path $script:FixturesDir 'does-not-exist.json') } | Should -Throw "*not found*"
    }
}

Describe "Get-BrandPolicyViolations" {
    Context "Positive fixture — correctly fictional ZavaGas content" {
        It "reports zero violations" {
            $lines = Get-Content -Path (Join-Path $script:FixturesDir "valid.md")
            $violations = Get-BrandPolicyViolations -Lines $lines -FileName "valid.md" -Policy $script:Policy
            $violations.Count | Should -Be 0
        }

        It "never flags legitimate allowlisted vendor/product terms" {
            $lines = @(
                'This demo uses Microsoft Azure, GitHub, Kubernetes, MongoDB, RabbitMQ, and OpenTelemetry.',
                'Built with PowerShell and deployed via Bicep to an AKS cluster.'
            )
            $violations = Get-BrandPolicyViolations -Lines $lines -FileName "allowlist-check.md" -Policy $script:Policy
            $violations.Count | Should -Be 0
        }
    }

    Context "Negative fixture — deliberately reintroduced banned terms" {
        BeforeAll {
            $script:invalidLines = Get-Content -Path (Join-Path $script:FixturesDir "invalid.md")
            $script:invalidViolations = Get-BrandPolicyViolations -Lines $script:invalidLines -FileName "invalid.md" -Policy $script:Policy
        }

        It "reports at least one violation" {
            $script:invalidViolations.Count | Should -BeGreaterThan 0
        }

        It "flags the former real company name" {
            ($script:invalidViolations | ForEach-Object { $_.Term }) | Should -Contain 'AmeriGas'
        }

        It "flags real retailer/location terms" {
            $terms = $script:invalidViolations | ForEach-Object { $_.Term }
            $terms | Should -Contain 'Walmart'
            $terms | Should -Contain 'Home Depot'
            $terms | Should -Contain 'King of Prussia'
            $terms | Should -Contain 'Collegeville'
            $terms | Should -Contain 'Giant Pottstown'
            $terms | Should -Contain "Lowe's"
            $terms | Should -Contain 'Exton'
        }

        It "reports the correct 1-based line number for each violation" {
            foreach ($violation in $script:invalidViolations) {
                $script:invalidLines[$violation.Line - 1] | Should -Match ([regex]::Escape($violation.Term))
            }
        }
    }
}

Describe "Test-BrandPolicyPathExcluded" {
    It "excludes an exact-path match" {
        Test-BrandPolicyPathExcluded -RelativePath 'governance/brand-policy.json' -Exclusions $script:Policy.exclusions | Should -Be $true
    }

    It "excludes files under a directory-prefix exclusion" {
        Test-BrandPolicyPathExcluded -RelativePath 'node_modules/some-package/index.js' -Exclusions $script:Policy.exclusions | Should -Be $true
    }

    It "excludes files matching a wildcard extension exclusion" {
        Test-BrandPolicyPathExcluded -RelativePath 'media/menu.png' -Exclusions $script:Policy.exclusions | Should -Be $true
    }

    It "does not exclude an ordinary tracked source file" {
        Test-BrandPolicyPathExcluded -RelativePath 'docs/README.md' -Exclusions $script:Policy.exclusions | Should -Be $false
    }
}

Describe "Test-BrandPolicyBinaryPath" {
    It "detects a PNG as binary by extension without opening the real menu.png" {
        Test-BrandPolicyBinaryPath -FullPath (Join-Path $script:RepoRoot 'media' 'menu.png') | Should -Be $true
    }

    It "does not treat an ordinary markdown fixture as binary" {
        Test-BrandPolicyBinaryPath -FullPath (Join-Path $script:FixturesDir 'valid.md') | Should -Be $false
    }
}

Describe "Invoke-BrandPolicyAudit — real repository tree" {
    It "returns zero unexplained violations against the current, fully-rebranded repository tree" {
        $report = Invoke-BrandPolicyAudit -RepoRoot $script:RepoRoot -Policy $script:Policy
        if ($report.violationCount -gt 0) {
            $details = ($report.violations | ForEach-Object { "$($_.File):$($_.Line) '$($_.Term)'" }) -join "`n"
            throw "Expected zero brand policy violations, found $($report.violationCount):`n$details"
        }
        $report.violationCount | Should -Be 0
        $report.checkedFileCount | Should -BeGreaterThan 0
    }

    It "produces a deterministic report across repeated runs" {
        $reportA = Invoke-BrandPolicyAudit -RepoRoot $script:RepoRoot -Policy $script:Policy
        $reportB = Invoke-BrandPolicyAudit -RepoRoot $script:RepoRoot -Policy $script:Policy
        ($reportA | ConvertTo-Json -Depth 10) | Should -Be ($reportB | ConvertTo-Json -Depth 10)
    }

    It "applies path exclusions consistently even when -Paths is given explicitly (the negative fixture itself is excluded by policy, exactly like the real repo-wide run)" {
        $report = Invoke-BrandPolicyAudit -RepoRoot $script:RepoRoot -Policy $script:Policy -Paths @('scripts/tests/fixtures/brand-policy/invalid.md')
        $report.violationCount | Should -Be 0
        $report.checkedFileCount | Should -Be 0
    }
}
