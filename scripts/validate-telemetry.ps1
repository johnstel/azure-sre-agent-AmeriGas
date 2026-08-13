<#
.SYNOPSIS
    Generates and proves fresh, correlated Application Insights telemetry.

.DESCRIPTION
    Starts the repo-owned synthetic probe against the three real service health
    endpoints, records a Kubernetes event for the controlled failure, and polls
    the workspace-backed Application Insights tables until every proof is fresh.
#>

[CmdletBinding()]
param(
    [Parameter()]
    [string]$ResourceGroupName,

    [Parameter()]
    [ValidateRange(1, 900)]
    [int]$TimeoutSeconds = 300,

    [Parameter()]
    [ValidateRange(1, 60)]
    [int]$PollIntervalSeconds = 15,

    [Parameter()]
    [string]$ProofOutputPath = (Join-Path $PSScriptRoot '../tools/mission-control/.data/telemetry-proof.json')
)

$ErrorActionPreference = 'Stop'

function Test-TelemetryIdentifier {
    param([Parameter(Mandatory)][string]$Value)

    return $Value -match '\A[a-f0-9]{32}\z'
}

function New-TelemetryValidationQuery {
    param([Parameter(Mandatory)][string]$TransactionId)

    if (-not (Test-TelemetryIdentifier -Value $TransactionId)) {
        throw 'TransactionId must be exactly 32 lowercase hexadecimal characters.'
    }

    return @"
let transactionId = "$TransactionId";
let cutoff = ago(5m);
let matchingRequests = AppRequests
    | where TimeGenerated >= cutoff
    | where tostring(Properties["transaction.id"]) == transactionId;
let matchingDependencies = AppDependencies
    | where TimeGenerated >= cutoff
    | where tostring(Properties["transaction.id"]) == transactionId;
let observedDependencies = matchingDependencies
    | where tostring(Properties["span.role"]) == "observed-http-client";
let syntheticTransactions = matchingDependencies
    | where tostring(Properties["span.role"]) == "synthetic-transaction";
let matchingExceptions = AppExceptions
    | where TimeGenerated >= cutoff
    | where tostring(Properties["transaction.id"]) == transactionId;
let matchingTraces = AppTraces
    | where TimeGenerated >= cutoff
    | where tostring(Properties["transaction.id"]) == transactionId;
let matchingMetrics = AppMetrics
    | where TimeGenerated >= cutoff
    | where tostring(Properties["transaction.id"]) == transactionId;
print
    DependencyCount=toscalar(observedDependencies | count),
    CorrelatedTransactionCount=toscalar(
        syntheticTransactions
        | project OperationId, TransactionSpanId=Id
        | join kind=inner (observedDependencies | project OperationId, ParentId) on OperationId
        | where ParentId == TransactionSpanId
        | count
    ),
    RequiredTargetCount=toscalar(
        observedDependencies
        | where tostring(Properties["peer.service"]) in ("tank-monitor", "inventory-service", "order-service")
        | where tostring(Properties["http.route"]) == "/health"
        | where ResultCode == "200"
        | where
            (tostring(Properties["peer.service"]) == "tank-monitor" and Target contains_cs "tank-monitor" and Data contains_cs "/health")
            or (tostring(Properties["peer.service"]) == "inventory-service" and Target contains_cs "inventory-service" and Data contains_cs "/health")
            or (tostring(Properties["peer.service"]) == "order-service" and Target contains_cs "order-service" and Data contains_cs "/health")
        | summarize dcount(tostring(Properties["peer.service"]))
    ),
    ControlledFailureCount=toscalar(
        observedDependencies
        | where tostring(Properties["peer.service"]) == "order-pricing-dependency"
        | where tostring(Properties["http.route"]) == "/controlled-failure"
        | where ResultCode == "503"
        | count
    ),
    ControlledRequestCount=toscalar(
        matchingRequests
        | where AppRoleName == "order-pricing-dependency"
        | where Name == "GET /controlled-failure"
        | where ResultCode == "503"
        | count
    ),
    EndToEndCorrelationCount=toscalar(
        matchingRequests
        | where AppRoleName == "order-pricing-dependency"
        | where Name == "GET /controlled-failure"
        | project OperationId, RequestParentId=ParentId
        | join kind=inner (
            observedDependencies
            | where tostring(Properties["peer.service"]) == "order-pricing-dependency"
            | where tostring(Properties["http.route"]) == "/controlled-failure"
            | project OperationId, DependencySpanId=Id
        ) on OperationId
        | where RequestParentId == DependencySpanId
        | count
    ),
    ExternalServiceResourceCount=toscalar(
        union matchingRequests, matchingDependencies, matchingExceptions, matchingTraces, matchingMetrics
        | where AppRoleName in ("tank-monitor", "inventory-service", "order-service")
        | count
    ),
    MetricCount=toscalar(matchingMetrics | count),
    ExceptionCount=toscalar(matchingExceptions | count),
    TraceCount=toscalar(matchingTraces | count),
    KubernetesEventCount=toscalar(
        KubeEvents
        | where TimeGenerated >= cutoff
        | where Namespace == "propane"
        | where Reason == "ControlledTelemetryFailure"
        | where Message has transactionId
        | count
    )
"@
}

function ConvertFrom-LogAnalyticsResult {
    param([Parameter(Mandatory)]$Result)

    if ($Result.tables -and $Result.tables.Count -gt 0 -and $Result.tables[0].rows.Count -gt 0) {
        $columns = @($Result.tables[0].columns | ForEach-Object { $_.name })
        $row = @($Result.tables[0].rows[0])
        $values = [ordered]@{}
        for ($index = 0; $index -lt $columns.Count; $index++) {
            $values[$columns[$index]] = $row[$index]
        }
        return [pscustomobject]$values
    }

    if ($Result.Count -gt 0) {
        return @($Result)[0]
    }

    return $null
}

function Test-TelemetryProof {
    param([Parameter(Mandatory)]$Proof)

    $requiredMinimums = @{
        DependencyCount = 4
        CorrelatedTransactionCount = 4
        RequiredTargetCount = 3
        ControlledFailureCount = 1
        ControlledRequestCount = 1
        EndToEndCorrelationCount = 1
        MetricCount = 4
        ExceptionCount = 1
        TraceCount = 4
        KubernetesEventCount = 1
    }

    foreach ($entry in $requiredMinimums.GetEnumerator()) {
        if ($null -eq $Proof.PSObject.Properties[$entry.Key] -or [int]$Proof.($entry.Key) -lt $entry.Value) {
            return $false
        }
    }
    if ($null -eq $Proof.PSObject.Properties['ExternalServiceResourceCount'] -or [int]$Proof.ExternalServiceResourceCount -ne 0) {
        return $false
    }
    return $true
}

function Wait-TelemetryProof {
    param(
        [Parameter(Mandatory)][scriptblock]$QueryInvoker,
        [Parameter(Mandatory)][ValidateRange(1, 900)][int]$TimeoutSeconds,
        [Parameter()][ValidateRange(0, 60)][int]$PollIntervalSeconds = 15,
        [Parameter()][scriptblock]$SleepInvoker = { param($Seconds) Start-Sleep -Seconds $Seconds }
    )

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $remainingSeconds = [Math]::Max(1, [Math]::Ceiling(($deadline - [DateTimeOffset]::UtcNow).TotalSeconds))
        $proof = & $QueryInvoker $remainingSeconds
        if ($proof -and (Test-TelemetryProof -Proof $proof)) {
            return $proof
        }
        if ([DateTimeOffset]::UtcNow -ge $deadline) {
            break
        }
        & $SleepInvoker $PollIntervalSeconds
    } while ($true)

    throw "Fresh telemetry proof was not available within $TimeoutSeconds seconds."
}

function Start-TelemetryProbe {
    param([Parameter(Mandatory)][string]$TransactionId)

    if (-not (Test-TelemetryIdentifier -Value $TransactionId)) {
        throw 'TransactionId must be exactly 32 lowercase hexadecimal characters.'
    }

    $shortId = $TransactionId.Substring(0, 12)
    $jobName = "telemetry-proof-$shortId"
    $jobJson = kubectl create job $jobName --from=cronjob/telemetry-baseline --namespace propane --dry-run=client -o json
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($jobJson)) {
        throw 'Could not generate the telemetry proof Job.'
    }

    $job = $jobJson | ConvertFrom-Json
    $container = $job.spec.template.spec.containers[0]
    $container.env = @($container.env | Where-Object { $_.name -notin @('RUN_CORRELATION_ID', 'SCENARIO_ID') }) + @(
        [pscustomobject]@{ name = 'RUN_CORRELATION_ID'; value = $TransactionId }
        [pscustomobject]@{ name = 'SCENARIO_ID'; value = 'observability-validation' }
    )
    $job | ConvertTo-Json -Depth 100 -Compress | kubectl apply -f - | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not create the telemetry proof Job.'
    }

    kubectl wait "--for=condition=complete" "job/$jobName" --namespace propane --timeout=120s | Out-Null
    if ($LASTEXITCODE -ne 0) {
        $probeLog = kubectl logs "job/$jobName" --namespace propane 2>&1 | Out-String
        throw "Telemetry proof Job did not complete: $($probeLog.Trim())"
    }

    $output = kubectl logs "job/$jobName" --namespace propane | ConvertFrom-Json
    if ($output.runCorrelationId -ne $TransactionId) {
        throw 'Telemetry proof Job returned a mismatched correlation identifier.'
    }
    $requiredServices = @('tank-monitor', 'inventory-service', 'order-service')
    foreach ($requiredService in $requiredServices) {
        $healthyResult = @($output.results | Where-Object {
            $_.service -eq $requiredService -and
            $_.route -eq '/health' -and
            [int]$_.statusCode -eq 200 -and
            $_.controlledFailure -eq $false
        })
        if ($healthyResult.Count -ne 1) {
            throw "Telemetry proof Job did not observe a healthy HTTP 200 response from '$requiredService'."
        }
    }
    $controlledFailure = @($output.results | Where-Object {
        $_.service -eq 'order-pricing-dependency' -and
        $_.route -eq '/controlled-failure' -and
        [int]$_.statusCode -eq 503 -and
        $_.controlledFailure -eq $true
    })
    if ($controlledFailure.Count -ne 1) {
        throw 'Telemetry proof Job did not observe the deterministic repo-owned controlled failure.'
    }

    $event = [ordered]@{
        apiVersion          = 'events.k8s.io/v1'
        kind                = 'Event'
        metadata            = [ordered]@{
            name      = "telemetry-controlled-failure-$shortId"
            namespace = 'propane'
        }
        eventTime           = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ')
        action              = 'TelemetryValidation'
        reason              = 'ControlledTelemetryFailure'
        regarding           = [ordered]@{
            apiVersion = 'batch/v1'
            kind       = 'Job'
            name       = $jobName
            namespace  = 'propane'
        }
        note                = "Observed order-pricing-dependency GET /controlled-failure HTTP 503; transaction.id=$TransactionId"
        type                = 'Warning'
        reportingController = 'zavagas.telemetry.validation'
        reportingInstance   = 'validate-telemetry'
    }
    $event | ConvertTo-Json -Depth 10 -Compress | kubectl create -f - | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not create the correlated Kubernetes event.'
    }
}

function Invoke-BoundedProcess {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$ArgumentList,
        [Parameter(Mandatory)][ValidateRange(1, 900)][int]$TimeoutSeconds
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in $ArgumentList) {
        $startInfo.ArgumentList.Add($argument)
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Could not start $FilePath."
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        $process.Kill($true)
        $process.WaitForExit()
        throw "$FilePath timed out after $TimeoutSeconds seconds."
    }

    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $exitCode = $process.ExitCode
    $process.Dispose()
    return [pscustomobject]@{
        ExitCode = $exitCode
        StandardOutput = $stdout
        StandardError = $stderr
    }
}

function Invoke-WorkspaceTelemetryQuery {
    param(
        [Parameter(Mandatory)][string]$WorkspaceCustomerId,
        [Parameter(Mandatory)][string]$Query,
        [Parameter(Mandatory)][ValidateRange(1, 900)][int]$TimeoutSeconds
    )

    $result = Invoke-BoundedProcess -FilePath 'az' -TimeoutSeconds $TimeoutSeconds -ArgumentList @(
        'monitor', 'log-analytics', 'query',
        '--workspace', $WorkspaceCustomerId,
        '--analytics-query', $Query,
        '--timespan', 'PT10M',
        '--output', 'json',
        '--only-show-errors'
    )
    if ($result.ExitCode -ne 0) {
        throw 'The Log Analytics telemetry query failed.'
    }

    return ConvertFrom-LogAnalyticsResult -Result ($result.StandardOutput | ConvertFrom-Json)
}

function Invoke-TelemetryValidation {
    param(
        [Parameter(Mandatory)][string]$ResourceGroupName,
        [Parameter(Mandatory)][ValidateRange(1, 900)][int]$TimeoutSeconds,
        [Parameter(Mandatory)][ValidateRange(1, 60)][int]$PollIntervalSeconds,
        [Parameter(Mandatory)][string]$ProofOutputPath
    )

    if (Test-Path -LiteralPath $ProofOutputPath) {
        Remove-Item -LiteralPath $ProofOutputPath -Force
    }

    $workspaceResult = Invoke-BoundedProcess -FilePath 'az' -TimeoutSeconds 30 -ArgumentList @(
        'monitor', 'log-analytics', 'workspace', 'list',
        '--resource-group', $ResourceGroupName,
        '--query', '[0].customerId',
        '--output', 'tsv',
        '--only-show-errors'
    )
    $workspaceCustomerId = $workspaceResult.StandardOutput.Trim()
    if ($workspaceResult.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($workspaceCustomerId)) {
        throw "No Log Analytics workspace was found in resource group '$ResourceGroupName'."
    }

    $transactionId = ([guid]::NewGuid().ToString('N')).ToLowerInvariant()
    Start-TelemetryProbe -TransactionId $transactionId
    $query = New-TelemetryValidationQuery -TransactionId $transactionId
    $proof = Wait-TelemetryProof `
        -TimeoutSeconds $TimeoutSeconds `
        -PollIntervalSeconds $PollIntervalSeconds `
        -QueryInvoker {
            param($RemainingSeconds)
            Invoke-WorkspaceTelemetryQuery `
                -WorkspaceCustomerId $workspaceCustomerId `
                -Query $query `
                -TimeoutSeconds ([Math]::Min(30, $RemainingSeconds))
        }

    $proofRecord = [ordered]@{
        transactionId = $transactionId
        verifiedAt = [DateTimeOffset]::UtcNow.ToString('o')
        maxAgeMinutes = 5
        dependencyCount = [int]$proof.DependencyCount
        correlatedTransactionCount = [int]$proof.CorrelatedTransactionCount
        requiredTargetCount = [int]$proof.RequiredTargetCount
        controlledFailureCount = [int]$proof.ControlledFailureCount
        controlledRequestCount = [int]$proof.ControlledRequestCount
        endToEndCorrelationCount = [int]$proof.EndToEndCorrelationCount
        externalServiceResourceCount = [int]$proof.ExternalServiceResourceCount
        metricCount = [int]$proof.MetricCount
        exceptionCount = [int]$proof.ExceptionCount
        traceCount = [int]$proof.TraceCount
        kubernetesEventCount = [int]$proof.KubernetesEventCount
    }
    $proofDirectory = Split-Path -Parent $ProofOutputPath
    New-Item -ItemType Directory -Path $proofDirectory -Force | Out-Null
    $temporaryProofPath = "$ProofOutputPath.$PID.tmp"
    $proofRecord | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporaryProofPath -Encoding utf8NoBOM
    Move-Item -LiteralPath $temporaryProofPath -Destination $ProofOutputPath -Force

    Write-Host "  Telemetry proof transaction: $transactionId" -ForegroundColor Gray
    Write-Host "  Dependencies=$($proof.DependencyCount), CorrelatedTransactions=$($proof.CorrelatedTransactionCount), RequiredTargets=$($proof.RequiredTargetCount), ControlledFailures=$($proof.ControlledFailureCount), ControlledRequests=$($proof.ControlledRequestCount), EndToEnd=$($proof.EndToEndCorrelationCount), ExternalServiceResources=$($proof.ExternalServiceResourceCount), Metrics=$($proof.MetricCount), Exceptions=$($proof.ExceptionCount), Traces=$($proof.TraceCount), KubeEvents=$($proof.KubernetesEventCount)" -ForegroundColor Gray
}

if ($MyInvocation.InvocationName -ne '.') {
    if ([string]::IsNullOrWhiteSpace($ResourceGroupName)) {
        throw 'ResourceGroupName is required.'
    }
    Invoke-TelemetryValidation `
        -ResourceGroupName $ResourceGroupName `
        -TimeoutSeconds $TimeoutSeconds `
        -PollIntervalSeconds $PollIntervalSeconds `
        -ProofOutputPath $ProofOutputPath
}
