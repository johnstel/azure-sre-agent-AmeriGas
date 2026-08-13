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
    $requiredRoutes = @(
        @{ Path = '/api/inventory/health'; Proxy = 'http://inventory-service.propane.svc.cluster.local:3002/health' },
        @{ Path = '/api/tanks/health'; Proxy = 'http://tank-monitor.propane.svc.cluster.local:3000/health' },
        @{ Path = '/api/orders/health'; Proxy = 'http://order-service.propane.svc.cluster.local:3001/health' },
        @{ Path = '/api/orders/latency-status'; Proxy = 'http://order-checkout-probe.propane.svc.cluster.local:4100/status'; IsDispatchOnly = $true }
    )

    foreach ($route in $requiredRoutes) {
        if ($route.IsDispatchOnly -and $name -ne 'dispatch-console-nginx') {
            continue
        }

        $locationText = "location = $($route.Path) {"
        if (-not $block.Contains($locationText)) {
            $failures.Add("$name is missing required route: $locationText")
            continue
        }

        $routeStart = $block.IndexOf($locationText)
        $nextLocationStart = $block.IndexOf("location ", $routeStart + $locationText.Length)
        if ($nextLocationStart -lt 0) {
            $nextLocationStart = $block.Length
        }

        $routeBlock = $block.Substring($routeStart, $nextLocationStart - $routeStart)

        if (-not $routeBlock.Contains($route.Proxy)) {
            $failures.Add("$name is missing the proxy target for $($route.Path): $($route.Proxy)")
        }

        foreach ($required in @('limit_except GET {', 'deny all;', $route.Proxy)) {
            if (-not $routeBlock.Contains($required)) {
                $failures.Add("$name is missing required policy in $($route.Path): $required")
            }
        }

        if ($route.Path -like '/api/orders/latency-status') {
            foreach ($forbidden in @(
                'if ($request_method',
                'if ($request_method !~',
                'if ($request_method !=',
                'proxy_pass http://order-checkout-probe.propane.svc.cluster.local:4100/;',
                'proxy_pass http://order-checkout-probe.propane.svc.cluster.local:4100/\$uri;',
                'proxy_pass http://order-checkout-probe.propane.svc.cluster.local:4100;'
            )) {
                if ($routeBlock.Contains($forbidden)) {
                    $failures.Add("$name has a method or target bypass in the latency-status route: $forbidden")
                }
            }
        }
    }

    if (-not ($block -match '(?m)location\s*/health\s*\{')) {
        $failures.Add("$name must preserve the /health endpoint used by the load balancer")
    }

    if (-not ($block -match '(?m)return\s+200\s+''\{"status":"ok"\}'';')) {
        $failures.Add("$name must preserve the root health response payload used by the portal")
    }

    if (-not ($block -match '(?m)location\s*/api/\s*\{')) {
        $failures.Add("$name is missing the /api/ catch-all block")
    }

    if (-not ($block -match '(?m)return\s+404;')) {
        $failures.Add("$name is missing the /api/ 404 guard")
    }

    $broadRoutePattern = '(?im)location\s+(?:=|\^~|~\*?|~)?\s*(?:\^)?/api/(?:inventory|tanks|orders)/(?!health\b)(?!latency-status\b)'
    if ($block -match $broadRoutePattern) {
        $failures.Add("$name still contains a broad /api/<service>/ route that bypasses the exact health-only policy")
    }

    foreach ($proxy in @(
        'proxy_pass http://inventory-service.propane.svc.cluster.local:3002/;',
        'proxy_pass http://tank-monitor.propane.svc.cluster.local:3000/;',
        'proxy_pass http://order-service.propane.svc.cluster.local:3001/;'
    )) {
        if ($block.Contains($proxy)) {
            $failures.Add("$name still proxies the broad $($proxy.Split(':')[-1]) backend without the health-only route restriction")
        }
    }

    $methodBypassPattern = '(?im)if\s*\(\s*\$request_method\s*(?:!~|!=|==)\s*[''\"]?GET[''\"]?\s*\)'
    if ($block -match $methodBypassPattern) {
        $failures.Add("$name still uses a request-method bypass that would allow non-GET access to the exact public API route")
    }
}

if ($failures.Count -gt 0) {
    Write-Error "Public API exposure validation failed:`n - $($failures -join "`n - ")"
    exit 1
}

Write-Host "Public API exposure validation passed for $ManifestPath"
