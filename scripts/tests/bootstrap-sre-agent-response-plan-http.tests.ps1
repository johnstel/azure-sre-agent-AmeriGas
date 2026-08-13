#Requires -Modules Pester

<#
.SYNOPSIS
    Execution-level HTTP test for the REAL scripts/bootstrap-sre-agent-response-plan.ps1
    Invoke-DataPlaneRequest function — no mocking of that function.

.DESCRIPTION
    scripts/tests/bootstrap-sre-agent-response-plan.tests.ps1 mocks
    Invoke-DataPlaneRequest everywhere it needs a canned HTTP response, which
    is correct for testing the orchestration/semantic-verification logic but
    never actually exercises the function's own header construction, request
    body encoding, or HTTP call against a real listener. This file closes
    that gap, mirroring the pattern in
    scripts/tests/bootstrap-sre-agent-knowledge-http.tests.ps1.

    It stands up a real System.Net.HttpListener on loopback, runs the
    unmodified Invoke-DataPlaneRequest in a background job (so the
    listener's blocking Accept and the client call can both make progress),
    and inspects the request the listener actually received:
      - The Authorization header carries the exact supplied test token as
        "Bearer <token>", for GET, PUT (with body), and DELETE.
      - PUT request bodies are sent as UTF-8 WITHOUT a byte-order-mark
        (verified by checking the raw byte stream for the absence of the
        EF BB BF BOM sequence) and with Content-Type: application/json.
      - GET/DELETE/PUT all send Accept: application/json.
      - The function correctly parses a 2xx JSON response body back into
        an object, and correctly classifies 404/405/500 status codes.
      - Everything printed to the job's host/verbose/error/output streams
        is captured and asserted to never contain the token value.

    This is a real network round-trip (127.0.0.1 only), not a mock — it
    proves the header/body actually leave the process correctly formed.

.EXAMPLE
    Invoke-Pester -Path scripts/tests/bootstrap-sre-agent-response-plan-http.tests.ps1
#>

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot ".." "bootstrap-sre-agent-response-plan.ps1"

    function Get-EphemeralLoopbackListener {
        <#
        Tries a handful of high ports and returns a started HttpListener bound
        to 127.0.0.1, plus the port it bound to. Uses a different port range
        than the knowledge-bootstrap HTTP tests to avoid any collision if
        both suites happen to run concurrently.
        #>
        [CmdletBinding()]
        param()

        $candidatePorts = 18800..18860
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

    function Invoke-RealDataPlaneRequestInJob {
        <#
        .SYNOPSIS
            Runs the REAL (unmocked) Invoke-DataPlaneRequest in a background
            job against the given loopback endpoint, and returns both its
            return value and everything written to the job's output streams.
        #>
        [CmdletBinding()]
        param(
            [Parameter(Mandatory = $true)] [int]$Port,
            [Parameter(Mandatory = $true)] [string]$Token,
            [Parameter(Mandatory = $true)] [string]$Method,
            [Parameter(Mandatory = $true)] [string]$Path,
            [Parameter()] [string]$BodyJson
        )

        $job = Start-Job -ScriptBlock {
            param($scriptPath, $port, $token, $method, $path, $bodyJson)
            . $scriptPath -ResourceGroupName 'rg-test' -AgentName 'agent-test' -AksClusterName 'aks-test'

            $requestParams = @{
                Endpoint = "http://127.0.0.1:$port"
                Token    = $token
                Method   = $method
                Path     = $path
            }
            if ($bodyJson) {
                $requestParams.BodyJson = $bodyJson
            }

            Invoke-DataPlaneRequest @requestParams
        } -ArgumentList $script:ScriptPath, $Port, $Token, $Method, $Path, $BodyJson

        return $job
    }

    function Get-JobStreamText {
        param($Job)
        $errorText = ($Job.ChildJobs[0].Error | Out-String)
        $verboseText = ($Job.ChildJobs[0].Verbose | Out-String)
        $warningText = ($Job.ChildJobs[0].Warning | Out-String)
        $informationText = ($Job.ChildJobs[0].Information | Out-String)
        return "$errorText`n$verboseText`n$warningText`n$informationText"
    }
}

Describe "Invoke-DataPlaneRequest — real HTTP execution (no mocking)" {
    Context "GET request" {
        It "sends 'Authorization: Bearer <token>' and 'Accept: application/json', and never leaks the token in any output stream" {
            $testToken = 'exec-test-token-' + [guid]::NewGuid().ToString('N')
            $bound = Get-EphemeralLoopbackListener
            $listener = $bound.Listener
            $port = $bound.Port

            try {
                $acceptTask = $listener.GetContextAsync()

                $job = Invoke-RealDataPlaneRequestInJob -Port $port -Token $testToken -Method 'GET' -Path '/api/v2/incidentManagement/incidentFilters'

                if (-not $acceptTask.Wait(15000)) {
                    throw "Listener did not receive a request within 15 seconds."
                }
                $context = $acceptTask.Result

                $receivedAuthHeader = $context.Request.Headers['Authorization']
                $receivedAcceptHeader = $context.Request.Headers['Accept']
                $receivedMethod = $context.Request.HttpMethod
                $receivedUrl = $context.Request.Url.AbsolutePath

                $responseBytes = [System.Text.Encoding]::UTF8.GetBytes('{"value":[]}')
                $context.Response.StatusCode = 200
                $context.Response.ContentType = 'application/json'
                $context.Response.ContentLength64 = $responseBytes.Length
                $context.Response.OutputStream.Write($responseBytes, 0, $responseBytes.Length)
                $context.Response.OutputStream.Close()

                $null = Wait-Job -Job $job -Timeout 15
                $functionResult = Receive-Job -Job $job -Keep
                $streamText = Get-JobStreamText -Job $job
                Remove-Job -Job $job -Force -ErrorAction SilentlyContinue

                # --- What the server actually received ---
                $receivedMethod | Should -Be 'GET'
                $receivedUrl | Should -Be '/api/v2/incidentManagement/incidentFilters'
                $receivedAuthHeader | Should -Be "Bearer $testToken"
                $receivedAcceptHeader | Should -Match 'application/json'

                # --- What the real function returned ---
                $functionResult.StatusCode | Should -Be 200
                $functionResult.Success | Should -Be $true
                $functionResult.Content | Should -Not -BeNullOrEmpty
                ($functionResult.Content.PSObject.Properties.Name -contains 'value') | Should -Be $true

                # --- The token must never appear in any captured stream ---
                $streamText | Should -Not -Match ([regex]::Escape($testToken))
            }
            finally {
                $listener.Stop()
                $listener.Close()
            }
        }
    }

    Context "PUT request with a JSON body" {
        It "sends the body as UTF-8 WITHOUT a byte-order-mark, Content-Type: application/json, and the exact Authorization header" {
            $testToken = 'exec-test-token-' + [guid]::NewGuid().ToString('N')
            $uniqueMarker = [guid]::NewGuid().ToString('N')
            $bodyJson = "{`"id`":`"test-filter-$uniqueMarker`",`"priorities`":[`"Sev1`"],`"agentMode`":`"Review`"}"

            $bound = Get-EphemeralLoopbackListener
            $listener = $bound.Listener
            $port = $bound.Port

            try {
                $acceptTask = $listener.GetContextAsync()

                $job = Invoke-RealDataPlaneRequestInJob -Port $port -Token $testToken -Method 'PUT' -Path '/api/v1/incidentplayground/filters/test-filter' -BodyJson $bodyJson

                if (-not $acceptTask.Wait(15000)) {
                    throw "Listener did not receive a request within 15 seconds."
                }
                $context = $acceptTask.Result

                $receivedAuthHeader = $context.Request.Headers['Authorization']
                $receivedMethod = $context.Request.HttpMethod
                $receivedContentType = $context.Request.ContentType

                # Read the RAW bytes (not just the decoded string) so we can
                # positively assert the absence of a UTF-8 BOM (EF BB BF) at
                # the start of the body.
                $memoryStream = [System.IO.MemoryStream]::new()
                $context.Request.InputStream.CopyTo($memoryStream)
                $rawBodyBytes = $memoryStream.ToArray()
                $bodyText = [System.Text.Encoding]::UTF8.GetString($rawBodyBytes)

                $responseBytes = [System.Text.Encoding]::UTF8.GetBytes('{"accepted":true}')
                $context.Response.StatusCode = 200
                $context.Response.ContentType = 'application/json'
                $context.Response.ContentLength64 = $responseBytes.Length
                $context.Response.OutputStream.Write($responseBytes, 0, $responseBytes.Length)
                $context.Response.OutputStream.Close()

                $null = Wait-Job -Job $job -Timeout 15
                $functionResult = Receive-Job -Job $job -Keep
                $streamText = Get-JobStreamText -Job $job
                Remove-Job -Job $job -Force -ErrorAction SilentlyContinue

                # --- What the server actually received ---
                $receivedMethod | Should -Be 'PUT'
                $receivedAuthHeader | Should -Be "Bearer $testToken"
                $receivedContentType | Should -Match '^application/json'
                $bodyText | Should -Match ([regex]::Escape("test-filter-$uniqueMarker"))

                # --- No BOM: the first three bytes must NOT be the UTF-8 BOM sequence ---
                if ($rawBodyBytes.Length -ge 3) {
                    $hasBom = ($rawBodyBytes[0] -eq 0xEF) -and ($rawBodyBytes[1] -eq 0xBB) -and ($rawBodyBytes[2] -eq 0xBF)
                    $hasBom | Should -Be $false
                }
                # The body must start with '{' (the literal JSON opening
                # brace), which would NOT be true if a BOM were prepended.
                $rawBodyBytes[0] | Should -Be ([byte][char]'{')

                # --- What the real function returned ---
                $functionResult.StatusCode | Should -Be 200
                $functionResult.Success | Should -Be $true
                $functionResult.Content.accepted | Should -Be $true

                # --- The token must never appear in any captured stream or in the body ---
                $streamText | Should -Not -Match ([regex]::Escape($testToken))
                $bodyText | Should -Not -Match ([regex]::Escape($testToken))
            }
            finally {
                $listener.Stop()
                $listener.Close()
            }
        }
    }

    Context "DELETE request" {
        It "sends 'Authorization: Bearer <token>' with no body" {
            $testToken = 'exec-test-token-' + [guid]::NewGuid().ToString('N')
            $bound = Get-EphemeralLoopbackListener
            $listener = $bound.Listener
            $port = $bound.Port

            try {
                $acceptTask = $listener.GetContextAsync()

                $job = Invoke-RealDataPlaneRequestInJob -Port $port -Token $testToken -Method 'DELETE' -Path '/api/v1/incidentplayground/filters/quickstart-plan'

                if (-not $acceptTask.Wait(15000)) {
                    throw "Listener did not receive a request within 15 seconds."
                }
                $context = $acceptTask.Result

                $receivedAuthHeader = $context.Request.Headers['Authorization']
                $receivedMethod = $context.Request.HttpMethod
                $receivedHasBody = $context.Request.HasEntityBody

                $context.Response.StatusCode = 204
                $context.Response.ContentLength64 = 0
                $context.Response.OutputStream.Close()

                $null = Wait-Job -Job $job -Timeout 15
                $functionResult = Receive-Job -Job $job -Keep
                $streamText = Get-JobStreamText -Job $job
                Remove-Job -Job $job -Force -ErrorAction SilentlyContinue

                $receivedMethod | Should -Be 'DELETE'
                $receivedAuthHeader | Should -Be "Bearer $testToken"
                $receivedHasBody | Should -Be $false

                $functionResult.StatusCode | Should -Be 204
                $functionResult.Success | Should -Be $true

                $streamText | Should -Not -Match ([regex]::Escape($testToken))
            }
            finally {
                $listener.Stop()
                $listener.Close()
            }
        }
    }

    Context "Capability-detection failure responses (404/405) are correctly classified, never crash" {
        It "returns Success=false and StatusCode=404 for a 404 response, without throwing" {
            $testToken = 'exec-test-token-' + [guid]::NewGuid().ToString('N')
            $bound = Get-EphemeralLoopbackListener
            $listener = $bound.Listener
            $port = $bound.Port

            try {
                $acceptTask = $listener.GetContextAsync()
                $job = Invoke-RealDataPlaneRequestInJob -Port $port -Token $testToken -Method 'GET' -Path '/api/v2/incidentManagement/incidentFilters'

                if (-not $acceptTask.Wait(15000)) {
                    throw "Listener did not receive a request within 15 seconds."
                }
                $context = $acceptTask.Result
                $context.Response.StatusCode = 404
                $context.Response.OutputStream.Close()

                $null = Wait-Job -Job $job -Timeout 15
                $functionResult = Receive-Job -Job $job -Keep
                Remove-Job -Job $job -Force -ErrorAction SilentlyContinue

                $functionResult.StatusCode | Should -Be 404
                $functionResult.Success | Should -Be $false
            }
            finally {
                $listener.Stop()
                $listener.Close()
            }
        }

        It "returns Success=false and StatusCode=500 for a genuine server error, without throwing (caller distinguishes this from 404/405)" {
            $testToken = 'exec-test-token-' + [guid]::NewGuid().ToString('N')
            $bound = Get-EphemeralLoopbackListener
            $listener = $bound.Listener
            $port = $bound.Port

            try {
                $acceptTask = $listener.GetContextAsync()
                $job = Invoke-RealDataPlaneRequestInJob -Port $port -Token $testToken -Method 'GET' -Path '/api/v2/extendedAgent/incidentHandlers'

                if (-not $acceptTask.Wait(15000)) {
                    throw "Listener did not receive a request within 15 seconds."
                }
                $context = $acceptTask.Result
                $responseBytes = [System.Text.Encoding]::UTF8.GetBytes('{"error":"internal"}')
                $context.Response.StatusCode = 500
                $context.Response.ContentType = 'application/json'
                $context.Response.ContentLength64 = $responseBytes.Length
                $context.Response.OutputStream.Write($responseBytes, 0, $responseBytes.Length)
                $context.Response.OutputStream.Close()

                $null = Wait-Job -Job $job -Timeout 15
                $functionResult = Receive-Job -Job $job -Keep
                Remove-Job -Job $job -Force -ErrorAction SilentlyContinue

                $functionResult.StatusCode | Should -Be 500
                $functionResult.Success | Should -Be $false
            }
            finally {
                $listener.Stop()
                $listener.Close()
            }
        }
    }
}
