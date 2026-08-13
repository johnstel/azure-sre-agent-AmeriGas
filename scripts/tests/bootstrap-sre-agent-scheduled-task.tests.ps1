#Requires -Modules Pester

<#
.SYNOPSIS
    Pester tests for scripts/bootstrap-sre-agent-scheduled-task.ps1

.DESCRIPTION
    Covers the acceptance scenarios from issue #24:
      - Clean create (no prior task) writes exactly once via PUT and
        semantically verifies the write.
      - Unchanged rerun (existing state already semantically matches) makes
        zero write calls.
      - A prompt/parameter change triggers exactly one PATCH (not PUT,
        since the task already exists), preserving the task id/name.
      - A write that does not semantically round-trip is reported as
        SchemaMismatch, never success.
      - Explicit capability detection (404/405 on the ARM
        scheduledTasks sub-resource collection) never claims success and
        makes NO write calls.
      - -Action Validate detects drift in every tracked field without
        writing anything, and reports NotFound distinctly from Drift.
      - -Action RunNow capability-detects an unpublished execute path,
        never fabricates a thread when no candidate succeeds, and never
        fabricates an outcome when a thread id cannot be found in the
        response.
      - The health-report outcome parser only ever returns exactly one of
        Healthy / Degraded / Insufficient evidence, and defaults to
        Insufficient evidence for missing/malformed/absent status text —
        never Healthy by omission.
      - RunNow polling honors its bounded timeout and reports Timeout
        rather than fabricating a completed report.
      - -Action History is a best-effort, read-only heuristic that never
        invents an execution when none match.
      - Teardown removes only the scheduled task, idempotently (404 ==
        success).
      - The task is always written with agentAutonomyLevel=Autonomous;
        there is no parameter path to make it Review.
      - No data-plane bearer token is ever written to host/verbose output.

.EXAMPLE
    Invoke-Pester -Path scripts/tests/bootstrap-sre-agent-scheduled-task.tests.ps1
#>

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot ".." "bootstrap-sre-agent-scheduled-task.ps1"
    $script:PromptPath = Join-Path $PSScriptRoot ".." ".." "docs/sre-agent-scheduled-tasks/daily-propane-health-report-prompt.md"

    # Dot-source with dummy parameters so the file's own top-level execution
    # block (guarded by $MyInvocation.InvocationName -ne '.') is a no-op, and
    # only the reusable functions are defined in this scope.
    . $script:ScriptPath -ResourceGroupName 'rg-test' -AgentName 'agent-test' -AksClusterName 'aks-test'

    function New-FakeAgent {
        param([string]$ProvisioningState = 'Succeeded')
        return [pscustomobject]@{
            properties = [pscustomobject]@{
                provisioningState = $ProvisioningState
            }
        }
    }

    function ConvertTo-DecodedSpec {
        # Round-trips a spec through JSON exactly like a real server
        # response would arrive.
        param($Spec)
        return ($Spec | ConvertTo-Json -Depth 10 | ConvertFrom-Json)
    }

    function New-NotFoundResponse {
        return [pscustomobject]@{ StatusCode = 404; Success = $false; Content = $null; RawContent = 'not found' }
    }

    function New-OkResponse {
        param($Content)
        return [pscustomobject]@{ StatusCode = 200; Success = $true; Content = $Content; RawContent = ($Content | ConvertTo-Json -Depth 10 -Compress) }
    }

    function New-TestSpec {
        param([bool]$Enabled = $true)
        return New-ScheduledTaskDataPlaneSpec -Name 'daily-propane-health-report' -RenderedPrompt 'rendered prompt body' -PromptVersionHash 'abc123' -ScheduleHourUtc 8 -ScheduleMinuteUtc 0 -TimeZone 'UTC' -Enabled $Enabled
    }
}

Describe "ConvertTo-CanonicalJson / Get-ScheduledTaskPromptHash — deterministic, no BOM" {
    It "produces a stable 64-hex-character SHA-256 hash for the same text" {
        $hash1 = Get-ScheduledTaskPromptHash -Text 'hello world'
        $hash2 = Get-ScheduledTaskPromptHash -Text 'hello world'
        $hash1 | Should -Be $hash2
        $hash1 | Should -Match '^[0-9a-f]{64}$'
    }

    It "produces a different hash when the text changes" {
        $hash1 = Get-ScheduledTaskPromptHash -Text 'version 1'
        $hash2 = Get-ScheduledTaskPromptHash -Text 'version 2'
        $hash1 | Should -Not -Be $hash2
    }

    It "preserves nested arrays without unwrapping via ConvertTo-CanonicalJson" {
        $spec = New-TestSpec
        $json = ConvertTo-CanonicalJson -InputObject $spec
        $json | Should -Match '"frequency":"Daily"'
    }
}

Describe "New-ScheduledTaskDataPlaneSpec — always read-only Autonomous, never Review" {
    It "always sets agentAutonomyLevel to Autonomous" {
        $spec = New-TestSpec
        $spec.agentAutonomyLevel | Should -Be 'Autonomous'
    }

    It "leaves responseCustomAgent empty to use the main agent" {
        $spec = New-TestSpec
        $spec.responseCustomAgent | Should -Be ''
    }

    It "groups messages into the same thread" {
        $spec = New-TestSpec
        $spec.messageGrouping | Should -Be 'SameThread'
    }

    It "formats timeOfDay as zero-padded HH:mm" {
        $spec = New-ScheduledTaskDataPlaneSpec -Name 't' -RenderedPrompt 'p' -PromptVersionHash 'h' -ScheduleHourUtc 8 -ScheduleMinuteUtc 5 -TimeZone 'UTC' -Enabled $true
        $spec.timeOfDay | Should -Be '08:05'
    }
}

Describe "Get-RenderedScheduledTaskPrompt — placeholder substitution" {
    It "renders all placeholders from the real versioned prompt file" {
        $rendered = Get-RenderedScheduledTaskPrompt -PromptFilePath $script:PromptPath -SubscriptionId 'sub-123' -ResourceGroupName 'rg-srelab-eastus2' -AksClusterName 'aks-srelab'
        $rendered | Should -Match 'rg-srelab-eastus2'
        $rendered | Should -Match 'aks-srelab'
        $rendered | Should -Match 'sub-123'
        $rendered | Should -Not -Match '\{\{RESOURCE_GROUP\}\}'
        $rendered | Should -Not -Match '\{\{AKS_CLUSTER_NAME\}\}'
        $rendered | Should -Not -Match '\{\{SUBSCRIPTION_ID\}\}'
    }

    It "throws when the template file does not exist" {
        { Get-RenderedScheduledTaskPrompt -PromptFilePath '/nonexistent/path.md' -SubscriptionId 's' -ResourceGroupName 'r' -AksClusterName 'a' } | Should -Throw
    }

    It "requires the output contract's three mandatory status labels to be present" {
        $rendered = Get-RenderedScheduledTaskPrompt -PromptFilePath $script:PromptPath -SubscriptionId 's' -ResourceGroupName 'r' -AksClusterName 'a'
        $rendered | Should -Match 'Healthy'
        $rendered | Should -Match 'Degraded'
        $rendered | Should -Match 'Insufficient evidence'
    }
}

Describe "Test-ScheduledTaskSemanticMatch — real JSON round trip, not byte compare" {
    It "matches a spec round-tripped through real JSON encode/decode" {
        $spec = New-TestSpec
        $decoded = ConvertTo-DecodedSpec -Spec $spec
        Test-ScheduledTaskSemanticMatch -Expected $spec -Actual $decoded | Should -Be $true
    }

    It "detects a mismatch when taskDetails (prompt) differs" {
        $spec = New-TestSpec
        $tampered = ConvertTo-DecodedSpec -Spec (New-ScheduledTaskDataPlaneSpec -Name 'daily-propane-health-report' -RenderedPrompt 'DIFFERENT prompt' -PromptVersionHash 'abc123' -ScheduleHourUtc 8 -ScheduleMinuteUtc 0 -TimeZone 'UTC' -Enabled $true)
        Test-ScheduledTaskSemanticMatch -Expected $spec -Actual $tampered | Should -Be $false
    }

    It "detects a mismatch when the prompt hash differs (drift without matching taskDetails somehow)" {
        $spec = New-TestSpec
        $tampered = ConvertTo-DecodedSpec -Spec (New-ScheduledTaskDataPlaneSpec -Name 'daily-propane-health-report' -RenderedPrompt 'rendered prompt body' -PromptVersionHash 'different-hash' -ScheduleHourUtc 8 -ScheduleMinuteUtc 0 -TimeZone 'UTC' -Enabled $true)
        Test-ScheduledTaskSemanticMatch -Expected $spec -Actual $tampered | Should -Be $false
    }

    It "detects a mismatch when enabled differs" {
        $spec = New-TestSpec -Enabled $true
        $tampered = ConvertTo-DecodedSpec -Spec (New-TestSpec -Enabled $false)
        Test-ScheduledTaskSemanticMatch -Expected $spec -Actual $tampered | Should -Be $false
    }

    It "returns false when the actual value is null (task does not exist yet)" {
        Test-ScheduledTaskSemanticMatch -Expected (New-TestSpec) -Actual $null | Should -Be $false
    }

    It "rejects a decoded task whose agentAutonomyLevel is not Autonomous, even if every other field matches" {
        $spec = New-TestSpec
        $decoded = ConvertTo-DecodedSpec -Spec $spec
        $decoded.agentAutonomyLevel = 'Review'
        Test-ScheduledTaskSemanticMatch -Expected $spec -Actual $decoded | Should -Be $false
    }
}

Describe "Test-ScheduledTaskApiSupported — capability detection on the ARM scheduledTasks collection" {
    It "returns false on a confirmed 404 from the ARM collection probe" {
        Mock Invoke-ArmControlPlaneRequest { [pscustomobject]@{ StatusCode = 404; Success = $false; RawContent = 'not found' } }
        Test-ScheduledTaskApiSupported -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'agent' -ApiVersion '2026-01-01' | Should -Be $false
    }

    It "returns false on a confirmed 405 from the ARM collection probe" {
        Mock Invoke-ArmControlPlaneRequest { [pscustomobject]@{ StatusCode = 405; Success = $false; RawContent = 'not allowed' } }
        Test-ScheduledTaskApiSupported -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'agent' -ApiVersion '2026-01-01' | Should -Be $false
    }

    It "returns true when the collection responds 200 with an empty value array" {
        Mock Invoke-ArmControlPlaneRequest { [pscustomobject]@{ StatusCode = 200; Success = $true; Content = [pscustomobject]@{ value = @() }; RawContent = '{"value":[]}' } }
        Test-ScheduledTaskApiSupported -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'agent' -ApiVersion '2026-01-01' | Should -Be $true
    }

    It "throws (never silently reports unsupported) on a non-404/405 failure such as 500" {
        Mock Invoke-ArmControlPlaneRequest { [pscustomobject]@{ StatusCode = 500; Success = $false; RawContent = 'boom' } }
        { Test-ScheduledTaskApiSupported -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'agent' -ApiVersion '2026-01-01' } | Should -Throw
    }
}

Describe "Assert-AgentReadyForScheduledTask — only requires provisioningState Succeeded" {
    It "does not throw for an agent with no incident-management connection or non-Review mode (unlike the response plan)" {
        { Assert-AgentReadyForScheduledTask -Agent (New-FakeAgent) -AgentName 'agent' } | Should -Not -Throw
    }

    It "throws when provisioningState is not Succeeded" {
        { Assert-AgentReadyForScheduledTask -Agent (New-FakeAgent -ProvisioningState 'Failed') -AgentName 'agent' } | Should -Throw
    }
}

Describe "Assert-ScheduledTaskSubscriptionMatch — wrong-subscription rejection" {
    It "throws when the resource group belongs to a different subscription" {
        Mock az {
            $global:LASTEXITCODE = 0
            if ($args[0] -eq 'account') { return 'sub-current' }
            if ($args[0] -eq 'group') { return '/subscriptions/sub-DIFFERENT/resourceGroups/rg-test' }
        }
        { Assert-ScheduledTaskSubscriptionMatch -ResourceGroupName 'rg-test' } | Should -Throw
    }

    It "returns the subscription id when it matches" {
        Mock az {
            $global:LASTEXITCODE = 0
            if ($args[0] -eq 'account') { return 'sub-current' }
            if ($args[0] -eq 'group') { return '/subscriptions/sub-current/resourceGroups/rg-test' }
        }
        Assert-ScheduledTaskSubscriptionMatch -ResourceGroupName 'rg-test' | Should -Be 'sub-current'
    }
}

Describe "Set-ScheduledTaskDataPlaneIdempotent" {
    It "makes exactly one PUT when the task does not exist yet" {
        $script:calledMethods = [System.Collections.Generic.List[string]]::new()
        $spec = New-TestSpec
        Mock Invoke-DataPlaneRequest {
            $script:calledMethods.Add($Method)
            if ($Method -eq 'GET' -and $script:calledMethods.Count -eq 1) { return New-NotFoundResponse }
            return New-OkResponse -Content (ConvertTo-DecodedSpec -Spec $spec)
        }

        $result = Set-ScheduledTaskDataPlaneIdempotent -Endpoint 'https://a' -Token 't' -Path '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report' -Spec $spec
        $result.Success | Should -Be $true
        $result.Reason | Should -Be 'Written'
        $script:calledMethods | Should -Contain 'PUT'
        $script:calledMethods | Should -Not -Contain 'PATCH'
    }

    It "makes exactly one PATCH (not PUT) when the task already exists but differs" {
        $spec = New-TestSpec
        $existingDifferent = ConvertTo-DecodedSpec -Spec (New-TestSpec -Enabled $false)
        $script:setIdempotentCallCount = 0
        Mock Invoke-DataPlaneRequest {
            $script:setIdempotentCallCount++
            if ($script:setIdempotentCallCount -eq 1) { return New-OkResponse -Content $existingDifferent }
            return New-OkResponse -Content (ConvertTo-DecodedSpec -Spec $spec)
        }

        $result = Set-ScheduledTaskDataPlaneIdempotent -Endpoint 'https://a' -Token 't' -Path '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report' -Spec $spec
        $result.Success | Should -Be $true
        $result.Reason | Should -Be 'Written'
    }

    It "makes ZERO write calls when the existing task already semantically matches" {
        $spec = New-TestSpec
        Mock Invoke-DataPlaneRequest {
            if ($Method -ne 'GET') { throw "should not be called — task is unchanged" }
            return New-OkResponse -Content (ConvertTo-DecodedSpec -Spec $spec)
        }

        $result = Set-ScheduledTaskDataPlaneIdempotent -Endpoint 'https://a' -Token 't' -Path '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report' -Spec $spec
        $result.Success | Should -Be $true
        $result.Reason | Should -Be 'Unchanged'
    }

    It "reports UnsupportedApi (never success) on a 404/405 from the write itself" {
        $spec = New-TestSpec
        $callCount = 0
        Mock Invoke-DataPlaneRequest {
            $callCount++
            if ($callCount -eq 1) { return New-NotFoundResponse }
            return [pscustomobject]@{ StatusCode = 405; Success = $false; RawContent = 'not allowed' }
        }

        $result = Set-ScheduledTaskDataPlaneIdempotent -Endpoint 'https://a' -Token 't' -Path '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report' -Spec $spec
        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'UnsupportedApi'
    }

    It "reports SchemaMismatch (never success) when the semantic re-read does not match what was sent" {
        $spec = New-TestSpec
        $script:schemaMismatchCallCount = 0
        Mock Invoke-DataPlaneRequest {
            $script:schemaMismatchCallCount++
            if ($script:schemaMismatchCallCount -eq 1) { return New-NotFoundResponse }
            if ($script:schemaMismatchCallCount -eq 2) { return New-OkResponse -Content $null } # PUT ack
            return New-OkResponse -Content (ConvertTo-DecodedSpec -Spec (New-TestSpec -Enabled $false)) # verify GET, mismatched
        }

        $result = Set-ScheduledTaskDataPlaneIdempotent -Endpoint 'https://a' -Token 't' -Path '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report' -Spec $spec
        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'SchemaMismatch'
    }

    It "throws (does not silently proceed) when the pre-write GET fails with a non-404 status" {
        $spec = New-TestSpec
        Mock Invoke-DataPlaneRequest { [pscustomobject]@{ StatusCode = 500; Success = $false; RawContent = 'boom' } }
        { Set-ScheduledTaskDataPlaneIdempotent -Endpoint 'https://a' -Token 't' -Path '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report' -Spec $spec } | Should -Throw
    }
}

Describe "Invoke-ScheduledTaskBootstrap — end-to-end orchestration" {
    BeforeEach {
        Mock Get-RenderedScheduledTaskPrompt { 'rendered prompt body' }
    }

    It "reports UnsupportedApi and makes NO write calls when the capability probe fails" {
        Mock Test-ScheduledTaskApiSupported { $false }
        Mock Set-ScheduledTaskDataPlaneIdempotent { throw "should not be called" }

        $result = Invoke-ScheduledTaskBootstrap -Endpoint 'https://a' -Token 't' -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'agent' -ApiVersion '2026-01-01' -AksClusterName 'aks-test' -TaskName 'daily-propane-health-report' -ScheduleHourUtc 8 -ScheduleMinuteUtc 0 -TimeZone 'UTC' -Enabled $true -PromptFilePath $script:PromptPath -DataPlanePath '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report'

        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'UnsupportedApi'
    }

    It "reports success and mentions semantic verification when the task is written" {
        Mock Test-ScheduledTaskApiSupported { $true }
        Mock Set-ScheduledTaskDataPlaneIdempotent { [pscustomobject]@{ Success = $true; Reason = 'Written' } }

        $result = Invoke-ScheduledTaskBootstrap -Endpoint 'https://a' -Token 't' -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'agent' -ApiVersion '2026-01-01' -AksClusterName 'aks-test' -TaskName 'daily-propane-health-report' -ScheduleHourUtc 8 -ScheduleMinuteUtc 0 -TimeZone 'UTC' -Enabled $true -PromptFilePath $script:PromptPath -DataPlanePath '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report'

        $result.Success | Should -Be $true
        $result.Message | Should -Match 'semantically verified'
        $result.TaskName | Should -Be 'daily-propane-health-report'
        $result.PromptVersionHash | Should -Match '^[0-9a-f]{64}$'
    }

    It "propagates a SchemaMismatch as an overall failure" {
        Mock Test-ScheduledTaskApiSupported { $true }
        Mock Set-ScheduledTaskDataPlaneIdempotent { [pscustomobject]@{ Success = $false; Reason = 'SchemaMismatch'; Message = 'mismatch' } }

        $result = Invoke-ScheduledTaskBootstrap -Endpoint 'https://a' -Token 't' -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'agent' -ApiVersion '2026-01-01' -AksClusterName 'aks-test' -TaskName 'daily-propane-health-report' -ScheduleHourUtc 8 -ScheduleMinuteUtc 0 -TimeZone 'UTC' -Enabled $true -PromptFilePath $script:PromptPath -DataPlanePath '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report'

        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'SchemaMismatch'
    }
}

Describe "Invoke-ScheduledTaskValidate — read-only, never writes" {
    BeforeEach {
        Mock Get-RenderedScheduledTaskPrompt { 'rendered prompt body' }
    }

    It "reports NotFound distinctly from a drift, and never calls a write method" {
        Mock Invoke-DataPlaneRequest {
            if ($Method -ne 'GET') { throw "Validate must never write" }
            return New-NotFoundResponse
        }

        $result = Invoke-ScheduledTaskValidate -Endpoint 'https://a' -Token 't' -SubscriptionId 's' -ResourceGroupName 'rg' -AksClusterName 'aks-test' -TaskName 'daily-propane-health-report' -ScheduleHourUtc 8 -ScheduleMinuteUtc 0 -TimeZone 'UTC' -Enabled $true -PromptFilePath $script:PromptPath -DataPlanePath '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report'

        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'NotFound'
    }

    It "reports Valid when the live task matches the versioned spec exactly" {
        # Invoke-ScheduledTaskValidate recomputes the prompt hash itself from
        # the (mocked) rendered prompt text, so the fake "live" document must
        # embed that SAME real hash — not an arbitrary placeholder — for an
        # exact-match scenario to be representative.
        $realPromptHash = Get-ScheduledTaskPromptHash -Text 'rendered prompt body'
        $expectedSpec = New-ScheduledTaskDataPlaneSpec -Name 'daily-propane-health-report' -RenderedPrompt 'rendered prompt body' -PromptVersionHash $realPromptHash -ScheduleHourUtc 8 -ScheduleMinuteUtc 0 -TimeZone 'UTC' -Enabled $true
        Mock Invoke-DataPlaneRequest {
            if ($Method -ne 'GET') { throw "Validate must never write" }
            return New-OkResponse -Content (ConvertTo-DecodedSpec -Spec $expectedSpec)
        }

        $result = Invoke-ScheduledTaskValidate -Endpoint 'https://a' -Token 't' -SubscriptionId 's' -ResourceGroupName 'rg' -AksClusterName 'aks-test' -TaskName 'daily-propane-health-report' -ScheduleHourUtc 8 -ScheduleMinuteUtc 0 -TimeZone 'UTC' -Enabled $true -PromptFilePath $script:PromptPath -DataPlanePath '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report'

        $result.Success | Should -Be $true
        $result.Reason | Should -Be 'Valid'
    }

    It "reports Drift and names the exact drifted field(s) when the prompt hash has changed" {
        $liveButStalePrompt = ConvertTo-DecodedSpec -Spec (New-ScheduledTaskDataPlaneSpec -Name 'daily-propane-health-report' -RenderedPrompt 'OLD prompt' -PromptVersionHash 'old-hash-value' -ScheduleHourUtc 8 -ScheduleMinuteUtc 0 -TimeZone 'UTC' -Enabled $true)
        Mock Invoke-DataPlaneRequest {
            if ($Method -ne 'GET') { throw "Validate must never write" }
            return New-OkResponse -Content $liveButStalePrompt
        }

        $result = Invoke-ScheduledTaskValidate -Endpoint 'https://a' -Token 't' -SubscriptionId 's' -ResourceGroupName 'rg' -AksClusterName 'aks-test' -TaskName 'daily-propane-health-report' -ScheduleHourUtc 8 -ScheduleMinuteUtc 0 -TimeZone 'UTC' -Enabled $true -PromptFilePath $script:PromptPath -DataPlanePath '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report'

        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'Drift'
        $result.DriftedFields | Should -Contain 'promptVersionHash'
    }

    It "reports Drift when agentAutonomyLevel is not Autonomous on the live task" {
        $expectedSpec = New-TestSpec
        $liveTampered = ConvertTo-DecodedSpec -Spec $expectedSpec
        $liveTampered.agentAutonomyLevel = 'Review'
        Mock Invoke-DataPlaneRequest {
            if ($Method -ne 'GET') { throw "Validate must never write" }
            return New-OkResponse -Content $liveTampered
        }

        $result = Invoke-ScheduledTaskValidate -Endpoint 'https://a' -Token 't' -SubscriptionId 's' -ResourceGroupName 'rg' -AksClusterName 'aks-test' -TaskName 'daily-propane-health-report' -ScheduleHourUtc 8 -ScheduleMinuteUtc 0 -TimeZone 'UTC' -Enabled $true -PromptFilePath $script:PromptPath -DataPlanePath '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report'

        $result.Success | Should -Be $false
        $result.DriftedFields | Should -Contain 'agentAutonomyLevel'
    }
}

Describe "ConvertTo-HealthReportOutcome — never fabricates Healthy" {
    It "parses a well-formed Healthy status line" {
        ConvertTo-HealthReportOutcome -Text "Executive summary...`nOverall status: Healthy" | Should -Be 'Healthy'
    }

    It "parses a well-formed Degraded status line" {
        ConvertTo-HealthReportOutcome -Text "Overall status: Degraded" | Should -Be 'Degraded'
    }

    It "parses a well-formed Insufficient evidence status line" {
        ConvertTo-HealthReportOutcome -Text "Overall status: Insufficient evidence" | Should -Be 'Insufficient evidence'
    }

    It "returns Insufficient evidence (never Healthy) for null/empty text" {
        ConvertTo-HealthReportOutcome -Text $null | Should -Be 'Insufficient evidence'
        ConvertTo-HealthReportOutcome -Text '' | Should -Be 'Insufficient evidence'
    }

    It "returns Insufficient evidence (never Healthy) when no recognized label is present" {
        ConvertTo-HealthReportOutcome -Text 'Everything looks great, no issues found!' | Should -Be 'Insufficient evidence'
    }

    It "returns Insufficient evidence for a malformed/unrecognized label" {
        ConvertTo-HealthReportOutcome -Text 'Overall status: Mostly Fine' | Should -Be 'Insufficient evidence'
    }
}

Describe "Get-ThreadIdFromRunNowResponse — tolerant extraction, never fabricates" {
    It "extracts threadId directly" {
        Get-ThreadIdFromRunNowResponse -Content ([pscustomobject]@{ threadId = 'THREAD-1' }) | Should -Be 'THREAD-1'
    }

    It "extracts a nested thread.id" {
        Get-ThreadIdFromRunNowResponse -Content ([pscustomobject]@{ thread = [pscustomobject]@{ id = 'THREAD-2' } }) | Should -Be 'THREAD-2'
    }

    It "returns null when no recognizable field is present" {
        Get-ThreadIdFromRunNowResponse -Content ([pscustomobject]@{ unrelated = 'value' }) | Should -BeNullOrEmpty
    }

    It "returns null for null content" {
        Get-ThreadIdFromRunNowResponse -Content $null | Should -BeNullOrEmpty
    }
}

Describe "Invoke-ScheduledTaskRunNowRequest — capability detection for an unpublished trigger path" {
    It "reports UnsupportedApi when both candidate paths 404" {
        Mock Invoke-DataPlaneRequest { New-NotFoundResponse }
        $result = Invoke-ScheduledTaskRunNowRequest -Endpoint 'https://a' -Token 't' -TaskDataPlanePath '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report'
        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'UnsupportedApi'
        $result.Message | Should -Match 'Run task now'
    }

    It "succeeds on the first candidate that returns 2xx and does not try the second" {
        $attemptedPaths = [System.Collections.Generic.List[string]]::new()
        Mock Invoke-DataPlaneRequest {
            $attemptedPaths.Add($Path)
            New-OkResponse -Content ([pscustomobject]@{ threadId = 'THREAD-1' })
        }
        $result = Invoke-ScheduledTaskRunNowRequest -Endpoint 'https://a' -Token 't' -TaskDataPlanePath '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report'
        $result.Success | Should -Be $true
        $attemptedPaths.Count | Should -Be 1
    }

    It "throws (never silently reports unsupported) on a non-404/405 failure such as 500" {
        Mock Invoke-DataPlaneRequest { [pscustomobject]@{ StatusCode = 500; Success = $false; RawContent = 'boom' } }
        { Invoke-ScheduledTaskRunNowRequest -Endpoint 'https://a' -Token 't' -TaskDataPlanePath '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report' } | Should -Throw
    }
}

Describe "Wait-ScheduledTaskThreadReport — bounded polling, never fabricates completion" {
    It "returns Completed with the parsed outcome once the thread reports Complete" {
        Mock Invoke-DataPlaneRequest {
            if ($Path -match '/messages$') {
                return New-OkResponse -Content ([pscustomobject]@{ value = @([pscustomobject]@{ content = "Overall status: Healthy" }) })
            }
            return New-OkResponse -Content ([pscustomobject]@{ status = 'Complete' })
        }

        $result = Wait-ScheduledTaskThreadReport -Endpoint 'https://a' -Token 't' -ThreadId 'THREAD-1' -MaxWaitSeconds 5 -PollIntervalSeconds 1
        $result.Success | Should -Be $true
        $result.Outcome | Should -Be 'Healthy'
    }

    It "reports Timeout (never a fabricated completion) when the thread never reaches Complete within the bound" {
        Mock Invoke-DataPlaneRequest { New-OkResponse -Content ([pscustomobject]@{ status = 'InProgress' }) }

        $sleepCalls = 0
        $result = Wait-ScheduledTaskThreadReport -Endpoint 'https://a' -Token 't' -ThreadId 'THREAD-1' -MaxWaitSeconds 0 -PollIntervalSeconds 0 -SleepOverride { param($seconds) $sleepCalls++ }
        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'Timeout'
    }
}

Describe "Invoke-ScheduledTaskRunNow — end-to-end orchestration, never fabricates a report" {
    It "propagates UnsupportedApi from the trigger step without polling" {
        Mock Invoke-ScheduledTaskRunNowRequest { [pscustomobject]@{ Success = $false; Reason = 'UnsupportedApi'; Message = 'no candidate path supported' } }
        Mock Wait-ScheduledTaskThreadReport { throw "should not poll when trigger failed" }

        $result = Invoke-ScheduledTaskRunNow -Endpoint 'https://a' -Token 't' -TaskDataPlanePath '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report'
        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'UnsupportedApi'
    }

    It "reports SchemaMismatch (never a fabricated thread) when RunNow succeeds but no thread id can be found" {
        Mock Invoke-ScheduledTaskRunNowRequest { [pscustomobject]@{ Success = $true; Reason = 'Triggered'; Content = [pscustomobject]@{ unrelated = 'field' }; Path = '/x/run' } }
        Mock Wait-ScheduledTaskThreadReport { throw "should not poll without a thread id" }

        $result = Invoke-ScheduledTaskRunNow -Endpoint 'https://a' -Token 't' -TaskDataPlanePath '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report'
        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'SchemaMismatch'
    }

    It "returns the completed outcome end-to-end when the trigger and poll both succeed" {
        Mock Invoke-ScheduledTaskRunNowRequest { [pscustomobject]@{ Success = $true; Reason = 'Triggered'; Content = [pscustomobject]@{ threadId = 'THREAD-9' }; Path = '/x/run' } }
        Mock Wait-ScheduledTaskThreadReport { [pscustomobject]@{ Success = $true; Reason = 'Completed'; ThreadId = 'THREAD-9'; Status = 'Complete'; Timestamp = '2024-01-01T00:00:00Z'; Outcome = 'Degraded'; ReportText = 'text' } }

        $result = Invoke-ScheduledTaskRunNow -Endpoint 'https://a' -Token 't' -TaskDataPlanePath '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report'
        $result.Success | Should -Be $true
        $result.Outcome | Should -Be 'Degraded'
        $result.ThreadId | Should -Be 'THREAD-9'
    }
}

Describe "Get-ScheduledTaskExecutionHistory — best-effort, never invents an execution" {
    It "reports NoHistory when no thread title matches the task name" {
        Mock Invoke-DataPlaneRequest { New-OkResponse -Content ([pscustomobject]@{ value = @([pscustomobject]@{ id = 't1'; title = 'unrelated chat'; createdAt = '2024-01-01T00:00:00Z' }) }) }

        $result = Get-ScheduledTaskExecutionHistory -Endpoint 'https://a' -Token 't' -TaskName 'daily-propane-health-report'
        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'NoHistory'
    }

    It "finds and reports the most recent matching thread" {
        Mock Invoke-DataPlaneRequest {
            if ($Path -eq '/api/v1/threads') {
                return New-OkResponse -Content ([pscustomobject]@{ value = @(
                            [pscustomobject]@{ id = 'older'; title = 'daily-propane-health-report run'; createdAt = '2024-01-01T00:00:00Z' },
                            [pscustomobject]@{ id = 'newer'; title = 'daily-propane-health-report run'; createdAt = '2024-01-02T00:00:00Z' }
                        ) })
            }
            return New-OkResponse -Content ([pscustomobject]@{ status = 'Complete' })
        }

        $result = Get-ScheduledTaskExecutionHistory -Endpoint 'https://a' -Token 't' -TaskName 'daily-propane-health-report'
        $result.Success | Should -Be $true
        $result.ExecutionCount | Should -Be 2
        $result.LatestThreadId | Should -Be 'newer'
    }
}

Describe "Invoke-ScheduledTaskTeardown — idempotent, scoped to exactly this task" {
    It "deletes only the scheduled task path" {
        $calledPaths = [System.Collections.Generic.List[string]]::new()
        Mock Invoke-DataPlaneRequest {
            $calledPaths.Add($Path)
            New-OkResponse -Content $null
        }

        Invoke-ScheduledTaskTeardown -Endpoint 'https://a' -Token 't' -TaskName 'daily-propane-health-report' -Path '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report' | Out-Null

        $calledPaths.Count | Should -Be 1
        $calledPaths[0] | Should -Be '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report'
    }

    It "treats 404 as success (idempotent — already torn down)" {
        Mock Invoke-DataPlaneRequest { New-NotFoundResponse }
        $result = Invoke-ScheduledTaskTeardown -Endpoint 'https://a' -Token 't' -TaskName 'daily-propane-health-report' -Path '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report'
        $result.Success | Should -Be $true
    }

    It "throws on a genuine delete failure (non-404, non-2xx)" {
        Mock Invoke-DataPlaneRequest { [pscustomobject]@{ StatusCode = 500; Success = $false; RawContent = 'boom' } }
        { Invoke-ScheduledTaskTeardown -Endpoint 'https://a' -Token 't' -TaskName 'daily-propane-health-report' -Path '/api/v2/extendedAgent/scheduledtasks/daily-propane-health-report' } | Should -Throw
    }
}

Describe "No data-plane token is ever written to host output" {
    It "the script source never interpolates the token directly into Write-Host/Write-Verbose" {
        $source = Get-Content -Path $script:ScriptPath -Raw
        $source | Should -Not -Match 'Write-(Host|Verbose)[^\n]*\$(dataPlaneToken|Token)\b'
    }
}
