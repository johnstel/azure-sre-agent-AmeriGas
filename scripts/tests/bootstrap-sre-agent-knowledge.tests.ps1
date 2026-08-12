#Requires -Modules Pester

<#
.SYNOPSIS
    Pester tests for scripts/bootstrap-sre-agent-knowledge.ps1

.DESCRIPTION
    Covers the acceptance scenarios from issue #18:
      - Clean run (no existing knowledge documents)
      - Unchanged rerun (same content hash) does not duplicate the upload
      - Content update uploads a new hash-keyed document and removes the
        stale one only after the new one is confirmed indexed
      - Partial failure (indexing times out) does not duplicate the upload
        on retry
      - Explicit "unsupported API" detection (404/405) never claims success
      - Wrong-subscription / wrong-resource-group detection fails fast
      - The bearer token is never written to host/verbose output anywhere
        in the orchestration path

.EXAMPLE
    Invoke-Pester -Path scripts/tests/bootstrap-sre-agent-knowledge.tests.ps1
#>

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot ".." "bootstrap-sre-agent-knowledge.ps1"

    # Dot-source with a dummy AgentName/ResourceGroupName so the file's own
    # top-level execution block (guarded by $MyInvocation.InvocationName -ne '.')
    # is a no-op, and only the reusable functions are defined in this scope.
    . $script:ScriptPath -ResourceGroupName 'rg-test' -AgentName 'agent-test'

    function New-TempKnowledgeFile {
        param([string]$Content = "# AmeriGas Propane Knowledge`nSample content.")
        $path = Join-Path ([System.IO.Path]::GetTempPath()) "knowledge-$([guid]::NewGuid()).md"
        Set-Content -Path $path -Value $Content -NoNewline
        return $path
    }
}

Describe "Invoke-SreAgentKnowledgeBootstrap" {
    BeforeEach {
        $script:knowledgeFile = New-TempKnowledgeFile
        $script:expectedHash = (Get-FileHash -Path $script:knowledgeFile -Algorithm SHA256).Hash.ToLowerInvariant()
        $script:expectedDocName = "sre-agent-knowledge.$($script:expectedHash.Substring(0, 12)).md"
    }

    AfterEach {
        Remove-Item -Path $script:knowledgeFile -Force -ErrorAction SilentlyContinue
    }

    Context "Clean run — no existing knowledge documents" {
        It "uploads once, waits for indexing, and never deletes anything" {
            Mock Test-AgentMemoryApiSupported { $true }
            Mock Get-AgentMemoryDocumentNames { @() }
            Mock Invoke-KnowledgeDocumentUpload { [pscustomobject]@{ Success = $true } }
            Mock Wait-KnowledgeIndexed { $true }
            Mock Remove-StaleKnowledgeDocument { }

            $result = Invoke-SreAgentKnowledgeBootstrap -Endpoint 'https://agent.example.azuresre.ai' -Token 'fake-token' -KnowledgeFilePath $script:knowledgeFile

            $result.Success | Should -Be $true
            $result.Reason | Should -Be 'CleanUpload'
            $result.DocumentName | Should -Be $script:expectedDocName

            Should -Invoke Invoke-KnowledgeDocumentUpload -Times 1 -Exactly
            Should -Invoke Wait-KnowledgeIndexed -Times 1 -Exactly
            Should -Invoke Remove-StaleKnowledgeDocument -Times 0 -Exactly
        }
    }

    Context "Unchanged rerun — identical content hash already present" {
        It "skips the upload but confirms indexing" {
            Mock Test-AgentMemoryApiSupported { $true }
            Mock Get-AgentMemoryDocumentNames { @($script:expectedDocName) }
            Mock Invoke-KnowledgeDocumentUpload { throw "should not be called" }
            Mock Wait-KnowledgeIndexed { $true }
            Mock Remove-StaleKnowledgeDocument { }

            $result = Invoke-SreAgentKnowledgeBootstrap -Endpoint 'https://agent.example.azuresre.ai' -Token 'fake-token' -KnowledgeFilePath $script:knowledgeFile

            $result.Success | Should -Be $true
            $result.Reason | Should -Be 'Unchanged'
            $result.DocumentName | Should -Be $script:expectedDocName

            Should -Invoke Invoke-KnowledgeDocumentUpload -Times 0 -Exactly
            Should -Invoke Wait-KnowledgeIndexed -Times 1 -Exactly
            Should -Invoke Remove-StaleKnowledgeDocument -Times 0 -Exactly
        }
    }

    Context "Content update — a different-hash document already exists" {
        It "uploads the new version, confirms indexing, then removes exactly the stale version" {
            $staleDocName = 'sre-agent-knowledge.aaaaaaaaaaaa.md'
            Mock Test-AgentMemoryApiSupported { $true }
            Mock Get-AgentMemoryDocumentNames { @($staleDocName) }
            Mock Invoke-KnowledgeDocumentUpload { [pscustomobject]@{ Success = $true } }
            Mock Wait-KnowledgeIndexed { $true }
            Mock Remove-StaleKnowledgeDocument { }

            $result = Invoke-SreAgentKnowledgeBootstrap -Endpoint 'https://agent.example.azuresre.ai' -Token 'fake-token' -KnowledgeFilePath $script:knowledgeFile

            $result.Success | Should -Be $true
            $result.Reason | Should -Be 'ContentUpdated'

            Should -Invoke Invoke-KnowledgeDocumentUpload -Times 1 -Exactly -ParameterFilter { $DocumentName -eq $script:expectedDocName }
            Should -Invoke Remove-StaleKnowledgeDocument -Times 1 -Exactly -ParameterFilter { $DocumentName -eq $staleDocName }
        }

        It "removes stale documents only AFTER the new upload is confirmed indexed (upload-then-delete ordering)" {
            $staleDocName = 'sre-agent-knowledge.aaaaaaaaaaaa.md'
            $callOrder = [System.Collections.Generic.List[string]]::new()

            Mock Test-AgentMemoryApiSupported { $true }
            Mock Get-AgentMemoryDocumentNames { @($staleDocName) }
            Mock Invoke-KnowledgeDocumentUpload { $callOrder.Add('upload'); [pscustomobject]@{ Success = $true } }
            Mock Wait-KnowledgeIndexed { $callOrder.Add('index'); $true }
            Mock Remove-StaleKnowledgeDocument { $callOrder.Add('delete') }

            Invoke-SreAgentKnowledgeBootstrap -Endpoint 'https://agent.example.azuresre.ai' -Token 'fake-token' -KnowledgeFilePath $script:knowledgeFile | Out-Null

            ($callOrder -join ',') | Should -Be 'upload,index,delete'
        }
    }

    Context "Partial failure / retry — indexing times out then a rerun recovers" {
        It "propagates the indexing failure without swallowing it" {
            Mock Test-AgentMemoryApiSupported { $true }
            Mock Get-AgentMemoryDocumentNames { @() }
            Mock Invoke-KnowledgeDocumentUpload { [pscustomobject]@{ Success = $true } }
            Mock Wait-KnowledgeIndexed { throw "Timed out waiting for indexing." }
            Mock Remove-StaleKnowledgeDocument { }

            { Invoke-SreAgentKnowledgeBootstrap -Endpoint 'https://agent.example.azuresre.ai' -Token 'fake-token' -KnowledgeFilePath $script:knowledgeFile } | Should -Throw "*Timed out*"

            Should -Invoke Invoke-KnowledgeDocumentUpload -Times 1 -Exactly
        }

        It "does not re-upload on a rerun once the document is already present (idempotent retry)" {
            # Simulates the state after the first run's upload succeeded but
            # indexing had not yet completed: the document is now visible in
            # the status listing.
            Mock Test-AgentMemoryApiSupported { $true }
            Mock Get-AgentMemoryDocumentNames { @($script:expectedDocName) }
            Mock Invoke-KnowledgeDocumentUpload { throw "should not be called on retry" }
            Mock Wait-KnowledgeIndexed { $true }
            Mock Remove-StaleKnowledgeDocument { }

            $result = Invoke-SreAgentKnowledgeBootstrap -Endpoint 'https://agent.example.azuresre.ai' -Token 'fake-token' -KnowledgeFilePath $script:knowledgeFile

            $result.Success | Should -Be $true
            Should -Invoke Invoke-KnowledgeDocumentUpload -Times 0 -Exactly
        }
    }

    Context "API unsupported — agent memory endpoint returns 404/405" {
        It "reports an explicit unsupported-API failure and never calls upload/list/delete" {
            Mock Test-AgentMemoryApiSupported { $false }
            Mock Get-AgentMemoryDocumentNames { throw "should not be called" }
            Mock Invoke-KnowledgeDocumentUpload { throw "should not be called" }
            Mock Wait-KnowledgeIndexed { throw "should not be called" }
            Mock Remove-StaleKnowledgeDocument { throw "should not be called" }

            $result = Invoke-SreAgentKnowledgeBootstrap -Endpoint 'https://agent.example.azuresre.ai' -Token 'fake-token' -KnowledgeFilePath $script:knowledgeFile

            $result.Success | Should -Be $false
            $result.Reason | Should -Be 'UnsupportedApi'
            $result.Message | Should -Match 'not available'

            Should -Invoke Get-AgentMemoryDocumentNames -Times 0 -Exactly
        }
    }

    Context "Missing knowledge file" {
        It "throws before attempting any network call" {
            Mock Test-AgentMemoryApiSupported { throw "should not be called" }

            { Invoke-SreAgentKnowledgeBootstrap -Endpoint 'https://agent.example.azuresre.ai' -Token 'fake-token' -KnowledgeFilePath (Join-Path ([System.IO.Path]::GetTempPath()) "does-not-exist-$([guid]::NewGuid()).md") } | Should -Throw "*not found*"
        }
    }
}

Describe "Test-AgentMemoryApiSupported" {
    It "returns false on a confirmed HTTP 404 (unsupported API)" {
        Mock Invoke-AgentMemoryRequest { [pscustomobject]@{ StatusCode = 404; Success = $false; Content = $null; RawContent = '' } }
        Test-AgentMemoryApiSupported -Endpoint 'https://agent.example.azuresre.ai' -Token 'fake-token' | Should -Be $false
    }

    It "returns false on a confirmed HTTP 405 (unsupported API)" {
        Mock Invoke-AgentMemoryRequest { [pscustomobject]@{ StatusCode = 405; Success = $false; Content = $null; RawContent = '' } }
        Test-AgentMemoryApiSupported -Endpoint 'https://agent.example.azuresre.ai' -Token 'fake-token' | Should -Be $false
    }

    It "returns true on HTTP 200" {
        Mock Invoke-AgentMemoryRequest { [pscustomobject]@{ StatusCode = 200; Success = $true; Content = [pscustomobject]@{ documents = @() }; RawContent = '{}' } }
        Test-AgentMemoryApiSupported -Endpoint 'https://agent.example.azuresre.ai' -Token 'fake-token' | Should -Be $true
    }

    It "throws (does not silently report unsupported) on an unrelated server error like HTTP 500" {
        Mock Invoke-AgentMemoryRequest { [pscustomobject]@{ StatusCode = 500; Success = $false; Content = $null; RawContent = 'boom' } }
        { Test-AgentMemoryApiSupported -Endpoint 'https://agent.example.azuresre.ai' -Token 'fake-token' } | Should -Throw "*transient*"
    }

    It "throws (does not silently report unsupported) on HTTP 401/403 auth errors" {
        Mock Invoke-AgentMemoryRequest { [pscustomobject]@{ StatusCode = 403; Success = $false; Content = $null; RawContent = 'forbidden' } }
        { Test-AgentMemoryApiSupported -Endpoint 'https://agent.example.azuresre.ai' -Token 'fake-token' } | Should -Throw
    }
}

Describe "Get-AgentMemoryDocumentNames" {
    It "parses a 'documents' array of objects with fileName" {
        Mock Invoke-AgentMemoryRequest {
            [pscustomobject]@{
                StatusCode = 200
                Success    = $true
                Content    = [pscustomobject]@{ documents = @([pscustomobject]@{ fileName = 'a.md' }, [pscustomobject]@{ fileName = 'b.md' }) }
                RawContent = '{}'
            }
        }
        $names = Get-AgentMemoryDocumentNames -Endpoint 'https://agent.example.azuresre.ai' -Token 'fake-token'
        $names | Should -Contain 'a.md'
        $names | Should -Contain 'b.md'
    }

    It "parses a 'files' array of plain strings" {
        Mock Invoke-AgentMemoryRequest {
            [pscustomobject]@{
                StatusCode = 200
                Success    = $true
                Content    = [pscustomobject]@{ files = @('a.md', 'b.md') }
                RawContent = '{}'
            }
        }
        $names = Get-AgentMemoryDocumentNames -Endpoint 'https://agent.example.azuresre.ai' -Token 'fake-token'
        $names | Should -Contain 'a.md'
        $names | Should -Contain 'b.md'
    }

    It "returns an empty list when there are no documents" {
        Mock Invoke-AgentMemoryRequest {
            [pscustomobject]@{ StatusCode = 200; Success = $true; Content = [pscustomobject]@{ documents = @() }; RawContent = '{}' }
        }
        @(Get-AgentMemoryDocumentNames -Endpoint 'https://agent.example.azuresre.ai' -Token 'fake-token').Count | Should -Be 0
    }

    It "throws on a non-success response" {
        Mock Invoke-AgentMemoryRequest { [pscustomobject]@{ StatusCode = 500; Success = $false; Content = $null; RawContent = 'boom' } }
        { Get-AgentMemoryDocumentNames -Endpoint 'https://agent.example.azuresre.ai' -Token 'fake-token' } | Should -Throw
    }
}

Describe "Assert-ResourceGroupSubscriptionMatch" {
    It "throws when the resource group belongs to a different subscription" {
        Mock az {
            $global:LASTEXITCODE = 0
            if ($args[0] -eq 'account') { return 'sub-current' }
            if ($args[0] -eq 'group') { return '/subscriptions/sub-OTHER/resourceGroups/rg-test' }
        }

        { Assert-ResourceGroupSubscriptionMatch -ResourceGroupName 'rg-test' } | Should -Throw "*does not belong to the current subscription*"
    }

    It "succeeds when the resource group belongs to the current subscription" {
        Mock az {
            $global:LASTEXITCODE = 0
            if ($args[0] -eq 'account') { return 'sub-current' }
            if ($args[0] -eq 'group') { return '/subscriptions/sub-current/resourceGroups/rg-test' }
        }

        Assert-ResourceGroupSubscriptionMatch -ResourceGroupName 'rg-test' | Should -Be 'sub-current'
    }

    It "throws when the resource group cannot be found at all" {
        Mock az {
            $global:LASTEXITCODE = 0
            if ($args[0] -eq 'account') { return 'sub-current' }
            if ($args[0] -eq 'group') { return $null }
        }

        { Assert-ResourceGroupSubscriptionMatch -ResourceGroupName 'rg-missing' } | Should -Throw "*was not found*"
    }
}

Describe "Secret redaction — the bearer token is never written to host output" {
    It "never appears in any Write-Host call during a clean bootstrap run" {
        $secretToken = 'super-secret-data-plane-token-value'
        $writeHostCalls = [System.Collections.Generic.List[string]]::new()

        Mock Write-Host { $writeHostCalls.Add(($ArgumentList -join ' ')) } -ParameterFilter { $true }
        Mock Test-AgentMemoryApiSupported { $true }
        Mock Get-AgentMemoryDocumentNames { @() }
        Mock Invoke-KnowledgeDocumentUpload { [pscustomobject]@{ Success = $true } }
        Mock Wait-KnowledgeIndexed { $true }
        Mock Remove-StaleKnowledgeDocument { }

        $knowledgeFile = New-TempKnowledgeFile
        try {
            Invoke-SreAgentKnowledgeBootstrap -Endpoint 'https://agent.example.azuresre.ai' -Token $secretToken -KnowledgeFilePath $knowledgeFile | Out-Null
        }
        finally {
            Remove-Item -Path $knowledgeFile -Force -ErrorAction SilentlyContinue
        }

        ($writeHostCalls -join "`n") | Should -Not -Match ([regex]::Escape($secretToken))
    }

    It "the script source never interpolates `$Token or `$dataPlaneToken directly into Write-Host/Write-Verbose" {
        $source = Get-Content -Path $script:ScriptPath -Raw
        $source | Should -Not -Match 'Write-(Host|Verbose)[^\n]*\$(dataPlaneToken|Token)\b'
    }
}
