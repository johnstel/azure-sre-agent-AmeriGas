#Requires -Modules Pester

BeforeAll {
    $script:RepoRoot = Join-Path $PSScriptRoot ".." ".."
    $script:HelpersPath = Join-Path $script:RepoRoot "scripts" "demo-helpers.ps1"
    $script:LifecycleScript = Join-Path $script:RepoRoot "tools" "mission-control" "scenario-lifecycle.js"
}

Describe "Scenario lifecycle wrappers" {
    It "exposes the shared PowerShell lifecycle entry points" {
        . $script:HelpersPath

        Get-Command Start-DemoScenario | Should -Not -BeNullOrEmpty
        Get-Command Reset-DemoBaseline | Should -Not -BeNullOrEmpty
    }

    It "calls the shared mission-control lifecycle script instead of duplicating restore logic" {
        $content = Get-Content -Path $script:HelpersPath -Raw
        $content | Should -Match "Invoke-ScenarioLifecycle"
        $content | Should -Match "scenario-lifecycle\.js"
    }

    It "rejects malformed or unknown scenario ids before reaching the cluster" {
        $output = & node $script:LifecycleScript start --scenario-id not-real 2>&1 | Out-String
        $output | Should -Match "Unknown scenario|UNEXPECTED_ERROR|Scenario ID is required"
    }
}
