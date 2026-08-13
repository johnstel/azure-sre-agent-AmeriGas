[CmdletBinding()]
param(
    [string]$Scenario,
    [ValidateSet('Baseline','Broken','Recovered')]
    [string]$Phase = 'Baseline',
    [ValidateSet('Human','Json')]
    [string]$OutputFormat = 'Human',
    [switch]$All
)

$ErrorActionPreference = 'Stop'

function Get-ScenarioCatalog {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $catalogPath = Join-Path $repoRoot 'tools/mission-control/scenario-catalog.json'
    if (-not (Test-Path $catalogPath)) {
        throw "Scenario catalog not found: $catalogPath"
    }

    $catalog = Get-Content -Raw -Path $catalogPath | ConvertFrom-Json -Depth 100
    if (-not $catalog.scenarios) {
        throw 'Scenario catalog does not contain a scenarios array.'
    }

    return @{ RepoRoot = $repoRoot; Catalog = $catalog }
}

function Get-ScenarioSelection {
    param(
        [object]$Catalog,
        [string]$RequestedScenario,
        [switch]$AllRequested
    )

    $scenarioIds = @($Catalog.scenarios | ForEach-Object { $_.id })
    $dupes = @($scenarioIds | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })
    if ($dupes.Count -gt 0) {
        throw "Duplicate scenario IDs found in catalog: $($dupes -join ', ')"
    }

    if ($AllRequested) {
        return $scenarioIds
    }

    if (-not $RequestedScenario) {
        throw 'Scenario name is required unless -All is supplied.'
    }

    $match = $scenarioIds | Where-Object { $_ -eq $RequestedScenario }
    if (-not $match) {
        throw "Unknown scenario: $RequestedScenario. Valid values: $($scenarioIds -join ', ')"
    }

    return @($RequestedScenario)
}

function New-DeterministicEvidenceBundle {
    param(
        [object]$Scenario,
        [string]$PhaseName
    )

    $safeQuery = @($Scenario.safeEvidenceQueries)
    $sanitized = @()
    foreach ($query in $safeQuery) {
        $value = $query
        $value = $value.Replace('password=', '[redacted=password]')
        $value = $value.Replace('token=', '[redacted=token]')
        $value = $value.Replace('secret=', '[redacted=secret]')
        $value = $value.Replace('connectionString=', '[redacted=connection-string]')
        $value = $value.Replace('connection_string=', '[redacted=connection-string]')
        $value = $value.Replace('mongodb://', 'mongodb://[redacted]')
        $value = $value.Replace('amqp://', 'amqp://[redacted]')
        $sanitized += $value
    }

    [ordered]@{
        scenarioId = $Scenario.id
        phase = $PhaseName
        manifest = $Scenario.manifest
        evidenceQueries = $sanitized
        redacted = $true
        deterministic = $true
        correlationId = "scenario-$($Scenario.id)-$($PhaseName.ToLowerInvariant())"
    }
}

function Test-ScenarioCatalog {
    param(
        [object]$Catalog,
        [string[]]$ScenarioIds,
        [string]$PhaseName,
        [string]$ScenarioFilter
    )

    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $docPath = Join-Path $repoRoot 'docs/BREAKABLE-SCENARIOS.md'
    $docText = if (Test-Path $docPath) { Get-Content -Raw -Path $docPath } else { '' }
    $errors = @()
    $results = @()

    foreach ($id in $ScenarioIds) {
        $scenario = @($Catalog.scenarios | Where-Object { $_.id -eq $id })[0]
        if (-not $scenario) {
            $errors += "Scenario '$id' is selected but missing from the catalog."
            continue
        }

        $manifestPath = Join-Path $repoRoot "k8s/scenarios/$($scenario.manifest)"
        if (-not (Test-Path $manifestPath)) {
            $errors += "Scenario '$id' references missing manifest '$($scenario.manifest)'."
        }

        if (-not $scenario.brokenAssertions -or @($scenario.brokenAssertions).Count -eq 0) {
            $errors += "Scenario '$id' is missing brokenAssertions."
        }
        elseif (@($scenario.brokenAssertions | Where-Object { $_.rootCause -and $_.rootCause.Trim() }).Count -eq 0) {
            $errors += "Scenario '$id' must include a root-cause-specific broken assertion."
        }

        $phaseAsserts = switch ($PhaseName) {
            'Baseline' { @($scenario.baselinePreconditions) }
            'Broken' { @($scenario.brokenAssertions) }
            'Recovered' { @($scenario.postRecoveryAssertions) }
        }

        if (-not $phaseAsserts -or @($phaseAsserts).Count -eq 0) {
            $errors += "Scenario '$id' is missing required assertions for phase '$PhaseName'."
        }

        if ($PhaseName -eq 'Broken') {
            $telemetry = @($scenario.telemetryAssertions)
            $blockedTelemetry = @($telemetry | Where-Object { $_.status -eq 'blocked' })
            if ($blockedTelemetry.Count -eq 0) {
                $errors += "Scenario '$id' must include blocked telemetry assertions for data-dependent signals."
            }
            foreach ($item in $telemetry) {
                if ($item.status -eq 'blocked' -and (-not $item.prerequisite -or $item.prerequisite.Trim().Length -eq 0)) {
                    $errors += "Scenario '$id' telemetry assertion is blocked without a prerequisite."
                }
            }
        }

        $docHasEntry = (($docText -match [regex]::Escape($scenario.id)) -or ($docText -match [regex]::Escape($scenario.manifest)))
        if (-not $docHasEntry) {
            $errors += "Scenario '$id' is missing from the quick-reference docs."
        }

        $result = [ordered]@{
            scenarioId = $scenario.id
            title = $scenario.title
            manifest = $scenario.manifest
            phase = $PhaseName
            passed = $true
            evidenceBundle = New-DeterministicEvidenceBundle -Scenario $scenario -PhaseName $PhaseName
            activationTimeoutMs = [int]$scenario.activationTimeoutMs
        }

        if ($PhaseName -eq 'Broken') {
            $result.failedAssertions = @($scenario.brokenAssertions | ForEach-Object {
                $_.assertion
            })
        }

        if ($PhaseName -eq 'Recovered') {
            $result.recoveryAssertions = @($scenario.postRecoveryAssertions | ForEach-Object {
                $_.assertion
            })
        }

        $results += [pscustomobject]$result
    }

    return [pscustomobject]@{
        ok = ($errors.Count -eq 0)
        phase = $PhaseName
        selectedScenario = $ScenarioFilter
        errors = $errors
        results = $results
    }
}

function Write-HumanOutput {
    param([object]$Payload)

    if (-not $Payload.ok) {
        Write-Host "Scenario contract validation failed at phase '$($Payload.phase)'" -ForegroundColor Red
        foreach ($error in $Payload.errors) {
            Write-Host " - $error" -ForegroundColor Red
        }
        return
    }

    foreach ($result in $Payload.results) {
        Write-Host "[$($result.scenarioId)] $($result.title) :: $($result.phase)" -ForegroundColor Green
        Write-Host "  Manifest: $($result.manifest)"
        Write-Host "  Activation timeout: $($result.activationTimeoutMs)ms"
        $bundle = $result.evidenceBundle
        Write-Host "  Evidence bundle: $($bundle.correlationId)"
    }
}

$catalogData = Get-ScenarioCatalog
$selectedIds = Get-ScenarioSelection -Catalog $catalogData.Catalog -RequestedScenario $Scenario -AllRequested:$All
$result = Test-ScenarioCatalog -Catalog $catalogData.Catalog -ScenarioIds $selectedIds -PhaseName $Phase -ScenarioFilter $Scenario

switch ($OutputFormat) {
    'Json' {
        $result | ConvertTo-Json -Depth 100
    }
    default {
        Write-HumanOutput -Payload $result
    }
}

if (-not $result.ok) {
    exit 1
}
