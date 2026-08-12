<#
.SYNOPSIS
    Idempotently bootstraps (or tears down) the native Azure SRE Agent
    alert-to-approved-remediation response plan for the MongoDB-down demo
    scenario (issue #19): a custom agent plus an incident response plan
    (Microsoft.App/agents/subagents and Microsoft.App/agents/incidentFilters
    control-plane sub-resources), bound to the dedicated demo alert deployed
    by infra/bicep/modules/alerts.bicep.

.DESCRIPTION
    This is a genuine native Azure SRE Agent response plan — NOT Mission
    Control Copilot, NOT a generic webhook. It configures:

      1. A custom agent ("mongodb-down-responder") whose instructions are
         rendered from docs/sre-agent-response-plans/mongodb-down-custom-agent-instructions.md
         with the actual deployed subscription/resource group/AKS cluster
         name substituted in, so the agent's own instructions enforce
         wrong-subscription/wrong-resource rejection as defense in depth
         alongside RBAC.
      2. An incident response plan ("mongodb-down-response-plan") that
         filters Azure Monitor incidents by the exact alert title + severity
         configured in the demo profile, routes matches to that custom
         agent, and is explicitly set to Review autonomy (never Autonomous)
         with the platform's default 3-hour reinvestigation cooldown.

    Both are Microsoft.App/agents control-plane sub-resources
    (`/subagents/{name}`, `/incidentFilters/{name}`), managed via
    `az rest` with the caller's normal Azure CLI credentials (NOT the
    data-plane azuresre.dev token — subagents/incidentFilters are
    control-plane, unlike agent memory in bootstrap-sre-agent-knowledge.ps1).

    CAPABILITY DETECTION AND HONESTY ABOUT AN UNDOCUMENTED PREVIEW SCHEMA:
    The Azure SRE Agent API reference (https://learn.microsoft.com/azure/sre-agent/api-reference)
    documents that "other sub-resources" (skills, subagents, tools, and so
    on) use a base64-encoded envelope (`properties.value`) but does NOT
    publish the exact JSON keys inside that envelope for subagents or
    incidentFilters specifically — only an example for `tools`, plus the
    portal-UI field names documented in the "Custom agents" and "Incident
    response plans" conceptual docs. This script's spec payloads are a
    best-effort mapping from those documented UI fields. Because the exact
    schema is not published, this script NEVER claims a write succeeded
    just because the HTTP status was 2xx: after every PUT it performs a
    round-trip GET, decodes the stored envelope, and verifies the fields it
    just wrote came back byte-for-byte. If the service silently drops,
    renames, or reinterprets a field, that mismatch is surfaced as an
    explicit failure (Reason = 'SchemaMismatch') rather than reported as
    success. If the sub-resource type itself is not exposed at all
    (404/405 on a collection GET), that is reported as Reason =
    'UnsupportedApi' — this script never falls back to a webhook-only or
    manual-setup path and never asks the operator to assume it worked.

.PARAMETER ResourceGroupName
    Resource group containing the deployed SRE Agent, AKS cluster, and
    demo alert.

.PARAMETER AgentName
    Name of the Microsoft.App/agents resource.

.PARAMETER AksClusterName
    Name of the AKS cluster the rendered custom-agent instructions scope
    the remediation to.

.PARAMETER ApiVersion
    Control-plane API version. Must match one of the versions
    infra/bicep/modules/sre-agent.bicep supports.

.PARAMETER AlertTitle
    Exact Azure Monitor alert display title the response plan filters on.
    Must match mongoDbDownDemoAlertTitle in infra/bicep/modules/alerts.bicep.

.PARAMETER AlertSeverity
    Azure Monitor alert severity (0-4) the response plan filters on. Must
    match mongoDbDownDemoAlertSeverity in infra/bicep/modules/alerts.bicep.

.PARAMETER InstructionsFilePath
    Path to the versioned custom-agent instructions template.

.PARAMETER Teardown
    Remove the incident response plan and custom agent instead of creating
    them. Idempotent — a 404 on delete is treated as success. Never touches
    the alert rule or the SRE Agent resource itself.

.EXAMPLE
    ./bootstrap-sre-agent-response-plan.ps1 -ResourceGroupName rg-srelab-eastus2 -AgentName sre-srelab -AksClusterName aks-srelab

.EXAMPLE
    ./bootstrap-sre-agent-response-plan.ps1 -ResourceGroupName rg-srelab-eastus2 -AgentName sre-srelab -AksClusterName aks-srelab -Teardown

.NOTES
    Idempotent and safe to rerun. Content-hash keyed (like
    bootstrap-sre-agent-knowledge.ps1): a rerun with unchanged rendered
    instructions/filter criteria makes no write calls at all.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ResourceGroupName,

    [Parameter(Mandatory = $true)]
    [string]$AgentName,

    [Parameter(Mandatory = $true)]
    [string]$AksClusterName,

    [Parameter()]
    [ValidateSet('2026-01-01', '2025-05-01-preview')]
    [string]$ApiVersion = '2026-01-01',

    [Parameter()]
    [string]$AlertTitle = 'AmeriGas Propane Demo - MongoDB Down',

    [Parameter()]
    [ValidateRange(0, 4)]
    [int]$AlertSeverity = 1,

    [Parameter()]
    [string]$InstructionsFilePath = (Join-Path $PSScriptRoot ".." "docs/sre-agent-response-plans/mongodb-down-custom-agent-instructions.md"),

    [Parameter()]
    [switch]$Teardown
)

$script:CustomAgentName = 'mongodb-down-responder'
$script:ResponsePlanName = 'mongodb-down-response-plan'

# =============================================================================
# FUNCTIONS (dot-sourced by Pester tests; guarded execution block at bottom)
# =============================================================================

function Assert-ResponsePlanSubscriptionMatch {
    <#
    .SYNOPSIS
        Fails fast if the target resource group is not in the Azure CLI's
        current subscription context — prevents bootstrapping (or tearing
        down) the response plan against the wrong subscription.
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
        throw "Resource group '$ResourceGroupName' (resolved ID: $resourceGroupId) does not belong to the current subscription context ('$currentSubscriptionId'). Refusing to bootstrap the response plan against a mismatched subscription."
    }

    return $currentSubscriptionId
}

function Get-ResponsePlanAgentResource {
    <#
    .SYNOPSIS
        Reads the SRE Agent's control-plane state via ARM using the
        caller's standard Azure CLI credentials.
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

function Assert-AgentReadyForResponsePlan {
    <#
    .SYNOPSIS
        Fails fast unless the agent is provisioned, in Review mode, and
        already connected to Azure Monitor as its incident management
        platform. Extracted as its own testable function (rather than
        inline in the guarded entry point) so wrong-state rejection can be
        covered directly by Pester without shelling out to `az`.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        $Agent,

        [Parameter(Mandatory = $true)]
        [string]$AgentName
    )

    if ($Agent.properties.provisioningState -ne 'Succeeded') {
        throw "SRE Agent '$AgentName' provisioningState is '$($Agent.properties.provisioningState)', expected 'Succeeded'."
    }
    if ($Agent.properties.actionConfiguration.mode -ne 'Review') {
        throw "SRE Agent '$AgentName' actionConfiguration.mode is '$($Agent.properties.actionConfiguration.mode)', expected 'Review'. Refusing to bootstrap a response plan onto an agent that is not in Review mode."
    }

    $incidentType = $null
    if ($Agent.properties.PSObject.Properties.Name -contains 'incidentManagementConfiguration') {
        $incidentType = $Agent.properties.incidentManagementConfiguration.type
    }
    if ($incidentType -ne 'AzMonitor') {
        throw "SRE Agent '$AgentName' incidentManagementConfiguration.type is '$incidentType', expected 'AzMonitor'. Redeploy with infra/bicep/main.demo.bicepparam (deployDemoResponsePlan=true) first."
    }
}

function Invoke-SubResourceRequest {
    <#
    .SYNOPSIS
        Single choke point for all control-plane sub-resource ARM calls
        (subagents, incidentFilters) via `az rest`, so tests can mock
        exactly one function.
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
        [string]$ApiVersion,

        [Parameter(Mandatory = $true)]
        [ValidateSet('GET', 'PUT', 'DELETE')]
        [string]$Method,

        [Parameter(Mandatory = $true)]
        [ValidateSet('subagents', 'incidentFilters')]
        [string]$SubResourceType,

        [Parameter()]
        [string]$Name,

        [Parameter()]
        [string]$BodyJson
    )

    $path = "/subscriptions/${SubscriptionId}/resourceGroups/${ResourceGroupName}/providers/Microsoft.App/agents/${AgentName}/${SubResourceType}"
    if ($Name) {
        $path = "$path/$Name"
    }
    $url = "https://management.azure.com${path}?api-version=${ApiVersion}"

    $azArgs = @('rest', '--method', $Method, '--url', $url, '--output', 'json')
    $tempBodyFile = $null
    if ($BodyJson) {
        # Write the body to a temp file and use @file syntax rather than
        # passing JSON inline, which is fragile across shells/quoting.
        $tempBodyFile = Join-Path ([System.IO.Path]::GetTempPath()) "sre-agent-subresource-body-$([guid]::NewGuid()).json"
        Set-Content -Path $tempBodyFile -Value $BodyJson -NoNewline
        $azArgs += @('--body', "@$tempBodyFile")
        $azArgs += @('--headers', 'Content-Type=application/json')
    }

    try {
        $raw = & az @azArgs 2>$null
        $exitCode = $LASTEXITCODE
    }
    finally {
        if ($tempBodyFile) {
            Remove-Item -Path $tempBodyFile -Force -ErrorAction SilentlyContinue
        }
    }

    # `az rest` exits non-zero on any non-2xx response. We still need to
    # distinguish 404 (not found — often expected, e.g. idempotent
    # delete/first-run GET) from a genuine transport/auth failure, so shell
    # out again for just the status code rather than trying to parse it out
    # of stderr text.
    if ($exitCode -ne 0) {
        $statusCode = Get-LastAzRestStatusCode -Method $Method -Url $url -BodyFile $tempBodyFile
        return [pscustomobject]@{
            StatusCode = $statusCode
            Success    = $false
            Content    = $null
            RawContent = $raw
        }
    }

    $content = $null
    if ($raw) {
        try { $content = $raw | ConvertFrom-Json } catch { $content = $null }
    }

    return [pscustomobject]@{
        StatusCode = 200
        Success    = $true
        Content    = $content
        RawContent = $raw
    }
}

function Get-LastAzRestStatusCode {
    <#
    .SYNOPSIS
        Re-issues the same `az rest` call with --skip-authorization-header-check-like
        semantics not being available in `az rest`; instead uses `--only-show-errors`
        off and inspects stderr for "Status: <code>", which `az rest` reliably
        emits on a non-2xx response. Isolated in its own function so tests
        can mock the outcome without shelling out.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Method,

        [Parameter(Mandatory = $true)]
        [string]$Url,

        [Parameter()]
        [string]$BodyFile
    )

    $azArgs = @('rest', '--method', $Method, '--url', $Url)
    if ($BodyFile -and (Test-Path -Path $BodyFile)) {
        $azArgs += @('--body', "@$BodyFile")
    }
    $errText = & az @azArgs 2>&1 | Out-String

    if ($errText -match 'Status:\s*(\d{3})' -or $errText -match '\((\d{3})\)' -or $errText -match 'HTTP/[\d.]+\s+(\d{3})') {
        return [int]$Matches[1]
    }

    # Could not determine the exact status — treat as an unclassified
    # failure (not a confirmed 404), so callers never mistake this for
    # "unsupported API".
    return 0
}

function Test-ResponsePlanApiSupported {
    <#
    .SYNOPSIS
        Explicit capability detection for both sub-resource types. Returns
        $false only on a confirmed 404/405 ("this API does not exist here")
        for EITHER type. Any other non-success response is treated as a
        transient failure and thrown, so a genuine outage or auth problem is
        never misreported as "unsupported".
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

    foreach ($subResourceType in @('subagents', 'incidentFilters')) {
        $result = Invoke-SubResourceRequest -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName -AgentName $AgentName -ApiVersion $ApiVersion -Method GET -SubResourceType $subResourceType

        if ($result.StatusCode -eq 404 -or $result.StatusCode -eq 405) {
            return $false
        }

        if (-not $result.Success) {
            throw "Capability probe for '$subResourceType' returned HTTP $($result.StatusCode), which is not a confirmed 'unsupported API' response (404/405). Treating this as a transient failure rather than silently degrading: $($result.RawContent)"
        }
    }

    return $true
}

function ConvertTo-CanonicalJson {
    <#
    .SYNOPSIS
        Serializes a hashtable/pscustomobject to JSON with sorted keys and
        no extraneous whitespace, so content hashing and round-trip
        equality checks are stable regardless of property declaration
        order.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        $InputObject
    )

    function Sort-ObjectKeysRecursively($obj) {
        if ($null -eq $obj) { return $null }
        if ($obj -is [System.Collections.IDictionary]) {
            $sorted = [ordered]@{}
            foreach ($key in ($obj.Keys | Sort-Object)) {
                $sorted[$key] = Sort-ObjectKeysRecursively $obj[$key]
            }
            return $sorted
        }
        # NOTE: deliberately NOT `$obj -is [pscustomobject]` — that type
        # literal resolves to System.Management.Automation.PSObject, and
        # PowerShell's pipeline wraps EVERY value (including plain strings)
        # in a PSObject envelope in some contexts (e.g. `$arr | ForEach-Object
        # { ... $_ ... }`), making that check true even for a bare string
        # flowing through a pipeline. Checking the concrete runtime type name
        # is the only reliable way to detect an actual custom object here.
        if ($obj.GetType().FullName -eq 'System.Management.Automation.PSCustomObject') {
            $sorted = [ordered]@{}
            foreach ($prop in ($obj.PSObject.Properties.Name | Sort-Object)) {
                $sorted[$prop] = Sort-ObjectKeysRecursively $obj.$prop
            }
            return $sorted
        }
        if ($obj -is [System.Collections.IEnumerable] -and -not ($obj -is [string])) {
            # The leading unary comma prevents PowerShell's function-return
            # pipeline from unwrapping a single-element array back down to
            # a scalar (a well-known PowerShell gotcha) — without it,
            # `tools: @('azure_cli')` round-trips through this function as
            # the bare string `azure_cli` instead of a one-element array.
            return , @($obj | ForEach-Object { Sort-ObjectKeysRecursively $_ })
        }
        return $obj
    }

    $sorted = Sort-ObjectKeysRecursively $InputObject
    return ($sorted | ConvertTo-Json -Depth 50 -Compress)
}

function Get-ContentHash {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Content
    )

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Content)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $sha256.ComputeHash($bytes)
        return ([System.BitConverter]::ToString($hashBytes) -replace '-', '').ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
}

function Get-RenderedCustomAgentInstructions {
    <#
    .SYNOPSIS
        Reads the versioned custom-agent instructions template and
        substitutes {{...}} placeholders with the actual deployed
        subscription/resource-group/AKS-cluster/alert values, so the
        agent's own instructions enforce the exact scope this response plan
        is bound to (defense in depth alongside RBAC scope).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstructionsFilePath,

        [Parameter(Mandatory = $true)]
        [string]$SubscriptionId,

        [Parameter(Mandatory = $true)]
        [string]$ResourceGroupName,

        [Parameter(Mandatory = $true)]
        [string]$AksClusterName,

        [Parameter(Mandatory = $true)]
        [string]$AlertTitle,

        [Parameter(Mandatory = $true)]
        [int]$AlertSeverity
    )

    if (-not (Test-Path -Path $InstructionsFilePath)) {
        throw "Custom-agent instructions template not found: $InstructionsFilePath"
    }

    $template = Get-Content -Path $InstructionsFilePath -Raw
    $rendered = $template `
        -replace '\{\{SUBSCRIPTION_ID\}\}', [regex]::Escape($SubscriptionId).Replace('\', '') `
        -replace '\{\{RESOURCE_GROUP\}\}', [regex]::Escape($ResourceGroupName).Replace('\', '') `
        -replace '\{\{AKS_CLUSTER_NAME\}\}', [regex]::Escape($AksClusterName).Replace('\', '') `
        -replace '\{\{ALERT_TITLE\}\}', [regex]::Escape($AlertTitle).Replace('\', '') `
        -replace '\{\{ALERT_SEVERITY\}\}', [string]$AlertSeverity

    if ($rendered -match '\{\{[A-Z_]+\}\}') {
        throw "Custom-agent instructions template still contains an unrendered placeholder: $($Matches[0]). Update Get-RenderedCustomAgentInstructions to substitute it."
    }

    return $rendered
}

function New-CustomAgentSpec {
    <#
    .SYNOPSIS
        Builds the best-effort custom-agent spec object (see the module
        docstring for why this is explicitly "best-effort" and how
        correctness is verified). Field names follow the documented
        Custom-agent YAML example (system_prompt, handoff_description,
        tools, enable_skills) in https://learn.microsoft.com/azure/sre-agent/sub-agents.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$RenderedInstructions
    )

    $contentHash = Get-ContentHash -Content $RenderedInstructions

    return [ordered]@{
        name                = $Name
        system_prompt       = $RenderedInstructions
        handoff_description = 'Handles the AmeriGas MongoDB-down demo scenario (issue #19): confirms the mongodb Deployment in namespace propane is scaled to 0, proposes scaling it back to 1 replica via az aks command invoke, executes only after approval, and verifies recovery.'
        tools               = @('azure_cli')
        enable_skills       = $false
        metadata            = [ordered]@{
            contentHash = $contentHash
        }
    }
}

function New-IncidentFilterSpec {
    <#
    .SYNOPSIS
        Builds the best-effort incident-filter (response plan) spec object.
        Field names follow the documented portal UI fields in
        https://learn.microsoft.com/azure/sre-agent/incident-response-plans
        (severity, titleContains, response custom agent, autonomy level,
        Azure-Monitor-only reinvestigation cooldown).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$CustomAgentName,

        [Parameter(Mandatory = $true)]
        [string]$AlertTitle,

        [Parameter(Mandatory = $true)]
        [int]$AlertSeverity
    )

    $spec = [ordered]@{
        name             = $Name
        incidentPlatform = 'AzMonitor'
        severity         = @($AlertSeverity)
        titleContains    = $AlertTitle
        customAgent      = $CustomAgentName
        # Never Autonomous — issue #19 requires explicit Review autonomy at
        # the response-plan level even though the platform defaults new
        # plans to Autonomous.
        autonomyLevel    = 'Review'
        cooldown         = [ordered]@{
            enabled = $true
            hours   = 3
        }
    }

    $contentHash = Get-ContentHash -Content (ConvertTo-CanonicalJson -InputObject $spec)
    $spec['metadata'] = [ordered]@{ contentHash = $contentHash }
    return $spec
}

function ConvertTo-SubResourceEnvelope {
    <#
    .SYNOPSIS
        Wraps a spec object in the base64-encoded envelope documented for
        "other sub-resources" (skills, subagents, tools, ...) in the API
        reference: {"properties":{"value":"<base64 JSON>"}}.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        $Spec
    )

    $json = ConvertTo-CanonicalJson -InputObject $Spec
    $base64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
    $envelope = [ordered]@{
        properties = [ordered]@{
            value = $base64
        }
    }
    return ($envelope | ConvertTo-Json -Depth 10 -Compress)
}

function ConvertFrom-SubResourceEnvelope {
    <#
    .SYNOPSIS
        Decodes a previously-PUT sub-resource's base64 envelope back into
        its spec object, for round-trip verification and drift detection.
        Returns $null if the resource has no decodable envelope (rather
        than throwing), so callers can treat "exists but unreadable" as
        "needs to be overwritten" instead of crashing.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        $Resource
    )

    $value = $null
    if ($Resource.properties -and $Resource.properties.value) {
        $value = $Resource.properties.value
    }
    elseif ($Resource.properties -and $Resource.properties.PSObject.Properties.Name -contains 'value') {
        $value = $Resource.properties.value
    }

    if (-not $value) {
        return $null
    }

    try {
        $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
        return $json | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Test-SpecRoundTrip {
    <#
    .SYNOPSIS
        Verifies a just-written sub-resource's decoded spec matches what
        was intended, keyed on the canonical JSON of both sides. This is
        the check that turns a "the server returned 2xx" assumption into a
        verified fact — see the module docstring.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        $ExpectedSpec,

        [Parameter()]
        $ActualDecodedSpec
    )

    if ($null -eq $ActualDecodedSpec) {
        return $false
    }

    $expectedJson = ConvertTo-CanonicalJson -InputObject $ExpectedSpec
    $actualJson = ConvertTo-CanonicalJson -InputObject $ActualDecodedSpec
    return $expectedJson -eq $actualJson
}

function Get-ContentHashFromDecodedSpec {
    [CmdletBinding()]
    param(
        [Parameter()]
        $DecodedSpec
    )

    if ($null -eq $DecodedSpec) { return $null }
    if ($DecodedSpec.PSObject.Properties.Name -contains 'metadata' -and $DecodedSpec.metadata.PSObject.Properties.Name -contains 'contentHash') {
        return [string]$DecodedSpec.metadata.contentHash
    }
    return $null
}

function Set-SubResourceIdempotent {
    <#
    .SYNOPSIS
        Content-hash-keyed create-or-update for one sub-resource: skips the
        PUT entirely if an existing resource's decoded contentHash already
        matches, otherwise PUTs and verifies the round trip before
        reporting success. Never reports success without that
        verification.
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
        [string]$ApiVersion,

        [Parameter(Mandatory = $true)]
        [ValidateSet('subagents', 'incidentFilters')]
        [string]$SubResourceType,

        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        $Spec
    )

    $existing = Invoke-SubResourceRequest -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName -AgentName $AgentName -ApiVersion $ApiVersion -Method GET -SubResourceType $SubResourceType -Name $Name

    if ($existing.Success) {
        $existingDecoded = ConvertFrom-SubResourceEnvelope -Resource $existing.Content
        $existingHash = Get-ContentHashFromDecodedSpec -DecodedSpec $existingDecoded
        $expectedHash = $Spec.metadata.contentHash

        if ($existingHash -and $existingHash -eq $expectedHash -and (Test-SpecRoundTrip -ExpectedSpec $Spec -ActualDecodedSpec $existingDecoded)) {
            return [pscustomobject]@{
                Success = $true
                Reason  = 'Unchanged'
                Name    = $Name
            }
        }
    }
    elseif ($existing.StatusCode -ne 404) {
        throw "Failed to read existing '$SubResourceType/$Name' before writing: HTTP $($existing.StatusCode). $($existing.RawContent)"
    }

    $body = ConvertTo-SubResourceEnvelope -Spec $Spec
    $putResult = Invoke-SubResourceRequest -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName -AgentName $AgentName -ApiVersion $ApiVersion -Method PUT -SubResourceType $SubResourceType -Name $Name -BodyJson $body

    if (-not $putResult.Success) {
        throw "Failed to write '$SubResourceType/$Name': HTTP $($putResult.StatusCode). This may indicate the undocumented Preview schema this script targets is no longer accepted — see the script's SchemaMismatch handling. Response: $($putResult.RawContent)"
    }

    $verifyResult = Invoke-SubResourceRequest -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName -AgentName $AgentName -ApiVersion $ApiVersion -Method GET -SubResourceType $SubResourceType -Name $Name
    if (-not $verifyResult.Success) {
        throw "'$SubResourceType/$Name' was written (HTTP 2xx) but could not be read back for verification: HTTP $($verifyResult.StatusCode). Not reporting success without round-trip verification."
    }

    $verifyDecoded = ConvertFrom-SubResourceEnvelope -Resource $verifyResult.Content
    if (-not (Test-SpecRoundTrip -ExpectedSpec $Spec -ActualDecodedSpec $verifyDecoded)) {
        return [pscustomobject]@{
            Success  = $false
            Reason   = 'SchemaMismatch'
            Name     = $Name
            Expected = (ConvertTo-CanonicalJson -InputObject $Spec)
            Actual   = if ($verifyDecoded) { (ConvertTo-CanonicalJson -InputObject $verifyDecoded) } else { '<undecodable>' }
        }
    }

    return [pscustomobject]@{
        Success = $true
        Reason  = 'Written'
        Name    = $Name
    }
}

function Find-ConflictingQuickstartResponsePlans {
    <#
    .SYNOPSIS
        Lists all incidentFilters sub-resources and returns any whose ARM
        resource name or decoded spec name contains "quickstart"
        (case-insensitive) and is NOT this response plan — the default
        plan Azure auto-creates when an incident platform is first
        connected (see https://learn.microsoft.com/azure/sre-agent/response-plan).
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
        [string]$ApiVersion,

        [Parameter(Mandatory = $true)]
        [string]$OwnResponsePlanName
    )

    $listResult = Invoke-SubResourceRequest -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName -AgentName $AgentName -ApiVersion $ApiVersion -Method GET -SubResourceType 'incidentFilters'
    if (-not $listResult.Success) {
        throw "Failed to list incidentFilters to check for a conflicting quickstart plan: HTTP $($listResult.StatusCode). $($listResult.RawContent)"
    }

    $items = @()
    if ($listResult.Content) {
        if ($listResult.Content.PSObject.Properties.Name -contains 'value') {
            $items = @($listResult.Content.value)
        }
        elseif ($listResult.Content -is [System.Collections.IEnumerable] -and -not ($listResult.Content -is [string])) {
            $items = @($listResult.Content)
        }
    }

    $conflicts = New-Object System.Collections.Generic.List[string]
    foreach ($item in $items) {
        $armName = [string]$item.name
        if ([string]::IsNullOrWhiteSpace($armName)) { continue }
        if ($armName -eq $OwnResponsePlanName) { continue }

        $isQuickstart = $armName -match '(?i)quickstart'
        if (-not $isQuickstart) {
            $decoded = ConvertFrom-SubResourceEnvelope -Resource $item
            if ($decoded -and $decoded.PSObject.Properties.Name -contains 'name' -and [string]$decoded.name -match '(?i)quickstart') {
                $isQuickstart = $true
            }
        }

        if ($isQuickstart) {
            $conflicts.Add($armName)
        }
    }

    return @($conflicts)
}

function Invoke-SreAgentResponsePlanBootstrap {
    <#
    .SYNOPSIS
        Orchestrates the full idempotent response-plan bootstrap: agent
        state validation, capability detection, content-hash-keyed
        create-or-update of the custom agent and incident filter (each
        round-trip verified), and conflicting-quickstart-plan detection.
        Never throws for a confirmed "unsupported API" or "schema
        mismatch" condition — those are reported as structured,
        unsuccessful results instead so callers can distinguish them from a
        transient/retryable failure (which this function DOES throw for,
        via its callees).
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
        [string]$ApiVersion,

        [Parameter(Mandatory = $true)]
        [string]$AksClusterName,

        [Parameter(Mandatory = $true)]
        [string]$AlertTitle,

        [Parameter(Mandatory = $true)]
        [int]$AlertSeverity,

        [Parameter(Mandatory = $true)]
        [string]$InstructionsFilePath
    )

    if (-not (Test-ResponsePlanApiSupported -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName -AgentName $AgentName -ApiVersion $ApiVersion)) {
        return [pscustomobject]@{
            Success = $false
            Reason  = 'UnsupportedApi'
            Message = "Microsoft.App/agents/subagents and/or /incidentFilters responded 404/405 on this agent (api-version=$ApiVersion). This Preview capability is not available here — failing readiness explicitly instead of claiming the response plan is active or falling back to a manual/webhook-only setup."
        }
    }

    $renderedInstructions = Get-RenderedCustomAgentInstructions -InstructionsFilePath $InstructionsFilePath -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName -AksClusterName $AksClusterName -AlertTitle $AlertTitle -AlertSeverity $AlertSeverity

    $customAgentSpec = New-CustomAgentSpec -Name $script:CustomAgentName -RenderedInstructions $renderedInstructions
    $customAgentResult = Set-SubResourceIdempotent -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName -AgentName $AgentName -ApiVersion $ApiVersion -SubResourceType 'subagents' -Name $script:CustomAgentName -Spec $customAgentSpec

    if (-not $customAgentResult.Success) {
        return [pscustomobject]@{
            Success  = $false
            Reason   = $customAgentResult.Reason
            Message  = "Custom agent '$($script:CustomAgentName)' was written but did not round-trip correctly — the server may have silently ignored or reinterpreted fields in this undocumented Preview schema. Expected: $($customAgentResult.Expected) Actual: $($customAgentResult.Actual)"
        }
    }

    $incidentFilterSpec = New-IncidentFilterSpec -Name $script:ResponsePlanName -CustomAgentName $script:CustomAgentName -AlertTitle $AlertTitle -AlertSeverity $AlertSeverity
    $incidentFilterResult = Set-SubResourceIdempotent -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName -AgentName $AgentName -ApiVersion $ApiVersion -SubResourceType 'incidentFilters' -Name $script:ResponsePlanName -Spec $incidentFilterSpec

    if (-not $incidentFilterResult.Success) {
        return [pscustomobject]@{
            Success = $false
            Reason  = $incidentFilterResult.Reason
            Message = "Incident response plan '$($script:ResponsePlanName)' was written but did not round-trip correctly. Expected: $($incidentFilterResult.Expected) Actual: $($incidentFilterResult.Actual)"
        }
    }

    $conflicts = Find-ConflictingQuickstartResponsePlans -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName -AgentName $AgentName -ApiVersion $ApiVersion -OwnResponsePlanName $script:ResponsePlanName

    $removedConflicts = New-Object System.Collections.Generic.List[string]
    $unremovableConflicts = New-Object System.Collections.Generic.List[string]
    foreach ($conflict in $conflicts) {
        $deleteResult = Invoke-SubResourceRequest -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName -AgentName $AgentName -ApiVersion $ApiVersion -Method DELETE -SubResourceType 'incidentFilters' -Name $conflict
        if ($deleteResult.Success -or $deleteResult.StatusCode -eq 404) {
            $removedConflicts.Add($conflict)
        }
        else {
            $unremovableConflicts.Add($conflict)
        }
    }

    if ($unremovableConflicts.Count -gt 0) {
        # Per issue #19: fail validation rather than risk duplicate
        # incident routing when a conflicting quickstart plan cannot be
        # removed through the API.
        return [pscustomobject]@{
            Success              = $false
            Reason               = 'ConflictingQuickstartPlanNotRemovable'
            Message              = "Found conflicting quickstart response plan(s) that could not be removed via the API: $($unremovableConflicts -join ', '). Refusing to consider this response plan bootstrap successful, because leaving them in place risks duplicate/incorrect incident routing. Remove them manually (Builder > Incident response plans > Table view) and rerun."
            RemovedQuickstartPlans = @($removedConflicts)
        }
    }

    return [pscustomobject]@{
        Success                = $true
        Reason                 = if ($customAgentResult.Reason -eq 'Unchanged' -and $incidentFilterResult.Reason -eq 'Unchanged') { 'Unchanged' } else { 'Bootstrapped' }
        Message                = "Custom agent '$($script:CustomAgentName)' and response plan '$($script:ResponsePlanName)' are configured (Review autonomy, severity=$AlertSeverity, title='$AlertTitle')."
        CustomAgentName        = $script:CustomAgentName
        ResponsePlanName        = $script:ResponsePlanName
        RemovedQuickstartPlans = @($removedConflicts)
    }
}

function Invoke-SreAgentResponsePlanTeardown {
    <#
    .SYNOPSIS
        Idempotently removes the incident filter and custom agent (in that
        order — filter first so nothing routes to a partially-removed
        agent mid-teardown). Never touches the alert rule or the SRE Agent
        resource itself. A 404 on either delete is treated as success.
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

    $filterResult = Invoke-SubResourceRequest -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName -AgentName $AgentName -ApiVersion $ApiVersion -Method DELETE -SubResourceType 'incidentFilters' -Name $script:ResponsePlanName
    if (-not $filterResult.Success -and $filterResult.StatusCode -ne 404) {
        throw "Failed to remove response plan '$($script:ResponsePlanName)': HTTP $($filterResult.StatusCode). $($filterResult.RawContent)"
    }

    $agentResult = Invoke-SubResourceRequest -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName -AgentName $AgentName -ApiVersion $ApiVersion -Method DELETE -SubResourceType 'subagents' -Name $script:CustomAgentName
    if (-not $agentResult.Success -and $agentResult.StatusCode -ne 404) {
        throw "Failed to remove custom agent '$($script:CustomAgentName)': HTTP $($agentResult.StatusCode). $($agentResult.RawContent)"
    }

    return [pscustomobject]@{
        Success  = $true
        Message  = "Removed response plan '$($script:ResponsePlanName)' and custom agent '$($script:CustomAgentName)' (idempotent — already-absent resources are treated as success)."
    }
}

# =============================================================================
# ENTRY POINT — only runs when the file is executed directly, not dot-sourced
# for its functions by Pester tests.
# =============================================================================
if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'

    try {
        $action = if ($Teardown) { 'Tearing down' } else { 'Bootstrapping' }
        Write-Host "`n🧭 $action SRE Agent response plan for '$AgentName' in '$ResourceGroupName'..." -ForegroundColor Cyan

        $subscriptionId = Assert-ResponsePlanSubscriptionMatch -ResourceGroupName $ResourceGroupName
        Write-Host "  ✅ Subscription context verified: $subscriptionId" -ForegroundColor Green

        $agent = Get-ResponsePlanAgentResource -SubscriptionId $subscriptionId -ResourceGroupName $ResourceGroupName -AgentName $AgentName -ApiVersion $ApiVersion

        if (-not $Teardown) {
            Assert-AgentReadyForResponsePlan -Agent $agent -AgentName $AgentName
            Write-Host "  ✅ Agent is Succeeded, Review mode, AzMonitor-connected" -ForegroundColor Green
        }

        if ($Teardown) {
            $result = Invoke-SreAgentResponsePlanTeardown -SubscriptionId $subscriptionId -ResourceGroupName $ResourceGroupName -AgentName $AgentName -ApiVersion $ApiVersion
            Write-Host "`n✅ $($result.Message)" -ForegroundColor Green
            exit 0
        }

        $result = Invoke-SreAgentResponsePlanBootstrap `
            -SubscriptionId $subscriptionId `
            -ResourceGroupName $ResourceGroupName `
            -AgentName $AgentName `
            -ApiVersion $ApiVersion `
            -AksClusterName $AksClusterName `
            -AlertTitle $AlertTitle `
            -AlertSeverity $AlertSeverity `
            -InstructionsFilePath $InstructionsFilePath

        if (-not $result.Success) {
            Write-Host "`n❌ $($result.Message)" -ForegroundColor Red
            exit 1
        }

        Write-Host "`n✅ $($result.Message)" -ForegroundColor Green
        if ($result.RemovedQuickstartPlans -and $result.RemovedQuickstartPlans.Count -gt 0) {
            Write-Host "  🧹 Removed conflicting quickstart plan(s): $($result.RemovedQuickstartPlans -join ', ')" -ForegroundColor Yellow
        }
        exit 0
    }
    catch {
        Write-Host "`n❌ SRE Agent response plan $(if ($Teardown) { 'teardown' } else { 'bootstrap' }) failed: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}
