param(
    [string]$ManifestPath = (Join-Path $PSScriptRoot ".." "k8s/base/application.yaml")
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -Path $ManifestPath)) {
    throw "Manifest not found: $ManifestPath"
}

$content = Get-Content -Path $ManifestPath -Raw
$checks = @(
    @{ Name = 'customer portal inventory health route'; Pattern = 'name: customer-portal-nginx'; ShouldExist = $true },
    @{ Name = 'customer portal inventory health route'; Pattern = 'location = /api/inventory/health'; ShouldExist = $true },
    @{ Name = 'customer portal tank health route'; Pattern = 'location = /api/tanks/health'; ShouldExist = $true },
    @{ Name = 'customer portal order health route'; Pattern = 'location = /api/orders/health'; ShouldExist = $true },
    @{ Name = 'customer portal api catch-all'; Pattern = 'location /api/ {'; ShouldExist = $true },
    @{ Name = 'customer portal api catch-all response'; Pattern = 'return 404;'; ShouldExist = $true },
    @{ Name = 'dispatch console inventory health route'; Pattern = 'name: dispatch-console-nginx'; ShouldExist = $true },
    @{ Name = 'dispatch console inventory health route'; Pattern = 'location = /api/inventory/health'; ShouldExist = $true },
    @{ Name = 'dispatch console tank health route'; Pattern = 'location = /api/tanks/health'; ShouldExist = $true },
    @{ Name = 'dispatch console order health route'; Pattern = 'location = /api/orders/health'; ShouldExist = $true },
    @{ Name = 'dispatch console api catch-all'; Pattern = 'location /api/ {'; ShouldExist = $true },
    @{ Name = 'dispatch console api catch-all response'; Pattern = 'return 404;'; ShouldExist = $true }
)

$disallowed = @(
    'location /api/inventory/ {',
    'location /api/tanks/ {',
    'location /api/orders/ {'
)

$failures = @()

foreach ($check in $checks) {
    $found = $content.Contains($check.Pattern)
    if ($check.ShouldExist -and -not $found) {
        $failures += "Missing required pattern: $($check.Pattern)"
    }
    if (-not $check.ShouldExist -and $found) {
        $failures += "Unexpected pattern present: $($check.Pattern)"
    }
}

foreach ($pattern in $disallowed) {
    if ($content.Contains($pattern)) {
        $failures += "Disallowed pattern still present: $pattern"
    }
}

if ($failures.Count -gt 0) {
    Write-Error "Public API exposure validation failed:`n - $($failures -join "`n - ")"
    exit 1
}

Write-Host "Public API exposure validation passed for $ManifestPath"
