<#
.SYNOPSIS
    Idempotently bootstraps (or tears down) the native Azure SRE Agent
    alert-to-approved-remediation response plan for the MongoDB-down demo
    scenario (issue #19): a custom agent plus an incident response plan
    (data-plane resources), bound to the dedicated demo alert deployed by
    infra/bicep/modules/alerts.bicep.

.DESCRIPTION
    This is a genuine native Azure SRE Agent response plan — NOT Mission
    Control Copilot, NOT a generic webhook. It configures three data-plane
    resources on the agent's own endpoint (audience https://azuresre.dev,
    NOT the ARM control plane):

      1. A custom agent ("mongodb-down-responder") via the officially
         documented `PUT /api/v2/extendedAgent/agents/{name}` endpoint
         (https://learn.microsoft.com/azure/sre-agent/api-reference,
         "Extended agent configuration"). Its instructions are rendered
         from docs/sre-agent-response-plans/mongodb-down-custom-agent-instructions.md
         with the actual deployed subscription/resource group/AKS cluster
         name substituted in.
      2. An incident filter ("mongodb-down-response-plan") via
         `PUT /api/v1/incidentplayground/filters/{id}` — filters incidents
         by severity + title, in Review autonomy, bound to the custom
         agent above.
      3. An incident handler via `PUT /api/v1/incidentplayground/handlers/{id}`
         — binds the filter to the custom agent's handling.

    ROUND 2 FIX (issue #19 review): the first implementation of this script
    wrote these resources through ARM control-plane sub-resources
    (Microsoft.App/agents/subagents, .../incidentFilters) and verified
    success by reading the same opaque base64 envelope back and comparing
    bytes. That proves the envelope round-trips, but proves NOTHING about
    whether the platform's incident-routing engine actually interprets the
    filter/handler semantically — a byte-identical opaque blob could still
    be silently ignored by the runtime that does the actual alert-to-agent
    routing. This version writes and reads through the DATA-PLANE endpoints
    instead (the same plane the runtime itself uses to route incidents),
    and after every write performs a SEMANTIC verification: it re-lists the
    resource via `GET /api/v2/incidentManagement/incidentFilters` and
    `GET /api/v2/extendedAgent/incidentHandlers`, decodes the INTERPRETED
    JSON fields (severity/priorities, titleContains, agentMode, the
    handlingAgent/custom-agent binding, mergeEnabled/mergeWindowHours), and
    compares those interpreted values against what was intended — never a
    raw byte/envelope comparison.

    CAPABILITY DETECTION AND HONESTY ABOUT AN UNPUBLISHED SCHEMA: the
    `/api/v1/incidentplayground/*` write paths and their
    `/api/v2/incidentManagement/incidentFilters` /
    `/api/v2/extendedAgent/incidentHandlers` semantic list counterparts are
    NOT published in https://learn.microsoft.com/azure/sre-agent/api-reference
    beyond the general sub-resource/base64-envelope convention — only the
    custom-agent endpoint (`/api/v2/extendedAgent/agents/{name}`) is
    officially documented. This script treats the filter/handler endpoints
    as capability-sensitive, unpublished Preview surface:
      - It probes the two LIST endpoints first (a safe, non-mutating GET).
        A confirmed 404/405 on either is reported as an explicit
        'UnsupportedApi' result — no write is ever attempted, and this
        script never falls back to a webhook-only or manual setup, and
        never claims the response plan is configured.
      - Any other non-2xx probe response is treated as a transient/unknown
        failure and thrown (never silently reported as unsupported).
      - After writing, if the interpreted fields it reads back do not match
        what was written, the result is 'SchemaMismatch' with the expected
        vs. actual JSON — never reported as success.
    Because the exact schema is unpublished, this script's request bodies
    are a best-effort mapping; the semantic verification step is what turns
    "the server returned 2xx" into an actually-trustworthy "configured"
    claim.

.PARAMETER ResourceGroupName
    Resource group containing the deployed SRE Agent, AKS cluster, and
    demo alert.

.PARAMETER AgentName
    Name of the Microsoft.App/agents resource.

.PARAMETER AksClusterName
    Name of the AKS cluster the rendered custom-agent instructions scope
    the remediation to.

.PARAMETER ApiVersion
    Control-plane API version used only to read the agent's ARM state
    (provisioningState, agentEndpoint). Must match one of the versions
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
    Remove the incident handler, incident filter, and custom agent instead
    of creating them (in that order — handler first, so nothing routes to
    a partially-removed filter/agent mid-teardown). Idempotent — a 404 on
    delete is treated as success. Never touches the alert rule or the SRE
    Agent resource itself.

.EXAMPLE
    ./bootstrap-sre-agent-response-plan.ps1 -ResourceGroupName rg-srelab-eastus2 -AgentName sre-srelab -AksClusterName aks-srelab

.EXAMPLE
    ./bootstrap-sre-agent-response-plan.ps1 -ResourceGroupName rg-srelab-eastus2 -AgentName sre-srelab -AksClusterName aks-srelab -Teardown

.NOTES
    IMPORTANT: this script proves the response plan is configured AND
    semantically interpreted by the platform's own list/get APIs. It does
    NOT prove that a live Azure Monitor alert actually reaches this filter
    and executes end-to-end — that requires a live rehearsal (apply the
    scenario, observe the alert fire, observe the agent investigate,
    approve/deny/let-expire the proposed action). See
    docs/sre-agent-response-plans/README.md for that rehearsal procedure;
    do not claim the demo is "proven" from this script's output alone.
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
        caller's standard Azure CLI credentials — used only to obtain
        provisioningState/actionConfiguration/agentEndpoint. All actual
        response-plan resources are written through the data plane (see
        Invoke-DataPlaneRequest below), not through this ARM read.
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
        platform.
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

function Get-ResponsePlanDataPlaneAccessToken {
    <#
    .SYNOPSIS
        Acquires an in-memory-only data-plane token for audience
        https://azuresre.dev. Never persisted to disk or written to host
        output, exactly like bootstrap-sre-agent-knowledge.ps1's token
        acquisition.
    #>
    [CmdletBinding()]
    param()

    $token = & az account get-access-token --resource 'https://azuresre.dev' --query accessToken --output tsv 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
        throw "Failed to acquire a data-plane access token for audience https://azuresre.dev."
    }

    return $token
}

function ConvertTo-Utf8NoBomBytes {
    <#
    .SYNOPSIS
        Encodes a string as UTF-8 WITHOUT a byte-order-mark, for JSON
        request bodies. .NET's default UTF8Encoding emits a BOM; a raw JSON
        body must not carry one.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Text
    )

    # The leading unary comma is required here, not stylistic: without it,
    # PowerShell's function-return pipeline unrolls the Byte[] into N
    # individual System.Byte objects and the caller's assignment recollects
    # them into a generic System.Object[] (boxed bytes), NOT a genuine
    # System.Byte[]. Invoke-WebRequest's -Body parameter only recognizes an
    # actual Byte[] for raw binary transmission; given an Object[] it falls
    # back to stringifying the array (joining each boxed byte's decimal
    # value with spaces) as the request body — silently corrupting every
    # JSON payload this script sends. The comma preserves the real
    # System.Byte[] type through the return.
    return , [System.Text.UTF8Encoding]::new($false).GetBytes($Text)
}

function Invoke-DataPlaneRequest {
    <#
    .SYNOPSIS
        Single choke point for all response-plan data-plane HTTP calls, so
        tests can mock exactly one function and so no other code path ever
        needs to see, log, or persist the bearer token. Writes request
        bodies as UTF-8 without a BOM and sends Accept: application/json.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token,

        [Parameter(Mandatory = $true)]
        [ValidateSet('GET', 'PUT', 'DELETE')]
        [string]$Method,

        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter()]
        [string]$BodyJson
    )

    $uri = "$Endpoint$Path"
    $headers = @{
        Authorization = "Bearer $Token"
        Accept        = 'application/json'
    }

    try {
        if ($BodyJson) {
            $bodyBytes = ConvertTo-Utf8NoBomBytes -Text $BodyJson
            $response = Invoke-WebRequest -Uri $uri -Method $Method -Headers $headers -Body $bodyBytes -ContentType 'application/json' -SkipHttpErrorCheck
        }
        else {
            $response = Invoke-WebRequest -Uri $uri -Method $Method -Headers $headers -SkipHttpErrorCheck
        }
    }
    catch {
        # Transport-level failure (DNS, TLS, timeout) — not an HTTP status
        # from the server. Always rethrow so callers treat this as a
        # transient/retryable error, never as a confirmed "unsupported API".
        throw "Data-plane request $Method $Path failed at the transport level: $($_.Exception.Message)"
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

function ConvertTo-SeverityLabel {
    <#
    .SYNOPSIS
        Maps an Azure Monitor numeric severity (0-4) to the "SevN" label
        convention used by the incident filter's `priorities` field.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateRange(0, 4)]
        [int]$Severity
    )

    return "Sev$Severity"
}

function ConvertTo-CanonicalJson {
    <#
    .SYNOPSIS
        Serializes a hashtable/pscustomobject to JSON with sorted keys and
        no extraneous whitespace, so semantic-mismatch error messages are
        stable and readable regardless of property declaration order.
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
            # a scalar (a well-known PowerShell gotcha).
            return , @($obj | ForEach-Object { Sort-ObjectKeysRecursively $_ })
        }
        return $obj
    }

    $sorted = Sort-ObjectKeysRecursively $InputObject
    return ($sorted | ConvertTo-Json -Depth 50 -Compress)
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

    if ($rendered -match '(?m)^(?!.*Version:)\{\{[A-Z_]+\}\}') {
        throw "Custom-agent instructions template still contains an unrendered placeholder. Update Get-RenderedCustomAgentInstructions to substitute it."
    }

    return $rendered
}

function New-CustomAgentDataPlaneSpec {
    <#
    .SYNOPSIS
        Builds the custom-agent request body for the officially documented
        `PUT /api/v2/extendedAgent/agents/{name}` endpoint. Field names
        follow the documented custom-agent YAML example (system_prompt,
        handoff_description, tools, connectors, enable_skills) in
        https://learn.microsoft.com/azure/sre-agent/sub-agents, plus
        `handoffs: []`, which the official hooks troubleshooting table
        (https://learn.microsoft.com/azure/sre-agent/hooks) documents as
        required for the ExtendedAgent kind ("Handoffs cannot be null").
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$RenderedInstructions
    )

    return [ordered]@{
        name                = $Name
        system_prompt       = $RenderedInstructions
        handoff_description = 'Handles the AmeriGas MongoDB-down demo scenario (issue #19): confirms the mongodb Deployment in namespace propane is scaled to 0, proposes scaling it back to 1 replica via az aks command invoke, executes only after approval, and verifies recovery.'
        tools               = @('azure_cli')
        connectors          = @()
        handoffs            = @()
        enable_skills       = $false
    }
}

function New-IncidentFilterDataPlaneSpec {
    <#
    .SYNOPSIS
        Builds the incident-filter request body for
        `PUT /api/v1/incidentplayground/filters/{id}`. `incidentPlatform`
        is deliberately omitted — it is server-derived from the agent's
        connected incident management configuration, not something a
        filter creator specifies.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Id,

        [Parameter(Mandatory = $true)]
        [string]$CustomAgentName,

        [Parameter(Mandatory = $true)]
        [string]$AlertTitle,

        [Parameter(Mandatory = $true)]
        [int]$AlertSeverity
    )

    return [ordered]@{
        id               = $Id
        name             = $Id
        priorities       = @(ConvertTo-SeverityLabel -Severity $AlertSeverity)
        titleContains    = $AlertTitle
        titleNotContains = @()
        # Never Autonomous — issue #19 requires explicit Review autonomy at
        # the response-plan level even though the platform defaults new
        # plans to Autonomous.
        agentMode        = 'Review'
        handlingAgent    = $CustomAgentName
        mergeEnabled     = $true
        mergeWindowHours = 3
    }
}

function New-IncidentHandlerDataPlaneSpec {
    <#
    .SYNOPSIS
        Builds the incident-handler request body for
        `PUT /api/v1/incidentplayground/handlers/{id}` — binds an incident
        filter to the custom agent that handles matches.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Id,

        [Parameter(Mandatory = $true)]
        [string]$IncidentFilterId,

        [Parameter(Mandatory = $true)]
        [string]$CustomAgentName
    )

    return [ordered]@{
        id               = $Id
        incidentFilterId = $IncidentFilterId
        handlingAgent    = $CustomAgentName
        agentMode        = 'Review'
    }
}

function Get-ListItems {
    <#
    .SYNOPSIS
        Tolerantly extracts an array of items from a list-endpoint response
        body, accepting either a bare JSON array or a `{ value: [...] }` /
        `{ items: [...] }` wrapper — the exact shape is not published for
        these endpoints. Always returns an actual array, even when empty —
        every `return` uses the leading unary comma so a zero-element
        result is never unrolled away into `$null` by PowerShell's pipeline
        output semantics (a well-known gotcha: capturing a function's
        zero-item array return into a variable yields `$null`, not an
        empty array, unless the array is wrapped this way).
    #>
    [CmdletBinding()]
    param(
        [Parameter()]
        $Content
    )

    if ($null -eq $Content) {
        return , @()
    }
    if ($Content.PSObject.Properties.Name -contains 'value') {
        return , @($Content.value)
    }
    if ($Content.PSObject.Properties.Name -contains 'items') {
        return , @($Content.items)
    }
    if ($Content -is [System.Collections.IEnumerable] -and -not ($Content -is [string])) {
        return , @($Content)
    }
    return , @()
}

function Get-IncidentFiltersList {
    <#
    .SYNOPSIS
        Calls the semantic list endpoint `GET /api/v2/incidentManagement/incidentFilters`
        and returns its items. This is the capability-detection surface for
        the filter endpoint family: a confirmed 404/405 here means the
        whole filter capability is unsupported.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token
    )

    return Invoke-DataPlaneRequest -Endpoint $Endpoint -Token $Token -Method GET -Path '/api/v2/incidentManagement/incidentFilters'
}

function Get-IncidentHandlersList {
    <#
    .SYNOPSIS
        Calls the semantic list endpoint `GET /api/v2/extendedAgent/incidentHandlers`
        and returns its items. Capability-detection surface for the handler
        endpoint family.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token
    )

    return Invoke-DataPlaneRequest -Endpoint $Endpoint -Token $Token -Method GET -Path '/api/v2/extendedAgent/incidentHandlers'
}

function Test-ResponsePlanApiSupported {
    <#
    .SYNOPSIS
        Explicit capability detection for the filter/handler semantic list
        endpoints. Returns $false only on a confirmed 404/405 from EITHER
        list endpoint ("this API does not exist here"). Any other
        non-success response is treated as a transient failure and thrown,
        so a genuine outage or auth problem is never misreported as
        "unsupported". Deliberately checked BEFORE any write is attempted —
        an unsupported result here means zero PUT calls are ever made,
        including for the custom agent.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token
    )

    $filtersResult = Get-IncidentFiltersList -Endpoint $Endpoint -Token $Token
    if ($filtersResult.StatusCode -eq 404 -or $filtersResult.StatusCode -eq 405) {
        return $false
    }
    if (-not $filtersResult.Success) {
        throw "Incident filters list endpoint returned HTTP $($filtersResult.StatusCode), which is not a confirmed 'unsupported API' response (404/405). Treating this as a transient failure rather than silently degrading: $($filtersResult.RawContent)"
    }

    $handlersResult = Get-IncidentHandlersList -Endpoint $Endpoint -Token $Token
    if ($handlersResult.StatusCode -eq 404 -or $handlersResult.StatusCode -eq 405) {
        return $false
    }
    if (-not $handlersResult.Success) {
        throw "Incident handlers list endpoint returned HTTP $($handlersResult.StatusCode), which is not a confirmed 'unsupported API' response (404/405). Treating this as a transient failure rather than silently degrading: $($handlersResult.RawContent)"
    }

    return $true
}

function Test-CustomAgentSemanticMatch {
    <#
    .SYNOPSIS
        Compares the INTERPRETED fields of a decoded custom-agent response
        against the expected spec — not a byte/JSON-string comparison.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        $Expected,

        [Parameter()]
        $Actual
    )

    if ($null -eq $Actual) { return $false }
    if ([string]$Actual.system_prompt -ne [string]$Expected.system_prompt) { return $false }
    if ([string]$Actual.handoff_description -ne [string]$Expected.handoff_description) { return $false }

    $actualTools = @($Actual.tools)
    $expectedTools = @($Expected.tools)
    if ((Compare-Object -ReferenceObject $expectedTools -DifferenceObject $actualTools -SyncWindow 0 | Measure-Object).Count -ne 0) {
        return $false
    }

    return $true
}

function Test-FilterSemanticMatch {
    <#
    .SYNOPSIS
        Compares the INTERPRETED fields of a decoded incident-filter list
        entry against the expected spec (severity/priorities, titleContains,
        agentMode=Review, handlingAgent binding, mergeEnabled/mergeWindowHours).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        $Expected,

        [Parameter()]
        $Actual
    )

    if ($null -eq $Actual) { return $false }

    $actualPriorities = @($Actual.priorities)
    $expectedPriorities = @($Expected.priorities)
    if ((Compare-Object -ReferenceObject $expectedPriorities -DifferenceObject $actualPriorities -SyncWindow 0 | Measure-Object).Count -ne 0) {
        return $false
    }

    if ([string]$Actual.titleContains -ne [string]$Expected.titleContains) { return $false }
    if ([string]$Actual.agentMode -ne 'Review') { return $false }
    if ([string]$Actual.handlingAgent -ne [string]$Expected.handlingAgent) { return $false }
    if ([bool]$Actual.mergeEnabled -ne $true) { return $false }
    if ([int]$Actual.mergeWindowHours -ne [int]$Expected.mergeWindowHours) { return $false }

    return $true
}

function Test-HandlerSemanticMatch {
    <#
    .SYNOPSIS
        Compares the INTERPRETED fields of a decoded incident-handler list
        entry against the expected spec (filter binding, handling-agent
        binding, Review mode).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        $Expected,

        [Parameter()]
        $Actual
    )

    if ($null -eq $Actual) { return $false }
    if ([string]$Actual.incidentFilterId -ne [string]$Expected.incidentFilterId) { return $false }
    if ([string]$Actual.handlingAgent -ne [string]$Expected.handlingAgent) { return $false }
    if ([string]$Actual.agentMode -ne 'Review') { return $false }

    return $true
}

function Find-ItemById {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [array]$Items,

        [Parameter(Mandatory = $true)]
        [string]$Id
    )

    foreach ($item in $Items) {
        if ($null -eq $item) { continue }
        $itemId = $null
        if ($item.PSObject.Properties.Name -contains 'id') { $itemId = [string]$item.id }
        elseif ($item.PSObject.Properties.Name -contains 'name') { $itemId = [string]$item.name }
        if ($itemId -eq $Id) { return $item }
    }
    return $null
}

function Set-CustomAgentDataPlaneIdempotent {
    <#
    .SYNOPSIS
        Create-or-update for the custom agent: fetches the current state
        (tolerating 404 as "not yet created"), skips the PUT if it already
        semantically matches, otherwise PUTs and semantically re-verifies.
        A 404/405 on the PUT itself is reported as 'UnsupportedApi' (the
        officially documented endpoint route does not exist here).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token,

        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        $Spec
    )

    $path = "/api/v2/extendedAgent/agents/$Name"
    $existing = Invoke-DataPlaneRequest -Endpoint $Endpoint -Token $Token -Method GET -Path $path

    if ($existing.Success -and (Test-CustomAgentSemanticMatch -Expected $Spec -Actual $existing.Content)) {
        return [pscustomobject]@{ Success = $true; Reason = 'Unchanged' }
    }
    if (-not $existing.Success -and $existing.StatusCode -ne 404) {
        throw "Failed to read existing custom agent '$Name' before writing: HTTP $($existing.StatusCode). $($existing.RawContent)"
    }

    $bodyJson = ConvertTo-CanonicalJson -InputObject $Spec
    $putResult = Invoke-DataPlaneRequest -Endpoint $Endpoint -Token $Token -Method PUT -Path $path -BodyJson $bodyJson

    if ($putResult.StatusCode -eq 404 -or $putResult.StatusCode -eq 405) {
        return [pscustomobject]@{
            Success = $false
            Reason  = 'UnsupportedApi'
            Message = "PUT $path responded HTTP $($putResult.StatusCode) — the officially documented custom-agent data-plane endpoint is not available on this agent. Failing readiness explicitly instead of claiming the response plan is active."
        }
    }
    if (-not $putResult.Success) {
        throw "Failed to write custom agent '$Name': HTTP $($putResult.StatusCode). Response: $($putResult.RawContent)"
    }

    $verify = Invoke-DataPlaneRequest -Endpoint $Endpoint -Token $Token -Method GET -Path $path
    if (-not $verify.Success -or -not (Test-CustomAgentSemanticMatch -Expected $Spec -Actual $verify.Content)) {
        return [pscustomobject]@{
            Success  = $false
            Reason   = 'SchemaMismatch'
            Message  = "Custom agent '$Name' was written (HTTP $($putResult.StatusCode)) but the interpreted fields read back from $path do not match what was sent — the server may have silently ignored or reinterpreted fields in this schema."
            Expected = (ConvertTo-CanonicalJson -InputObject $Spec)
            Actual   = if ($verify.Content) { (ConvertTo-CanonicalJson -InputObject $verify.Content) } else { '<unreadable>' }
        }
    }

    return [pscustomobject]@{ Success = $true; Reason = 'Written' }
}

function Set-IncidentFilterDataPlaneIdempotent {
    <#
    .SYNOPSIS
        Create-or-update for the incident filter, using the semantic list
        endpoint (already proven supported by Test-ResponsePlanApiSupported)
        both to check current state and to verify the write. A 404/405 on
        the PUT itself (distinct from the list, which was already proven
        supported) is still checked defensively and reported as
        'UnsupportedApi'.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token,

        [Parameter(Mandatory = $true)]
        [string]$Id,

        [Parameter(Mandatory = $true)]
        $Spec,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [array]$CurrentFilters
    )

    $existing = Find-ItemById -Items $CurrentFilters -Id $Id
    if (Test-FilterSemanticMatch -Expected $Spec -Actual $existing) {
        return [pscustomobject]@{ Success = $true; Reason = 'Unchanged' }
    }

    $bodyJson = ConvertTo-CanonicalJson -InputObject $Spec
    $putResult = Invoke-DataPlaneRequest -Endpoint $Endpoint -Token $Token -Method PUT -Path "/api/v1/incidentplayground/filters/$Id" -BodyJson $bodyJson

    if ($putResult.StatusCode -eq 404 -or $putResult.StatusCode -eq 405) {
        return [pscustomobject]@{
            Success = $false
            Reason  = 'UnsupportedApi'
            Message = "PUT /api/v1/incidentplayground/filters/$Id responded HTTP $($putResult.StatusCode) even though the list endpoint is supported — treating the write path itself as unavailable."
        }
    }
    if (-not $putResult.Success) {
        throw "Failed to write incident filter '$Id': HTTP $($putResult.StatusCode). Response: $($putResult.RawContent)"
    }

    $verifyList = Get-IncidentFiltersList -Endpoint $Endpoint -Token $Token
    if (-not $verifyList.Success) {
        throw "Incident filter '$Id' was written (HTTP $($putResult.StatusCode)) but the list endpoint could not be re-read for verification: HTTP $($verifyList.StatusCode)."
    }
    $verifyItem = Find-ItemById -Items (Get-ListItems -Content $verifyList.Content) -Id $Id
    if (-not (Test-FilterSemanticMatch -Expected $Spec -Actual $verifyItem)) {
        return [pscustomobject]@{
            Success  = $false
            Reason   = 'SchemaMismatch'
            Message  = "Incident filter '$Id' was written but the interpreted fields read back from the list endpoint do not match what was sent."
            Expected = (ConvertTo-CanonicalJson -InputObject $Spec)
            Actual   = if ($verifyItem) { (ConvertTo-CanonicalJson -InputObject $verifyItem) } else { '<not found in list>' }
        }
    }

    return [pscustomobject]@{ Success = $true; Reason = 'Written' }
}

function Set-IncidentHandlerDataPlaneIdempotent {
    <#
    .SYNOPSIS
        Create-or-update for the incident handler, mirroring
        Set-IncidentFilterDataPlaneIdempotent.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token,

        [Parameter(Mandatory = $true)]
        [string]$Id,

        [Parameter(Mandatory = $true)]
        $Spec,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [array]$CurrentHandlers
    )

    $existing = Find-ItemById -Items $CurrentHandlers -Id $Id
    if (Test-HandlerSemanticMatch -Expected $Spec -Actual $existing) {
        return [pscustomobject]@{ Success = $true; Reason = 'Unchanged' }
    }

    $bodyJson = ConvertTo-CanonicalJson -InputObject $Spec
    $putResult = Invoke-DataPlaneRequest -Endpoint $Endpoint -Token $Token -Method PUT -Path "/api/v1/incidentplayground/handlers/$Id" -BodyJson $bodyJson

    if ($putResult.StatusCode -eq 404 -or $putResult.StatusCode -eq 405) {
        return [pscustomobject]@{
            Success = $false
            Reason  = 'UnsupportedApi'
            Message = "PUT /api/v1/incidentplayground/handlers/$Id responded HTTP $($putResult.StatusCode) even though the list endpoint is supported — treating the write path itself as unavailable."
        }
    }
    if (-not $putResult.Success) {
        throw "Failed to write incident handler '$Id': HTTP $($putResult.StatusCode). Response: $($putResult.RawContent)"
    }

    $verifyList = Get-IncidentHandlersList -Endpoint $Endpoint -Token $Token
    if (-not $verifyList.Success) {
        throw "Incident handler '$Id' was written (HTTP $($putResult.StatusCode)) but the list endpoint could not be re-read for verification: HTTP $($verifyList.StatusCode)."
    }
    $verifyItem = Find-ItemById -Items (Get-ListItems -Content $verifyList.Content) -Id $Id
    if (-not (Test-HandlerSemanticMatch -Expected $Spec -Actual $verifyItem)) {
        return [pscustomobject]@{
            Success  = $false
            Reason   = 'SchemaMismatch'
            Message  = "Incident handler '$Id' was written but the interpreted fields read back from the list endpoint do not match what was sent."
            Expected = (ConvertTo-CanonicalJson -InputObject $Spec)
            Actual   = if ($verifyItem) { (ConvertTo-CanonicalJson -InputObject $verifyItem) } else { '<not found in list>' }
        }
    }

    return [pscustomobject]@{ Success = $true; Reason = 'Written' }
}

function Find-ConflictingQuickstartFilters {
    <#
    .SYNOPSIS
        Given an already-fetched incident-filters list, returns any whose
        id/name contains "quickstart" (case-insensitive) and is NOT this
        response plan — the default plan Azure creates automatically the
        first time an incident platform is connected (see
        https://learn.microsoft.com/azure/sre-agent/response-plan).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [array]$Filters,

        [Parameter(Mandatory = $true)]
        [string]$OwnFilterId
    )

    $conflicts = New-Object System.Collections.Generic.List[string]
    foreach ($item in $Filters) {
        if ($null -eq $item) { continue }
        $itemId = if ($item.PSObject.Properties.Name -contains 'id') { [string]$item.id } elseif ($item.PSObject.Properties.Name -contains 'name') { [string]$item.name } else { $null }
        if ([string]::IsNullOrWhiteSpace($itemId) -or $itemId -eq $OwnFilterId) { continue }
        if ($itemId -match '(?i)quickstart') {
            $conflicts.Add($itemId)
        }
    }
    return @($conflicts)
}

function Invoke-SreAgentResponsePlanBootstrap {
    <#
    .SYNOPSIS
        Orchestrates the full idempotent, semantically-verified response-plan
        bootstrap: capability detection (list endpoints), custom-agent
        create-or-update + verify, incident-filter create-or-update +
        verify, incident-handler create-or-update + verify, and conflicting
        quickstart-plan detection/removal with a post-removal absence check.
        Never throws for a confirmed "unsupported API" or "schema mismatch"
        condition — those are reported as structured, unsuccessful results
        instead so callers can distinguish them from a transient/retryable
        failure (which this function DOES throw for, via its callees).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token,

        [Parameter(Mandatory = $true)]
        [string]$AksClusterName,

        [Parameter(Mandatory = $true)]
        [string]$SubscriptionId,

        [Parameter(Mandatory = $true)]
        [string]$ResourceGroupName,

        [Parameter(Mandatory = $true)]
        [string]$AlertTitle,

        [Parameter(Mandatory = $true)]
        [int]$AlertSeverity,

        [Parameter(Mandatory = $true)]
        [string]$InstructionsFilePath
    )

    # Step 1: capability-detect the filter/handler list endpoints BEFORE any
    # write is attempted — an unsupported result here means zero PUT calls
    # are made for the custom agent either, since there would be no way to
    # ever route an incident to it.
    if (-not (Test-ResponsePlanApiSupported -Endpoint $Endpoint -Token $Token)) {
        return [pscustomobject]@{
            Success = $false
            Reason  = 'UnsupportedApi'
            Message = "The incident-filter/handler semantic list endpoints (/api/v2/incidentManagement/incidentFilters, /api/v2/extendedAgent/incidentHandlers) responded 404/405 on this agent's data-plane endpoint. This Preview capability is not available here — failing readiness explicitly instead of claiming the response plan is active or falling back to a manual/webhook-only setup."
        }
    }

    # Step 2: custom agent (officially documented endpoint).
    $renderedInstructions = Get-RenderedCustomAgentInstructions -InstructionsFilePath $InstructionsFilePath -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName -AksClusterName $AksClusterName -AlertTitle $AlertTitle -AlertSeverity $AlertSeverity
    $agentSpec = New-CustomAgentDataPlaneSpec -Name $script:CustomAgentName -RenderedInstructions $renderedInstructions
    $agentResult = Set-CustomAgentDataPlaneIdempotent -Endpoint $Endpoint -Token $Token -Name $script:CustomAgentName -Spec $agentSpec

    if (-not $agentResult.Success) {
        return [pscustomobject]@{
            Success = $false
            Reason  = $agentResult.Reason
            Message = $agentResult.Message
        }
    }

    # Step 3: incident filter (capability-sensitive, already proven
    # list-supported in step 1).
    $filtersList = Get-IncidentFiltersList -Endpoint $Endpoint -Token $Token
    $currentFilters = Get-ListItems -Content $filtersList.Content
    $filterSpec = New-IncidentFilterDataPlaneSpec -Id $script:ResponsePlanName -CustomAgentName $script:CustomAgentName -AlertTitle $AlertTitle -AlertSeverity $AlertSeverity
    $filterResult = Set-IncidentFilterDataPlaneIdempotent -Endpoint $Endpoint -Token $Token -Id $script:ResponsePlanName -Spec $filterSpec -CurrentFilters $currentFilters

    if (-not $filterResult.Success) {
        return [pscustomobject]@{
            Success = $false
            Reason  = $filterResult.Reason
            Message = $filterResult.Message
        }
    }

    # Step 4: incident handler, bound to the filter above.
    $handlersList = Get-IncidentHandlersList -Endpoint $Endpoint -Token $Token
    $currentHandlers = Get-ListItems -Content $handlersList.Content
    $handlerSpec = New-IncidentHandlerDataPlaneSpec -Id $script:ResponsePlanName -IncidentFilterId $script:ResponsePlanName -CustomAgentName $script:CustomAgentName
    $handlerResult = Set-IncidentHandlerDataPlaneIdempotent -Endpoint $Endpoint -Token $Token -Id $script:ResponsePlanName -Spec $handlerSpec -CurrentHandlers $currentHandlers

    if (-not $handlerResult.Success) {
        return [pscustomobject]@{
            Success = $false
            Reason  = $handlerResult.Reason
            Message = $handlerResult.Message
        }
    }

    # Step 5: conflicting quickstart-plan detection and removal, with a
    # post-removal absence check (never assume a DELETE worked without
    # re-verifying).
    $postWriteFiltersList = Get-IncidentFiltersList -Endpoint $Endpoint -Token $Token
    if (-not $postWriteFiltersList.Success) {
        throw "Failed to re-list incident filters to check for conflicting quickstart plans: HTTP $($postWriteFiltersList.StatusCode)."
    }
    $conflicts = Find-ConflictingQuickstartFilters -Filters (Get-ListItems -Content $postWriteFiltersList.Content) -OwnFilterId $script:ResponsePlanName

    $removedConflicts = New-Object System.Collections.Generic.List[string]
    $unremovableConflicts = New-Object System.Collections.Generic.List[string]
    foreach ($conflict in $conflicts) {
        $deleteResult = Invoke-DataPlaneRequest -Endpoint $Endpoint -Token $Token -Method DELETE -Path "/api/v1/incidentplayground/filters/$conflict"
        if ($deleteResult.Success -or $deleteResult.StatusCode -eq 404) {
            $removedConflicts.Add($conflict)
        }
        else {
            $unremovableConflicts.Add($conflict)
        }
    }

    if ($removedConflicts.Count -gt 0) {
        # Verify absence — never assume a DELETE worked without re-reading.
        $verifyAbsenceList = Get-IncidentFiltersList -Endpoint $Endpoint -Token $Token
        $stillPresentIds = @()
        if ($verifyAbsenceList.Success) {
            # Capture Get-ListItems's result into a variable FIRST, then pipe
            # the variable — piping the function call's return value
            # directly into ForEach-Object does not unroll it into
            # individual elements (the leading comma inside Get-ListItems
            # that preserves empty/single-element arrays for callers who
            # capture the return value also prevents normal pipeline
            # unrolling for callers who pipe it directly).
            $absenceCheckItems = Get-ListItems -Content $verifyAbsenceList.Content
            $stillPresentIds = @($absenceCheckItems | ForEach-Object {
                    if ($_.PSObject.Properties.Name -contains 'id') { [string]$_.id }
                    elseif ($_.PSObject.Properties.Name -contains 'name') { [string]$_.name }
                } | Where-Object { $removedConflicts -contains $_ })
        }
        if ($stillPresentIds.Count -gt 0) {
            foreach ($stillPresentId in $stillPresentIds) {
                $unremovableConflicts.Add($stillPresentId)
            }
        }
    }

    if ($unremovableConflicts.Count -gt 0) {
        # Per issue #19: fail validation rather than risk duplicate
        # incident routing when a conflicting quickstart plan cannot be
        # confirmed removed.
        return [pscustomobject]@{
            Success                 = $false
            Reason                  = 'ConflictingQuickstartPlanNotRemovable'
            Message                 = "Found conflicting quickstart response plan(s) that could not be removed and verified absent: $(($unremovableConflicts | Select-Object -Unique) -join ', '). Refusing to consider this response plan bootstrap successful, because leaving them in place risks duplicate/incorrect incident routing. Remove them manually (Builder > Incident response plans > Table view) and rerun."
            RemovedQuickstartPlans  = @($removedConflicts)
        }
    }

    $allUnchanged = ($agentResult.Reason -eq 'Unchanged') -and ($filterResult.Reason -eq 'Unchanged') -and ($handlerResult.Reason -eq 'Unchanged')

    return [pscustomobject]@{
        Success                = $true
        Reason                 = if ($allUnchanged) { 'Unchanged' } else { 'Bootstrapped' }
        Message                = "Custom agent '$($script:CustomAgentName)', incident filter, and incident handler '$($script:ResponsePlanName)' are configured AND semantically verified (Review autonomy, severity=$AlertSeverity, title='$AlertTitle') via the data-plane list endpoints — not inferred from an opaque write acknowledgement. NOTE: this does not prove a live end-to-end alert rehearsal has occurred; see docs/sre-agent-response-plans/README.md for the required approve/deny/expiry rehearsal before calling the demo proven."
        CustomAgentName        = $script:CustomAgentName
        ResponsePlanName        = $script:ResponsePlanName
        RemovedQuickstartPlans = @($removedConflicts)
    }
}

function Invoke-SreAgentResponsePlanTeardown {
    <#
    .SYNOPSIS
        Idempotently removes the incident handler, incident filter, and
        custom agent (in that order — handler first, so nothing routes to
        a partially-removed filter/agent mid-teardown) through the
        data-plane endpoints. Never touches the alert rule or the SRE Agent
        resource itself. A 404 on any delete is treated as success.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token
    )

    $handlerResult = Invoke-DataPlaneRequest -Endpoint $Endpoint -Token $Token -Method DELETE -Path "/api/v1/incidentplayground/handlers/$($script:ResponsePlanName)"
    if (-not $handlerResult.Success -and $handlerResult.StatusCode -ne 404) {
        throw "Failed to remove incident handler '$($script:ResponsePlanName)': HTTP $($handlerResult.StatusCode). $($handlerResult.RawContent)"
    }

    $filterResult = Invoke-DataPlaneRequest -Endpoint $Endpoint -Token $Token -Method DELETE -Path "/api/v1/incidentplayground/filters/$($script:ResponsePlanName)"
    if (-not $filterResult.Success -and $filterResult.StatusCode -ne 404) {
        throw "Failed to remove incident filter '$($script:ResponsePlanName)': HTTP $($filterResult.StatusCode). $($filterResult.RawContent)"
    }

    $agentResult = Invoke-DataPlaneRequest -Endpoint $Endpoint -Token $Token -Method DELETE -Path "/api/v2/extendedAgent/agents/$($script:CustomAgentName)"
    if (-not $agentResult.Success -and $agentResult.StatusCode -ne 404) {
        throw "Failed to remove custom agent '$($script:CustomAgentName)': HTTP $($agentResult.StatusCode). $($agentResult.RawContent)"
    }

    return [pscustomobject]@{
        Success = $true
        Message = "Removed incident handler, incident filter, and custom agent '$($script:CustomAgentName)' / '$($script:ResponsePlanName)' (idempotent — already-absent resources are treated as success)."
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

        if ([string]::IsNullOrWhiteSpace($agent.properties.agentEndpoint)) {
            throw "SRE Agent '$AgentName' has no data-plane agentEndpoint yet."
        }

        # Acquired once, held only in this local variable, never logged.
        $dataPlaneToken = Get-ResponsePlanDataPlaneAccessToken

        if ($Teardown) {
            $result = Invoke-SreAgentResponsePlanTeardown -Endpoint $agent.properties.agentEndpoint -Token $dataPlaneToken
            Write-Host "`n✅ $($result.Message)" -ForegroundColor Green
            exit 0
        }

        $result = Invoke-SreAgentResponsePlanBootstrap `
            -Endpoint $agent.properties.agentEndpoint `
            -Token $dataPlaneToken `
            -AksClusterName $AksClusterName `
            -SubscriptionId $subscriptionId `
            -ResourceGroupName $ResourceGroupName `
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
        Write-Host "`nℹ️  This confirms the response plan is configured and semantically verified via the data-plane list APIs. It does NOT confirm a live alert rehearsal has occurred — run the approve/deny/expiry rehearsal in docs/sre-agent-response-plans/README.md before treating the demo as proven." -ForegroundColor Yellow
        exit 0
    }
    catch {
        Write-Host "`n❌ SRE Agent response plan $(if ($Teardown) { 'teardown' } else { 'bootstrap' }) failed: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}
