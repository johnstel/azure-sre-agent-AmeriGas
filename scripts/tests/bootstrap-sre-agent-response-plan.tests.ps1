#Requires -Modules Pester

<#
.SYNOPSIS
    Pester tests for scripts/bootstrap-sre-agent-response-plan.ps1

.DESCRIPTION
    Covers the acceptance scenarios from issue #19:
      - Clean bootstrap (no existing custom agent / response plan)
      - Unchanged rerun (same rendered instructions / filter criteria) makes
        zero write calls
      - A changed instructions file or filter parameter triggers exactly one
        PUT per changed sub-resource, verified via round-trip GET
      - A write that does not round-trip correctly is reported as
        SchemaMismatch, never as success
      - Explicit "unsupported API" detection (404/405 on either sub-resource
        collection) never claims success
      - Wrong-subscription / wrong-resource-group detection fails fast
      - The agent must be Succeeded + Review mode + AzMonitor-connected
        before a response plan is bootstrapped
      - The incident filter always sets autonomyLevel to 'Review', never
        'Autonomous' (there is no parameter path to override this)
      - A conflicting quickstart response plan is removed when the API
        supports DELETE, and causes a hard failure (not a silent partial
        success) when it cannot be removed
      - Teardown removes the response plan and custom agent idempotently
        (404 == success), and never touches the alert rule or agent itself
      - No data-plane bearer token is ever acquired or referenced by this
        script (subagents/incidentFilters are control-plane sub-resources)

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
                provisioningState               = $ProvisioningState
                actionConfiguration              = [pscustomobject]@{ mode = $Mode }
                incidentManagementConfiguration  = [pscustomobject]@{ type = $IncidentType }
            }
        }
    }

    function New-EnvelopeResponse {
        param($Spec, [int]$StatusCode = 200)
        $body = ConvertTo-SubResourceEnvelope -Spec $Spec
        $content = $body | ConvertFrom-Json
        return [pscustomobject]@{
            StatusCode = $StatusCode
            Success    = ($StatusCode -ge 200 -and $StatusCode -lt 300)
            Content    = $content
            RawContent = $body
        }
    }

    function New-NotFoundResponse {
        return [pscustomobject]@{ StatusCode = 404; Success = $false; Content = $null; RawContent = 'not found' }
    }
}

Describe "ConvertTo-CanonicalJson / round-trip envelope helpers" {
    It "produces a stable SHA-256 content hash of the expected length" {
        $hash = Get-ContentHash -Content 'hello world'
        $hash.Length | Should -Be 64
    }

    It "preserves single-element arrays through Sort-ObjectKeysRecursively (regression: PowerShell function-return array unwrapping)" {
        $spec = New-CustomAgentSpec -Name 'test-agent' -RenderedInstructions 'hello'
        $json = ConvertTo-CanonicalJson -InputObject $spec
        $json | Should -Match '"tools":\["azure_cli"\]'
    }

    It "round-trips a custom-agent spec through the base64 envelope unchanged" {
        $spec = New-CustomAgentSpec -Name 'test-agent' -RenderedInstructions 'hello world'
        $envelopeJson = ConvertTo-SubResourceEnvelope -Spec $spec
        $resource = $envelopeJson | ConvertFrom-Json
        $decoded = ConvertFrom-SubResourceEnvelope -Resource $resource
        Test-SpecRoundTrip -ExpectedSpec $spec -ActualDecodedSpec $decoded | Should -Be $true
    }

    It "round-trips an incident-filter spec through the base64 envelope unchanged" {
        $spec = New-IncidentFilterSpec -Name 'mongodb-down-response-plan' -CustomAgentName 'mongodb-down-responder' -AlertTitle 'AmeriGas Propane Demo - MongoDB Down' -AlertSeverity 1
        $envelopeJson = ConvertTo-SubResourceEnvelope -Spec $spec
        $resource = $envelopeJson | ConvertFrom-Json
        $decoded = ConvertFrom-SubResourceEnvelope -Resource $resource
        Test-SpecRoundTrip -ExpectedSpec $spec -ActualDecodedSpec $decoded | Should -Be $true
    }

    It "detects a mismatch when the decoded spec differs from what was intended" {
        $spec = New-IncidentFilterSpec -Name 'mongodb-down-response-plan' -CustomAgentName 'mongodb-down-responder' -AlertTitle 'AmeriGas Propane Demo - MongoDB Down' -AlertSeverity 1
        $tamperedDecoded = [pscustomobject]@{ name = 'mongodb-down-response-plan'; severity = @(2) }
        Test-SpecRoundTrip -ExpectedSpec $spec -ActualDecodedSpec $tamperedDecoded | Should -Be $false
    }

    It "treats an undecodable resource as a round-trip failure, not a crash" {
        $spec = New-IncidentFilterSpec -Name 'mongodb-down-response-plan' -CustomAgentName 'mongodb-down-responder' -AlertTitle 'AmeriGas Propane Demo - MongoDB Down' -AlertSeverity 1
        Test-SpecRoundTrip -ExpectedSpec $spec -ActualDecodedSpec $null | Should -Be $false
    }
}

Describe "New-IncidentFilterSpec — always Review autonomy" {
    It "sets autonomyLevel to 'Review' regardless of inputs (issue #19: explicit Review autonomy even though the platform defaults new plans to Autonomous)" {
        $spec = New-IncidentFilterSpec -Name 'plan-a' -CustomAgentName 'agent-a' -AlertTitle 'anything' -AlertSeverity 0
        $spec.autonomyLevel | Should -Be 'Review'

        $spec2 = New-IncidentFilterSpec -Name 'plan-b' -CustomAgentName 'agent-b' -AlertTitle 'anything else' -AlertSeverity 4
        $spec2.autonomyLevel | Should -Be 'Review'
    }

    It "has no parameter that can set autonomyLevel to Autonomous" {
        (Get-Command New-IncidentFilterSpec).Parameters.Keys | Should -Not -Contain 'AutonomyLevel'
    }

    It "sets the platform default reinvestigation cooldown (enabled, 3 hours)" {
        $spec = New-IncidentFilterSpec -Name 'plan-a' -CustomAgentName 'agent-a' -AlertTitle 'x' -AlertSeverity 1
        $spec.cooldown.enabled | Should -Be $true
        $spec.cooldown.hours | Should -Be 3
    }
}

Describe "Get-RenderedCustomAgentInstructions" {
    It "substitutes every documented placeholder and leaves none unrendered" {
        $rendered = Get-RenderedCustomAgentInstructions -InstructionsFilePath $script:InstructionsPath -SubscriptionId 'sub-123' -ResourceGroupName 'rg-srelab-eastus2' -AksClusterName 'aks-srelab' -AlertTitle 'AmeriGas Propane Demo - MongoDB Down' -AlertSeverity 1
        $rendered | Should -Match 'sub-123'
        $rendered | Should -Match 'rg-srelab-eastus2'
        $rendered | Should -Match 'aks-srelab'
        $rendered | Should -Match 'AmeriGas Propane Demo - MongoDB Down'
    }

    It "throws if the instructions file does not exist" {
        { Get-RenderedCustomAgentInstructions -InstructionsFilePath (Join-Path ([System.IO.Path]::GetTempPath()) "does-not-exist-$([guid]::NewGuid()).md") -SubscriptionId 'x' -ResourceGroupName 'y' -AksClusterName 'z' -AlertTitle 't' -AlertSeverity 1 } | Should -Throw "*not found*"
    }

    It "produces a different rendered result (and content hash) when the AKS cluster name changes, proving the render is not a no-op" {
        $renderedA = Get-RenderedCustomAgentInstructions -InstructionsFilePath $script:InstructionsPath -SubscriptionId 'sub-1' -ResourceGroupName 'rg-1' -AksClusterName 'aks-one' -AlertTitle 't' -AlertSeverity 1
        $renderedB = Get-RenderedCustomAgentInstructions -InstructionsFilePath $script:InstructionsPath -SubscriptionId 'sub-1' -ResourceGroupName 'rg-1' -AksClusterName 'aks-two' -AlertTitle 't' -AlertSeverity 1
        (Get-ContentHash -Content $renderedA) | Should -Not -Be (Get-ContentHash -Content $renderedB)
    }
}

Describe "Test-ResponsePlanApiSupported" {
    It "returns false when either sub-resource type responds 404" {
        Mock Invoke-SubResourceRequest {
            if ($SubResourceType -eq 'subagents') { return [pscustomobject]@{ StatusCode = 404; Success = $false } }
            return [pscustomobject]@{ StatusCode = 200; Success = $true }
        }
        Test-ResponsePlanApiSupported -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' | Should -Be $false
    }

    It "returns false when either sub-resource type responds 405" {
        Mock Invoke-SubResourceRequest {
            if ($SubResourceType -eq 'incidentFilters') { return [pscustomobject]@{ StatusCode = 405; Success = $false } }
            return [pscustomobject]@{ StatusCode = 200; Success = $true }
        }
        Test-ResponsePlanApiSupported -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' | Should -Be $false
    }

    It "returns true when both sub-resource types respond 200" {
        Mock Invoke-SubResourceRequest { [pscustomobject]@{ StatusCode = 200; Success = $true } }
        Test-ResponsePlanApiSupported -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' | Should -Be $true
    }

    It "throws (does not silently report unsupported) on an unrelated server error like HTTP 500" {
        Mock Invoke-SubResourceRequest { [pscustomobject]@{ StatusCode = 500; Success = $false; RawContent = 'boom' } }
        { Test-ResponsePlanApiSupported -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' } | Should -Throw "*transient*"
    }
}

Describe "Assert-AgentReadyForResponsePlan — wrong-state / wrong-target rejection" {
    It "throws if provisioningState is not Succeeded" {
        $agent = New-FakeAgent -ProvisioningState 'Failed'
        { Assert-AgentReadyForResponsePlan -Agent $agent -AgentName 'a' } | Should -Throw "*provisioningState*"
    }

    It "throws if actionConfiguration.mode is not Review" {
        $agent = New-FakeAgent -Mode 'Autonomous'
        { Assert-AgentReadyForResponsePlan -Agent $agent -AgentName 'a' } | Should -Throw "*Review*"
    }

    It "throws if incidentManagementConfiguration.type is not AzMonitor" {
        $agent = New-FakeAgent -IncidentType 'PagerDuty'
        { Assert-AgentReadyForResponsePlan -Agent $agent -AgentName 'a' } | Should -Throw "*AzMonitor*"
    }

    It "throws if incidentManagementConfiguration is entirely absent" {
        $agent = [pscustomobject]@{ properties = [pscustomobject]@{ provisioningState = 'Succeeded'; actionConfiguration = [pscustomobject]@{ mode = 'Review' } } }
        { Assert-AgentReadyForResponsePlan -Agent $agent -AgentName 'a' } | Should -Throw "*AzMonitor*"
    }

    It "passes silently when the agent is Succeeded, Review, and AzMonitor-connected" {
        $agent = New-FakeAgent
        { Assert-AgentReadyForResponsePlan -Agent $agent -AgentName 'a' } | Should -Not -Throw
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

Describe "Set-SubResourceIdempotent" {
    BeforeEach {
        $script:testSpec = New-CustomAgentSpec -Name 'mongodb-down-responder' -RenderedInstructions 'v1 instructions'
    }

    Context "Clean create — no existing resource" {
        It "PUTs once and verifies the round trip" {
            # First GET (existence check) -> 404, PUT -> success, second GET (verify) -> envelope matching testSpec
            $script:callCount = 0
            Mock Invoke-SubResourceRequest {
                $script:callCount = ($script:callCount + 1)
                if ($script:callCount -eq 1) { return New-NotFoundResponse }
                if ($script:callCount -eq 2) { return [pscustomobject]@{ StatusCode = 200; Success = $true } }
                return New-EnvelopeResponse -Spec $script:testSpec
            }

            $result = Set-SubResourceIdempotent -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' -SubResourceType 'subagents' -Name 'mongodb-down-responder' -Spec $script:testSpec

            $result.Success | Should -Be $true
            $result.Reason | Should -Be 'Written'
            Should -Invoke Invoke-SubResourceRequest -Times 3 -Exactly
        }
    }

    Context "Unchanged rerun — existing resource already matches" {
        It "makes no PUT call at all" {
            Mock Invoke-SubResourceRequest {
                return New-EnvelopeResponse -Spec $script:testSpec
            } -ParameterFilter { $Method -eq 'GET' }
            Mock Invoke-SubResourceRequest { throw "PUT should not be called on an unchanged rerun" } -ParameterFilter { $Method -eq 'PUT' }

            $result = Set-SubResourceIdempotent -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' -SubResourceType 'subagents' -Name 'mongodb-down-responder' -Spec $script:testSpec

            $result.Success | Should -Be $true
            $result.Reason | Should -Be 'Unchanged'
            Should -Invoke Invoke-SubResourceRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'PUT' }
        }
    }

    Context "Content update — existing resource has a different content hash" {
        It "PUTs the new spec and verifies the round trip" {
            $staleSpec = New-CustomAgentSpec -Name 'mongodb-down-responder' -RenderedInstructions 'OLD instructions'
            $script:callCount = 0
            Mock Invoke-SubResourceRequest {
                $script:callCount = ($script:callCount + 1)
                if ($script:callCount -eq 1) { return New-EnvelopeResponse -Spec $staleSpec }
                if ($script:callCount -eq 2) { return [pscustomobject]@{ StatusCode = 200; Success = $true } }
                return New-EnvelopeResponse -Spec $script:testSpec
            }

            $result = Set-SubResourceIdempotent -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' -SubResourceType 'subagents' -Name 'mongodb-down-responder' -Spec $script:testSpec

            $result.Success | Should -Be $true
            $result.Reason | Should -Be 'Written'
        }
    }

    Context "Schema mismatch — the server does not round-trip what was written" {
        It "reports SchemaMismatch, never Success" {
            $script:callCount = 0
            Mock Invoke-SubResourceRequest {
                $script:callCount = ($script:callCount + 1)
                if ($script:callCount -eq 1) { return New-NotFoundResponse }
                if ($script:callCount -eq 2) { return [pscustomobject]@{ StatusCode = 200; Success = $true } }
                # Verification GET returns a DIFFERENT spec than what was sent
                # (simulating the server silently dropping/reinterpreting a field).
                $tamperedSpec = New-CustomAgentSpec -Name 'mongodb-down-responder' -RenderedInstructions 'TAMPERED'
                return New-EnvelopeResponse -Spec $tamperedSpec
            }

            $result = Set-SubResourceIdempotent -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' -SubResourceType 'subagents' -Name 'mongodb-down-responder' -Spec $script:testSpec

            $result.Success | Should -Be $false
            $result.Reason | Should -Be 'SchemaMismatch'
        }
    }

    Context "Write fails outright (non-2xx PUT)" {
        It "throws rather than reporting a structured failure (this is a transient/unexpected condition, not a confirmed schema issue)" {
            Mock Invoke-SubResourceRequest {
                if ($Method -eq 'GET') { return New-NotFoundResponse }
                return [pscustomobject]@{ StatusCode = 400; Success = $false; RawContent = 'bad request' }
            }

            { Set-SubResourceIdempotent -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' -SubResourceType 'subagents' -Name 'mongodb-down-responder' -Spec $script:testSpec } | Should -Throw "*Failed to write*"
        }
    }

    Context "Existing-resource GET fails with a non-404 error" {
        It "throws rather than silently overwriting" {
            Mock Invoke-SubResourceRequest { [pscustomobject]@{ StatusCode = 500; Success = $false; RawContent = 'boom' } }
            { Set-SubResourceIdempotent -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' -SubResourceType 'subagents' -Name 'mongodb-down-responder' -Spec $script:testSpec } | Should -Throw
        }
    }
}

Describe "Find-ConflictingQuickstartResponsePlans" {
    It "finds a plan named with 'quickstart' in its ARM resource name" {
        Mock Invoke-SubResourceRequest {
            [pscustomobject]@{
                StatusCode = 200
                Success    = $true
                Content    = [pscustomobject]@{ value = @([pscustomobject]@{ name = 'quickstart-plan' }, [pscustomobject]@{ name = 'mongodb-down-response-plan' }) }
            }
        }
        $conflicts = Find-ConflictingQuickstartResponsePlans -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' -OwnResponsePlanName 'mongodb-down-response-plan'
        $conflicts | Should -Contain 'quickstart-plan'
        $conflicts | Should -Not -Contain 'mongodb-down-response-plan'
    }

    It "does not flag its own response plan even if its ARM name happens to be found in the list" {
        Mock Invoke-SubResourceRequest {
            [pscustomobject]@{
                StatusCode = 200
                Success    = $true
                Content    = [pscustomobject]@{ value = @([pscustomobject]@{ name = 'mongodb-down-response-plan' }) }
            }
        }
        $conflicts = Find-ConflictingQuickstartResponsePlans -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' -OwnResponsePlanName 'mongodb-down-response-plan'
        @($conflicts).Count | Should -Be 0
    }

    It "returns an empty list when there are no other plans" {
        Mock Invoke-SubResourceRequest {
            [pscustomobject]@{ StatusCode = 200; Success = $true; Content = [pscustomobject]@{ value = @() } }
        }
        $conflicts = Find-ConflictingQuickstartResponsePlans -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' -OwnResponsePlanName 'mongodb-down-response-plan'
        @($conflicts).Count | Should -Be 0
    }

    It "throws on a failed list call rather than assuming there is no conflict" {
        Mock Invoke-SubResourceRequest { [pscustomobject]@{ StatusCode = 500; Success = $false; RawContent = 'boom' } }
        { Find-ConflictingQuickstartResponsePlans -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' -OwnResponsePlanName 'mongodb-down-response-plan' } | Should -Throw
    }
}

Describe "Invoke-SreAgentResponsePlanBootstrap — end-to-end orchestration" {
    BeforeEach {
        $script:renderedInstructions = 'rendered instructions body'
        Mock Get-RenderedCustomAgentInstructions { $script:renderedInstructions }
    }

    It "reports UnsupportedApi and makes no write calls when the sub-resource API is not available" {
        Mock Test-ResponsePlanApiSupported { $false }
        Mock Set-SubResourceIdempotent { throw "should not be called" }
        Mock Find-ConflictingQuickstartResponsePlans { throw "should not be called" }

        $result = Invoke-SreAgentResponsePlanBootstrap -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' -AksClusterName 'aks-test' -AlertTitle 'title' -AlertSeverity 1 -InstructionsFilePath $script:InstructionsPath

        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'UnsupportedApi'
    }

    It "reports success with both sub-resources bootstrapped and no conflicting plans" {
        Mock Test-ResponsePlanApiSupported { $true }
        Mock Set-SubResourceIdempotent { [pscustomobject]@{ Success = $true; Reason = 'Written'; Name = $Name } }
        Mock Find-ConflictingQuickstartResponsePlans { @() }

        $result = Invoke-SreAgentResponsePlanBootstrap -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' -AksClusterName 'aks-test' -AlertTitle 'title' -AlertSeverity 1 -InstructionsFilePath $script:InstructionsPath

        $result.Success | Should -Be $true
        $result.Reason | Should -Be 'Bootstrapped'
        $result.CustomAgentName | Should -Be 'mongodb-down-responder'
        $result.ResponsePlanName | Should -Be 'mongodb-down-response-plan'
    }

    It "reports Unchanged when both sub-resources were already up to date" {
        Mock Test-ResponsePlanApiSupported { $true }
        Mock Set-SubResourceIdempotent { [pscustomobject]@{ Success = $true; Reason = 'Unchanged'; Name = $Name } }
        Mock Find-ConflictingQuickstartResponsePlans { @() }

        $result = Invoke-SreAgentResponsePlanBootstrap -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' -AksClusterName 'aks-test' -AlertTitle 'title' -AlertSeverity 1 -InstructionsFilePath $script:InstructionsPath

        $result.Success | Should -Be $true
        $result.Reason | Should -Be 'Unchanged'
    }

    It "propagates a SchemaMismatch on the custom agent as an overall failure and does not proceed to the incident filter" {
        Mock Test-ResponsePlanApiSupported { $true }
        Mock Set-SubResourceIdempotent {
            [pscustomobject]@{ Success = $false; Reason = 'SchemaMismatch'; Name = $Name; Expected = 'x'; Actual = 'y' }
        } -ParameterFilter { $SubResourceType -eq 'subagents' }
        Mock Set-SubResourceIdempotent { throw "should not be called for incidentFilters when subagents failed" } -ParameterFilter { $SubResourceType -eq 'incidentFilters' }

        $result = Invoke-SreAgentResponsePlanBootstrap -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' -AksClusterName 'aks-test' -AlertTitle 'title' -AlertSeverity 1 -InstructionsFilePath $script:InstructionsPath

        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'SchemaMismatch'
    }

    It "removes a conflicting quickstart plan when the API supports DELETE" {
        Mock Test-ResponsePlanApiSupported { $true }
        Mock Set-SubResourceIdempotent { [pscustomobject]@{ Success = $true; Reason = 'Written'; Name = $Name } }
        Mock Find-ConflictingQuickstartResponsePlans { @('quickstart-plan') }
        Mock Invoke-SubResourceRequest { [pscustomobject]@{ StatusCode = 200; Success = $true } } -ParameterFilter { $Method -eq 'DELETE' }

        $result = Invoke-SreAgentResponsePlanBootstrap -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' -AksClusterName 'aks-test' -AlertTitle 'title' -AlertSeverity 1 -InstructionsFilePath $script:InstructionsPath

        $result.Success | Should -Be $true
        $result.RemovedQuickstartPlans | Should -Contain 'quickstart-plan'
    }

    It "fails validation (does not report success) when a conflicting quickstart plan cannot be removed" {
        Mock Test-ResponsePlanApiSupported { $true }
        Mock Set-SubResourceIdempotent { [pscustomobject]@{ Success = $true; Reason = 'Written'; Name = $Name } }
        Mock Find-ConflictingQuickstartResponsePlans { @('quickstart-plan') }
        Mock Invoke-SubResourceRequest { [pscustomobject]@{ StatusCode = 403; Success = $false; RawContent = 'forbidden' } } -ParameterFilter { $Method -eq 'DELETE' }

        $result = Invoke-SreAgentResponsePlanBootstrap -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' -AksClusterName 'aks-test' -AlertTitle 'title' -AlertSeverity 1 -InstructionsFilePath $script:InstructionsPath

        $result.Success | Should -Be $false
        $result.Reason | Should -Be 'ConflictingQuickstartPlanNotRemovable'
    }

    It "treats a 404 on quickstart-plan delete as removed (idempotent)" {
        Mock Test-ResponsePlanApiSupported { $true }
        Mock Set-SubResourceIdempotent { [pscustomobject]@{ Success = $true; Reason = 'Written'; Name = $Name } }
        Mock Find-ConflictingQuickstartResponsePlans { @('quickstart-plan') }
        Mock Invoke-SubResourceRequest { [pscustomobject]@{ StatusCode = 404; Success = $false } } -ParameterFilter { $Method -eq 'DELETE' }

        $result = Invoke-SreAgentResponsePlanBootstrap -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' -AksClusterName 'aks-test' -AlertTitle 'title' -AlertSeverity 1 -InstructionsFilePath $script:InstructionsPath

        $result.Success | Should -Be $true
        $result.RemovedQuickstartPlans | Should -Contain 'quickstart-plan'
    }
}

Describe "Invoke-SreAgentResponsePlanTeardown — idempotent, scoped to exactly two sub-resources" {
    It "deletes the response plan then the custom agent, in that order" {
        $callOrder = [System.Collections.Generic.List[string]]::new()
        Mock Invoke-SubResourceRequest {
            $callOrder.Add("$SubResourceType/$Name")
            [pscustomobject]@{ StatusCode = 200; Success = $true }
        }

        Invoke-SreAgentResponsePlanTeardown -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' | Out-Null

        $callOrder[0] | Should -Be 'incidentFilters/mongodb-down-response-plan'
        $callOrder[1] | Should -Be 'subagents/mongodb-down-responder'
    }

    It "treats 404 on both deletes as success (idempotent — already torn down)" {
        Mock Invoke-SubResourceRequest { [pscustomobject]@{ StatusCode = 404; Success = $false } }
        $result = Invoke-SreAgentResponsePlanTeardown -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01'
        $result.Success | Should -Be $true
    }

    It "throws on a genuine delete failure (non-404, non-2xx)" {
        Mock Invoke-SubResourceRequest { [pscustomobject]@{ StatusCode = 500; Success = $false; RawContent = 'boom' } }
        { Invoke-SreAgentResponsePlanTeardown -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' } | Should -Throw
    }

    It "never references the alert rule or the agent resource itself (only subagents/incidentFilters sub-resource types)" {
        $calledTypes = [System.Collections.Generic.List[string]]::new()
        Mock Invoke-SubResourceRequest {
            $calledTypes.Add($SubResourceType)
            [pscustomobject]@{ StatusCode = 200; Success = $true }
        }
        Invoke-SreAgentResponsePlanTeardown -SubscriptionId 's' -ResourceGroupName 'rg' -AgentName 'a' -ApiVersion '2026-01-01' | Out-Null
        ($calledTypes | Select-Object -Unique) | Should -Be @('incidentFilters', 'subagents')
    }
}

Describe "No data-plane token is ever used by this script" {
    It "the script source never calls az account get-access-token or Invoke-WebRequest against the data-plane audience (subagents/incidentFilters are control-plane sub-resources, unlike agent memory — only mentioned in an explanatory comment, never invoked)" {
        $source = Get-Content -Path $script:ScriptPath -Raw
        $source | Should -Not -Match 'get-access-token'
        $source | Should -Not -Match 'Invoke-WebRequest'
        $source | Should -Not -Match 'resource\s+.https://azuresre\.dev'
    }
}
