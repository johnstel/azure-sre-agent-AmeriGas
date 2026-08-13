#Requires -Modules Pester

BeforeAll {
    $script:RepoRoot = Join-Path $PSScriptRoot '..' '..'
    $script:ManifestPath = Join-Path $script:RepoRoot 'k8s/base/application.yaml'
    $script:DeployPath = Join-Path $script:RepoRoot 'scripts/deploy.ps1'
    $script:ValidationPath = Join-Path $script:RepoRoot 'scripts/validate-telemetry.ps1'
    $script:ProbePath = Join-Path $script:RepoRoot 'tools/telemetry-probe/probe.js'
    . $script:ValidationPath
}

Describe 'OpenTelemetry Collector configuration' {
    BeforeAll {
        $script:Manifest = Get-Content -LiteralPath $script:ManifestPath -Raw
    }

    It 'pins the validated Contrib image and exports every supported signal through azuremonitor' {
        $script:Manifest | Should -Match 'otel/opentelemetry-collector-contrib:0\.158\.0'
        $script:Manifest | Should -Match '(?m)^\s{6}azuremonitor:$'
        $script:Manifest | Should -Not -Match 'otlp/appinsights'
        ([regex]::Matches($script:Manifest, 'exporters: \[azuremonitor\]')).Count | Should -Be 3
        $script:Manifest | Should -Match '(?m)^\s{6}debug:$'
    }

    It 'keeps the connection string out of ConfigMaps and references only a Secret' {
        $telemetryConfig = [regex]::Match(
            $script:Manifest,
            '(?s)kind: ConfigMap\s+metadata:\s+name: propane-telemetry-config.*?(?=\n---)'
        ).Value
        $telemetryConfig | Should -Not -Match 'APPLICATIONINSIGHTS_CONNECTION_STRING|InstrumentationKey=|connection-string'
        $script:Manifest | Should -Match '(?s)name: APPLICATIONINSIGHTS_CONNECTION_STRING\s+valueFrom:\s+secretKeyRef:\s+name: application-insights-connection\s+key: connection-string'
    }

    It 'wires the repo-owned probe source, pinned runtime image, and resource attributes' {
        $script:Manifest | Should -Match 'name: telemetry-probe-source'
        $script:Manifest | Should -Match 'image: node:22\.14\.0-alpine'
        $probe = Get-Content -LiteralPath $script:ProbePath -Raw
        foreach ($attribute in @('service.name', 'service.namespace', 'deployment.environment', 'scenario.id', 'run.correlation_id', 'transaction.id')) {
            $probe | Should -Match ([regex]::Escape($attribute))
        }
        $probe | Should -Match "PROBE_SERVICE_NAME = 'telemetry-probe'"
        $probe | Should -Match "'peer.service': target.service"
        $probe | Should -Match "'span.role': 'observed-http-client'"
        $probe | Should -Not -Match 'resource\(target\.service\)'
    }

    It 'uses a deterministic repo-owned controlled failure endpoint' {
        $probe = Get-Content -LiteralPath $script:ProbePath -Raw
        $probe | Should -Match "service: 'order-pricing-dependency'"
        $probe | Should -Match "url: 'http://order-pricing-dependency:4000/controlled-failure'"
        $script:Manifest | Should -Match "req\.method === 'GET' && req\.url === '/controlled-failure'"
        $script:Manifest | Should -Match "status_code: 503"
        $script:Manifest | Should -Match "event: 'controlled_failure'"
    }
}

Describe 'Telemetry deployment secret handling' {
    It 'creates a Secret without printing or committing the connection string' {
        $deploy = Get-Content -LiteralPath $script:DeployPath -Raw
        $deploy | Should -Match "'connection-string' = \[Convert\]::ToBase64String"
        $deploy | Should -Match 'ConvertTo-Json.*kubectl apply -f -'
        $deploy | Should -Not -Match 'create configmap propane-telemetry-config'
        $deploy | Should -Not -Match 'from-literal=connection-string='
        $deploy | Should -Not -Match 'Write-Host.*\$appInsightsConnStr'
    }
}

Describe 'Bounded workspace telemetry validation' {
    It 'rejects identifiers before KQL interpolation' {
        { New-TelemetryValidationQuery -TransactionId 'bad"; AppDependencies | take 1 //' } | Should -Throw
    }

    It 'uses workspace-backed Application Insights table names and exact transaction matching' {
        $id = '0123456789abcdef0123456789abcdef'
        $query = New-TelemetryValidationQuery -TransactionId $id
        foreach ($table in @('AppRequests', 'AppDependencies', 'AppExceptions', 'AppTraces', 'AppMetrics', 'KubeEvents')) {
            $query | Should -Match $table
        }
        $query | Should -Match 'peer\.service'
        $query | Should -Match 'ExternalServiceResourceCount'
        $query | Should -Match 'EndToEndCorrelationCount'
        $query | Should -Match 'AppRoleName == "order-pricing-dependency"'
        $query | Should -Match 'ResultCode == "200"'
        $query | Should -Match 'Target contains_cs "tank-monitor"'
        $query | Should -Match 'Data contains_cs "/health"'
        $query | Should -Match 'RequestParentId == DependencySpanId'
        $query | Should -Match 'union matchingRequests, matchingDependencies, matchingExceptions, matchingTraces, matchingMetrics'
        $query | Should -Match ([regex]::Escape('Properties["transaction.id"]'))
        $query | Should -Match ([regex]::Escape($id))
    }

    It 'fails on no data after the bounded timeout' {
        {
            Wait-TelemetryProof `
                -TimeoutSeconds 1 `
                -PollIntervalSeconds 0 `
                -QueryInvoker { $null } `
                -SleepInvoker { param($Seconds) }
        } | Should -Throw '*not available within 1 seconds*'
    }

    It 'terminates a query process that exceeds its timeout' {
        $pwshPath = (Get-Process -Id $PID).Path
        {
            Invoke-BoundedProcess `
                -FilePath $pwshPath `
                -ArgumentList @('-NoLogo', '-NoProfile', '-Command', 'Start-Sleep -Seconds 5') `
                -TimeoutSeconds 1
        } | Should -Throw '*timed out after 1 seconds*'
    }

    It 'rejects stale or mismatched partial proof' {
        $partial = [pscustomobject]@{
            DependencyCount = 4
            CorrelatedTransactionCount = 0
            RequiredTargetCount = 3
            ControlledFailureCount = 1
            ControlledRequestCount = 1
            EndToEndCorrelationCount = 1
            ExternalServiceResourceCount = 0
            MetricCount = 4
            ExceptionCount = 1
            TraceCount = 4
            KubernetesEventCount = 1
        }
        Test-TelemetryProof -Proof $partial | Should -BeFalse
    }

    It 'creates the Kubernetes event only after the deterministic HTTP 503 is verified' {
        $validation = Get-Content -LiteralPath $script:ValidationPath -Raw
        $failureCheck = $validation.IndexOf("Telemetry proof Job did not observe the deterministic repo-owned controlled failure.")
        $eventCreation = $validation.IndexOf("reason              = 'ControlledTelemetryFailure'")
        $failureCheck | Should -BeGreaterThan 0
        $eventCreation | Should -BeGreaterThan $failureCheck
        $validation | Should -Match "route -eq '/controlled-failure'"
        $validation | Should -Match "statusCode -eq 503"
        $validation | Should -Match "route -eq '/health'"
        $validation | Should -Match "statusCode -eq 200"
    }
}
