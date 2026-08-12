#Requires -Modules Pester

<#
.SYNOPSIS
    Execution-level HTTP test for the REAL scripts/bootstrap-sre-agent-knowledge.ps1
    Invoke-AgentMemoryRequest function — no mocking of that function.

.DESCRIPTION
    scripts/tests/bootstrap-sre-agent-knowledge.tests.ps1 mocks
    Invoke-AgentMemoryRequest everywhere it needs a canned HTTP response, which
    is correct for testing the orchestration logic (Invoke-SreAgentKnowledgeBootstrap
    etc.) but never actually exercises the function's own header construction
    and HTTP call against a real listener. This file closes that gap.

    It stands up a real System.Net.HttpListener on loopback, runs the
    unmodified Invoke-AgentMemoryRequest in a background job (so the
    listener's blocking Accept and the client call can both make progress),
    and inspects the request the listener actually received:
      - The Authorization header uses the Bearer scheme and carries the exact
        supplied test token — for both a plain GET and a multipart POST.
      - Everything printed to the job's host/verbose/error/output streams is
        captured and asserted to never contain the token value.

    This is a real network round-trip (127.0.0.1 only), not a mock — it proves
    the header actually leaves the process correctly formed.

.EXAMPLE
    Invoke-Pester -Path scripts/tests/bootstrap-sre-agent-knowledge-http.tests.ps1
#>

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot ".." "bootstrap-sre-agent-knowledge.ps1"

    function Get-EphemeralLoopbackListener {
        <#
        Tries a handful of high ports and returns a started HttpListener bound
        to 127.0.0.1, plus the port it bound to.
        #>
        [CmdletBinding()]
        param()

        $candidatePorts = 18700..18760
        foreach ($candidatePort in $candidatePorts) {
            $listener = [System.Net.HttpListener]::new()
            $listener.Prefixes.Add("http://127.0.0.1:$candidatePort/")
            try {
                $listener.Start()
                return [pscustomobject]@{ Listener = $listener; Port = $candidatePort }
            }
            catch {
                continue
            }
        }

        throw "Could not bind an HttpListener to any candidate loopback port."
    }

    function Invoke-RealAgentMemoryRequestInJob {
        <#
        .SYNOPSIS
            Runs the REAL (unmocked) Invoke-AgentMemoryRequest in a background
            job against the given loopback endpoint, and returns both its
            return value and everything written to the job's output streams.
        #>
        [CmdletBinding()]
        param(
            [Parameter(Mandatory = $true)] [int]$Port,
            [Parameter(Mandatory = $true)] [string]$Token,
            [Parameter(Mandatory = $true)] [string]$Method,
            [Parameter(Mandatory = $true)] [string]$Path,
            [Parameter()] [string]$FilePath
        )

        $job = Start-Job -ScriptBlock {
            param($scriptPath, $port, $token, $method, $path, $filePath)
            . $scriptPath -ResourceGroupName 'rg-test' -AgentName 'agent-test'

            $requestParams = @{
                Endpoint = "http://127.0.0.1:$port"
                Token    = $token
                Method   = $method
                Path     = $path
            }
            if ($filePath) {
                $requestParams.FilePath = $filePath
            }

            Invoke-AgentMemoryRequest @requestParams
        } -ArgumentList $script:ScriptPath, $Port, $Token, $Method, $Path, $FilePath

        return $job
    }
}

Describe "Invoke-AgentMemoryRequest — real HTTP execution (no mocking)" {
    Context "GET request" {
        It "sends 'Authorization: Bearer <token>' and never leaks the token in any output stream" {
            $testToken = 'exec-test-token-' + [guid]::NewGuid().ToString('N')
            $bound = Get-EphemeralLoopbackListener
            $listener = $bound.Listener
            $port = $bound.Port

            try {
                $acceptTask = $listener.GetContextAsync()

                $job = Invoke-RealAgentMemoryRequestInJob -Port $port -Token $testToken -Method 'GET' -Path '/api/v1/agentmemory/status'

                if (-not $acceptTask.Wait(15000)) {
                    throw "Listener did not receive a request within 15 seconds."
                }
                $context = $acceptTask.Result

                $receivedAuthHeader = $context.Request.Headers['Authorization']
                $receivedMethod = $context.Request.HttpMethod

                $responseBytes = [System.Text.Encoding]::UTF8.GetBytes('{"documents":[]}')
                $context.Response.StatusCode = 200
                $context.Response.ContentType = 'application/json'
                $context.Response.ContentLength64 = $responseBytes.Length
                $context.Response.OutputStream.Write($responseBytes, 0, $responseBytes.Length)
                $context.Response.OutputStream.Close()

                $null = Wait-Job -Job $job -Timeout 15
                $functionResult = Receive-Job -Job $job -Keep
                $errorStreamText = ($job.ChildJobs[0].Error | Out-String)
                $verboseStreamText = ($job.ChildJobs[0].Verbose | Out-String)
                $warningStreamText = ($job.ChildJobs[0].Warning | Out-String)
                $informationStreamText = ($job.ChildJobs[0].Information | Out-String)
                Remove-Job -Job $job -Force -ErrorAction SilentlyContinue

                # --- What the server actually received ---
                $receivedMethod | Should -Be 'GET'
                $receivedAuthHeader | Should -Be "Bearer $testToken"
                $receivedAuthHeader | Should -Match '^Bearer '

                # --- What the real function returned ---
                $functionResult.StatusCode | Should -Be 200
                $functionResult.Success | Should -Be $true

                # --- The token must never appear in any captured stream ---
                $errorStreamText | Should -Not -Match ([regex]::Escape($testToken))
                $verboseStreamText | Should -Not -Match ([regex]::Escape($testToken))
                $warningStreamText | Should -Not -Match ([regex]::Escape($testToken))
                $informationStreamText | Should -Not -Match ([regex]::Escape($testToken))
            }
            finally {
                $listener.Stop()
                $listener.Close()
            }
        }
    }

    Context "Multipart POST request (file upload)" {
        It "sends 'Authorization: Bearer <token>' with a multipart body carrying the file, and never leaks the token" {
            $testToken = 'exec-test-token-' + [guid]::NewGuid().ToString('N')
            $fileContent = "# Test knowledge`nUnique marker: $([guid]::NewGuid())"
            $tempFile = Join-Path ([System.IO.Path]::GetTempPath()) "http-test-$([guid]::NewGuid()).md"
            Set-Content -Path $tempFile -Value $fileContent -NoNewline

            $bound = Get-EphemeralLoopbackListener
            $listener = $bound.Listener
            $port = $bound.Port

            try {
                $acceptTask = $listener.GetContextAsync()

                $job = Invoke-RealAgentMemoryRequestInJob -Port $port -Token $testToken -Method 'POST' -Path '/api/v1/agentmemory/upload' -FilePath $tempFile

                if (-not $acceptTask.Wait(15000)) {
                    throw "Listener did not receive a request within 15 seconds."
                }
                $context = $acceptTask.Result

                $receivedAuthHeader = $context.Request.Headers['Authorization']
                $receivedMethod = $context.Request.HttpMethod
                $receivedContentType = $context.Request.ContentType

                $bodyText = $null
                if ($context.Request.HasEntityBody) {
                    $reader = [System.IO.StreamReader]::new($context.Request.InputStream, $context.Request.ContentEncoding)
                    $bodyText = $reader.ReadToEnd()
                    $reader.Dispose()
                }

                $responseBytes = [System.Text.Encoding]::UTF8.GetBytes('{"accepted":true}')
                $context.Response.StatusCode = 200
                $context.Response.ContentType = 'application/json'
                $context.Response.ContentLength64 = $responseBytes.Length
                $context.Response.OutputStream.Write($responseBytes, 0, $responseBytes.Length)
                $context.Response.OutputStream.Close()

                $null = Wait-Job -Job $job -Timeout 15
                $functionResult = Receive-Job -Job $job -Keep
                $errorStreamText = ($job.ChildJobs[0].Error | Out-String)
                $verboseStreamText = ($job.ChildJobs[0].Verbose | Out-String)
                Remove-Job -Job $job -Force -ErrorAction SilentlyContinue

                # --- What the server actually received ---
                $receivedMethod | Should -Be 'POST'
                $receivedAuthHeader | Should -Be "Bearer $testToken"
                $receivedContentType | Should -Match '^multipart/form-data'
                $bodyText | Should -Match ([regex]::Escape($fileContent))

                # --- What the real function returned ---
                $functionResult.StatusCode | Should -Be 200
                $functionResult.Success | Should -Be $true

                # --- The token must never appear in any captured stream ---
                $errorStreamText | Should -Not -Match ([regex]::Escape($testToken))
                $verboseStreamText | Should -Not -Match ([regex]::Escape($testToken))

                # Sanity: the token must also never appear in the multipart
                # body itself (it belongs only in the header, never the form).
                $bodyText | Should -Not -Match ([regex]::Escape($testToken))
            }
            finally {
                $listener.Stop()
                $listener.Close()
                Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
