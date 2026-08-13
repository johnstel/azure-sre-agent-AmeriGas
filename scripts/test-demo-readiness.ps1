[CmdletBinding()]
param(
    [Alias('Subscription')]
    [string]$SubscriptionId,
    [Alias('ResourceGroup')]
    [string]$ResourceGroupName,
    [string]$Profile = 'default',
    [string]$RunId,
    [int]$TimeoutMs = 90000,
    [switch]$Json,
    [switch]$Human,
    [switch]$RequireMissionControl,
    [switch]$RequireNativeSreAgent,
    [string]$Mock = ''
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeScript = Join-Path $scriptDir '..' 'tools/mission-control/demo-readiness.js'
$nodeScript = [System.IO.Path]::GetFullPath($nodeScript)

$nodeArgs = @($nodeScript)
if ($SubscriptionId) {
    $nodeArgs += '--subscription-id'
    $nodeArgs += $SubscriptionId
}
if ($ResourceGroupName) {
    $nodeArgs += '--resource-group'
    $nodeArgs += $ResourceGroupName
}
if ($Profile) {
    $nodeArgs += '--profile'
    $nodeArgs += $Profile
}
if ($RunId) {
    $nodeArgs += '--run-id'
    $nodeArgs += $RunId
}
if ($TimeoutMs -gt 0) {
    $nodeArgs += '--timeout-ms'
    $nodeArgs += [string]$TimeoutMs
}
if ($RequireMissionControl) {
    $nodeArgs += '--require-mission-control'
}
if ($RequireNativeSreAgent) {
    $nodeArgs += '--require-native-sre-agent'
}
if ($Mock) {
    $nodeArgs += '--mock'
    $nodeArgs += $Mock
}
if ($Json) {
    $nodeArgs += '--json'
}
elseif ($Human) {
    $nodeArgs += '--human'
}

& node @nodeArgs
exit $LASTEXITCODE
