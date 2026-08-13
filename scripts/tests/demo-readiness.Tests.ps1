#Requires -Modules Pester

BeforeAll {
    $script:RepoRoot = Split-Path -Parent $PSScriptRoot
    $script:WrapperPath = Join-Path $script:RepoRoot 'test-demo-readiness.ps1'

    function Invoke-DemoReadinessScript {
        param(
            [Parameter(Mandatory = $true)]
            [string[]]$Arguments
        )

        $output = & pwsh -NoProfile -File $script:WrapperPath @Arguments 2>&1
        $exitCode = $LASTEXITCODE

        $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
        return [pscustomobject]@{
            ExitCode = [int]$exitCode
            StdOut   = $text.Trim()
        }
    }
}

Describe "demo readiness script" {
    It "returns a ready JSON payload for the healthy mock scenario" {
        $result = Invoke-DemoReadinessScript @(
            '-SubscriptionId', 'sub-demo',
            '-ResourceGroupName', 'rg-demo',
            '-Profile', 'demo',
            '-Json',
            '-RequireMissionControl',
            '-RequireNativeSreAgent',
            '-Mock', 'healthy'
        )

        $result.ExitCode | Should -Be 0
        $payload = $result.StdOut | ConvertFrom-Json
        $payload.status | Should -Be 'ready'
        $payload.blocking | Should -BeFalse
        $payload.summary | Should -Match 'Ready for Demo'
        $payload.checks | Should -Not -BeNullOrEmpty
    }

    It "accepts explicit requirement switches without weakening the healthy demo profile" {
        $result = Invoke-DemoReadinessScript @(
            '-SubscriptionId', 'sub-demo',
            '-ResourceGroupName', 'rg-demo',
            '-Profile', 'demo',
            '-Json',
            '-RequireMissionControl',
            '-RequireNativeSreAgent',
            '-Mock', 'healthy'
        )

        $result.ExitCode | Should -Be 0
        $payload = $result.StdOut | ConvertFrom-Json
        $payload.status | Should -Be 'ready'
        $payload.blocking | Should -BeFalse
    }

    It "blocks when required Mission Control and native SRE Agent evidence are missing" {
        $readinessModule = (Resolve-Path (Join-Path $script:RepoRoot '..' 'tools' 'mission-control' 'readiness.js')).Path
        $readinessModuleJs = $readinessModule -replace '\\', '\\\\'
        $scriptText = @"
        const { evaluateReadiness } = require('$readinessModuleJs');
        (async () => {
          const result = await evaluateReadiness({
            subscriptionId: 'sub-required',
            resourceGroupName: 'rg-required',
            profile: 'demo',
            timeoutMs: 90000,
            requireMissionControl: true,
            requireNativeSreAgent: true,
          }, {
            missionControl: { available: false, fresh: false, status: 'unavailable', details: { message: 'Mission Control is missing' } },
            nativeSreAgent: { available: false, fresh: false, status: 'unavailable', details: { message: 'Native SRE Agent is missing' } },
          });
          console.log(JSON.stringify(result));
        })();
        "@

        $result = & node -e $scriptText 2>&1
        $resultText = ($result | ForEach-Object { $_.ToString() }) -join "`n"
        $payload = $resultText | ConvertFrom-Json

        $payload.status | Should -Be 'blocked'
        $payload.blockers | Should -Contain 'mission-control-required'
        $payload.blockers | Should -Contain 'native-sre-agent-required'
    }

    It "returns blocked JSON for malformed and timeout scenarios and exits non-zero" {
        $timeoutResult = Invoke-DemoReadinessScript @(
            '-SubscriptionId', 'sub-timeout',
            '-ResourceGroupName', 'rg-timeout',
            '-Profile', 'demo',
            '-Json',
            '-RequireMissionControl',
            '-RequireNativeSreAgent',
            '-Mock', 'timeout'
        )
        $timeoutResult.ExitCode | Should -Be 1
        $timeoutPayload = $timeoutResult.StdOut | ConvertFrom-Json
        $timeoutPayload.status | Should -Be 'blocked'
        $timeoutPayload.blocking | Should -BeTrue

        $malformedResult = Invoke-DemoReadinessScript @(
            '-SubscriptionId', 'sub-malformed',
            '-ResourceGroupName', 'rg-malformed',
            '-Profile', 'demo',
            '-Json',
            '-RequireMissionControl',
            '-RequireNativeSreAgent',
            '-Mock', 'malformed'
        )
        $malformedResult.ExitCode | Should -Be 1
        $malformedPayload = $malformedResult.StdOut | ConvertFrom-Json
        $malformedPayload.status | Should -Be 'blocked'
    }

    It "redacts secrets from serialized evidence and leaves no new JSON artifacts behind" {
        $before = Get-ChildItem $script:RepoRoot -File | Where-Object { $_.Extension -eq '.json' } | Select-Object -ExpandProperty Name

        $redactionResult = Invoke-DemoReadinessScript @(
            '-SubscriptionId', 'sub-redact',
            '-ResourceGroupName', 'rg-redact',
            '-Profile', 'demo',
            '-Json',
            '-RequireMissionControl',
            '-RequireNativeSreAgent',
            '-Mock', 'redaction'
        )

        $redactionResult.ExitCode | Should -Be 1
        $redactionPayload = $redactionResult.StdOut | ConvertFrom-Json
        $redactionPayload.status | Should -Be 'blocked'

        $evidenceText = ($redactionPayload.checks | ConvertTo-Json -Depth 10 -Compress)
        $evidenceText | Should -Not -Match 'super-secret-token-123'
        $evidenceText | Should -Match '\[REDACTED\]'

        $after = Get-ChildItem $script:RepoRoot -File | Where-Object { $_.Extension -eq '.json' } | Select-Object -ExpandProperty Name
        $after | Should -Be $before
    }
}
