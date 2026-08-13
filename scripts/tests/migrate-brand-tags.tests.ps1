#Requires -Modules Pester

<#
.SYNOPSIS
    Pester tests for scripts/migrate-brand-tags.ps1

.DESCRIPTION
    All Azure/`kubectl` calls are mocked in every test in this file — there
    is no live Azure environment available (no rg-srelab* resource group
    exists in the target subscription), so none of these tests make a real
    `az` or `kubectl` call. Coverage:
      - -WhatIf never calls the mutating `az tag update` / `kubectl apply`
        commands.
      - A resource already tagged with the new slug is left alone (no-op).
      - A resource group / child resource missing entirely throws instead
        of silently reporting success.
      - Tag verification failure (the re-read tag doesn't match what was
        just written) throws instead of reporting success.
      - The Kubernetes reapply step regenerates the partner-catalog-config
        ConfigMap from the real repo file and reapplies
        k8s/base/application.yaml, without ever passing --prune (i.e.
        never deletes anything).

.EXAMPLE
    Invoke-Pester -Path scripts/tests/migrate-brand-tags.tests.ps1
#>

BeforeAll {
    $script:MigrationScriptPath = Join-Path $PSScriptRoot ".." "migrate-brand-tags.ps1"
    $script:RepoRoot = Join-Path $PSScriptRoot ".." ".."

    # Dot-source with dummy mandatory parameter values so the file's own
    # top-level execution block (guarded by
    # `$MyInvocation.InvocationName -ne '.'`) is a no-op, and only the
    # reusable functions are defined in this scope.
    . $script:MigrationScriptPath -SubscriptionId 'sub-dotsource' -ResourceGroupName 'rg-dotsource' -SkipKubernetesApply
}

Describe "Update-BrandWorkloadTag" {
    Context "resource with no workload tag at all" {
        It "is skipped and never calls az tag update" {
            Mock az { throw "az should not be called when there is no workload tag" }
            $result = Update-BrandWorkloadTag -SubscriptionId 'sub-1' -ResourceId '/subscriptions/sub-1/resourceGroups/rg-1' -DisplayName 'rg-1' -CurrentWorkloadTag $null
            $result | Should -Be $false
        }
    }

    Context "resource already tagged with the new slug" {
        It "is a no-op and never calls az tag update" {
            Mock az { throw "az should not be called when the tag already matches" }
            $result = Update-BrandWorkloadTag -SubscriptionId 'sub-1' -ResourceId '/subscriptions/sub-1/resourceGroups/rg-1' -DisplayName 'rg-1' -CurrentWorkloadTag 'zavagas-propane-demo'
            $result | Should -Be $false
        }
    }

    Context "-WhatIf" {
        It "never calls az tag update" {
            Mock az { throw "az tag update should not be called under -WhatIf" }
            $result = Update-BrandWorkloadTag -SubscriptionId 'sub-1' -ResourceId '/subscriptions/sub-1/resourceGroups/rg-1' -DisplayName 'rg-1' -CurrentWorkloadTag 'amerigas-propane-demo' -WhatIf
            $result | Should -Be $false
        }
    }

    Context "real update with successful verification" {
        It "calls az tag update, re-reads the resource, and confirms the new tag" {
            Mock az {
                $global:LASTEXITCODE = 0
                if ($args[0] -eq 'tag') { return $null }
                if ($args[0] -eq 'resource' -and $args[1] -eq 'show') {
                    return (@{ tags = @{ workload = 'zavagas-propane-demo' } } | ConvertTo-Json -Depth 5 -Compress)
                }
                throw "unexpected az invocation: $($args -join ' ')"
            }
            $result = Update-BrandWorkloadTag -SubscriptionId 'sub-1' -ResourceId '/subscriptions/sub-1/resourceGroups/rg-1' -DisplayName 'rg-1' -CurrentWorkloadTag 'amerigas-propane-demo'
            $result | Should -Be $true
            Should -Invoke az -Times 1 -ParameterFilter { $args[0] -eq 'tag' }
            Should -Invoke az -Times 1 -ParameterFilter { $args[0] -eq 'resource' -and $args[1] -eq 'show' }
        }
    }

    Context "verification failure (re-read tag does not match what was written)" {
        It "throws instead of silently reporting success" {
            Mock az {
                $global:LASTEXITCODE = 0
                if ($args[0] -eq 'tag') { return $null }
                if ($args[0] -eq 'resource' -and $args[1] -eq 'show') {
                    return (@{ tags = @{ workload = 'amerigas-propane-demo' } } | ConvertTo-Json -Depth 5 -Compress)
                }
                throw "unexpected az invocation: $($args -join ' ')"
            }
            { Update-BrandWorkloadTag -SubscriptionId 'sub-1' -ResourceId '/subscriptions/sub-1/resourceGroups/rg-1' -DisplayName 'rg-1' -CurrentWorkloadTag 'amerigas-propane-demo' } | Should -Throw "*verification FAILED*"
        }
    }

    Context "az tag update failure" {
        It "throws a clear, specific error rather than swallowing the failure" {
            Mock az {
                $global:LASTEXITCODE = 1
                return $null
            }
            { Update-BrandWorkloadTag -SubscriptionId 'sub-1' -ResourceId '/subscriptions/sub-1/resourceGroups/rg-1' -DisplayName 'rg-1' -CurrentWorkloadTag 'amerigas-propane-demo' } | Should -Throw "*Failed to update tags*"
        }
    }
}

Describe "Get-MigrationResourceGroup" {
    It "throws a clear error when the resource group does not exist (never silently continues)" {
        Mock az {
            $global:LASTEXITCODE = 1
            return ''
        }
        { Get-MigrationResourceGroup -SubscriptionId 'sub-1' -ResourceGroupName 'rg-does-not-exist' } | Should -Throw "*rg-does-not-exist*was not found*"
    }

    It "returns the parsed resource group when it exists" {
        Mock az {
            $global:LASTEXITCODE = 0
            return (@{ id = '/subscriptions/sub-1/resourceGroups/rg-1'; name = 'rg-1'; tags = @{ workload = 'amerigas-propane-demo' } } | ConvertTo-Json -Depth 5 -Compress)
        }
        $rg = Get-MigrationResourceGroup -SubscriptionId 'sub-1' -ResourceGroupName 'rg-1'
        $rg.name | Should -Be 'rg-1'
        $rg.tags.workload | Should -Be 'amerigas-propane-demo'
    }
}

Describe "Update-BrandWorkloadTagsInResourceGroup" {
    It "migrates the resource group and only the child resources that carry the old tag" {
        Mock az {
            $global:LASTEXITCODE = 0
            if ($args[0] -eq 'group' -and $args[1] -eq 'show') {
                return (@{ id = '/subscriptions/sub-1/resourceGroups/rg-1'; name = 'rg-1'; tags = @{ workload = 'amerigas-propane-demo' } } | ConvertTo-Json -Depth 5 -Compress)
            }
            if ($args[0] -eq 'resource' -and $args[1] -eq 'list') {
                return (@(
                    @{ id = '/subscriptions/sub-1/resourceGroups/rg-1/providers/x/aks-srelab'; name = 'aks-srelab'; tags = @{ workload = 'amerigas-propane-demo' } },
                    @{ id = '/subscriptions/sub-1/resourceGroups/rg-1/providers/x/already-migrated'; name = 'already-migrated'; tags = @{ workload = 'zavagas-propane-demo' } },
                    @{ id = '/subscriptions/sub-1/resourceGroups/rg-1/providers/x/untagged'; name = 'untagged'; tags = $null }
                ) | ConvertTo-Json -Depth 5)
            }
            if ($args[0] -eq 'tag') { return $null }
            if ($args[0] -eq 'resource' -and $args[1] -eq 'show') {
                return (@{ tags = @{ workload = 'zavagas-propane-demo' } } | ConvertTo-Json -Depth 5 -Compress)
            }
            throw "unexpected az invocation: $($args -join ' ')"
        }

        $summary = Update-BrandWorkloadTagsInResourceGroup -SubscriptionId 'sub-1' -ResourceGroupName 'rg-1'

        $summary.ResourceGroupUpdated | Should -Be $true
        $summary.ChildResourcesTotal | Should -Be 3
        # Only 'aks-srelab' actually needed migrating; the other two are
        # already-migrated / untagged and must NOT trigger a tag update.
        $summary.ChildResourcesUpdated | Should -Be 1
        Should -Invoke az -Times 2 -ParameterFilter { $args[0] -eq 'tag' }
    }
}

Describe "Invoke-BrandKubernetesReapply" {
    It "regenerates the partner-catalog-config ConfigMap from the real repo file and reapplies the base manifest, never with --prune" {
        Mock kubectl {
            $global:LASTEXITCODE = 0
            if (($args -join ' ') -match '--prune') {
                throw "kubectl must never be invoked with --prune by the migration script (that would delete resources)"
            }
            return 'configmap/partner-catalog-config configured'
        }

        Invoke-BrandKubernetesReapply -RepoRoot $script:RepoRoot -Namespace 'propane'

        Should -Invoke kubectl -ParameterFilter { ($args -join ' ') -match 'create' -and ($args -join ' ') -match 'configmap' -and ($args -join ' ') -match 'partner-catalog-config' }
        Should -Invoke kubectl -ParameterFilter { ($args -join ' ') -match 'apply' -and ($args -join ' ') -match 'application\.yaml' }
    }

    It "-WhatIf never calls kubectl" {
        Mock kubectl { throw "kubectl should not be called under -WhatIf" }
        Invoke-BrandKubernetesReapply -RepoRoot $script:RepoRoot -Namespace 'propane' -WhatIf
        Should -Invoke kubectl -Times 0
    }

    It "throws when the shared partner catalog file cannot be found" {
        { Invoke-BrandKubernetesReapply -RepoRoot (Join-Path $script:RepoRoot 'does-not-exist') -Namespace 'propane' } | Should -Throw "*partner-catalog.json*"
    }
}
