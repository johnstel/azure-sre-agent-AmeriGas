<#
.SYNOPSIS
    Idempotently bootstraps (creates/updates), validates, runs, inspects the
    history of, or tears down the native Azure SRE Agent scheduled task
    `daily-propane-health-report` (issue #24): a proactive, read-only,
    Autonomous-mode daily health report — NOT a cron job, NOT a GitHub
    Action, NOT Mission Control Copilot.

.DESCRIPTION
    Uses the officially documented data-plane extended-agent-configuration
    endpoint for scheduled tasks
    (https://learn.microsoft.com/azure/sre-agent/api-reference,
    "Extended agent configuration": `PUT/GET/PATCH/DELETE
    /api/v2/extendedAgent/scheduledtasks/{name}`), the same data plane
    (audience `https://azuresre.dev`) used by
    scripts/bootstrap-sre-agent-response-plan.ps1.

    CAPABILITY DETECTION FOR AN UNPUBLISHED BODY SCHEMA: the API reference
    documents the *path* and *verbs* for scheduled tasks, but not the
    request/response body schema. This script infers a best-effort schema
    from the officially documented portal workflow
    (https://learn.microsoft.com/azure/sre-agent/create-scheduled-task:
    task name, task details/instructions, frequency, time of day, time
    zone, response custom agent, message grouping, agent autonomy level,
    run limit / date range) and, like the response-plan script, NEVER
    trusts an opaque 2xx write acknowledgement — every write is followed by
    a semantic re-read that compares the platform's own INTERPRETED fields
    against what was sent. A field silently dropped or reinterpreted
    surfaces as an explicit `SchemaMismatch`, never a false "configured"
    claim.

    Because the single-item data-plane path
    (`/api/v2/extendedAgent/scheduledtasks/{name}`) 404s both when the task
    doesn't exist yet AND when the whole capability is unsupported, this
    script does NOT use that path alone for capability detection (that
    ambiguity is exactly the trap the response-plan script's design notes
    warn about). Instead it capability-detects via the ARM CONTROL-PLANE
    collection-level GET on the `scheduledTasks` sub-resource type
    (`GET .../providers/Microsoft.App/agents/{agent}/scheduledTasks
    ?api-version=...`, no item name) — standard ARM resource-provider
    convention returns HTTP 200 with an empty `value: []` array when the
    sub-resource TYPE exists but has no items, and a confirmed 404 only
    when the type itself is not enabled for this agent/api-version. This
    list path is not spelled out verbatim in the API reference (only the
    item path `/scheduledTasks/{name}` is), so — consistent with this
    repository's existing precedent for unpublished list surfaces — a
    confirmed 404/405 here is reported as an explicit 'UnsupportedApi'
    result and this script makes ZERO write calls, rather than silently
    falling back to portal-click automation or claiming a false success.

    RUN NOW IS ENTIRELY UNPUBLISHED. Microsoft's own docs mention only a
    portal button ("Test with \"Run task now\"" —
    https://learn.microsoft.com/azure/sre-agent/workflow-automation) with
    no documented REST path. `-Action RunNow` therefore probes a small,
    explicitly-labeled set of plausible data-plane execute paths
    (`POST /api/v2/extendedAgent/scheduledtasks/{name}/run` then
    `.../execute`) and reports `UnsupportedApi` — recommending the portal's
    "Run task now" button instead — if every candidate 404s/405s. It never
    fabricates a thread or a report. A successful RunNow polls the
    documented thread endpoints (`GET /api/v1/threads/{threadId}`,
    `GET /api/v1/threads/{threadId}/messages`) for up to 5 minutes.

    IDEMPOTENCE AND CHANGE DETECTION: the task's prompt (task details) is
    versioned in
    docs/sre-agent-scheduled-tasks/daily-propane-health-report-prompt.md.
    This script renders its `{{...}}` placeholders, SHA-256 hashes the
    rendered text, and embeds that hash as a `promptVersionHash` field in
    the task spec sent to the platform — so `-Action Validate` (and the
    idempotent bootstrap's own before-write comparison) can detect a
    prompt-text drift deterministically, without ever assuming the
    platform stores or echoes the instructions byte-for-byte.

.PARAMETER ResourceGroupName
    Resource group containing the deployed SRE Agent.

.PARAMETER AgentName
    Name of the Microsoft.App/agents resource.

.PARAMETER ApiVersion
    Control-plane API version used only to read the agent's ARM state and
    to probe the scheduledTasks sub-resource collection. Must match one of
    the versions infra/bicep/modules/sre-agent.bicep supports.

.PARAMETER AksClusterName
    AKS cluster name substituted into the rendered task prompt.

.PARAMETER TaskName
    Scheduled task name. Defaults to 'daily-propane-health-report'.

.PARAMETER ScheduleHourUtc
    Hour of day (0-23, UTC) the daily task runs. Defaults to 8 (08:00 UTC).

.PARAMETER ScheduleMinuteUtc
    Minute of hour (0-59, UTC) the daily task runs. Defaults to 0.

.PARAMETER TimeZone
    IANA time zone identifier recorded on the task. Defaults to 'UTC' —
    ScheduleHourUtc/ScheduleMinuteUtc are always UTC regardless of this
    value; it is metadata only, matching the portal's own "Time zone"
    field.

.PARAMETER Enabled
    Whether the task is enabled (status 'On') after this call. Defaults to
    $true. Set to $false to pause the task without deleting it.

.PARAMETER PromptFilePath
    Path to the versioned scheduled-task prompt template.

.PARAMETER Action
    'Bootstrap' (default) — idempotent create-or-update.
    'Validate' — read-only: compares the live task's interpreted fields
        (name, schedule, time zone, enabled, prompt hash, response custom
        agent, run mode/message grouping) against the versioned spec and
        reports drift without writing anything.
    'RunNow' — capability-detects and, if supported, triggers an
        out-of-schedule execution, then polls (bounded to 5 minutes) for
        the resulting thread and parses the report.
    'History' — lists prior executions (best-effort; see
        Get-ScheduledTaskExecutionHistory) and the latest parsed report.
    'Teardown' — deletes only this lab's scheduled task.

.EXAMPLE
    ./bootstrap-sre-agent-scheduled-task.ps1 -ResourceGroupName rg-srelab-eastus2 -AgentName sre-srelab -AksClusterName aks-srelab

.EXAMPLE
    ./bootstrap-sre-agent-scheduled-task.ps1 -ResourceGroupName rg-srelab-eastus2 -AgentName sre-srelab -AksClusterName aks-srelab -Action RunNow

.EXAMPLE
    ./bootstrap-sre-agent-scheduled-task.ps1 -ResourceGroupName rg-srelab-eastus2 -AgentName sre-srelab -AksClusterName aks-srelab -Action Teardown

.NOTES
    This script proves the scheduled task is configured and semantically
    verified via the platform's own data-plane read. It does NOT prove a
    live scheduled execution has produced a real report — run `-Action
    RunNow` (or wait for the daily schedule) and inspect `-Action History`
    before describing the proactive-monitoring story as demonstrated. See
    docs/sre-agent-scheduled-tasks/README.md for the full validation
    runbook (healthy / degraded / insufficient-evidence rehearsal).
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
    [string]$TaskName = 'daily-propane-health-report',

    [Parameter()]
    [ValidateRange(0, 23)]
    [int]$ScheduleHourUtc = 8,

    [Parameter()]
    [ValidateRange(0, 59)]
    [int]$ScheduleMinuteUtc = 0,

    [Parameter()]
    [string]$TimeZone = 'UTC',

    [Parameter()]
    [bool]$Enabled = $true,

    [Parameter()]
    [string]$PromptFilePath = (Join-Path $PSScriptRoot ".." "docs/sre-agent-scheduled-tasks/daily-propane-health-report-prompt.md"),

    [Parameter()]
    [ValidateSet('Bootstrap', 'Validate', 'RunNow', 'History', 'Teardown')]
    [string]$Action = 'Bootstrap'
)

$script:ScheduledTaskDataPlanePath = "/api/v2/extendedAgent/scheduledtasks/$TaskName"
$script:RunNowMaxWaitSeconds = 300
$script:RunNowPollIntervalSeconds = 10

# =============================================================================
# FUNCTIONS (dot-sourced by Pester tests; guarded execution block at bottom)
# =============================================================================

function Assert-ScheduledTaskSubscriptionMatch {
    <#
    .SYNOPSIS
        Fails fast if the target resource group is not in the Azure CLI's
        current subscription context.
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
        throw "Resource group '$ResourceGroupName' (resolved ID: $resourceGroupId) does not belong to the current subscription context ('$currentSubscriptionId'). Refusing to bootstrap the scheduled task against a mismatched subscription."
    }

    return $currentSubscriptionId
}

function Get-ScheduledTaskAgentResource {
    <#
    .SYNOPSIS
        Reads the SRE Agent's control-plane state via ARM using the
        caller's standard Azure CLI credentials — used only to obtain
        provisioningState/agentEndpoint. The task itself is written through
        the data plane.
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

function Assert-AgentReadyForScheduledTask {
    <#
    .SYNOPSIS
        Fails fast unless the agent is provisioned. Unlike the incident
        response plan (issue #19), scheduled tasks set their autonomy level
        PER TASK, not at the agent level
        (https://learn.microsoft.com/azure/sre-agent/run-modes: "Set run
        modes per response plan and per scheduled task ... You don't set
        run modes at the agent level"), so this does not require the
        agent's own actionConfiguration.mode to be any particular value,
        and does not require an incident-management connection (a
        scheduled task has nothing to do with incident routing).
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
}

function Get-ScheduledTaskDataPlaneAccessToken {
    <#
    .SYNOPSIS
        Acquires an in-memory-only data-plane token for audience
        https://azuresre.dev. Never persisted to disk or written to host
        output.
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

    # Leading unary comma required — see the identical note in
    # bootstrap-sre-agent-response-plan.ps1: without it PowerShell unrolls
    # the Byte[] into individual boxed System.Byte objects on return.
    return , [System.Text.UTF8Encoding]::new($false).GetBytes($Text)
}

function Invoke-DataPlaneRequest {
    <#
    .SYNOPSIS
        Single choke point for all scheduled-task data-plane HTTP calls, so
        tests can mock exactly one function and no other code path ever
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
        [ValidateSet('GET', 'PUT', 'PATCH', 'POST', 'DELETE')]
        [string]$Method,

        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter()]
        [string]$BodyJson
    )

    $uri = "$Endpoint$Path"
    $headers = @{
        Authorization = "******"
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
        # Transport-level failure (DNS, TLS, timeout) — always rethrow so
        # callers treat this as transient/retryable, never a confirmed
        # "unsupported API".
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

function Invoke-ArmControlPlaneRequest {
    <#
    .SYNOPSIS
        Single choke point for the ARM control-plane GET used only to
        capability-detect the scheduledTasks sub-resource collection (see
        Test-ScheduledTaskApiSupported). Uses the caller's standard Azure
        CLI credentials via `az rest`, exactly like Get-ScheduledTaskAgentResource.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url
    )

    $raw = & az rest --method GET --url $Url --output json 2>$null
    $exitCode = $LASTEXITCODE

    if ($exitCode -eq 0) {
        $content = $null
        if (-not [string]::IsNullOrWhiteSpace($raw)) {
            try { $content = $raw | ConvertFrom-Json } catch { $content = $null }
        }
        return [pscustomobject]@{ StatusCode = 200; Success = $true; Content = $content; RawContent = $raw }
    }

    # `az rest` does not hand back the HTTP status code directly on
    # failure; it prints an error containing the status. We look for the
    # documented 404/405 markers so a confirmed "not found"/"not allowed"
    # is distinguishable from a transient/auth failure, mirroring the
    # response-plan script's Invoke-DataPlaneRequest status handling.
    $errorText = "$raw"
    if ($errorText -match '\b404\b' -or $errorText -match 'NotFound') {
        return [pscustomobject]@{ StatusCode = 404; Success = $false; Content = $null; RawContent = $errorText }
    }
    if ($errorText -match '\b405\b' -or $errorText -match 'MethodNotAllowed') {
        return [pscustomobject]@{ StatusCode = 405; Success = $false; Content = $null; RawContent = $errorText }
    }
    throw "ARM control-plane request GET $Url failed: $errorText"
}

function Get-ScheduledTaskPromptHash {
    <#
    .SYNOPSIS
        SHA-256 hashes the rendered prompt text (UTF-8, no BOM) so drift
        between the versioned prompt file and the live task is detected
        deterministically — never by comparing opaque platform echoes.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Text
    )

    $bytes = ConvertTo-Utf8NoBomBytes -Text $Text
    $hashBytes = [System.Security.Cryptography.SHA256]::HashData($bytes)
    return ([System.BitConverter]::ToString($hashBytes) -replace '-', '').ToLowerInvariant()
}

function Get-RenderedScheduledTaskPrompt {
    <#
    .SYNOPSIS
        Reads the versioned scheduled-task prompt template and substitutes
        {{...}} placeholders with the actual deployed
        subscription/resource-group/AKS-cluster-name values.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$PromptFilePath,

        [Parameter(Mandatory = $true)]
        [string]$SubscriptionId,

        [Parameter(Mandatory = $true)]
        [string]$ResourceGroupName,

        [Parameter(Mandatory = $true)]
        [string]$AksClusterName
    )

    if (-not (Test-Path -Path $PromptFilePath)) {
        throw "Scheduled-task prompt template not found: $PromptFilePath"
    }

    $template = Get-Content -Path $PromptFilePath -Raw
    $rendered = $template `
        -replace '\{\{SUBSCRIPTION_ID\}\}', [regex]::Escape($SubscriptionId).Replace('\', '') `
        -replace '\{\{RESOURCE_GROUP\}\}', [regex]::Escape($ResourceGroupName).Replace('\', '') `
        -replace '\{\{AKS_CLUSTER_NAME\}\}', [regex]::Escape($AksClusterName).Replace('\', '')

    if ($rendered -match '(?m)^(?!Version:)\{\{[A-Z_]+\}\}') {
        throw "Scheduled-task prompt template still contains an unrendered placeholder. Update Get-RenderedScheduledTaskPrompt to substitute it."
    }

    return $rendered
}

function ConvertTo-CanonicalJson {
    <#
    .SYNOPSIS
        Serializes a hashtable/pscustomobject to JSON with sorted keys and
        no extraneous whitespace, so mismatch error messages are stable
        regardless of property declaration order.
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
        # Deliberately NOT `$obj -is [pscustomobject]` — see the identical
        # note in bootstrap-sre-agent-response-plan.ps1's ConvertTo-CanonicalJson.
        if ($obj.GetType().FullName -eq 'System.Management.Automation.PSCustomObject') {
            $sorted = [ordered]@{}
            foreach ($prop in ($obj.PSObject.Properties.Name | Sort-Object)) {
                $sorted[$prop] = Sort-ObjectKeysRecursively $obj.$prop
            }
            return $sorted
        }
        if ($obj -is [System.Collections.IEnumerable] -and -not ($obj -is [string])) {
            return , @($obj | ForEach-Object { Sort-ObjectKeysRecursively $_ })
        }
        return $obj
    }

    $sorted = Sort-ObjectKeysRecursively $InputObject
    return ($sorted | ConvertTo-Json -Depth 50 -Compress)
}

function New-ScheduledTaskDataPlaneSpec {
    <#
    .SYNOPSIS
        Builds the scheduled-task request body for the officially
        documented path `PUT /api/v2/extendedAgent/scheduledtasks/{name}`.
        Field names are a best-effort mapping from the documented portal
        workflow (task name, task details, frequency, time of day, time
        zone, response custom agent, message grouping, agent autonomy
        level) — see the SCHEMA NOTE in this script's top-level comment
        block. `promptVersionHash` is this script's own addition (not a
        documented platform field) used purely for local drift detection;
        if the platform does not preserve unknown fields on write, the
        semantic verification step in Set-ScheduledTaskDataPlaneIdempotent
        will surface that as a SchemaMismatch rather than silently
        succeeding.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$RenderedPrompt,

        [Parameter(Mandatory = $true)]
        [string]$PromptVersionHash,

        [Parameter(Mandatory = $true)]
        [int]$ScheduleHourUtc,

        [Parameter(Mandatory = $true)]
        [int]$ScheduleMinuteUtc,

        [Parameter(Mandatory = $true)]
        [string]$TimeZone,

        [Parameter(Mandatory = $true)]
        [bool]$Enabled
    )

    return [ordered]@{
        name              = $Name
        taskDetails       = $RenderedPrompt
        promptVersionHash = $PromptVersionHash
        frequency         = 'Daily'
        timeOfDay         = ('{0:D2}:{1:D2}' -f $ScheduleHourUtc, $ScheduleMinuteUtc)
        timeZone          = $TimeZone
        # Empty string = "leave empty to use the main agent" per
        # https://learn.microsoft.com/azure/sre-agent/create-scheduled-task.
        responseCustomAgent = ''
        messageGrouping     = 'SameThread'
        # Read-only but explicitly Autonomous per issue #24: the task never
        # proposes a write action, so there is nothing for a human to
        # approve — Review mode would only add unnecessary friction to a
        # read-only report.
        agentAutonomyLevel  = 'Autonomous'
        enabled             = $Enabled
        runLimit            = $null
    }
}

function Test-ScheduledTaskSemanticMatch {
    <#
    .SYNOPSIS
        Compares the INTERPRETED fields of a decoded scheduled-task
        response against the expected spec — not a byte/JSON-string
        comparison.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        $Expected,

        [Parameter()]
        $Actual
    )

    if ($null -eq $Actual) { return $false }
    if ([string]$Actual.taskDetails -ne [string]$Expected.taskDetails) { return $false }
    if ([string]$Actual.promptVersionHash -ne [string]$Expected.promptVersionHash) { return $false }
    if ([string]$Actual.frequency -ne [string]$Expected.frequency) { return $false }
    if ([string]$Actual.timeOfDay -ne [string]$Expected.timeOfDay) { return $false }
    if ([string]$Actual.timeZone -ne [string]$Expected.timeZone) { return $false }
    if ([string]$Actual.messageGrouping -ne [string]$Expected.messageGrouping) { return $false }
    if ([string]$Actual.agentAutonomyLevel -ne 'Autonomous') { return $false }
    if ([bool]$Actual.enabled -ne [bool]$Expected.enabled) { return $false }

    return $true
}

function Test-ScheduledTaskApiSupported {
    <#
    .SYNOPSIS
        Capability-detects the scheduledTasks sub-resource TYPE via the ARM
        control-plane collection-level GET (no item name) — see the
        top-level comment block for why this, and not the data-plane
        single-item path, is the unambiguous "does this capability exist
        here" signal. Returns $false only on a confirmed 404/405. Any other
        non-success response is thrown as a transient/unknown failure, so a
        genuine outage or auth problem is never misreported as
        "unsupported".
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

    $url = "https://management.azure.com/subscriptions/${SubscriptionId}/resourceGroups/${ResourceGroupName}/providers/Microsoft.App/agents/${AgentName}/scheduledTasks?api-version=${ApiVersion}"
    $result = Invoke-ArmControlPlaneRequest -Url $url

    if ($result.StatusCode -eq 404 -or $result.StatusCode -eq 405) {
        return $false
    }
    if (-not $result.Success) {
        throw "scheduledTasks sub-resource collection probe returned HTTP $($result.StatusCode), which is not a confirmed 'unsupported API' response (404/405). Treating this as a transient failure rather than silently degrading: $($result.RawContent)"
    }

    return $true
}

function Set-ScheduledTaskDataPlaneIdempotent {
    <#
    .SYNOPSIS
        Create-or-update for the scheduled task: fetches current state
        (tolerating 404 as "not yet created"), skips the PATCH/PUT if it
        already semantically matches, otherwise writes (PUT for a brand new
        task, PATCH for an existing one — both documented verbs) and
        semantically re-verifies. A 404/405 on the write itself is reported
        as 'UnsupportedApi'.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token,

        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        $Spec
    )

    $existing = Invoke-DataPlaneRequest -Endpoint $Endpoint -Token $Token -Method GET -Path $Path

    if ($existing.Success -and (Test-ScheduledTaskSemanticMatch -Expected $Spec -Actual $existing.Content)) {
        return [pscustomobject]@{ Success = $true; Reason = 'Unchanged' }
    }
    if (-not $existing.Success -and $existing.StatusCode -ne 404) {
        throw "Failed to read existing scheduled task before writing: HTTP $($existing.StatusCode). $($existing.RawContent)"
    }

    $taskAlreadyExists = $existing.Success
    $writeMethod = if ($taskAlreadyExists) { 'PATCH' } else { 'PUT' }
    $bodyJson = ConvertTo-CanonicalJson -InputObject $Spec
    $writeResult = Invoke-DataPlaneRequest -Endpoint $Endpoint -Token $Token -Method $writeMethod -Path $Path -BodyJson $bodyJson

    if ($writeResult.StatusCode -eq 404 -or $writeResult.StatusCode -eq 405) {
        return [pscustomobject]@{
            Success = $false
            Reason  = 'UnsupportedApi'
            Message = "$writeMethod $Path responded HTTP $($writeResult.StatusCode) — the officially documented scheduled-task data-plane endpoint is not available on this agent. Failing readiness explicitly instead of claiming the task is active."
        }
    }
    if (-not $writeResult.Success) {
        throw "Failed to write scheduled task '$($Spec.name)': HTTP $($writeResult.StatusCode). Response: $($writeResult.RawContent)"
    }

    $verify = Invoke-DataPlaneRequest -Endpoint $Endpoint -Token $Token -Method GET -Path $Path
    if (-not $verify.Success -or -not (Test-ScheduledTaskSemanticMatch -Expected $Spec -Actual $verify.Content)) {
        return [pscustomobject]@{
            Success  = $false
            Reason   = 'SchemaMismatch'
            Message  = "Scheduled task '$($Spec.name)' was written (HTTP $($writeResult.StatusCode)) but the interpreted fields read back from $Path do not match what was sent — the server may have silently ignored or reinterpreted fields in this unpublished schema."
            Expected = (ConvertTo-CanonicalJson -InputObject $Spec)
            Actual   = if ($verify.Content) { (ConvertTo-CanonicalJson -InputObject $verify.Content) } else { '<unreadable>' }
        }
    }

    return [pscustomobject]@{ Success = $true; Reason = 'Written' }
}

function Invoke-ScheduledTaskBootstrap {
    <#
    .SYNOPSIS
        Orchestrates the full idempotent, semantically-verified bootstrap:
        capability detection, then create-or-update + verify. Never throws
        for a confirmed "unsupported API" or "schema mismatch" condition —
        those are reported as structured, unsuccessful results.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token,

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
        [string]$TaskName,

        [Parameter(Mandatory = $true)]
        [int]$ScheduleHourUtc,

        [Parameter(Mandatory = $true)]
        [int]$ScheduleMinuteUtc,

        [Parameter(Mandatory = $true)]
        [string]$TimeZone,

        [Parameter(Mandatory = $true)]
        [bool]$Enabled,

        [Parameter(Mandatory = $true)]
        [string]$PromptFilePath,

        [Parameter(Mandatory = $true)]
        [string]$DataPlanePath
    )

    if (-not (Test-ScheduledTaskApiSupported -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName -AgentName $AgentName -ApiVersion $ApiVersion)) {
        return [pscustomobject]@{
            Success = $false
            Reason  = 'UnsupportedApi'
            Message = "The scheduledTasks ARM sub-resource collection (Microsoft.App/agents/$AgentName/scheduledTasks, api-version=$ApiVersion) responded 404/405. This Preview capability is not available here — failing readiness explicitly instead of claiming the scheduled task is active."
        }
    }

    $renderedPrompt = Get-RenderedScheduledTaskPrompt -PromptFilePath $PromptFilePath -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName -AksClusterName $AksClusterName
    $promptHash = Get-ScheduledTaskPromptHash -Text $renderedPrompt
    $spec = New-ScheduledTaskDataPlaneSpec -Name $TaskName -RenderedPrompt $renderedPrompt -PromptVersionHash $promptHash -ScheduleHourUtc $ScheduleHourUtc -ScheduleMinuteUtc $ScheduleMinuteUtc -TimeZone $TimeZone -Enabled $Enabled

    $writeResult = Set-ScheduledTaskDataPlaneIdempotent -Endpoint $Endpoint -Token $Token -Path $DataPlanePath -Spec $spec
    if (-not $writeResult.Success) {
        return [pscustomobject]@{
            Success = $false
            Reason  = $writeResult.Reason
            Message = $writeResult.Message
        }
    }

    return [pscustomobject]@{
        Success           = $true
        Reason            = $writeResult.Reason
        Message           = "Scheduled task '$TaskName' is configured AND semantically verified (Daily at $('{0:D2}:{1:D2}' -f $ScheduleHourUtc, $ScheduleMinuteUtc) $TimeZone, Autonomous, prompt hash $promptHash) via the data-plane read — not inferred from an opaque write acknowledgement. NOTE: this does not prove a live scheduled execution has produced a real report; run -Action RunNow or -Action History next."
        TaskName          = $TaskName
        PromptVersionHash = $promptHash
    }
}

function Invoke-ScheduledTaskValidate {
    <#
    .SYNOPSIS
        Read-only validation: re-derives the expected spec from the
        versioned prompt/parameters and compares it against the live task's
        interpreted fields, reporting exactly which field(s) drifted. Makes
        no write calls.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token,

        [Parameter(Mandatory = $true)]
        [string]$SubscriptionId,

        [Parameter(Mandatory = $true)]
        [string]$ResourceGroupName,

        [Parameter(Mandatory = $true)]
        [string]$AksClusterName,

        [Parameter(Mandatory = $true)]
        [string]$TaskName,

        [Parameter(Mandatory = $true)]
        [int]$ScheduleHourUtc,

        [Parameter(Mandatory = $true)]
        [int]$ScheduleMinuteUtc,

        [Parameter(Mandatory = $true)]
        [string]$TimeZone,

        [Parameter(Mandatory = $true)]
        [bool]$Enabled,

        [Parameter(Mandatory = $true)]
        [string]$PromptFilePath,

        [Parameter(Mandatory = $true)]
        [string]$DataPlanePath
    )

    $renderedPrompt = Get-RenderedScheduledTaskPrompt -PromptFilePath $PromptFilePath -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName -AksClusterName $AksClusterName
    $promptHash = Get-ScheduledTaskPromptHash -Text $renderedPrompt
    $expected = New-ScheduledTaskDataPlaneSpec -Name $TaskName -RenderedPrompt $renderedPrompt -PromptVersionHash $promptHash -ScheduleHourUtc $ScheduleHourUtc -ScheduleMinuteUtc $ScheduleMinuteUtc -TimeZone $TimeZone -Enabled $Enabled

    $existing = Invoke-DataPlaneRequest -Endpoint $Endpoint -Token $Token -Method GET -Path $DataPlanePath
    if ($existing.StatusCode -eq 404) {
        return [pscustomobject]@{
            Success = $false
            Reason  = 'NotFound'
            Message = "Scheduled task '$TaskName' does not exist yet at $DataPlanePath. Run -Action Bootstrap first."
        }
    }
    if (-not $existing.Success) {
        throw "Failed to read scheduled task '$TaskName' for validation: HTTP $($existing.StatusCode). $($existing.RawContent)"
    }

    $fieldChecks = [ordered]@{
        name                = ([string]$TaskName -eq [string]$existing.Content.name -or [string]::IsNullOrWhiteSpace([string]$existing.Content.name))
        frequency           = ([string]$expected.frequency -eq [string]$existing.Content.frequency)
        timeOfDay           = ([string]$expected.timeOfDay -eq [string]$existing.Content.timeOfDay)
        timeZone            = ([string]$expected.timeZone -eq [string]$existing.Content.timeZone)
        enabled             = ([bool]$expected.enabled -eq [bool]$existing.Content.enabled)
        promptVersionHash   = ([string]$expected.promptVersionHash -eq [string]$existing.Content.promptVersionHash)
        responseCustomAgent = ([string]$expected.responseCustomAgent -eq [string]$existing.Content.responseCustomAgent)
        messageGrouping     = ([string]$expected.messageGrouping -eq [string]$existing.Content.messageGrouping)
        agentAutonomyLevel  = ([string]$existing.Content.agentAutonomyLevel -eq 'Autonomous')
    }

    $driftedFields = @($fieldChecks.Keys | Where-Object { -not $fieldChecks[$_] })

    if ($driftedFields.Count -gt 0) {
        return [pscustomobject]@{
            Success       = $false
            Reason        = 'Drift'
            Message       = "Scheduled task '$TaskName' has drifted from the versioned spec in the following field(s): $($driftedFields -join ', '). Run -Action Bootstrap to reconcile, or update the versioned prompt/parameters if the live task reflects an intentional change."
            DriftedFields = $driftedFields
            Expected      = (ConvertTo-CanonicalJson -InputObject $expected)
            Actual        = (ConvertTo-CanonicalJson -InputObject $existing.Content)
        }
    }

    return [pscustomobject]@{
        Success = $true
        Reason  = 'Valid'
        Message = "Scheduled task '$TaskName' matches the versioned spec exactly (name, schedule=$($expected.timeOfDay) $($expected.timeZone), enabled=$($expected.enabled), prompt hash=$($expected.promptVersionHash), response custom agent, run mode=Autonomous, message grouping)."
    }
}

function Invoke-ScheduledTaskRunNowRequest {
    <#
    .SYNOPSIS
        Capability-detects and attempts an out-of-schedule execution by
        probing plausible (UNPUBLISHED — see top-level comment) candidate
        execute paths in order. Returns the first 2xx response; if every
        candidate 404s/405s, returns an explicit UnsupportedApi result
        recommending the portal's "Run task now" button. Any other
        non-success status is thrown (transient/unknown, never silently
        reported as unsupported).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token,

        [Parameter(Mandatory = $true)]
        [string]$TaskDataPlanePath
    )

    $candidatePaths = @("$TaskDataPlanePath/run", "$TaskDataPlanePath/execute")
    $notFoundCount = 0

    foreach ($candidatePath in $candidatePaths) {
        $result = Invoke-DataPlaneRequest -Endpoint $Endpoint -Token $Token -Method POST -Path $candidatePath
        if ($result.Success) {
            return [pscustomobject]@{ Success = $true; Reason = 'Triggered'; Content = $result.Content; Path = $candidatePath }
        }
        if ($result.StatusCode -eq 404 -or $result.StatusCode -eq 405) {
            $notFoundCount++
            continue
        }
        throw "RunNow candidate POST $candidatePath returned HTTP $($result.StatusCode), which is not a confirmed 'unsupported API' response (404/405). Treating this as a transient failure rather than silently reporting RunNow as unsupported: $($result.RawContent)"
    }

    if ($notFoundCount -eq $candidatePaths.Count) {
        return [pscustomobject]@{
            Success = $false
            Reason  = 'UnsupportedApi'
            Message = "No documented REST path exists for triggering a scheduled task out-of-schedule; both probed candidates ($($candidatePaths -join ', ')) responded 404/405. Use the portal's 'Run task now' button (Scheduled tasks > select task > Run task now) instead — this script never fabricates a thread or a report."
        }
    }

    # Unreachable given the loop above always either returns or throws, but
    # keeps the function's static return type honest.
    return [pscustomobject]@{ Success = $false; Reason = 'UnsupportedApi'; Message = 'RunNow capability could not be determined.' }
}

function Get-ThreadIdFromRunNowResponse {
    <#
    .SYNOPSIS
        Tolerantly extracts a thread id from an unpublished RunNow response
        shape, trying the field names Microsoft's documented thread APIs
        use elsewhere (threadId) plus common alternates.
    #>
    [CmdletBinding()]
    param(
        [Parameter()]
        $Content
    )

    if ($null -eq $Content) { return $null }
    foreach ($fieldName in @('threadId', 'thread_id', 'id')) {
        if ($Content.PSObject.Properties.Name -contains $fieldName -and -not [string]::IsNullOrWhiteSpace([string]$Content.$fieldName)) {
            return [string]$Content.$fieldName
        }
    }
    if ($Content.PSObject.Properties.Name -contains 'thread' -and $Content.thread) {
        foreach ($fieldName in @('id', 'threadId')) {
            if ($Content.thread.PSObject.Properties.Name -contains $fieldName -and -not [string]::IsNullOrWhiteSpace([string]$Content.thread.$fieldName)) {
                return [string]$Content.thread.$fieldName
            }
        }
    }
    return $null
}

function ConvertTo-HealthReportOutcome {
    <#
    .SYNOPSIS
        Parses the required `Overall status: <label>` line (see
        docs/sre-agent-scheduled-tasks/daily-propane-health-report-prompt.md)
        out of a thread message's text content. Returns 'Insufficient
        evidence' (never 'Healthy') when the label is missing or
        unrecognized — a missing/malformed status must never be silently
        treated as healthy.
    #>
    [CmdletBinding()]
    param(
        [Parameter()]
        [AllowEmptyString()]
        [AllowNull()]
        [string]$Text
    )

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return 'Insufficient evidence'
    }
    if ($Text -match '(?im)^Overall status:\s*Healthy\s*$') {
        return 'Healthy'
    }
    if ($Text -match '(?im)^Overall status:\s*Degraded\s*$') {
        return 'Degraded'
    }
    if ($Text -match '(?im)^Overall status:\s*Insufficient evidence\s*$') {
        return 'Insufficient evidence'
    }
    return 'Insufficient evidence'
}

function Wait-ScheduledTaskThreadReport {
    <#
    .SYNOPSIS
        Polls the documented thread endpoints (GET /api/v1/threads/{id},
        GET /api/v1/threads/{id}/messages) for a completed report, bounded
        to $script:RunNowMaxWaitSeconds total. Returns a structured
        timeout/failure result rather than throwing, so a slow (but
        eventually successful) run is distinguishable from RunNow having
        never been triggered.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token,

        [Parameter(Mandatory = $true)]
        [string]$ThreadId,

        [Parameter()]
        [int]$MaxWaitSeconds = $script:RunNowMaxWaitSeconds,

        [Parameter()]
        [int]$PollIntervalSeconds = $script:RunNowPollIntervalSeconds,

        [Parameter()]
        [scriptblock]$SleepOverride
    )

    $deadline = (Get-Date).AddSeconds($MaxWaitSeconds)
    do {
        $threadResult = Invoke-DataPlaneRequest -Endpoint $Endpoint -Token $Token -Method GET -Path "/api/v1/threads/$ThreadId"
        if (-not $threadResult.Success -and $threadResult.StatusCode -ne 404) {
            throw "Failed to poll thread '$ThreadId': HTTP $($threadResult.StatusCode). $($threadResult.RawContent)"
        }

        $status = if ($threadResult.Success) { [string]$threadResult.Content.status } else { $null }
        if ($status -eq 'Complete') {
            $messagesResult = Invoke-DataPlaneRequest -Endpoint $Endpoint -Token $Token -Method GET -Path "/api/v1/threads/$ThreadId/messages"
            if (-not $messagesResult.Success) {
                throw "Thread '$ThreadId' completed but its messages could not be read: HTTP $($messagesResult.StatusCode)."
            }
            $messages = if ($messagesResult.Content.PSObject.Properties.Name -contains 'value') { @($messagesResult.Content.value) } else { @($messagesResult.Content) }
            $lastMessage = $messages | Select-Object -Last 1
            $reportText = if ($lastMessage) { [string]$lastMessage.content } else { $null }

            return [pscustomobject]@{
                Success   = $true
                Reason    = 'Completed'
                ThreadId  = $ThreadId
                Status    = 'Complete'
                Timestamp = (Get-Date).ToUniversalTime().ToString('o')
                Outcome   = ConvertTo-HealthReportOutcome -Text $reportText
                ReportText = $reportText
            }
        }

        if ($SleepOverride) {
            & $SleepOverride $PollIntervalSeconds
        }
        else {
            Start-Sleep -Seconds $PollIntervalSeconds
        }
    } while ((Get-Date) -lt $deadline)

    return [pscustomobject]@{
        Success   = $false
        Reason    = 'Timeout'
        ThreadId  = $ThreadId
        Status    = 'InProgress'
        Message   = "Thread '$ThreadId' did not reach 'Complete' status within $MaxWaitSeconds seconds."
    }
}

function Invoke-ScheduledTaskRunNow {
    <#
    .SYNOPSIS
        Orchestrates -Action RunNow: capability-detect + trigger, then poll
        for the resulting thread/report.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token,

        [Parameter(Mandatory = $true)]
        [string]$TaskDataPlanePath
    )

    $triggerResult = Invoke-ScheduledTaskRunNowRequest -Endpoint $Endpoint -Token $Token -TaskDataPlanePath $TaskDataPlanePath
    if (-not $triggerResult.Success) {
        return [pscustomobject]@{ Success = $false; Reason = $triggerResult.Reason; Message = $triggerResult.Message }
    }

    $threadId = Get-ThreadIdFromRunNowResponse -Content $triggerResult.Content
    if (-not $threadId) {
        return [pscustomobject]@{
            Success = $false
            Reason  = 'SchemaMismatch'
            Message = "RunNow was triggered (POST $($triggerResult.Path) returned 2xx) but no thread id could be found in the response body — cannot poll for a report without fabricating one."
        }
    }

    $pollResult = Wait-ScheduledTaskThreadReport -Endpoint $Endpoint -Token $Token -ThreadId $threadId
    if (-not $pollResult.Success) {
        return [pscustomobject]@{ Success = $false; Reason = $pollResult.Reason; Message = $pollResult.Message; ThreadId = $threadId }
    }

    return [pscustomobject]@{
        Success   = $true
        Reason    = 'Completed'
        Message   = "RunNow triggered a fresh execution (thread $threadId), which completed with outcome '$($pollResult.Outcome)'."
        ThreadId  = $threadId
        Outcome   = $pollResult.Outcome
        Timestamp = $pollResult.Timestamp
        ReportText = $pollResult.ReportText
    }
}

function Get-ScheduledTaskExecutionHistory {
    <#
    .SYNOPSIS
        Best-effort listing of prior executions. The documented threads
        list (`GET /api/v1/threads`) does not publish a filter-by-source or
        filter-by-task-name query parameter, so this filters client-side by
        thread title containing the task name — a heuristic, not a
        guaranteed exact match, and reported as such.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token,

        [Parameter(Mandatory = $true)]
        [string]$TaskName
    )

    $threadsResult = Invoke-DataPlaneRequest -Endpoint $Endpoint -Token $Token -Method GET -Path '/api/v1/threads'
    if (-not $threadsResult.Success) {
        throw "Failed to list threads for scheduled-task history: HTTP $($threadsResult.StatusCode). $($threadsResult.RawContent)"
    }

    $allThreads = if ($threadsResult.Content.PSObject.Properties.Name -contains 'value') { @($threadsResult.Content.value) } else { @($threadsResult.Content) }
    $matchingThreads = @($allThreads | Where-Object { $_ -and [string]$_.title -match [regex]::Escape($TaskName) })

    if ($matchingThreads.Count -eq 0) {
        return [pscustomobject]@{
            Success = $false
            Reason  = 'NoHistory'
            Message = "No threads with a title matching '$TaskName' were found. Either the task has never run, or thread titles for this preview do not include the task name (best-effort heuristic; see docs/sre-agent-scheduled-tasks/README.md)."
        }
    }

    $sorted = $matchingThreads | Sort-Object -Property { [datetime]$_.createdAt } -Descending
    $latest = $sorted | Select-Object -First 1
    $latestThreadId = [string]$latest.id

    $pollResult = Wait-ScheduledTaskThreadReport -Endpoint $Endpoint -Token $Token -ThreadId $latestThreadId -MaxWaitSeconds 0
    $latestOutcome = if ($pollResult.Success) { $pollResult.Outcome } else { 'Insufficient evidence' }
    $latestTimestamp = if ($pollResult.Success) { $pollResult.Timestamp } else { [string]$latest.createdAt }

    return [pscustomobject]@{
        Success        = $true
        Reason         = 'Found'
        Message        = "Found $($matchingThreads.Count) thread(s) matching '$TaskName'. Latest: thread $latestThreadId at $latestTimestamp, outcome '$latestOutcome'."
        ExecutionCount = $matchingThreads.Count
        LatestThreadId = $latestThreadId
        LatestOutcome  = $latestOutcome
        LatestTimestamp = $latestTimestamp
    }
}

function Invoke-ScheduledTaskTeardown {
    <#
    .SYNOPSIS
        Idempotently removes ONLY this lab's scheduled task through the
        data-plane endpoint. A 404 is treated as success. Never touches the
        SRE Agent resource itself, nor any other scheduled task.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$Token,

        [Parameter(Mandatory = $true)]
        [string]$TaskName,

        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $deleteResult = Invoke-DataPlaneRequest -Endpoint $Endpoint -Token $Token -Method DELETE -Path $Path
    if (-not $deleteResult.Success -and $deleteResult.StatusCode -ne 404) {
        throw "Failed to remove scheduled task '$TaskName': HTTP $($deleteResult.StatusCode). $($deleteResult.RawContent)"
    }

    return [pscustomobject]@{
        Success = $true
        Message = "Removed scheduled task '$TaskName' (idempotent — an already-absent task is treated as success). No other scheduled task, response plan, or the SRE Agent resource itself was touched."
    }
}

# =============================================================================
# ENTRY POINT — only runs when the file is executed directly, not dot-sourced
# for its functions by Pester tests.
# =============================================================================
if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'

    try {
        Write-Host "`n🧭 $Action scheduled task '$TaskName' for agent '$AgentName' in '$ResourceGroupName'..." -ForegroundColor Cyan

        $subscriptionId = Assert-ScheduledTaskSubscriptionMatch -ResourceGroupName $ResourceGroupName
        Write-Host "  ✅ Subscription context verified: $subscriptionId" -ForegroundColor Green

        $agent = Get-ScheduledTaskAgentResource -SubscriptionId $subscriptionId -ResourceGroupName $ResourceGroupName -AgentName $AgentName -ApiVersion $ApiVersion
        Assert-AgentReadyForScheduledTask -Agent $agent -AgentName $AgentName
        Write-Host "  ✅ Agent provisioningState is Succeeded" -ForegroundColor Green

        if ([string]::IsNullOrWhiteSpace($agent.properties.agentEndpoint)) {
            throw "SRE Agent '$AgentName' has no data-plane agentEndpoint yet."
        }

        # Acquired once, held only in this local variable, never logged.
        $dataPlaneToken = Get-ScheduledTaskDataPlaneAccessToken

        switch ($Action) {
            'Teardown' {
                $result = Invoke-ScheduledTaskTeardown -Endpoint $agent.properties.agentEndpoint -Token $dataPlaneToken -TaskName $TaskName -Path $script:ScheduledTaskDataPlanePath
                Write-Host "`n✅ $($result.Message)" -ForegroundColor Green
                exit 0
            }
            'Validate' {
                $result = Invoke-ScheduledTaskValidate -Endpoint $agent.properties.agentEndpoint -Token $dataPlaneToken -SubscriptionId $subscriptionId -ResourceGroupName $ResourceGroupName -AksClusterName $AksClusterName -TaskName $TaskName -ScheduleHourUtc $ScheduleHourUtc -ScheduleMinuteUtc $ScheduleMinuteUtc -TimeZone $TimeZone -Enabled $Enabled -PromptFilePath $PromptFilePath -DataPlanePath $script:ScheduledTaskDataPlanePath
                if (-not $result.Success) {
                    Write-Host "`n❌ $($result.Message)" -ForegroundColor Red
                    exit 1
                }
                Write-Host "`n✅ $($result.Message)" -ForegroundColor Green
                exit 0
            }
            'RunNow' {
                $result = Invoke-ScheduledTaskRunNow -Endpoint $agent.properties.agentEndpoint -Token $dataPlaneToken -TaskDataPlanePath $script:ScheduledTaskDataPlanePath
                if (-not $result.Success) {
                    Write-Host "`n❌ $($result.Message)" -ForegroundColor Red
                    exit 1
                }
                Write-Host "`n✅ $($result.Message)" -ForegroundColor Green
                Write-Host "  📋 Outcome: $($result.Outcome)" -ForegroundColor Yellow
                exit 0
            }
            'History' {
                $result = Get-ScheduledTaskExecutionHistory -Endpoint $agent.properties.agentEndpoint -Token $dataPlaneToken -TaskName $TaskName
                if (-not $result.Success) {
                    Write-Host "`n❌ $($result.Message)" -ForegroundColor Red
                    exit 1
                }
                Write-Host "`n✅ $($result.Message)" -ForegroundColor Green
                exit 0
            }
            default {
                $result = Invoke-ScheduledTaskBootstrap `
                    -Endpoint $agent.properties.agentEndpoint `
                    -Token $dataPlaneToken `
                    -SubscriptionId $subscriptionId `
                    -ResourceGroupName $ResourceGroupName `
                    -AgentName $AgentName `
                    -ApiVersion $ApiVersion `
                    -AksClusterName $AksClusterName `
                    -TaskName $TaskName `
                    -ScheduleHourUtc $ScheduleHourUtc `
                    -ScheduleMinuteUtc $ScheduleMinuteUtc `
                    -TimeZone $TimeZone `
                    -Enabled $Enabled `
                    -PromptFilePath $PromptFilePath `
                    -DataPlanePath $script:ScheduledTaskDataPlanePath

                if (-not $result.Success) {
                    Write-Host "`n❌ $($result.Message)" -ForegroundColor Red
                    exit 1
                }
                Write-Host "`n✅ $($result.Message)" -ForegroundColor Green
                Write-Host "`nℹ️  This confirms the scheduled task is configured and semantically verified via the data-plane read. It does NOT confirm a live scheduled execution has produced a real report — run '-Action RunNow' or '-Action History' next, and see docs/sre-agent-scheduled-tasks/README.md for the full healthy/degraded/insufficient-evidence rehearsal." -ForegroundColor Yellow
                exit 0
            }
        }
    }
    catch {
        Write-Host "`n❌ Scheduled task '$Action' failed: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}
