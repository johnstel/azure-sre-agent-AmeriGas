#Requires -Modules Pester
using namespace System.Management.Automation.Language

<#
.SYNOPSIS
    Regression guard: fails when a PowerShell script hard-codes a password.

.DESCRIPTION
    Parses every PowerShell script in the repository (*.ps1, *.psm1) and reports
    non-empty string literals used as passwords:
      - assigned to a password-like variable, member, or index ($rabbitPassword = '...')
      - used as a password-like parameter default (param($AdminPassword = '...'))
      - stored under a password-like hashtable key (@{ Password = '...' })
      - passed to a password-like parameter or native argument (-Password '...',
        --admin-password '...')
      - passed to ConvertTo-SecureString -AsPlainText
      - embedded in a string as password=... or scheme://user:...@host
    A name is password-like when its last word is pass, passwd, password,
    passphrase, pwd, or secret, so names such as $secretName and -PasswordFile
    are allowed.

    Findings list path:line, kind, and name only. The literal value is never
    printed, so CI logs cannot leak it. Generate credentials at runtime or read
    them from a Kubernetes Secret or Key Vault instead.

.EXAMPLE
    Invoke-Pester -Path scripts/tests/no-hardcoded-pwd.tests.ps1
#>

BeforeAll {
    $script:RepoRoot = (Resolve-Path -Path (Join-Path -Path $PSScriptRoot -ChildPath '..' -AdditionalChildPath '..')).Path
    $script:SelfPath = $PSCommandPath
    $script:PasswordWords = @('pass', 'passwd', 'password', 'passphrase', 'pwd', 'secret')
    # password=value or password: value, unless the value is a variable, expression, <placeholder>, or quoted.
    $script:InlinePasswordPattern = '(?i)(?<![a-z0-9])(?:pass(?:word|wd)?|pwd)[ \t]*[=:][ \t]*(?![\s$({<''"`])\S'
    # scheme://user:password@host with a literal password.
    $script:UriPasswordPattern = '(?i)\b[a-z][a-z0-9+.-]*://[^\s/:@''"$]+:(?![\s$({<])[^\s/@''"]+@'

    function Test-PasswordLikeName([string]$Name) {
        $bareName = $Name -replace '^(?:env|script|global|local|private|using):', ''
        $words = @($bareName -csplit '[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])' | Where-Object { $_ })
        return $words.Count -gt 0 -and $script:PasswordWords -contains $words[-1].ToLowerInvariant()
    }

    function Get-LiteralString($Ast) {
        # Unwraps casts, parentheses, and pipelines that start with a literal.
        # Returns $null when the value is computed at runtime.
        while ($true) {
            if ($Ast -is [PipelineAst]) { $Ast = $Ast.PipelineElements[0] }
            elseif ($Ast -is [CommandExpressionAst]) { $Ast = $Ast.Expression }
            elseif ($Ast -is [ConvertExpressionAst]) { $Ast = $Ast.Child }
            elseif ($Ast -is [ParenExpressionAst]) { $Ast = $Ast.Pipeline }
            else { break }
        }
        if ($Ast -is [StringConstantExpressionAst]) { return $Ast.Value }
        if ($Ast -is [ExpandableStringExpressionAst] -and $Ast.NestedExpressions.Count -eq 0) { return $Ast.Value }
        return $null
    }

    function Find-HardcodedPassword {
        param(
            [Parameter(Mandatory)][AllowEmptyString()][string]$Code,
            [Parameter(Mandatory)][string]$Label
        )
        $tokens = $null
        $parseErrors = $null
        $ast = [Parser]::ParseInput($Code, [ref]$tokens, [ref]$parseErrors)
        if ($parseErrors.Count -gt 0) {
            return "${Label}:$($parseErrors[0].Extent.StartLineNumber) parse error (fix the syntax so this file can be checked)"
        }

        foreach ($node in $ast.FindAll({ $true }, $true)) {
            $location = "${Label}:$($node.Extent.StartLineNumber)"
            if ($node -is [AssignmentStatementAst]) {
                $target = $node.Left
                while ($target -is [ConvertExpressionAst]) { $target = $target.Child }
                $name = if ($target -is [VariableExpressionAst]) { $target.VariablePath.UserPath }
                elseif ($target -is [MemberExpressionAst]) { $target.Member.Extent.Text }
                elseif ($target -is [IndexExpressionAst]) { Get-LiteralString $target.Index }
                if ($name -and (Test-PasswordLikeName $name) -and (Get-LiteralString $node.Right)) {
                    "$location assignment $name"
                }
            }
            elseif ($node -is [ParameterAst]) {
                $name = $node.Name.VariablePath.UserPath
                if ((Test-PasswordLikeName $name) -and (Get-LiteralString $node.DefaultValue)) {
                    "$location parameter default $name"
                }
            }
            elseif ($node -is [HashtableAst]) {
                foreach ($pair in $node.KeyValuePairs) {
                    $key = Get-LiteralString $pair.Item1
                    if ($key -and (Test-PasswordLikeName $key) -and (Get-LiteralString $pair.Item2)) {
                        "${Label}:$($pair.Item1.Extent.StartLineNumber) hashtable key $key"
                    }
                }
            }
            elseif ($node -is [CommandAst]) {
                $elements = $node.CommandElements
                $plainTextSecureString = $node.GetCommandName() -eq 'ConvertTo-SecureString' -and
                    @($elements | Where-Object { $_ -is [CommandParameterAst] -and $_.ParameterName -eq 'AsPlainText' }).Count -gt 0
                for ($i = 1; $i -lt $elements.Count; $i++) {
                    $element = $elements[$i]
                    $next = if ($i + 1 -lt $elements.Count -and $elements[$i + 1] -isnot [CommandParameterAst]) { $elements[$i + 1] }
                    if ($element -is [CommandParameterAst]) {
                        $value = if ($element.Argument) { $element.Argument } else { $next }
                        if ($value -and (Test-PasswordLikeName $element.ParameterName) -and (Get-LiteralString $value)) {
                            "${Label}:$($element.Extent.StartLineNumber) parameter -$($element.ParameterName)"
                        }
                    }
                    elseif ($element -is [StringConstantExpressionAst] -and $element.StringConstantType -eq 'BareWord' -and
                        $element.Value -match '^--?[A-Za-z][\w-]*$' -and (Test-PasswordLikeName $element.Value) -and
                        $next -and (Get-LiteralString $next)) {
                        "${Label}:$($element.Extent.StartLineNumber) native argument $($element.Value)"
                    }
                    elseif ($plainTextSecureString -and (Get-LiteralString $element)) {
                        "${Label}:$($element.Extent.StartLineNumber) ConvertTo-SecureString -AsPlainText literal"
                    }
                }
            }
            elseif ($node -is [StringConstantExpressionAst] -or $node -is [ExpandableStringExpressionAst]) {
                if ($node.Value -match $script:InlinePasswordPattern) { "$location password= literal in string" }
                if ($node.Value -match $script:UriPasswordPattern) { "$location user:password@ literal in URI" }
            }
        }
    }

    function Get-RepositoryScript([string]$Path) {
        foreach ($item in Get-ChildItem -LiteralPath $Path -Force) {
            if ($item.PSIsContainer) {
                if ($item.Name -notin '.git', 'node_modules') { Get-RepositoryScript $item.FullName }
            }
            elseif ($item.Extension -in '.ps1', '.psm1' -and $item.FullName -ne $script:SelfPath) { $item }
        }
    }
}

Describe 'Hard-coded password guard' {
    Context 'Detector' {
        It 'flags <Case>' -ForEach @(
            @{ Case = 'a literal assigned to a password variable'; Code = '$rabbitPassword = ''example-only''' }
            @{ Case = 'a literal assigned to an environment variable'; Code = '$env:RABBITMQ_DEFAULT_PASS = "example-only"' }
            @{ Case = 'a cast literal'; Code = '$demoPass = [string]''example-only''' }
            @{ Case = 'a literal assigned through an index'; Code = '$settings[''AdminPassword''] = ''example-only''' }
            @{ Case = 'a literal parameter default'; Code = 'param([string]$AdminPassword = ''example-only'')' }
            @{ Case = 'a literal in a hashtable'; Code = '$splat = @{ Password = ''example-only'' }' }
            @{ Case = 'a literal parameter value'; Code = 'New-LabUser -Password ''example-only''' }
            @{ Case = 'a literal native argument'; Code = 'az vm create --admin-password ''example-only''' }
            @{ Case = 'a literal ConvertTo-SecureString input'; Code = 'ConvertTo-SecureString ''example-only'' -AsPlainText -Force' }
            @{ Case = 'a literal piped into ConvertTo-SecureString'; Code = '$adminPwd = ''example-only'' | ConvertTo-SecureString -AsPlainText -Force' }
            @{ Case = 'a literal kubectl Secret value'; Code = 'kubectl create secret generic demo --from-literal=password=example-only' }
            @{ Case = 'a literal in a connection URI'; Code = '$uri = ''amqp://demo-user:example-only@rabbitmq:5672/''' }
        ) {
            Find-HardcodedPassword -Code $Code -Label 'sample' | Should -Not -BeNullOrEmpty
        }

        It 'allows <Case>' -ForEach @(
            @{ Case = 'a runtime-generated password'; Code = '$demoPass = [Convert]::ToBase64String($bytes) -replace ''[^A-Za-z0-9]'', ''''' }
            @{ Case = 'an empty initializer'; Code = '$password = ''''' }
            @{ Case = 'a value read from the environment'; Code = '$password = $env:RABBITMQ_PASSWORD' }
            @{ Case = 'a prompted password'; Code = '$password = Read-Host -AsSecureString' }
            @{ Case = 'a secret name'; Code = '$secretName = ''rabbitmq-credentials''' }
            @{ Case = 'a password file path'; Code = 'Import-LabUser -PasswordFile ''./lab-user.json''' }
            @{ Case = 'a variable native argument'; Code = 'az vm create --admin-password $adminPassword' }
            @{ Case = 'a variable ConvertTo-SecureString input'; Code = 'ConvertTo-SecureString $plainText -AsPlainText -Force' }
            @{ Case = 'an interpolated kubectl Secret value'; Code = 'kubectl create secret generic demo --from-literal="password=$demoPass"' }
            @{ Case = 'an interpolated connection URI'; Code = '$uri = "amqp://${demoUser}:${demoPass}@rabbitmq:5672/"' }
        ) {
            Find-HardcodedPassword -Code $Code -Label 'sample' | Should -BeNullOrEmpty
        }
    }

    Context 'Repository scripts' {
        It 'contain no hard-coded passwords' {
            $scripts = @(Get-RepositoryScript $script:RepoRoot)
            $scripts.Count | Should -BeGreaterThan 0

            $findings = foreach ($file in $scripts) {
                $relativePath = [System.IO.Path]::GetRelativePath($script:RepoRoot, $file.FullName) -replace '\\', '/'
                Find-HardcodedPassword -Code ([System.IO.File]::ReadAllText($file.FullName)) -Label $relativePath
            }

            $findings | Should -BeNullOrEmpty -Because 'credentials must be generated at runtime or read from a secret store, never hard-coded'
        }
    }
}
