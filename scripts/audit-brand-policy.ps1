<#
.SYNOPSIS
    Audits tracked repository content against the ZavaGas brand/data policy
    (issue #27): flags the former real company name and any real
    retailer/location term reintroduced into tracked demo content.

.DESCRIPTION
    Loads the machine-readable policy from governance/brand-policy.json
    (denylist of banned real-world terms, allowlist of legitimate
    vendor/product terms used only for documentation/reference, documented
    path exclusions, and a narrow (path, term) `intentionalLegacyReferences`
    allowlist), then walks every file returned by `git ls-files` (or an
    explicit -Paths override, useful for tests and generated demo-artifact
    fixtures) looking for denylisted terms.

    Two distinct escape hatches exist, deliberately kept separate:

      1. `exclusions` (file/directory/extension-level) — the ENTIRE file is
         never scanned at all. Reserved for content that is not
         audience-facing demo prose: git internals, binary files,
         dependency metadata, and the policy/audit-tool's own source where
         quoting every denylisted term is unavoidable and expected.
      2. `intentionalLegacyReferences` (exact path+term level) — the file
         IS scanned, but one specific declared term is exempted in that one
         specific file only. Used for the small number of real files (e.g.
         a migration script, an admin rename checklist) that must contain a
         literal old-brand term as DATA, while still being fully audited
         for every OTHER banned term (a different real retailer/location
         name appearing in that same file is still a violation).

    Binary detection is by extension first, then by sniffing the first 8KB
    for a NUL byte, so binaries with no/unrecognized extension are still
    safely skipped without erroring.

    This never flags allowlisted vendor/product terms (Microsoft, Azure,
    GitHub, Kubernetes, MongoDB, RabbitMQ, OpenTelemetry, the canonical
    fictional partner-catalog brand names, etc.) because it only searches
    for denylist terms in the first place — the allowlist exists purely as
    living documentation of what is intentionally NOT denylisted.

.PARAMETER PolicyPath
    Path to the brand policy JSON file. Defaults to governance/brand-policy.json.

.PARAMETER RepoRoot
    Root of the git repository to audit. Defaults to the parent of this
    script's directory.

.PARAMETER Paths
    Optional explicit list of repo-relative file paths to audit instead of
    walking `git ls-files`. Used by tests to audit fixture content without
    needing it to be tracked by git. Path-level `exclusions` still apply to
    an explicit list, for consistent behavior with a full repo walk.

.PARAMETER OutputFormat
    'Human' (default): colorized summary + exemptions + violations text.
    'Json': prints the full deterministic JSON report to stdout and nothing
    else. Both formats exit non-zero when unexplained violations remain —
    JSON mode never silently swallows a non-zero exit.

.PARAMETER PassThru
    Returns the report object instead of printing/exiting. This is what the
    Pester tests use (via dot-sourcing this file).

.OUTPUTS
    A deterministic JSON report (schemaVersion 2):
      - summary: { checkedFileCount, violationCount, exemptionCount, skippedExcludedCount, skippedBinaryCount }
      - checkedFiles: sorted array of every file path actually scanned
      - exclusions: the policy's file-level exclusions, sorted by path
      - intentionalLegacyReferences: the policy's full declared (path, term) allowlist, sorted
      - exemptions: the (path, term) hits that were actually matched and suppressed this run, each with its rationale, evidence line(s), and text — sorted by File, Term
      - violations: unexplained hits, sorted by File, Line, Term
    All arrays are sorted so repeated runs against the same tree produce
    byte-identical JSON.

.EXAMPLE
    pwsh scripts/audit-brand-policy.ps1

.EXAMPLE
    pwsh scripts/audit-brand-policy.ps1 -OutputFormat Json

.EXAMPLE
    pwsh scripts/audit-brand-policy.ps1 -Paths @('docs/DEMO-SCRIPT.md')
#>
[CmdletBinding()]
param(
    [string]$PolicyPath = (Join-Path $PSScriptRoot ".." "governance/brand-policy.json"),
    [string]$RepoRoot = (Join-Path $PSScriptRoot ".."),
    [string[]]$Paths,
    [ValidateSet('Human', 'Json')]
    [string]$OutputFormat = 'Human',
    [switch]$PassThru
)

$ErrorActionPreference = 'Stop'

# Extensions always treated as binary (skipped without opening the file).
$script:BinaryExtensions = @(
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp',
    '.zip', '.gz', '.tar', '.7z', '.pdf',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.mp4', '.mov', '.exe', '.dll', '.so', '.bin'
)

function Get-BrandPolicy {
    <#
    .SYNOPSIS
        Loads, parses, and validates the machine-readable brand policy JSON
        file. Fails clearly (not with a raw parser stack trace) on a
        missing file, malformed JSON, or a policy missing required fields.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Brand policy file not found: $Path"
    }

    $raw = Get-Content -Raw -LiteralPath $Path
    try {
        $policy = $raw | ConvertFrom-Json -Depth 20
    }
    catch {
        throw "Brand policy file at '$Path' is not valid JSON: $($_.Exception.Message)"
    }

    foreach ($requiredArrayField in @('denylist', 'exclusions')) {
        $value = $policy.$requiredArrayField
        if ($null -eq $value) {
            throw "Brand policy file at '$Path' is missing required array field '$requiredArrayField'."
        }
    }

    # intentionalLegacyReferences is optional in older policy files; default
    # to an empty array rather than requiring every caller to null-check it.
    if ($null -eq $policy.intentionalLegacyReferences) {
        $policy | Add-Member -NotePropertyName intentionalLegacyReferences -NotePropertyValue @() -Force
    }

    return $policy
}

function Test-BrandPolicyPathExcluded {
    <#
    .SYNOPSIS
        Returns $true if the given repo-relative path matches one of the
        policy's documented file-level exclusions (exact path, "prefix/"
        directory match, or "*.ext" extension match).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Exclusions
    )

    $normalized = $RelativePath -replace '\\', '/'

    foreach ($exclusion in $Exclusions) {
        $pattern = [string]$exclusion.path
        if ([string]::IsNullOrEmpty($pattern)) { continue }

        if ($pattern.EndsWith('/')) {
            $prefix = $pattern.TrimEnd('/')
            if ($normalized -eq $prefix -or $normalized.StartsWith("$prefix/")) {
                return $true
            }
        }
        elseif ($pattern.StartsWith('*.')) {
            $ext = $pattern.Substring(1)
            if ($normalized.EndsWith($ext, [System.StringComparison]::OrdinalIgnoreCase)) {
                return $true
            }
        }
        elseif ($normalized -eq $pattern -or $normalized.EndsWith("/$pattern")) {
            return $true
        }
    }

    return $false
}

function Test-BrandPolicyBinaryPath {
    <#
    .SYNOPSIS
        Detects binary files by extension first (cheap), then by sniffing
        the first 8KB for a NUL byte (catches binaries with no/unknown
        extension without requiring the whole file to be read as text).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FullPath
    )

    $ext = [System.IO.Path]::GetExtension($FullPath)
    if ($ext -and ($script:BinaryExtensions -contains $ext.ToLowerInvariant())) {
        return $true
    }

    if (-not (Test-Path -LiteralPath $FullPath -PathType Leaf)) {
        return $false
    }

    try {
        $stream = [System.IO.File]::OpenRead($FullPath)
        try {
            $bufferSize = [Math]::Min(8192, $stream.Length)
            if ($bufferSize -le 0) { return $false }
            $buffer = New-Object byte[] $bufferSize
            [void]$stream.Read($buffer, 0, $bufferSize)
            return ($buffer -contains [byte]0)
        }
        finally {
            $stream.Dispose()
        }
    }
    catch {
        # If we can't even open it to sniff, treat it as binary/unreadable
        # rather than throwing the whole audit closed.
        return $true
    }
}

function Get-BrandPolicyViolations {
    <#
    .SYNOPSIS
        Returns raw hit objects for the given text lines against the
        policy's denylist — BEFORE intentionalLegacyReferences exemption
        filtering (see Split-BrandPolicyExemptions). Importable via
        dot-sourcing for Pester tests.
    #>
    [CmdletBinding()]
    param(
        [AllowEmptyCollection()]
        [AllowEmptyString()]
        [string[]]$Lines,
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][object]$Policy
    )

    $violations = @()

    foreach ($term in $Policy.denylist) {
        $escaped = [regex]::Escape([string]$term)
        for ($i = 0; $i -lt $Lines.Count; $i++) {
            if ($Lines[$i] -match "(?i)$escaped") {
                $violations += [pscustomobject]@{
                    File = $FileName
                    Line = $i + 1
                    Term = [string]$term
                    Text = $Lines[$i].Trim()
                }
            }
        }
    }

    return $violations
}

function Split-BrandPolicyExemptions {
    <#
    .SYNOPSIS
        Partitions raw denylist hits into (still-a-violation) vs
        (exempted-by-intentionalLegacyReferences), matching on the EXACT
        (path, term) pair only. A hit for a DIFFERENT term in an exempted
        file is never suppressed by this — only the exact declared term is.
    .OUTPUTS
        A [pscustomobject] with `Violations` and `Exemptions` array
        properties (Exemptions additionally carry a `Rationale`).
    #>
    [CmdletBinding()]
    param(
        [AllowEmptyCollection()][object[]]$Hits,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$IntentionalLegacyReferences
    )

    $exemptionLookup = @{}
    foreach ($ref in $IntentionalLegacyReferences) {
        $key = "$([string]$ref.path)|$([string]$ref.term)"
        $exemptionLookup[$key] = [string]$ref.rationale
    }

    $violations = @()
    $exemptions = @()

    foreach ($hit in $Hits) {
        $key = "$($hit.File)|$($hit.Term)"
        if ($exemptionLookup.ContainsKey($key)) {
            $exemptions += [pscustomobject]@{
                File      = $hit.File
                Line      = $hit.Line
                Term      = $hit.Term
                Text      = $hit.Text
                Rationale = $exemptionLookup[$key]
            }
        }
        else {
            $violations += $hit
        }
    }

    return [pscustomobject]@{
        Violations = $violations
        Exemptions = $exemptions
    }
}

function Get-BrandPolicyAuditFileList {
    <#
    .SYNOPSIS
        Returns the list of git-tracked repo-relative file paths to audit.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot
    )

    Push-Location -LiteralPath $RepoRoot
    try {
        $files = git ls-files
        if ($LASTEXITCODE -ne 0) {
            throw "git ls-files failed with exit code $LASTEXITCODE. Is $RepoRoot a git repository?"
        }
        return @($files)
    }
    finally {
        Pop-Location
    }
}

function Invoke-BrandPolicyAudit {
    <#
    .SYNOPSIS
        Runs the full audit and returns a deterministic report object
        (schemaVersion 2). See the script's .OUTPUTS help for the shape.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][object]$Policy,
        [string[]]$Paths
    )

    $filesToCheck = if ($Paths) { $Paths } else { Get-BrandPolicyAuditFileList -RepoRoot $RepoRoot }

    $rawHits = @()
    $checkedFiles = @()
    $skippedExcludedCount = 0
    $skippedBinaryCount = 0

    foreach ($relativePath in $filesToCheck) {
        if (Test-BrandPolicyPathExcluded -RelativePath $relativePath -Exclusions $Policy.exclusions) {
            $skippedExcludedCount++
            continue
        }

        $fullPath = Join-Path $RepoRoot $relativePath
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            continue
        }

        if (Test-BrandPolicyBinaryPath -FullPath $fullPath) {
            $skippedBinaryCount++
            continue
        }

        $lines = Get-Content -LiteralPath $fullPath
        $checkedFiles += $relativePath
        $rawHits += Get-BrandPolicyViolations -Lines $lines -FileName $relativePath -Policy $Policy
    }

    $split = Split-BrandPolicyExemptions -Hits $rawHits -IntentionalLegacyReferences $Policy.intentionalLegacyReferences

    $sortedCheckedFiles = @($checkedFiles | Sort-Object)
    $sortedExclusions = @($Policy.exclusions | Sort-Object -Property path)
    $sortedLegacyReferences = @($Policy.intentionalLegacyReferences | Sort-Object -Property path, term)
    $sortedExemptions = @($split.Exemptions | Sort-Object -Property File, Term, Line)
    $sortedViolations = @($split.Violations | Sort-Object -Property File, Line, Term)

    return [pscustomobject]@{
        schemaVersion                = 2
        summary                      = [pscustomobject]@{
            checkedFileCount     = $sortedCheckedFiles.Count
            violationCount       = $sortedViolations.Count
            exemptionCount       = $sortedExemptions.Count
            skippedExcludedCount = $skippedExcludedCount
            skippedBinaryCount   = $skippedBinaryCount
        }
        checkedFiles                 = $sortedCheckedFiles
        exclusions                   = $sortedExclusions
        intentionalLegacyReferences  = $sortedLegacyReferences
        exemptions                   = $sortedExemptions
        violations                   = $sortedViolations
        # Backward/convenience top-level mirrors of summary.* — several
        # existing Pester assertions and the human-readable output below
        # read these directly.
        checkedFileCount              = $sortedCheckedFiles.Count
        violationCount                = $sortedViolations.Count
        exemptionCount                = $sortedExemptions.Count
        skippedExcludedCount          = $skippedExcludedCount
        skippedBinaryCount            = $skippedBinaryCount
    }
}

# Only run the audit when this file is executed directly (not dot-sourced
# for its functions by Pester tests).
if ($MyInvocation.InvocationName -ne '.') {
    $policy = Get-BrandPolicy -Path $PolicyPath
    $report = Invoke-BrandPolicyAudit -RepoRoot $RepoRoot -Policy $policy -Paths $Paths

    if ($PassThru) {
        return $report
    }

    if ($OutputFormat -eq 'Json') {
        $report | ConvertTo-Json -Depth 12 | Write-Output
    }
    else {
        Write-Host "Brand policy audit — schemaVersion $($report.schemaVersion)" -ForegroundColor Cyan
        Write-Host "  Checked:  $($report.summary.checkedFileCount) file(s)"
        Write-Host "  Excluded: $($report.summary.skippedExcludedCount) file(s) (file-level exclusions)"
        Write-Host "  Binary:   $($report.summary.skippedBinaryCount) file(s) skipped"
        Write-Host "  Exempted: $($report.summary.exemptionCount) declared legacy reference hit(s)"

        if ($report.exemptions.Count -gt 0) {
            Write-Host "`nIntentional legacy references applied:" -ForegroundColor DarkYellow
            foreach ($e in $report.exemptions) {
                Write-Host ("  {0}:{1} '{2}' — {3}" -f $e.File, $e.Line, $e.Term, $e.Rationale) -ForegroundColor DarkYellow
            }
        }

        if ($report.summary.violationCount -gt 0) {
            Write-Host "`nBrand policy violations found:" -ForegroundColor Red
            foreach ($v in $report.violations) {
                Write-Host ("  {0}:{1} contains banned term '{2}': {3}" -f $v.File, $v.Line, $v.Term, $v.Text) -ForegroundColor Red
            }
            Write-Host "`n$($report.summary.violationCount) violation(s) found across $($report.summary.checkedFileCount) checked file(s)." -ForegroundColor Red
        }
        else {
            Write-Host "`nBrand policy audit passed — $($report.summary.checkedFileCount) file(s) checked, 0 unexplained violations." -ForegroundColor Green
        }
    }

    if ($report.summary.violationCount -gt 0) {
        exit 1
    }
    exit 0
}
