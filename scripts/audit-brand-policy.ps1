<#
.SYNOPSIS
    Audits tracked repository content against the ZavaGas brand/data policy
    (issue #27): flags the former real company name and any real
    retailer/location term reintroduced into tracked demo content.

.DESCRIPTION
    Loads the machine-readable policy from governance/brand-policy.json
    (denylist of banned real-world terms, allowlist of legitimate
    vendor/product terms used only for documentation/reference, and
    documented path exclusions), then walks every file returned by
    `git ls-files` (or an explicit -Paths override, useful for tests and
    generated demo-artifact fixtures) looking for denylisted terms.

    Excluded by design (see governance/brand-policy.json's `exclusions`):
      - .git/ (immutable git history)
      - the policy file and this doc/script/test themselves, which must
        legitimately contain the banned words to check for them
      - binary files (detected both by extension and by a null-byte sniff)
      - dependency lockfiles / node_modules (not repository-owned content)
      - archival records such as CHANGELOG.md

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
    needing it to be tracked by git.

.PARAMETER PassThru
    Returns the report object instead of printing JSON/exiting. This is
    what the Pester tests use (via dot-sourcing this file).

.OUTPUTS
    A deterministic JSON report: checkedFileCount, violationCount,
    exclusionsApplied, skippedExcludedCount, skippedBinaryCount, and a
    violations array (File, Line, Term, Text), sorted by File then Line
    then Term so repeated runs against the same tree produce identical
    output.

.EXAMPLE
    pwsh scripts/audit-brand-policy.ps1

.EXAMPLE
    pwsh scripts/audit-brand-policy.ps1 -Paths @('docs/DEMO-SCRIPT.md')
#>
[CmdletBinding()]
param(
    [string]$PolicyPath = (Join-Path $PSScriptRoot ".." "governance/brand-policy.json"),
    [string]$RepoRoot = (Join-Path $PSScriptRoot ".."),
    [string[]]$Paths,
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
        Loads and parses the machine-readable brand policy JSON file.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Brand policy file not found: $Path"
    }

    return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json -Depth 20
}

function Test-BrandPolicyPathExcluded {
    <#
    .SYNOPSIS
        Returns $true if the given repo-relative path matches one of the
        policy's documented exclusions (exact path, "prefix/" directory
        match, or "*.ext" extension match).
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
        Returns violation objects for the given text lines against the
        policy's denylist. Importable via dot-sourcing for Pester tests.
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
        Runs the full audit and returns a deterministic report object.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][object]$Policy,
        [string[]]$Paths
    )

    $filesToCheck = if ($Paths) { $Paths } else { Get-BrandPolicyAuditFileList -RepoRoot $RepoRoot }

    $violations = @()
    $checkedCount = 0
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
        $checkedCount++
        $violations += Get-BrandPolicyViolations -Lines $lines -FileName $relativePath -Policy $Policy
    }

    $sortedViolations = @($violations | Sort-Object -Property File, Line, Term)

    return [pscustomobject]@{
        schemaVersion         = 1
        checkedFileCount      = $checkedCount
        violationCount        = $sortedViolations.Count
        skippedExcludedCount  = $skippedExcludedCount
        skippedBinaryCount    = $skippedBinaryCount
        exclusionsApplied     = $Policy.exclusions
        violations            = $sortedViolations
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

    $report | ConvertTo-Json -Depth 10 | Write-Output

    if ($report.violationCount -gt 0) {
        Write-Host "`nBrand policy violations found:" -ForegroundColor Red
        foreach ($v in $report.violations) {
            Write-Host ("  {0}:{1} contains banned term '{2}': {3}" -f $v.File, $v.Line, $v.Term, $v.Text) -ForegroundColor Red
        }
        Write-Host "`n$($report.violationCount) violation(s) found across $($report.checkedFileCount) checked file(s)." -ForegroundColor Red
        exit 1
    }

    Write-Host "`nBrand policy audit passed — $($report.checkedFileCount) file(s) checked, 0 violations ($($report.skippedExcludedCount) excluded, $($report.skippedBinaryCount) binary)." -ForegroundColor Green
    exit 0
}
