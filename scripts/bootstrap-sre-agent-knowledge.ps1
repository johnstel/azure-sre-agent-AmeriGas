<#
.SYNOPSIS
    Idempotently uploads docs/sre-agent-knowledge.md to the Azure SRE Agent's
    knowledge base (agent memory) via the data-plane REST API.

.DESCRIPTION
    knowledgeGraphConfiguration.managedResources and the Application Insights
    binding can be expressed declaratively in Bicep, but knowledge-file upload
    and indexing cannot — Azure SRE Agent currently only exposes it through
    data-plane REST endpoints (see https://learn.microsoft.com/azure/sre-agent/api-reference,
    "Knowledge (agent memory)"). This script closes that gap:

      1. Verifies the target resource group belongs to the *current* Azure CLI
         subscription context (refuses to bootstrap against the wrong
         subscription).
      2. Reads the SRE Agent's control-plane state (provisioningState,
         agentEndpoint) via ARM (`az rest`), using the caller's normal Azure
         CLI credentials — no stored secrets.
      3. Acquires a data-plane token (audience `https://azuresre.dev`) with
         `az account get-access-token`. The token is held in a local variable
         only, for the lifetime of this process, and is never written to
         host output, logs, or disk.
      4. Explicitly probes GET /api/v1/agentmemory/status to detect whether
         the agent memory API is available at all. If it responds 404/405,
         this fails with a precise "unsupported API" error — it never claims
         success or asks for a manual portal step.
      5. Computes a SHA-256 hash of the knowledge file and uploads it under a
         deterministic, hash-keyed document name (sre-agent-knowledge.<hash12>.md).
         Because the name is derived purely from content:
           - An unchanged rerun finds the same document already present and
             indexed, and skips the upload (no duplication).
           - A changed file uploads under a new name, waits for indexing to
             report success, and only then deletes the previous hash-named
             document(s) — so a failure mid-run never leaves the agent with
             zero current knowledge, and a rerun after partial failure simply
             resumes (it never re-uploads a document that is already present).

.PARAMETER ResourceGroupName
    Resource group containing the deployed SRE Agent.

.PARAMETER AgentName
    Name of the Microsoft.App/agents resource.

.PARAMETER ApiVersion
    Control-plane API version to read the agent with. Must match one of the
    versions infra/bicep/modules/sre-agent.bicep supports.

.PARAMETER KnowledgeFilePath
    Path to the knowledge markdown file. Defaults to docs/sre-agent-knowledge.md.

.PARAMETER IndexTimeoutSeconds
    Maximum time to wait for the uploaded document to finish indexing.

.EXAMPLE
    ./bootstrap-sre-agent-knowledge.ps1 -ResourceGroupName rg-srelab-eastus2 -AgentName sre-srelab

.NOTES
    Idempotent and safe to rerun after a partial failure (upload succeeded but
    indexing timed out, network blip mid-run, etc.) — see DESCRIPTION.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ResourceGroupName,

    [Parameter(Mandatory = $true)]
    [string]$AgentName,

    [Parameter()]
    [ValidateSet('2026-01-01', '2025-05-01-preview')]
    [string]$ApiVersion = '2026-01-01',

    [Parameter()]
    [string]$KnowledgeFilePath = (Join-Path $PSScriptRoot ".." "docs/sre-agent-knowledge.md"),

    [Parameter()]
    [int]$IndexTimeoutSeconds = 300
)

$script:DocumentPrefix = 'sre-agent-knowledge.'

# =============================================================================
# FUNCTIONS (dot-sourced by Pester tests; guarded execution block at bottom)
# =============================================================================

function Assert-ResourceGroupSubscriptionMatch {
    <#
    .SYNOPSIS
        Fails fast if the target resource group is not in the Azure CLI's
        current subscription context — prevents bootstrapping knowledge
        against the wrong subscription.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$ResourceGroupName
    )

    $currentSubscriptionId = & az account show --query id --output tsv 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($currentSubscriptionId)) {
        throw "Unable to determine the current Azure CLI subscription context. Run 'az login' / 'az account set' and retry."
    }

    $resourceGroupId = & az group show --name $ResourceGroupName --query id --output tsv 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($resourceGroupId)) {
        throw "Resource group '$ResourceGroupName' was not found in subscription '$currentSubscriptionId'."
    }

    $expectedPrefix = "/subscriptions/$currentSubscriptionId/resourceGroups/"
    if (-not $resourceGroupId.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Resource group '$ResourceGroupName' (resolved ID: $resourceGroupId) does not belong to the current subscription context ('$currentSubscriptionId'). Refusing to bootstrap knowledge against a mismatched subscription."
    }

    return $currentSubscriptionId
}

function Get-SreAgentResource {
    <#
    .SYNOPSIS
        Reads the SRE Agent's control-plane state via ARM using the caller's
        standard Azure CLI credentials.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$SubscriptionId,

        [Parameter(Mandatory = $true)]
        [string]$ResourceGroupName,

        [Parameter(Mandatory = $true)]
        [string]$AgentName,

        [Parameter(Mandatory = $true)]
        [string]$ApiVersion
    )

    $url = "https://management.azure.com/subscriptions/${SubscriptionId}/resourceGroups/${ResourceGroupName}/providers/Microsoft.App/agents/${AgentName}?api-version=${ApiVersion}"
    $raw = & az rest --method GET --url $url --output json 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) {
        throw "Failed to read SRE Agent '$AgentName' in resource group '$ResourceGroupName' via ARM (api-version=$ApiVersion). Confirm the agent name, resource group, and API version are correct."
    }

    try {
        return $raw | ConvertFrom-Json
    }
    catch {
        throw "SRE Agent ARM response for '$AgentName' was not valid JSON: $($_.Exception.Message)"
    }
}

function Get-DataPlaneAccessToken {
    <#
    .SYNOPSIS
        Acquires an in-memory-only data-plane token for audience
        https://azuresre.dev. Never persisted to disk or written to output.
    #>
    [CmdletBinding()]
    param()

    $token = & az account get-access-token --resource 'https://azuresre.dev' --query accessToken --output tsv 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
        throw "Failed to acquire a data-plane access token for audience https://azuresre.dev."
    }

    return $token
}

function Invoke-AgentMemoryRequest {
    <#
    .SYNOPSIS
        Single choke point for all agent-memory data-plane HTTP calls, so
        tests can mock exactly one function and so no other code path ever
        needs to see, log, or persist the bearer token.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token,

        [Parameter(Mandatory = $true)]
        [ValidateSet('GET', 'POST', 'DELETE')]
        [string]$Method,

        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter()]
        [string]$FilePath,

        [Parameter()]
        [string]$FileFieldName = 'file'
    )

    $uri = "$Endpoint$Path"
    $headers = @{ Authorization = "Bearer $Token" }

    try {
        if ($Method -eq 'POST' -and $FilePath) {
            $response = Invoke-WebRequest -Uri $uri -Method Post -Headers $headers -Form @{ $FileFieldName = Get-Item -Path $FilePath } -SkipHttpErrorCheck
        }
        else {
            $response = Invoke-WebRequest -Uri $uri -Method $Method -Headers $headers -SkipHttpErrorCheck
        }
    }
    catch {
        # Transport-level failure (DNS, TLS, timeout) — not an HTTP status
        # from the server. Always rethrow so callers treat this as a
        # transient/retryable error, never as a confirmed "unsupported API".
        throw "Agent memory request $Method $Path failed at the transport level: $($_.Exception.Message)"
    }

    $statusCode = [int]$response.StatusCode
    $parsedContent = $null
    if ($response.Content) {
        try {
            $parsedContent = $response.Content | ConvertFrom-Json
        }
        catch {
            $parsedContent = $null
        }
    }

    return [pscustomobject]@{
        StatusCode = $statusCode
        Success    = ($statusCode -ge 200 -and $statusCode -lt 300)
        Content    = $parsedContent
        RawContent = $response.Content
    }
}

function Test-AgentMemoryApiSupported {
    <#
    .SYNOPSIS
        Explicit capability detection for the agent-memory API. Returns
        $false only on a confirmed 404/405 ("this API does not exist here").
        Any other non-success response is treated as a transient failure and
        thrown, so a genuine outage is never misreported as "unsupported".
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token
    )

    $result = Invoke-AgentMemoryRequest -Endpoint $Endpoint -Token $Token -Method GET -Path '/api/v1/agentmemory/status'

    if ($result.StatusCode -eq 404 -or $result.StatusCode -eq 405) {
        return $false
    }

    if (-not $result.Success) {
        throw "Agent memory status check returned HTTP $($result.StatusCode), which is not a confirmed 'unsupported API' response (404/405). Treating this as a transient failure rather than silently degrading: $($result.RawContent)"
    }

    return $true
}

function Get-AgentMemoryDocumentNames {
    <#
    .SYNOPSIS
        Lists currently known document names from GET /api/v1/agentmemory/status.
        Tolerates a couple of reasonable response shapes since the exact
        schema is not published beyond the endpoint path.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token
    )

    $result = Invoke-AgentMemoryRequest -Endpoint $Endpoint -Token $Token -Method GET -Path '/api/v1/agentmemory/status'
    if (-not $result.Success) {
        throw "Failed to list agent memory documents: HTTP $($result.StatusCode)."
    }

    $names = New-Object System.Collections.Generic.List[string]
    $content = $result.Content

    if ($null -eq $content) {
        return @()
    }

    $items = $null
    if ($content.PSObject.Properties.Name -contains 'documents') {
        $items = $content.documents
    }
    elseif ($content.PSObject.Properties.Name -contains 'files') {
        $items = $content.files
    }
    elseif ($content -is [System.Collections.IEnumerable] -and -not ($content -is [string])) {
        $items = $content
    }

    foreach ($item in @($items)) {
        if ($null -eq $item) { continue }
        if ($item -is [string]) {
            $names.Add($item)
        }
        elseif ($item.PSObject.Properties.Name -contains 'fileName') {
            $names.Add([string]$item.fileName)
        }
        elseif ($item.PSObject.Properties.Name -contains 'name') {
            $names.Add([string]$item.name)
        }
    }

    return @($names)
}

function Invoke-KnowledgeDocumentUpload {
    <#
    .SYNOPSIS
        Uploads the knowledge file under a deterministic, hash-keyed document
        name via multipart POST.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token,

        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [string]$DocumentName
    )

    # The multipart file name is what keys the document server-side, so stage
    # a temporary copy under the deterministic hash-keyed name rather than
    # renaming/mutating the source file in the repo.
    $stagingDir = Join-Path ([System.IO.Path]::GetTempPath()) "sre-agent-knowledge-$([guid]::NewGuid())"
    New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
    $stagedPath = Join-Path $stagingDir $DocumentName

    try {
        Copy-Item -Path $FilePath -Destination $stagedPath -Force

        $result = Invoke-AgentMemoryRequest -Endpoint $Endpoint -Token $Token -Method POST -Path '/api/v1/agentmemory/upload' -FilePath $stagedPath
        if (-not $result.Success) {
            throw "Knowledge upload of '$DocumentName' failed: HTTP $($result.StatusCode). Response: $($result.RawContent)"
        }

        return $result
    }
    finally {
        Remove-Item -Path $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Wait-KnowledgeIndexed {
    <#
    .SYNOPSIS
        Polls GET /api/v1/agentmemory/indexer-status until it reports a
        terminal success state, a terminal failure state, or the timeout
        elapses.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token,

        [Parameter(Mandatory = $true)]
        [string]$DocumentName,

        [Parameter()]
        [int]$TimeoutSeconds = 300,

        [Parameter()]
        [int]$PollIntervalSeconds = 10
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

    do {
        $result = Invoke-AgentMemoryRequest -Endpoint $Endpoint -Token $Token -Method GET -Path '/api/v1/agentmemory/indexer-status'
        if (-not $result.Success) {
            throw "Indexer status check failed: HTTP $($result.StatusCode)."
        }

        $state = $null
        if ($result.Content) {
            if ($result.Content.PSObject.Properties.Name -contains 'status') {
                $state = [string]$result.Content.status
            }
            elseif ($result.Content.PSObject.Properties.Name -contains 'state') {
                $state = [string]$result.Content.state
            }
        }

        if ($state -match '(?i)^(completed|succeeded|idle|ready)$') {
            return $true
        }

        if ($state -match '(?i)^(failed|error)$') {
            throw "Knowledge indexing for '$DocumentName' reported a failed state: $state"
        }

        Start-Sleep -Seconds $PollIntervalSeconds
    } while ((Get-Date) -lt $deadline)

    throw "Timed out after $TimeoutSeconds seconds waiting for '$DocumentName' to finish indexing. Rerun this script — it is safe to retry and will not re-upload the same content."
}

function Remove-StaleKnowledgeDocument {
    <#
    .SYNOPSIS
        Deletes a previous-version knowledge document. Treats 404 (already
        gone) as success for idempotency.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token,

        [Parameter(Mandatory = $true)]
        [string]$DocumentName
    )

    $result = Invoke-AgentMemoryRequest -Endpoint $Endpoint -Token $Token -Method DELETE -Path "/api/v1/agentmemory/document/$DocumentName"
    if (-not $result.Success -and $result.StatusCode -ne 404) {
        throw "Failed to remove stale knowledge document '$DocumentName': HTTP $($result.StatusCode)."
    }
}

function Invoke-SreAgentKnowledgeBootstrap {
    <#
    .SYNOPSIS
        Orchestrates the full idempotent knowledge bootstrap: capability
        detection, content-hash comparison, upload, indexing wait, and stale
        cleanup. Never throws on a confirmed "unsupported API" condition —
        that is reported as a structured, unsuccessful result instead so
        callers can distinguish it from a transient/retryable failure (which
        this function DOES throw for, via its callees).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token,

        [Parameter(Mandatory = $true)]
        [string]$KnowledgeFilePath,

        [Parameter()]
        [string]$DocumentPrefix = $script:DocumentPrefix,

        [Parameter()]
        [int]$IndexTimeoutSeconds = 300
    )

    if (-not (Test-Path -Path $KnowledgeFilePath)) {
        throw "Knowledge file not found: $KnowledgeFilePath"
    }

    if (-not (Test-AgentMemoryApiSupported -Endpoint $Endpoint -Token $Token)) {
        return [pscustomobject]@{
            Success      = $false
            Reason       = 'UnsupportedApi'
            Message      = "The agent memory API (/api/v1/agentmemory/*) responded 404/405 on this agent's data-plane endpoint. This Preview capability is not available here — failing readiness explicitly instead of claiming knowledge is loaded or asking for a manual portal upload."
            DocumentName = $null
        }
    }

    $hash = (Get-FileHash -Path $KnowledgeFilePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $documentName = "$DocumentPrefix$($hash.Substring(0, 12)).md"

    $existingDocs = @(Get-AgentMemoryDocumentNames -Endpoint $Endpoint -Token $Token)
    $staleDocs = @($existingDocs | Where-Object { $_ -like "$DocumentPrefix*" -and $_ -ne $documentName })

    if ($existingDocs -contains $documentName) {
        # Content unchanged since the last successful run for this exact
        # hash — do not re-upload. Still confirm it finished indexing (a
        # prior run may have uploaded it and then failed/timed out before
        # confirming), and clean up any stale versions a prior run left
        # behind.
        $null = Wait-KnowledgeIndexed -Endpoint $Endpoint -Token $Token -DocumentName $documentName -TimeoutSeconds $IndexTimeoutSeconds

        foreach ($stale in $staleDocs) {
            $null = Remove-StaleKnowledgeDocument -Endpoint $Endpoint -Token $Token -DocumentName $stale
        }

        return [pscustomobject]@{
            Success      = $true
            Reason       = 'Unchanged'
            Message      = "Knowledge is already up to date (content hash $hash) and indexed as $documentName."
            DocumentName = $documentName
        }
    }

    $null = Invoke-KnowledgeDocumentUpload -Endpoint $Endpoint -Token $Token -FilePath $KnowledgeFilePath -DocumentName $documentName
    $null = Wait-KnowledgeIndexed -Endpoint $Endpoint -Token $Token -DocumentName $documentName -TimeoutSeconds $IndexTimeoutSeconds

    # Only remove older versions after the new one is confirmed indexed, so a
    # mid-run failure never leaves the agent with zero current knowledge.
    foreach ($stale in $staleDocs) {
        $null = Remove-StaleKnowledgeDocument -Endpoint $Endpoint -Token $Token -DocumentName $stale
    }

    $reason = if ($existingDocs.Count -eq 0) { 'CleanUpload' } else { 'ContentUpdated' }

    return [pscustomobject]@{
        Success      = $true
        Reason       = $reason
        Message      = "Knowledge uploaded and indexed as $documentName (content hash $hash)."
        DocumentName = $documentName
    }
}

# =============================================================================
# ENTRY POINT — only runs when the file is executed directly, not dot-sourced
# for its functions by Pester tests.
# =============================================================================
if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'

    try {
        Write-Host "`n📚 Bootstrapping SRE Agent knowledge for '$AgentName' in '$ResourceGroupName'..." -ForegroundColor Cyan

        $subscriptionId = Assert-ResourceGroupSubscriptionMatch -ResourceGroupName $ResourceGroupName
        Write-Host "  ✅ Subscription context verified: $subscriptionId" -ForegroundColor Green

        if (-not (Test-Path -Path $KnowledgeFilePath)) {
            throw "Knowledge file not found: $KnowledgeFilePath"
        }

        $agent = Get-SreAgentResource -SubscriptionId $subscriptionId -ResourceGroupName $ResourceGroupName -AgentName $AgentName -ApiVersion $ApiVersion

        if ($agent.properties.provisioningState -ne 'Succeeded') {
            throw "SRE Agent '$AgentName' provisioningState is '$($agent.properties.provisioningState)', expected 'Succeeded'. Wait for provisioning to complete and rerun."
        }
        if ([string]::IsNullOrWhiteSpace($agent.properties.agentEndpoint)) {
            throw "SRE Agent '$AgentName' has no data-plane agentEndpoint yet."
        }

        Write-Host "  ✅ Agent provisioningState=Succeeded (data-plane endpoint resolved)" -ForegroundColor Green

        # Acquired once, held only in this local variable, never logged.
        $dataPlaneToken = Get-DataPlaneAccessToken

        $result = Invoke-SreAgentKnowledgeBootstrap `
            -Endpoint $agent.properties.agentEndpoint `
            -Token $dataPlaneToken `
            -KnowledgeFilePath $KnowledgeFilePath `
            -IndexTimeoutSeconds $IndexTimeoutSeconds

        if (-not $result.Success) {
            Write-Host "`n❌ $($result.Message)" -ForegroundColor Red
            exit 1
        }

        Write-Host "`n✅ $($result.Message)" -ForegroundColor Green
        exit 0
    }
    catch {
        Write-Host "`n❌ SRE Agent knowledge bootstrap failed: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}
