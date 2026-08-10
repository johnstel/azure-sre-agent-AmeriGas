param(
    [string]$ManifestPath = (Join-Path $PSScriptRoot ".." "k8s/base/application.yaml")
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -Path $ManifestPath)) {
    throw "Manifest not found: $ManifestPath"
}

$content = Get-Content -Path $ManifestPath -Raw
$documents = [regex]::Split($content, '(?m)^---\s*$')
$targetNames = @('customer-portal-nginx', 'dispatch-console-nginx')
$blocks = @{}

foreach ($document in $documents) {
    if ($document -match 'kind:\s*ConfigMap' -and $document -match 'name:\s*([A-Za-z0-9_.-]+)') {
        $name = $matches[1]
        if ($targetNames -contains $name) {
            $blocks[$name] = $document
        }
    }
}

$failures = New-Object System.Collections.Generic.List[string]

foreach ($name in $targetNames) {
    if (-not $blocks.ContainsKey($name)) {
        $failures.Add("Missing ConfigMap block for $name")
        continue
    }

    $block = $blocks[$name]
    $requiredPatterns = @(
        'location = /api/inventory/health {',
        'location = /api/tanks/health {',
        'location = /api/orders/health {',
        'location /api/ {',
        'return 404;',
        'limit_except GET {',
        'deny all;'
    )

    foreach ($pattern in $requiredPatterns) {
        if (-not $block.Contains($pattern)) {
            $failures.Add("$name is missing required pattern: $pattern")
        }
    }

    $disallowedPatterns = @(
        'location /api/inventory/ {',
        'location /api/tanks/ {',
        'location /api/orders/ {'
    )

    foreach ($pattern in $disallowedPatterns) {
        if ($block.Contains($pattern)) {
            $failures.Add("$name still contains disallowed broad proxy route: $pattern")
        }
    }
}

if ($failures.Count -gt 0) {
    Write-Error "Public API exposure validation failed:`n - $($failures -join "`n - ")"
    exit 1
}

Write-Host "Public API exposure validation passed for $ManifestPath"
