# Real Windows PowerShell 5.1 parsing and orchestration tests. Docker is mocked;
# the Linux job separately runs the compiled helper inside the original image.
param([string]$Bundle = (Join-Path $PSScriptRoot '..\build\history-repair'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$temp = Join-Path ([IO.Path]::GetTempPath()) ('kai repair Windows test ' + [Guid]::NewGuid().ToString('N'))
$nodeRoot = Join-Path $temp 'Master Koinos AI Node\mainnet'
$db = Join-Path $nodeRoot 'basedir\block_store\db'
$null = New-Item -ItemType Directory -Path $db -Force
Set-Content -LiteralPath (Join-Path $db 'MANIFEST') -Value 'fixture; never a live database'
$copy = Join-Path $temp 'repair package'
Copy-Item -LiteralPath $Bundle -Destination $copy -Recurse
$script = Join-Path $copy 'Repair-History.ps1'
$tokens = $null; $parseErrors = $null
$null = [Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$global:RepairCalls = [Collections.Generic.List[object]]::new()
$global:RepairRunning = $false
$global:RepairDockerFail = $false
function global:docker {
    $a = @($args)
    $global:RepairCalls.Add($a)
    $global:LASTEXITCODE = 0
    switch ($a[0]) {
        'info' { 'linux'; return }
        'ps' { if ($global:RepairRunning) { 'fixture-running-container' }; return }
        'image' { 'sha256:' + ('a' * 64); return }
        'run' { if ($global:RepairDockerFail) { $global:LASTEXITCODE = 17; return }; 'fixture helper succeeded'; return }
        default { throw ('Unexpected Docker operation: ' + ($a -join ' ')) }
    }
}
function Assert-Case([bool]$condition,[string]$message) { if (-not $condition) { throw $message } }
try {
    & $script -NodeRoot $nodeRoot -CheckOnly
    Assert-Case ($LASTEXITCODE -eq 0) 'Read-only preflight failed.'
    $runs = @($global:RepairCalls | Where-Object { $_[0] -eq 'run' })
    Assert-Case ($runs.Count -eq 1) 'Unexpected invocation count for CheckOnly.'
    Assert-Case (($runs[0] -join '|').Contains("source=$db,target=/database,readonly")) 'Read-only DB mount lost or path with spaces split.'
    Assert-Case (($runs[0] -join '|').Contains('--network|none')) 'Network isolation lost.'
    $global:RepairCalls.Clear()
    & $script -NodeRoot $nodeRoot
    Assert-Case ($LASTEXITCODE -eq 0) 'Repair orchestration failed.'
    $runs = @($global:RepairCalls | Where-Object { $_[0] -eq 'run' })
    Assert-Case ($runs.Count -eq 2) 'Expected preflight plus repair.'
    Assert-Case (($runs[1] -join '|').Contains('--repair --backup /backups/')) 'Missing mandatory backup argument.'
    Assert-Case (-not (($runs[1] -join '|').Contains("source=$db,target=/database,readonly"))) 'Repair DB mount remained read-only.'
    Assert-Case (-not (@($global:RepairCalls | Where-Object { $_[0] -in @('stop','start','restart','rm','compose') }).Count)) 'Wrapper changed existing services.'
    $global:RepairRunning = $true; $global:RepairCalls.Clear()
    & $script -NodeRoot $nodeRoot -CheckOnly
    Assert-Case ($LASTEXITCODE -eq 1) 'Running node was accepted.'
    Assert-Case (-not (@($global:RepairCalls | Where-Object { $_[0] -eq 'run' }).Count)) 'Started helper against running node.'
    $global:RepairRunning = $false; $global:RepairDockerFail = $true; $global:RepairCalls.Clear()
    & $script -NodeRoot $nodeRoot
    Assert-Case ($LASTEXITCODE -eq 1) 'Failed preflight was ignored.'
    Assert-Case (@($global:RepairCalls | Where-Object { $_[0] -eq 'run' }).Count -eq 1) 'Repair ran after failed preflight.'
    $global:RepairDockerFail = $false; $global:RepairCalls.Clear()
    Add-Content -LiteralPath (Join-Path $copy 'kai_history_repair') -Value 'tamper'
    & $script -NodeRoot $nodeRoot -CheckOnly
    Assert-Case ($LASTEXITCODE -eq 1) 'Tampered binary accepted.'
    Assert-Case ($global:RepairCalls.Count -eq 0) 'Docker ran before checksum rejection.'
    Write-Host 'Windows PowerShell checks passed: paths with spaces, backup arguments, stopped-node requirement, Docker failures, checksum failures, offline mounts.'
    $global:LASTEXITCODE = 0
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force
    Remove-Item Function:\docker
}
