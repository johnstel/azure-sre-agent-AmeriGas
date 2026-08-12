<#
.SYNOPSIS
    Validates that Bulk Tank and Cylinder Exchange domain vocabulary is never
    mixed within the same explicitly-tagged domain section.

.DESCRIPTION
    This platform supports two distinct propane business domains:
      - Bulk Tank: residential/commercial bulk propane tanks & deliveries.
        Vocabulary: gallons, tank percentage, consumption, refill
        recommendation, delivery scheduling.
      - Cylinder Exchange: retail cylinder exchange cages at partner stores.
        Vocabulary: full/empty/reserved cylinder counts, cage replenishment,
        exchange-location terminology.

    Content is tagged with an explicit domain marker such as:
      # Domain: Bulk Tank
      <!-- Domain: Cylinder Exchange -->
      // Domain: Shared

    Everything from the line after a marker up to the next marker (or end of
    file) is considered part of that domain's "zone". This script scans each
    zone for vocabulary that belongs exclusively to the *other* domain and
    reports a violation for each match. "Shared" zones, and any content
    before the first marker in a file, are not checked.

.PARAMETER Paths
    Files to validate. Defaults to the real repository targets that carry
    domain markers.

.PARAMETER FailOnNoMarkers
    If set, a file with zero domain markers is reported as a warning (not a
    failure). Off by default so arbitrary files can be passed in safely.

.OUTPUTS
    Writes violations to the host and returns a non-zero exit code (via
    `exit`) when run as a script and violations are found. When dot-sourced
    or invoked with -PassThru, returns the violation objects instead of
    exiting, which is what the Pester tests use.

.EXAMPLE
    pwsh scripts/validate-domain-terminology.ps1

.EXAMPLE
    pwsh scripts/validate-domain-terminology.ps1 -Paths k8s/base/application.yaml
#>
[CmdletBinding()]
param(
    [string[]]$Paths = @(
        (Join-Path $PSScriptRoot ".." "k8s/base/application.yaml"),
        (Join-Path $PSScriptRoot ".." "k8s/scenarios/oom-killed.yaml"),
        (Join-Path $PSScriptRoot ".." "k8s/scenarios/crash-loop.yaml"),
        (Join-Path $PSScriptRoot ".." "k8s/scenarios/image-pull-backoff.yaml"),
        (Join-Path $PSScriptRoot ".." "k8s/scenarios/high-cpu.yaml"),
        (Join-Path $PSScriptRoot ".." "k8s/scenarios/pending-pods.yaml"),
        (Join-Path $PSScriptRoot ".." "k8s/scenarios/probe-failure.yaml"),
        (Join-Path $PSScriptRoot ".." "k8s/scenarios/refill-order-backlog.yaml"),
        (Join-Path $PSScriptRoot ".." "k8s/scenarios/network-block.yaml"),
        (Join-Path $PSScriptRoot ".." "k8s/scenarios/missing-config.yaml"),
        (Join-Path $PSScriptRoot ".." "k8s/scenarios/mongodb-down.yaml"),
        (Join-Path $PSScriptRoot ".." "k8s/scenarios/service-mismatch.yaml"),
        (Join-Path $PSScriptRoot ".." "docs/sre-agent-knowledge.md"),
        (Join-Path $PSScriptRoot ".." "docs/DEMO-SCRIPT.md"),
        (Join-Path $PSScriptRoot ".." "docs/BREAKABLE-SCENARIOS.md")
    ),
    [switch]$FailOnNoMarkers,
    [switch]$PassThru
)

$ErrorActionPreference = 'Stop'

# Terms that belong exclusively to the Bulk Tank domain. These must never
# appear inside a section explicitly tagged "Cylinder Exchange".
$script:BulkTankOnlyPatterns = @(
    '\bgallons?\b',
    '\bgal/day\b',
    '/gal\b',
    '\bdays until empty\b',
    '\btank percentage\b',
    '\btank fill percentage\b',
    '\brefill recommendation\b'
)

# Terms that belong exclusively to the Cylinder Exchange domain. These must
# never appear inside a section explicitly tagged "Bulk Tank".
$script:CylinderExchangeOnlyPatterns = @(
    '\bfull cylinders?\b',
    '\bempty cylinders?\b',
    '\breserved cylinders?\b',
    '\bcylinder counts?\b',
    '\bcage capacity\b',
    '\bcage inventory\b',
    '\bcage restock\b',
    '\bcage grid\b',
    '\bcylinders? in field\b',
    '\bcylinders?/day\b',
    '\bcylinders? needed\b',
    '\bcylinder exchange\b'
)

$script:MarkerRegex = '(?i)Domain:\**\s*(Bulk Tank|Cylinder Exchange|Shared)'

function Get-DomainTerminologyViolations {
    <#
    .SYNOPSIS
        Returns an array of violation objects for the given text content.
    #>
    [CmdletBinding()]
    param(
        [AllowEmptyCollection()]
        [AllowEmptyString()]
        [string[]]$Lines,
        [Parameter(Mandatory = $true)][string]$FileName
    )

    $violations = @()
    $markerLineIndexes = @()

    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -match $script:MarkerRegex) {
            $markerLineIndexes += , @{ Index = $i; Domain = $Matches[1] }
        }
    }

    if ($markerLineIndexes.Count -eq 0) {
        return $violations
    }

    for ($m = 0; $m -lt $markerLineIndexes.Count; $m++) {
        $marker = $markerLineIndexes[$m]
        $domain = $marker.Domain

        # Skip the marker line itself, plus any contiguous "#"-style
        # comment-continuation lines directly after it (wrapped comment
        # paragraphs describing the domain in prose, which may legitimately
        # reference the *other* domain's vocabulary for contrast).
        $zoneStart = $marker.Index + 1
        $trimmedMarkerLine = $Lines[$marker.Index].TrimStart()
        if ($trimmedMarkerLine.StartsWith('#')) {
            while ($zoneStart -lt $Lines.Count -and $Lines[$zoneStart].TrimStart().StartsWith('#')) {
                $zoneStart++
            }
        }

        $zoneEnd = if ($m -lt $markerLineIndexes.Count - 1) { $markerLineIndexes[$m + 1].Index - 1 } else { $Lines.Count - 1 }

        if ($domain -eq 'Shared') {
            continue
        }

        $forbiddenPatterns = if ($domain -eq 'Bulk Tank') { $script:CylinderExchangeOnlyPatterns } else { $script:BulkTankOnlyPatterns }
        $forbiddenLabel = if ($domain -eq 'Bulk Tank') { 'Cylinder Exchange' } else { 'Bulk Tank' }

        for ($line = $zoneStart; $line -le $zoneEnd; $line++) {
            if ($line -ge $Lines.Count) { break }
            foreach ($pattern in $forbiddenPatterns) {
                if ($Lines[$line] -match $pattern) {
                    $violations += [pscustomobject]@{
                        File           = $FileName
                        Line           = $line + 1
                        Zone           = $domain
                        ForbiddenTerm  = $Matches[0]
                        ForbiddenDomain = $forbiddenLabel
                        Text           = $Lines[$line].Trim()
                    }
                }
            }
        }
    }

    return $violations
}

function Test-DomainTerminologyFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )

    if (-not (Test-Path -Path $Path)) {
        throw "File not found: $Path"
    }

    $lines = Get-Content -Path $Path
    return Get-DomainTerminologyViolations -Lines $lines -FileName $Path
}

# Only run validation when this file is executed directly (not dot-sourced
# for its functions by Pester tests).
if ($MyInvocation.InvocationName -ne '.') {
    $allViolations = @()
    $checkedAny = $false

    foreach ($path in $Paths) {
        if (-not (Test-Path -Path $path)) {
            Write-Warning "Skipping missing file: $path"
            continue
        }
        $checkedAny = $true
        $lines = Get-Content -Path $path
        $hasMarkers = ($lines | Select-String -Pattern $script:MarkerRegex -Quiet)
        if (-not $hasMarkers -and $FailOnNoMarkers) {
            Write-Warning "No domain markers found in: $path"
        }
        $allViolations += Get-DomainTerminologyViolations -Lines $lines -FileName $path
    }

    if ($PassThru) {
        return $allViolations
    }

    if ($allViolations.Count -gt 0) {
        Write-Host "Domain terminology violations found:" -ForegroundColor Red
        foreach ($v in $allViolations) {
            Write-Host ("  {0}:{1} [{2} zone] contains {3}-only term '{4}': {5}" -f $v.File, $v.Line, $v.Zone, $v.ForbiddenDomain, $v.ForbiddenTerm, $v.Text) -ForegroundColor Red
        }
        Write-Host "`n$($allViolations.Count) violation(s) found across $($Paths.Count) file(s)." -ForegroundColor Red
        exit 1
    }

    if ($checkedAny) {
        Write-Host "Domain terminology validation passed — no cross-domain vocabulary found." -ForegroundColor Green
    }
    exit 0
}
