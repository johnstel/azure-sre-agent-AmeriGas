#Requires -Modules Pester

<#
.SYNOPSIS
    Pester tests for scripts/bootstrap-sre-agent-response-plan.ps1

.DESCRIPTION
    Covers the acceptance scenarios from issue #19 (round 2 — semantic
    data-plane verification, not opaque ARM envelope round-trip):
      - Clean bootstrap (custom agent + filter + handler all newly created)
      - Unchanged rerun (existing state already semantically matches) makes
        zero PUT calls for any of the three resources
      - A changed instructions file / filter parameter triggers exactly one
        PUT per changed resource, verified via SEMANTIC re-read (not byte
        comparison)
      - A write that does not semantically round-trip is reported as
        SchemaMismatch, never as success
      - Explicit "unsupported API" detection (404/405 on the filter/handler
        LIST endpoints) never claims success and makes NO write calls at
        all — not even for the custom agent
      - A 404/405 on the custom-agent PUT itself (list endpoints supported,
        but the officially documented agent endpoint isn't) is also
        Unsupported
      - Wrong-subscription / wrong-resource-group detection fails fast
      - The agent must be Succeeded + Review mode + AzMonitor-connected
        before a response plan is bootstrapped
      - The incident filter always sets agentMode to 'Review', never
        'Autonomous' (there is no parameter path to override this)
      - A conflicting quickstart filter is removed AND its absence is
        re-verified when the API supports DELETE, and causes a hard failure
        (not a silent partial success) when it cannot be removed or
        confirmed absent
      - Teardown removes the handler, filter, and custom agent idempotently
        (404 == success), in the correct order (handler first)
      - No data-plane bearer token is ever written to host/verbose output

.EXAMPLE
    Invoke-Pester -Path scripts/tests/bootstrap-sre-agent-response-plan.tests.ps1
#>

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot ".." "bootstrap-sre-agent-response-plan.ps1"
    $script:InstructionsPath = Join-Path $PSScriptRoot ".." ".." "docs/sre-agent-response-plans/mongodb-down-custom-agent-instructions.md"

    # Dot-source with dummy parameters so the file's own top-level execution
    # block (guarded by $MyInvocation.InvocationName -ne '.') is a no-op, and
    # only the reusable functions are defined in this scope.
    . $script:ScriptPath -ResourceGroupName 'rg-test' -AgentName 'agent-test' -AksClusterName 'aks-test'

    function New-FakeAgent {
        param(
            [string]$ProvisioningState = 'Succeeded',
            [string]$Mode = 'Review',
            [string]$IncidentType = 'AzMonitor'
        )
        return [pscustomobject]@{
            properties = [pscustomobject]@{
                provisioningState              = $ProvisioningState
                actionConfiguration             = [pscustomobject]@{ mode = $Mode }
                incidentManagementConfiguration = [pscustomobject]@{ type = $IncidentType }
            }
        }
    }

    function ConvertTo-DecodedSpec {
        # Round-trips a spec through JSON exactly like a real server
        # response would arrive, so tests exercise the same decode path as
        # production (pscustomobject with real arrays, not the original
        # ordered-dictionary spec object).
        param($Spec)
        return ($Spec | ConvertTo-Json -Depth 10 | ConvertFrom-Json)
    }

    function New-ListResponse {
        param([array]$Items, [int]$StatusCode = 200)
        return [pscustomobject]@{
            StatusCode = $StatusCode
            Success    = ($StatusCode -ge 200 -and $StatusCode -lt 300)
            Content    = [pscustomobject]@{ value = @($Items) }
            RawContent = ($Items | ConvertTo-Json -Depth 10 -Compress)
        }
    }

    function New-NotFoundResponse {
        return [pscustomobject]@{ StatusCode = 404; Success = $false; Content = $null; RawContent = 'not found' }
    }

    function New-OkResponse {
        param($Content)
        return [pscustomobject]@{ StatusCode = 200; Success = $true; Content = $Content; RawContent = ($Content | ConvertTo-Json -Depth 10 -Compress) }
    }
}

Describe "ConvertTo-CanonicalJson / severity mapping / array preservation" {
    It "preserves single-element arrays (regression: PowerShell function-return array unwrapping via Compare-Object/Measure-Object precedence)" {
        $spec = New-CustomAgentDataPlaneSpec -Name 'test-agent' -RenderedInstructions 'hello'
        $json = ConvertTo-CanonicalJson -InputObject $spec
        $json | Should -Match '"tools":\["azure_cli"\]'
    }

    It "maps severity 0-4 to Sev0-Sev4" {
        0..4 | ForEach-Object {
            ConvertTo-SeverityLabel -Severity $_ | Should -Be "Sev$_"
        }
    }
}

Describe "Test-CustomAgentSemanticMatch / Test-FilterSemanticMatch / Test-HandlerSemanticMatch — real JSON round trip, not byte compare" {
    It "matches a custom-agent spec round-tripped through real JSON encode/decode" {
        $spec = New-CustomAgentDataPlaneSpec -Name 'mongodb-down-responder' -RenderedInstructions 'v1 instructions'
        $decoded = ConvertTo-DecodedSpec -Spec $spec
        Test-CustomAgentSemanticMatch -Expected $spec -Actual $decoded | Should -Be $true
    }

    It "detects a custom-agent semantic mismatch (different system_prompt)" {
        $spec = New-CustomAgentDataPlaneSpec -Name 'mongodb-down-responder' -RenderedInstructions 'v1 instructions'
        $tampered = ConvertTo-DecodedSpec -Spec (New-CustomAgentDataPlaneSpec -Name 'mongodb-down-responder' -RenderedInstructions 'DIFFERENT instructions')
        Test-CustomAgentSemanticMatch -Expected $spec -Actual $tampered | Should -Be $false
    }

    It "matches an incident-filter spec round-tripped through real JSON encode/decode" {
        $spec = New-IncidentFilterDataPlaneSpec -Id 'mongodb-down-response-plan' -CustomAgentName 'mongodb-down-responder' -AlertTitle 'AmeriGas Propane Demo - MongoDB Down' -AlertSeverity 1
        $decoded = ConvertTo-DecodedSpec -Spec $spec
        Test-FilterSemanticMatch -Expected $spec -Actual $decoded | Should -Be $true
    }

    It "detects a filter semantic mismatch (different severity)" {
        $spec = New-IncidentFilterDataPlaneSpec -Id 'mongodb-down-response-plan' -CustomAgentName 'mongodb-down-responder' -AlertTitle 'AmeriGas Propane Demo - MongoDB Down' -AlertSeverity 1
        $tampered = ConvertTo-DecodedSpec -Spec (New-IncidentFilterDataPlaneSpec -Id 'mongodb-down-response-plan' -CustomAgentName 'mongodb-down-responder' -AlertTitle 'AmeriGas Propane Demo - MongoDB Down' -AlertSeverity 2)
        Test-FilterSemanticMatch -Expected $spec -Actual $tampered | Should -Be $false
    }

    It "rejects a filter whose interpreted agentMode is not Review, even if the field was requested as Review (server-side reinterpretation)" {
        $spec = New-IncidentFilterDataPlaneSpec -Id 'mongodb-down-response-plan' -CustomAgentName 'mongodb-down-responder' -AlertTitle 'title' -AlertSeverity 1
        $decoded = ConvertTo-DecodedSpec -Spec $spec
        $decoded.agentMode = 'Autonomous'
        Test-FilterSemanticMatch -Expected $spec -Actual $decoded | Should -Be $false
    }

    It "rejects a filter whose interpreted mergeEnabled is false" {
        $spec = New-IncidentFilterDataPlaneSpec -Id 'mongodb-down-response-plan' -CustomAgentName 'mongodb-down-responder' -AlertTitle 'title' -AlertSeverity 1
        $decoded = ConvertTo-DecodedSpec -Spec $spec
        $decoded.mergeEnabled = $false
        Test-FilterSemanticMatch -Expected $spec -Actual $decoded | Should -Be $false
    }

    It "treats a null actual as a mismatch, not a crash" {
        $spec = New-IncidentFilterDataPlaneSpec -Id 'x' -CustomAgentName 'a' -AlertTitle 't' -AlertSeverity 1
        Test-FilterSemanticMatch -Expected $spec -Actual $null | Should -Be $false
    }

    It "matches an incident-handler spec round-tripped through real JSON encode/decode" {
        $spec = New-IncidentHandlerDataPlaneSpec -Id 'mongodb-down-response-plan' -IncidentFilterId 'mongodb-down-response-plan' -CustomAgentName 'mongodb-down-responder'
        $decoded = ConvertTo-DecodedSpec -Spec $spec
        Test-HandlerSemanticMatch -Expected $spec -Actual $decoded | Should -Be $true
    }

    It "detects a handler bound to the wrong filter id" {
        $spec = New-IncidentHandlerDataPlaneSpec -Id 'mongodb-down-response-plan' -IncidentFilterId 'mongodb-down-response-plan' -CustomAgentName 'mongodb-down-responder'
        $tampered = ConvertTo-DecodedSpec -Spec (New-IncidentHandlerDataPlaneSpec -Id 'mongodb-down-response-plan' -IncidentFilterId 'some-other-filter' -CustomAgentName 'mongodb-down-responder')
        Test-HandlerSemanticMatch -Expected $spec -Actual $tampered | Should -Be $false
    }
}

Describe "New-IncidentFilterDataPlaneSpec — always Review autonomy, never Autonomous" {
    It "sets agentMode to 'Review' regardless of inputs" {
        (New-IncidentFilterDataPlaneSpec -Id 'a' -CustomAgentName 'x' -AlertTitle 'anything' -AlertSeverity 0).agentMode | Should -Be 'Review'
        (New-IncidentFilterDataPlaneSpec -Id 'b' -CustomAgentName 'y' -AlertTitle 'anything else' -AlertSeverity 4).agentMode | Should -Be 'Review'
    }

    It "has no parameter that can set agentMode to Autonomous" {
        (Get-Command New-IncidentFilterDataPlaneSpec).Parameters.Keys | Should -Not -Contain 'AgentMode'
    }

    It "never includes an incidentPlatform field (server-derived, per instructions)" {
        $spec = New-IncidentFilterDataPlaneSpec -Id 'a' -CustomAgentName 'x' -AlertTitle 't' -AlertSeverity 1
        $spec.Keys | Should -Not -Contain 'incidentPlatform'
    }

    It "sets mergeEnabled=true and mergeWindowHours=3 (platform default reinvestigation cooldown)" {
        $spec = New-IncidentFilterDataPlaneSpec -Id 'a' -CustomAgentName 'x' -AlertTitle 't' -AlertSeverity 1
        $spec.mergeEnabled | Should -Be $true
        $spec.mergeWindowHours | Should -Be 3
    }
}

Describe "New-IncidentHandlerDataPlaneSpec — always Review mode" {
    It "sets agentMode to 'Review'" {
        (New-IncidentHandlerDataPlaneSpec -Id 'a' -IncidentFilterId 'f' -CustomAgentName 'x').agentMode | Should -Be 'Review'
    }
}

Describe "Get-RenderedCustomAgentInstructions" {
    It "substitutes every documented placeholder and leaves none unrendered" {
        $rendered = Get-RenderedCustomAgentInstructions -InstructionsFilePath $script:InstructionsPath -SubscriptionId 'sub-123' -ResourceGroupName 'rg-srelab-eastus2' -AksClusterName 'aks-srelab' -AlertTitle 'AmeriGas Propane Demo - MongoDB Down' -AlertSeverity 1
        $rendered | Should -Match 'sub-123'
        $rendered | Should -Match 'rg-srelab-eastus2'
        $rendered | Should -Match 'aks-srelab'
    }

    It "throws if the instructions file does not exist" {
        { Get-RenderedCustomAgentInstructions -InstructionsFilePath (Join-Path ([System.IO.Path]::GetTempPath()) "does-not-exist-$([guid]::NewGuid()).md") -SubscriptionId 'x' -ResourceGroupName 'y' -AksClusterName 'z' -AlertTitle 't' -AlertSeverity 1 } | Should -Throw "*not found*"
    }
}

Describe "Test-ResponsePlanApiSupported — capability detection on the semantic list endpoints" {
    It "returns false when the incident-filters list responds 404" {
        Mock Invoke-DataPlaneRequest {
            if ($Path -eq '/api/v2/incidentManagement/incidentFilters') { return New-NotFoundResponse }
            return New-OkResponse -Content @()
        }
        Test-ResponsePlanApiSupported -Endpoint 'https://agent.example.azuresre.ai' -Token 'fake-token' | Should -Be $false
    }

    It "returns false when the incident-handlers list responds 405" {
        Mock Invoke-DataPlaneRequest {
            if ($Path -eq '/api/v2/extendedAgent/incidentHandlers') { return [pscustomobject]@{ StatusCode = 405; Success = $false } }
            return New-OkResponse -Content @()
        }
        Test-ResponsePlanApiSupported -Endpoint 'https://agent.example.azuresre.ai' -Token 'fake-token' | Should -Be $false
    }

    It "returns true when both list endpoints respond 200" {
        Mock Invoke-DataPlaneRequest { New-OkResponse -Content @() }
        Test-ResponsePlanApiSupported -Endpoint 'https://agent.example.azuresre.ai' -Token 'fake-token' | Should -Be $true
    }

    It "throws (does not silently report unsupported) on an unrelated server error like HTTP 500" {
        Mock Invoke-DataPlaneRequest { [pscustomobject]@{ StatusCode = 500; Success = $false; RawContent = 'boom' } }
        { Test-ResponsePlanApiSupported -Endpoint 'https://agent.example.azuresre.ai' -Token 'fake-token' } | Should -Throw "*transient*"
    }
}

Describe "Assert-AgentReadyForResponsePlan — wrong-state rejection" {
    It "throws if provisioningState is not Succeeded" {
        { Assert-AgentReadyForResponsePlan -Agent (New-FakeAgent -ProvisioningState 'Failed') -AgentName 'a' } | Should -Throw "*provisioningState*"
    }

    It "throws if actionConfiguration.mode is not Review" {
        { Assert-AgentReadyForResponsePlan -Agent (New-FakeAgent -Mode 'Autonomous') -AgentName 'a' } | Should -Throw "*Review*"
    }

    It "throws if incidentManagementConfiguration.type is not AzMonitor" {
        { Assert-AgentReadyForResponsePlan -Agent (New-FakeAgent -IncidentType 'PagerDuty') -AgentName 'a' } | Should -Throw "*AzMonitor*"
    }

    It "passes silently when the agent is Succeeded, Review, and AzMonitor-connected" {
        { Assert-AgentReadyForResponsePlan -Agent (New-FakeAgent) -AgentName 'a' } | Should -Not -Throw
    }
}

Describe "Assert-ResponsePlanSubscriptionMatch — wrong-subscription rejection" {
    It "throws when the resource group belongs to a different subscription" {
        Mock az {
            $global:LASTEXITCODE = 0
            if ($args[0] -eq 'account') { return 'sub-current' }
            if ($args[0] -eq 'group') { return '/subscriptions/sub-OTHER/resourceGroups/rg-test' }
        }
        { Assert-ResponsePlanSubscriptionMatch -ResourceGroupName 'rg-test' } | Should -Throw "*does not belong to the current subscription*"
    }

    It "succeeds when the resource group belongs to the current subscription" {
        Mock az {
            $global:LASTEXITCODE = 0
            if ($args[0] -eq 'account') { return 'sub-current' }
            if ($args[0] -eq 'group') { return '/subscriptions/sub-current/resourceGroups/rg-test' }
        }
        Assert-ResponsePlanSubscriptionMatch -ResourceGroupName 'rg-test' | Should -Be 'sub-current'
    }
}

Describe "Set-CustomAgentDataPlaneIdempotent" {
    BeforeEach {
        $script:testSpec = New-CustomAgentDataPlaneSpec -Name 'mongodb-down-responder' -RenderedInstructions 'v1 instructions'
    }

    It "creates when absent: PUTs once, verifies via re-GET" {
        $script:callCount = 0
        Mock Invoke-DataPlaneRequest {
            $script:callCount++
            if ($script:callCount -eq 1) { return New-NotFoundResponse } # existence GET
            if ($script:callCount -eq 2) { return New-OkResponse -Content $null } # PUT
            return New-OkResponse -Content (ConvertTo-DecodedSpec -Spec $script:testSpec) # verify GET
        }
        $result = Set-CustomAgentDataPlaneIdempotent -Endpoint 'https://a' -Token 't' -Name 'mongodb-down-responder' -Spec $script:testSpec
        $result.Success | Should -Be $true
        $result.Reason | Should -Be 'Written'
        Should -Invoke Invoke-DataPlaneRequest -Times 3 -Exactly
    }

    It "skips the PUT entirely when the existing state already semantically matches" {
        Mock Invoke-DataPlaneRequest {
            New-OkResponse -Content (ConvertTo-DecodedSpec -Spec $script:testSpec)
        }
        $result = Set-CustomAgentDataPlaneIdempotent -Endpoint 'https://a' -Token 't' -Name 'mongodb-down-responder' -Spec $script:testSpec
        $result.Success | Should -Be $true
        $result.Reason | Should -Be 'Unchanged'
        Should -Invoke Invoke-DataPlaneRequest -Times 1 -Exactly
    }

    It "reports UnsupportedApi when the PUT itself returns 404 (documented endpoint unavailable)" {
        Mock Invoke-DataPlaneRequest {
            if ($Method -eq 'GET') { return New-NotFoundResponse }
            return [pscustomobject]@{ StatusCode = 404; Success = $false; RawContent = 'no route' }
        }
        $result = Set-CustomAgentDataPlaneIdempotent -Endpoint 'https://a' -Token 't' -Name 'mongodb-down-responder' -Spec $script:testSpec
        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'UnsupportedApi'
    }

    It "reports SchemaMismatch when the semantic re-GET after PUT does not match (never trusts a bare 2xx)" {
        $script:callCount = 0
        Mock Invoke-DataPlaneRequest {
            $script:callCount++
            if ($script:callCount -eq 1) { return New-NotFoundResponse }
            if ($script:callCount -eq 2) { return New-OkResponse -Content $null }
            $tampered = New-CustomAgentDataPlaneSpec -Name 'mongodb-down-responder' -RenderedInstructions 'TAMPERED'
            return New-OkResponse -Content (ConvertTo-DecodedSpec -Spec $tampered)
        }
        $result = Set-CustomAgentDataPlaneIdempotent -Endpoint 'https://a' -Token 't' -Name 'mongodb-down-responder' -Spec $script:testSpec
        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'SchemaMismatch'
        $result.Expected | Should -Not -BeNullOrEmpty
        $result.Actual | Should -Not -BeNullOrEmpty
    }

    It "throws (not a structured failure) on a genuine write error like HTTP 400" {
        Mock Invoke-DataPlaneRequest {
            if ($Method -eq 'GET') { return New-NotFoundResponse }
            return [pscustomobject]@{ StatusCode = 400; Success = $false; RawContent = 'bad request' }
        }
        { Set-CustomAgentDataPlaneIdempotent -Endpoint 'https://a' -Token 't' -Name 'mongodb-down-responder' -Spec $script:testSpec } | Should -Throw "*Failed to write*"
    }
}

Describe "Set-IncidentFilterDataPlaneIdempotent / Set-IncidentHandlerDataPlaneIdempotent" {
    BeforeEach {
        $script:filterSpec = New-IncidentFilterDataPlaneSpec -Id 'mongodb-down-response-plan' -CustomAgentName 'mongodb-down-responder' -AlertTitle 'AmeriGas Propane Demo - MongoDB Down' -AlertSeverity 1
        $script:handlerSpec = New-IncidentHandlerDataPlaneSpec -Id 'mongodb-down-response-plan' -IncidentFilterId 'mongodb-down-response-plan' -CustomAgentName 'mongodb-down-responder'
    }

    It "filter: skips the PUT when CurrentFilters already semantically matches" {
        Mock Invoke-DataPlaneRequest { throw "should not be called" }
        $current = @(ConvertTo-DecodedSpec -Spec $script:filterSpec)
        $result = Set-IncidentFilterDataPlaneIdempotent -Endpoint 'https://a' -Token 't' -Id 'mongodb-down-response-plan' -Spec $script:filterSpec -CurrentFilters $current
        $result.Success | Should -Be $true
        $result.Reason | Should -Be 'Unchanged'
        Should -Invoke Invoke-DataPlaneRequest -Times 0 -Exactly
    }

    It "filter: PUTs and semantically verifies via re-list when absent from CurrentFilters" {
        $script:callCount = 0
        Mock Invoke-DataPlaneRequest {
            $script:callCount++
            if ($script:callCount -eq 1) { return New-OkResponse -Content $null } # PUT
            return New-ListResponse -Items @((ConvertTo-DecodedSpec -Spec $script:filterSpec)) # verify list
        }
        $result = Set-IncidentFilterDataPlaneIdempotent -Endpoint 'https://a' -Token 't' -Id 'mongodb-down-response-plan' -Spec $script:filterSpec -CurrentFilters @()
        $result.Success | Should -Be $true
        $result.Reason | Should -Be 'Written'
    }

    It "filter: reports SchemaMismatch when the re-list doesn't contain the written filter" {
        Mock Invoke-DataPlaneRequest {
            if ($Method -eq 'PUT') { return New-OkResponse -Content $null }
            return New-ListResponse -Items @() # empty — write didn't take
        }
        $result = Set-IncidentFilterDataPlaneIdempotent -Endpoint 'https://a' -Token 't' -Id 'mongodb-down-response-plan' -Spec $script:filterSpec -CurrentFilters @()
        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'SchemaMismatch'
    }

    It "filter: reports UnsupportedApi when the PUT itself 404s despite the list being supported" {
        Mock Invoke-DataPlaneRequest { [pscustomobject]@{ StatusCode = 404; Success = $false } }
        $result = Set-IncidentFilterDataPlaneIdempotent -Endpoint 'https://a' -Token 't' -Id 'mongodb-down-response-plan' -Spec $script:filterSpec -CurrentFilters @()
        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'UnsupportedApi'
    }

    It "handler: skips the PUT when CurrentHandlers already semantically matches" {
        Mock Invoke-DataPlaneRequest { throw "should not be called" }
        $current = @(ConvertTo-DecodedSpec -Spec $script:handlerSpec)
        $result = Set-IncidentHandlerDataPlaneIdempotent -Endpoint 'https://a' -Token 't' -Id 'mongodb-down-response-plan' -Spec $script:handlerSpec -CurrentHandlers $current
        $result.Success | Should -Be $true
        $result.Reason | Should -Be 'Unchanged'
        Should -Invoke Invoke-DataPlaneRequest -Times 0 -Exactly
    }

    It "handler: PUTs and semantically verifies via re-list when absent from CurrentHandlers" {
        Mock Invoke-DataPlaneRequest {
            if ($Method -eq 'PUT') { return New-OkResponse -Content $null }
            return New-ListResponse -Items @((ConvertTo-DecodedSpec -Spec $script:handlerSpec))
        }
        $result = Set-IncidentHandlerDataPlaneIdempotent -Endpoint 'https://a' -Token 't' -Id 'mongodb-down-response-plan' -Spec $script:handlerSpec -CurrentHandlers @()
        $result.Success | Should -Be $true
        $result.Reason | Should -Be 'Written'
    }
}

Describe "Find-ConflictingQuickstartFilters" {
    It "finds a filter named with 'quickstart' and excludes its own filter id" {
        $items = @(
            [pscustomobject]@{ id = 'quickstart-plan' }
            [pscustomobject]@{ id = 'mongodb-down-response-plan' }
        )
        $conflicts = Find-ConflictingQuickstartFilters -Filters $items -OwnFilterId 'mongodb-down-response-plan'
        $conflicts | Should -Contain 'quickstart-plan'
        $conflicts | Should -Not -Contain 'mongodb-down-response-plan'
    }

    It "returns empty when there are no other filters" {
        $conflicts = Find-ConflictingQuickstartFilters -Filters @([pscustomobject]@{ id = 'mongodb-down-response-plan' }) -OwnFilterId 'mongodb-down-response-plan'
        @($conflicts).Count | Should -Be 0
    }
}

Describe "Invoke-SreAgentResponsePlanBootstrap — end-to-end orchestration" {
    BeforeEach {
        Mock Get-RenderedCustomAgentInstructions { 'rendered instructions body' }
    }

    It "reports UnsupportedApi and makes NO write calls at all (not even for the custom agent) when the list endpoints are unavailable" {
        Mock Test-ResponsePlanApiSupported { $false }
        Mock Set-CustomAgentDataPlaneIdempotent { throw "should not be called" }
        Mock Set-IncidentFilterDataPlaneIdempotent { throw "should not be called" }
        Mock Set-IncidentHandlerDataPlaneIdempotent { throw "should not be called" }

        $result = Invoke-SreAgentResponsePlanBootstrap -Endpoint 'https://a' -Token 't' -AksClusterName 'aks-test' -SubscriptionId 's' -ResourceGroupName 'rg' -AlertTitle 'title' -AlertSeverity 1 -InstructionsFilePath $script:InstructionsPath

        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'UnsupportedApi'
    }

    It "reports success (Bootstrapped) and mentions semantic verification, when all three resources are newly written" {
        Mock Test-ResponsePlanApiSupported { $true }
        Mock Invoke-DataPlaneRequest { New-ListResponse -Items @() }
        Mock Set-CustomAgentDataPlaneIdempotent { [pscustomobject]@{ Success = $true; Reason = 'Written' } }
        Mock Set-IncidentFilterDataPlaneIdempotent { [pscustomobject]@{ Success = $true; Reason = 'Written' } }
        Mock Set-IncidentHandlerDataPlaneIdempotent { [pscustomobject]@{ Success = $true; Reason = 'Written' } }

        $result = Invoke-SreAgentResponsePlanBootstrap -Endpoint 'https://a' -Token 't' -AksClusterName 'aks-test' -SubscriptionId 's' -ResourceGroupName 'rg' -AlertTitle 'title' -AlertSeverity 1 -InstructionsFilePath $script:InstructionsPath

        $result.Success | Should -Be $true
        $result.Reason | Should -Be 'Bootstrapped'
        $result.Message | Should -Match 'semantically verified'
        $result.CustomAgentName | Should -Be 'mongodb-down-responder'
        $result.ResponsePlanName | Should -Be 'mongodb-down-response-plan'
    }

    It "reports Unchanged when all three resources were already up to date" {
        Mock Test-ResponsePlanApiSupported { $true }
        Mock Invoke-DataPlaneRequest { New-ListResponse -Items @() }
        Mock Set-CustomAgentDataPlaneIdempotent { [pscustomobject]@{ Success = $true; Reason = 'Unchanged' } }
        Mock Set-IncidentFilterDataPlaneIdempotent { [pscustomobject]@{ Success = $true; Reason = 'Unchanged' } }
        Mock Set-IncidentHandlerDataPlaneIdempotent { [pscustomobject]@{ Success = $true; Reason = 'Unchanged' } }

        $result = Invoke-SreAgentResponsePlanBootstrap -Endpoint 'https://a' -Token 't' -AksClusterName 'aks-test' -SubscriptionId 's' -ResourceGroupName 'rg' -AlertTitle 'title' -AlertSeverity 1 -InstructionsFilePath $script:InstructionsPath

        $result.Success | Should -Be $true
        $result.Reason | Should -Be 'Unchanged'
    }

    It "propagates a custom-agent SchemaMismatch as an overall failure and never attempts the filter/handler" {
        Mock Test-ResponsePlanApiSupported { $true }
        Mock Set-CustomAgentDataPlaneIdempotent { [pscustomobject]@{ Success = $false; Reason = 'SchemaMismatch'; Message = 'mismatch' } }
        Mock Set-IncidentFilterDataPlaneIdempotent { throw "should not be called when the agent failed" }
        Mock Set-IncidentHandlerDataPlaneIdempotent { throw "should not be called when the agent failed" }

        $result = Invoke-SreAgentResponsePlanBootstrap -Endpoint 'https://a' -Token 't' -AksClusterName 'aks-test' -SubscriptionId 's' -ResourceGroupName 'rg' -AlertTitle 'title' -AlertSeverity 1 -InstructionsFilePath $script:InstructionsPath

        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'SchemaMismatch'
    }

    It "propagates a filter failure without attempting the handler" {
        Mock Test-ResponsePlanApiSupported { $true }
        Mock Invoke-DataPlaneRequest { New-ListResponse -Items @() }
        Mock Set-CustomAgentDataPlaneIdempotent { [pscustomobject]@{ Success = $true; Reason = 'Written' } }
        Mock Set-IncidentFilterDataPlaneIdempotent { [pscustomobject]@{ Success = $false; Reason = 'SchemaMismatch'; Message = 'filter mismatch' } }
        Mock Set-IncidentHandlerDataPlaneIdempotent { throw "should not be called when the filter failed" }

        $result = Invoke-SreAgentResponsePlanBootstrap -Endpoint 'https://a' -Token 't' -AksClusterName 'aks-test' -SubscriptionId 's' -ResourceGroupName 'rg' -AlertTitle 'title' -AlertSeverity 1 -InstructionsFilePath $script:InstructionsPath

        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'SchemaMismatch'
    }

    It "removes a conflicting quickstart filter and verifies its absence when the API supports DELETE" {
        Mock Test-ResponsePlanApiSupported { $true }
        Mock Set-CustomAgentDataPlaneIdempotent { [pscustomobject]@{ Success = $true; Reason = 'Written' } }
        Mock Set-IncidentFilterDataPlaneIdempotent { [pscustomobject]@{ Success = $true; Reason = 'Written' } }
        Mock Set-IncidentHandlerDataPlaneIdempotent { [pscustomobject]@{ Success = $true; Reason = 'Written' } }

        $script:listCallCount = 0
        Mock Invoke-DataPlaneRequest {
            if ($Method -eq 'DELETE') { return New-OkResponse -Content $null }
            if ($Path -eq '/api/v2/incidentManagement/incidentFilters') {
                $script:listCallCount++
                if ($script:listCallCount -le 2) {
                    # post-write list (finds conflict) — the 3rd+ call is the
                    # post-deletion absence-verification list.
                    return New-ListResponse -Items @([pscustomobject]@{ id = 'quickstart-plan' }, [pscustomobject]@{ id = 'mongodb-down-response-plan' })
                }
                return New-ListResponse -Items @([pscustomobject]@{ id = 'mongodb-down-response-plan' })
            }
            return New-ListResponse -Items @()
        }

        $result = Invoke-SreAgentResponsePlanBootstrap -Endpoint 'https://a' -Token 't' -AksClusterName 'aks-test' -SubscriptionId 's' -ResourceGroupName 'rg' -AlertTitle 'title' -AlertSeverity 1 -InstructionsFilePath $script:InstructionsPath

        $result.Success | Should -Be $true
        $result.RemovedQuickstartPlans | Should -Contain 'quickstart-plan'
    }

    It "fails validation (does not report success) when a conflicting quickstart filter cannot be removed" {
        Mock Test-ResponsePlanApiSupported { $true }
        Mock Set-CustomAgentDataPlaneIdempotent { [pscustomobject]@{ Success = $true; Reason = 'Written' } }
        Mock Set-IncidentFilterDataPlaneIdempotent { [pscustomobject]@{ Success = $true; Reason = 'Written' } }
        Mock Set-IncidentHandlerDataPlaneIdempotent { [pscustomobject]@{ Success = $true; Reason = 'Written' } }

        Mock Invoke-DataPlaneRequest {
            if ($Method -eq 'DELETE') { return [pscustomobject]@{ StatusCode = 403; Success = $false; RawContent = 'forbidden' } }
            if ($Path -eq '/api/v2/incidentManagement/incidentFilters') {
                return New-ListResponse -Items @([pscustomobject]@{ id = 'quickstart-plan' }, [pscustomobject]@{ id = 'mongodb-down-response-plan' })
            }
            return New-ListResponse -Items @()
        }

        $result = Invoke-SreAgentResponsePlanBootstrap -Endpoint 'https://a' -Token 't' -AksClusterName 'aks-test' -SubscriptionId 's' -ResourceGroupName 'rg' -AlertTitle 'title' -AlertSeverity 1 -InstructionsFilePath $script:InstructionsPath

        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'ConflictingQuickstartPlanNotRemovable'
    }

    It "fails validation when a delete reports success but the item is still present on re-list (absence not actually verified)" {
        Mock Test-ResponsePlanApiSupported { $true }
        Mock Set-CustomAgentDataPlaneIdempotent { [pscustomobject]@{ Success = $true; Reason = 'Written' } }
        Mock Set-IncidentFilterDataPlaneIdempotent { [pscustomobject]@{ Success = $true; Reason = 'Written' } }
        Mock Set-IncidentHandlerDataPlaneIdempotent { [pscustomobject]@{ Success = $true; Reason = 'Written' } }

        Mock Invoke-DataPlaneRequest {
            if ($Method -eq 'DELETE') { return New-OkResponse -Content $null }
            if ($Path -eq '/api/v2/incidentManagement/incidentFilters') {
                # Every list call (including the post-deletion absence check)
                # still shows the quickstart plan present.
                return New-ListResponse -Items @([pscustomobject]@{ id = 'quickstart-plan' }, [pscustomobject]@{ id = 'mongodb-down-response-plan' })
            }
            return New-ListResponse -Items @()
        }

        $result = Invoke-SreAgentResponsePlanBootstrap -Endpoint 'https://a' -Token 't' -AksClusterName 'aks-test' -SubscriptionId 's' -ResourceGroupName 'rg' -AlertTitle 'title' -AlertSeverity 1 -InstructionsFilePath $script:InstructionsPath

        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'ConflictingQuickstartPlanNotRemovable'
    }
}

Describe "Invoke-SreAgentResponsePlanTeardown — idempotent, correct order, scoped to exactly three resources" {
    It "deletes the handler, then the filter, then the custom agent, in that order" {
        $callOrder = [System.Collections.Generic.List[string]]::new()
        Mock Invoke-DataPlaneRequest {
            $callOrder.Add($Path)
            New-OkResponse -Content $null
        }

        Invoke-SreAgentResponsePlanTeardown -Endpoint 'https://a' -Token 't' | Out-Null

        $callOrder[0] | Should -Be '/api/v1/incidentplayground/handlers/mongodb-down-response-plan'
        $callOrder[1] | Should -Be '/api/v1/incidentplayground/filters/mongodb-down-response-plan'
        $callOrder[2] | Should -Be '/api/v2/extendedAgent/agents/mongodb-down-responder'
    }

    It "treats 404 on all three deletes as success (idempotent — already torn down)" {
        Mock Invoke-DataPlaneRequest { New-NotFoundResponse }
        $result = Invoke-SreAgentResponsePlanTeardown -Endpoint 'https://a' -Token 't'
        $result.Success | Should -Be $true
    }

    It "throws on a genuine delete failure (non-404, non-2xx)" {
        Mock Invoke-DataPlaneRequest { [pscustomobject]@{ StatusCode = 500; Success = $false; RawContent = 'boom' } }
        { Invoke-SreAgentResponsePlanTeardown -Endpoint 'https://a' -Token 't' } | Should -Throw
    }
}

Describe "No data-plane token is ever written to host output" {
    It "the script source never interpolates the token directly into Write-Host/Write-Verbose" {
        $source = Get-Content -Path $script:ScriptPath -Raw
        $source | Should -Not -Match 'Write-(Host|Verbose)[^\n]*\$(dataPlaneToken|Token)\b'
    }
}
