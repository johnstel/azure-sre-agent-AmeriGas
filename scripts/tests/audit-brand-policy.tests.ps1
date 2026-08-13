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
      - The narrow (path, term) intentionalLegacyReferences exemption
        mechanism: an exempted term is suppressed in its declared file, but
        a DIFFERENT banned term (or the exempted term in a different file)
        in that same content still fails the audit — proving the exemption
        cannot accidentally suppress unrelated real violations.
      - Get-BrandPolicy fails clearly (not with a raw parser stack trace)
        on a missing or malformed policy file.
      - Running the full audit against the real repository tree returns
        zero unexplained violations, acting as a regression guard for
        issue #27, and produces the expected exemption count.
      - CLI subprocess behavior: -OutputFormat Json prints valid JSON and
        exits 0 when clean / exits 1 when a real violation is present.
      - Binary files (e.g. media/menu.png) are skipped safely through the
        full Invoke-BrandPolicyAudit pipeline without erroring.

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
        $script:Policy.intentionalLegacyReferences.Count | Should -BeGreaterThan 0
    }

    It "throws a clear error when the policy file does not exist" {
        { Get-BrandPolicy -Path (Join-Path $script:FixturesDir 'does-not-exist.json') } | Should -Throw "*not found*"
    }

    It "throws a clear error (not a raw parser stack trace) on malformed JSON" {
        $badPolicyPath = Join-Path $script:FixturesDir 'malformed-policy.json'
        Set-Content -LiteralPath $badPolicyPath -Value 'not valid json {{{' -NoNewline
        try {
            { Get-BrandPolicy -Path $badPolicyPath } | Should -Throw "*not valid JSON*"
        }
        finally {
            Remove-Item -LiteralPath $badPolicyPath -Force -ErrorAction SilentlyContinue
        }
    }

    It "throws a clear error when a required field (denylist) is missing" {
        $incompletePolicyPath = Join-Path $script:FixturesDir 'incomplete-policy.json'
        Set-Content -LiteralPath $incompletePolicyPath -Value '{"exclusions": []}' -NoNewline
        try {
            { Get-BrandPolicy -Path $incompletePolicyPath } | Should -Throw "*missing required array field 'denylist'*"
        }
        finally {
            Remove-Item -LiteralPath $incompletePolicyPath -Force -ErrorAction SilentlyContinue
        }
    }

    It "defaults intentionalLegacyReferences to an empty array for backward compatibility with an older policy file" {
        $legacyPolicyPath = Join-Path $script:FixturesDir 'legacy-shape-policy.json'
        Set-Content -LiteralPath $legacyPolicyPath -Value '{"denylist": ["Foo"], "exclusions": []}' -NoNewline
        try {
            $legacyPolicy = Get-BrandPolicy -Path $legacyPolicyPath
            ($null -eq $legacyPolicy.intentionalLegacyReferences) | Should -Be $false -Because "Add-Member should have set an empty array, not left the property null"
            @($legacyPolicy.intentionalLegacyReferences).Count | Should -Be 0
        }
        finally {
            Remove-Item -LiteralPath $legacyPolicyPath -Force -ErrorAction SilentlyContinue
        }
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

Describe "Split-BrandPolicyExemptions — narrow (path, term) exemption matching" {
    BeforeAll {
        $script:LegacyRefs = @(
            [pscustomobject]@{ path = 'scripts/migrate-brand-tags.ps1'; term = 'AmeriGas'; rationale = 'Old tag literal value the migration script matches against.' }
        )
    }

    It "suppresses a hit whose (path, term) exactly matches a declared legacy reference" {
        $hits = @([pscustomobject]@{ File = 'scripts/migrate-brand-tags.ps1'; Line = 5; Term = 'AmeriGas'; Text = 'amerigas-propane-demo' })
        $result = Split-BrandPolicyExemptions -Hits $hits -IntentionalLegacyReferences $script:LegacyRefs
        $result.Violations.Count | Should -Be 0
        $result.Exemptions.Count | Should -Be 1
        $result.Exemptions[0].Rationale | Should -Match 'Old tag literal value'
    }

    It "does NOT suppress a DIFFERENT banned term in the SAME exempted file (the exemption is per-term, not per-file)" {
        $hits = @(
            [pscustomobject]@{ File = 'scripts/migrate-brand-tags.ps1'; Line = 5; Term = 'AmeriGas'; Text = 'amerigas-propane-demo' },
            [pscustomobject]@{ File = 'scripts/migrate-brand-tags.ps1'; Line = 42; Term = 'Walmart'; Text = 'echo Walmart Collegeville test data' }
        )
        $result = Split-BrandPolicyExemptions -Hits $hits -IntentionalLegacyReferences $script:LegacyRefs
        $result.Exemptions.Count | Should -Be 1
        $result.Violations.Count | Should -Be 1
        $result.Violations[0].Term | Should -Be 'Walmart'
    }

    It "does NOT suppress the SAME term in a DIFFERENT, non-exempted file (the exemption is per-path, not global)" {
        $hits = @([pscustomobject]@{ File = 'docs/DEMO-SCRIPT.md'; Line = 1; Term = 'AmeriGas'; Text = 'Welcome to AmeriGas' })
        $result = Split-BrandPolicyExemptions -Hits $hits -IntentionalLegacyReferences $script:LegacyRefs
        $result.Exemptions.Count | Should -Be 0
        $result.Violations.Count | Should -Be 1
    }

    It "handles an empty legacy-reference list without suppressing anything" {
        $hits = @([pscustomobject]@{ File = 'a.md'; Line = 1; Term = 'AmeriGas'; Text = 'AmeriGas' })
        $result = Split-BrandPolicyExemptions -Hits $hits -IntentionalLegacyReferences @()
        $result.Violations.Count | Should -Be 1
        $result.Exemptions.Count | Should -Be 0
    }
}

Describe "Exemption narrowness against the REAL migration script content (proves the mechanism is not a disguised whole-file exclusion)" {
    It "still fails when a different-casing/different-term violation is injected into a copy of scripts/migrate-brand-tags.ps1, even though its real AmeriGas references are exempted" {
        $realLines = @(Get-Content -Path (Join-Path $script:RepoRoot 'scripts' 'migrate-brand-tags.ps1'))
        # Inject a real-retailer reference that is NOT a declared legacy
        # reference for this file/term — this must still be caught.
        $injectedLines = $realLines + @('# TODO: verify against Walmart Collegeville test data before demo day')

        $rawHits = Get-BrandPolicyViolations -Lines $injectedLines -FileName 'scripts/migrate-brand-tags.ps1' -Policy $script:Policy
        $split = Split-BrandPolicyExemptions -Hits $rawHits -IntentionalLegacyReferences $script:Policy.intentionalLegacyReferences

        # The real file's own AmeriGas references remain exempted...
        ($split.Exemptions | ForEach-Object { $_.Term }) | Should -Contain 'AmeriGas'
        # ...but the injected Walmart/Collegeville reference is still a
        # live violation, proving the exemption is narrow (path+term only).
        $violationTerms = $split.Violations | ForEach-Object { $_.Term }
        $violationTerms | Should -Contain 'Walmart'
        $violationTerms | Should -Contain 'Collegeville'
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

    It "no longer whole-file-excludes the migration script or the rename checklist (they now use narrow term-level exemptions instead)" {
        Test-BrandPolicyPathExcluded -RelativePath 'scripts/migrate-brand-tags.ps1' -Exclusions $script:Policy.exclusions | Should -Be $false
        Test-BrandPolicyPathExcluded -RelativePath 'scripts/tests/migrate-brand-tags.tests.ps1' -Exclusions $script:Policy.exclusions | Should -Be $false
        Test-BrandPolicyPathExcluded -RelativePath 'docs/REPO-RENAME-CHECKLIST.md' -Exclusions $script:Policy.exclusions | Should -Be $false
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
    It "returns zero unexplained violations against the current, fully-rebranded repository tree, with the expected exemptions applied" {
        $report = Invoke-BrandPolicyAudit -RepoRoot $script:RepoRoot -Policy $script:Policy
        if ($report.summary.violationCount -gt 0) {
            $details = ($report.violations | ForEach-Object { "$($_.File):$($_.Line) '$($_.Term)'" }) -join "`n"
            throw "Expected zero brand policy violations, found $($report.summary.violationCount):`n$details"
        }
        $report.summary.violationCount | Should -Be 0
        $report.summary.checkedFileCount | Should -BeGreaterThan 0
        $report.summary.exemptionCount | Should -Be $report.exemptions.Count
        $report.exemptions.Count | Should -BeGreaterThan 0
        ($report.exemptions | ForEach-Object { $_.File }) | Should -Contain 'scripts/migrate-brand-tags.ps1'
        ($report.exemptions | ForEach-Object { $_.File }) | Should -Contain 'docs/REPO-RENAME-CHECKLIST.md'
    }

    It "schemaVersion is 2 and the summary counts match the top-level convenience mirrors" {
        $report = Invoke-BrandPolicyAudit -RepoRoot $script:RepoRoot -Policy $script:Policy
        $report.schemaVersion | Should -Be 2
        $report.checkedFileCount | Should -Be $report.summary.checkedFileCount
        $report.violationCount | Should -Be $report.summary.violationCount
        $report.exemptionCount | Should -Be $report.summary.exemptionCount
    }

    It "produces a deterministic report across repeated runs (checkedFiles, exclusions, and violations arrays are sorted)" {
        $reportA = Invoke-BrandPolicyAudit -RepoRoot $script:RepoRoot -Policy $script:Policy
        $reportB = Invoke-BrandPolicyAudit -RepoRoot $script:RepoRoot -Policy $script:Policy
        ($reportA | ConvertTo-Json -Depth 10) | Should -Be ($reportB | ConvertTo-Json -Depth 10)

        $sortedCheckedFiles = @($reportA.checkedFiles | Sort-Object)
        [string]::Join(',', $reportA.checkedFiles) | Should -Be ([string]::Join(',', $sortedCheckedFiles))
    }

    It "applies path exclusions consistently even when -Paths is given explicitly (the negative fixture itself is excluded by policy, exactly like the real repo-wide run)" {
        $report = Invoke-BrandPolicyAudit -RepoRoot $script:RepoRoot -Policy $script:Policy -Paths @('scripts/tests/fixtures/brand-policy/invalid.md')
        $report.summary.violationCount | Should -Be 0
        $report.summary.checkedFileCount | Should -Be 0
    }

    It "safely skips a binary file (media/menu.png) through the full pipeline without erroring, and does not count it as checked" {
        { Invoke-BrandPolicyAudit -RepoRoot $script:RepoRoot -Policy $script:Policy -Paths @('media/menu.png') } | Should -Not -Throw
        $report = Invoke-BrandPolicyAudit -RepoRoot $script:RepoRoot -Policy $script:Policy -Paths @('media/menu.png')
        $report.summary.checkedFileCount | Should -Be 0
        $report.summary.violationCount | Should -Be 0
        $report.checkedFiles | Should -Not -Contain 'media/menu.png'
    }
}

Describe "CLI subprocess behavior (-OutputFormat Json)" {
    It "exits 0 and prints valid, schema-versioned JSON when the real repository tree is clean" {
        $output = & pwsh -NoLogo -NoProfile -File $script:AuditScriptPath -OutputFormat Json 2>&1
        $exitCode = $LASTEXITCODE
        $exitCode | Should -Be 0

        $parsed = $output -join "`n" | ConvertFrom-Json -Depth 20
        $parsed.schemaVersion | Should -Be 2
        $parsed.summary.violationCount | Should -Be 0
    }

    It "exits 1 and still prints valid JSON when a real violation is present (JSON mode never swallows the non-zero exit)" {
        $violationFixturePath = Join-Path $script:FixturesDir 'cli-exit-code-violation.md'
        Set-Content -LiteralPath $violationFixturePath -Value 'This CLI test fixture mentions Walmart on purpose.' -NoNewline
        try {
            $relativeFixturePath = 'scripts/tests/fixtures/brand-policy/cli-exit-code-violation.md'
            $output = & pwsh -NoLogo -NoProfile -File $script:AuditScriptPath -OutputFormat Json -Paths @($relativeFixturePath) 2>&1
            $exitCode = $LASTEXITCODE
            $exitCode | Should -Be 1

            $parsed = $output -join "`n" | ConvertFrom-Json -Depth 20
            $parsed.schemaVersion | Should -Be 2
            $parsed.summary.violationCount | Should -BeGreaterThan 0
            ($parsed.violations | ForEach-Object { $_.Term }) | Should -Contain 'Walmart'
        }
        finally {
            Remove-Item -LiteralPath $violationFixturePath -Force -ErrorAction SilentlyContinue
        }
    }

    It "exits 0 in Human mode (default) when the real repository tree is clean" {
        & pwsh -NoLogo -NoProfile -File $script:AuditScriptPath | Out-Null
        $LASTEXITCODE | Should -Be 0
    }
}
