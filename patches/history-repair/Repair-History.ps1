#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$NodeRoot = (Join-Path $env:APPDATA 'Master Koinos AI Node\core\koinos-node\node\mainnet'),
    [string]$BackupDirectory = '',
    [switch]$CheckOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Docker-Text([string[]]$DockerArguments) {
    $output = & docker @DockerArguments
    if ($LASTEXITCODE -ne 0) { throw "Docker failed (exit $LASTEXITCODE). No further steps will run." }
    return (($output | Out-String).Trim())
}

try {
    $bundle = $PSScriptRoot
    $manifest = Get-Content -LiteralPath (Join-Path $bundle 'manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.repair -ne 'mainnet-6033632-v1' -or $manifest.platform -ne 'linux/amd64') {
        throw 'This is not the expected repair package.'
    }
    $expectedFiles = @('kai_history_repair', 'Repair-History.ps1', 'Start-Repair.cmd', 'README.txt', 'LICENSE.md', 'provenance.json')
    if (@($manifest.files).Count -ne $expectedFiles.Count) { throw 'Incomplete package manifest.' }
    foreach ($name in $expectedFiles) {
        $entry = @($manifest.files | Where-Object { $_.name -eq $name })
        if ($entry.Count -ne 1) { throw "Missing or repeated checksum: $name" }
        $actual = (Get-FileHash -LiteralPath (Join-Path $bundle $name) -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $entry[0].sha256) { throw "Package checksum failed: $name. Download and extract the package again." }
    }
    if (@(Get-Process -Name 'Master Koinos AI Node' -ErrorAction SilentlyContinue).Count -ne 0) {
        throw 'Stop the node in Master, wait for it to finish, then Quit Master from the tray before running this helper.'
    }
    if ((Docker-Text @('info', '--format', '{{.OSType}}')) -ne 'linux') { throw 'Docker Desktop must be running Linux containers.' }
    $running = Docker-Text @('ps', '-q', '--filter', 'label=com.docker.compose.project=koinos-desktop-mainnet')
    if ($running) { throw 'Mainnet containers are still running. Use Stop in Master, wait for completion, then Quit Master.' }
    $database = Join-Path $NodeRoot 'basedir\block_store\db'
    if (-not (Test-Path -LiteralPath (Join-Path $database 'MANIFEST') -PathType Leaf)) { throw "Existing block-store database not found at $database" }
    $database = (Resolve-Path -LiteralPath $database).Path
    $image = Docker-Text @('image', 'inspect', 'koinos/koinos-block-store:v1.1.0', '--format', '{{.Id}}')
    if ($image -notmatch '^sha256:[0-9a-f]{64}$') { throw 'The installed block-store image was not found.' }
    foreach ($path in @($database, $bundle)) { if ($path.Contains(',')) { throw 'Docker mount paths cannot contain commas.' } }
    $baseArgs = @('run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '0:0', '--tmpfs', '/tmp:rw,exec,size=64m', '--mount', "type=bind,source=$bundle,target=/repair,readonly", '--entrypoint', '/bin/sh')
    $launcher = 'cp /repair/kai_history_repair /tmp/kai_history_repair && chmod 700 /tmp/kai_history_repair && exec /tmp/kai_history_repair'
    Write-Host "Database: $database"
    Write-Host 'Checking the repair without changing database records...'
    $checkArgs = $baseArgs + @('--mount', "type=bind,source=$database,target=/database,readonly", $image, '-c', "$launcher --db /database --check")
    & docker @checkArgs
    if ($LASTEXITCODE -ne 0) { throw 'Preflight failed. No repair was attempted. Keep account history paused and share the output.' }
    if ($CheckOnly) { return }
    if (-not $BackupDirectory) { $BackupDirectory = Join-Path $NodeRoot 'history-repair-backups' }
    $null = New-Item -ItemType Directory -Path $BackupDirectory -Force
    $BackupDirectory = (Resolve-Path -LiteralPath $BackupDirectory).Path
    if ($BackupDirectory.Contains(',')) { throw 'Backup path cannot contain commas.' }
    if ($BackupDirectory.StartsWith($database.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or $BackupDirectory -eq $database) { throw 'The backup must be outside the live database directory.' }
    $size = (Get-ChildItem -LiteralPath $database -File -Recurse | Measure-Object -Property Length -Sum).Sum
    $drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($BackupDirectory).TrimEnd('\').TrimEnd(':'))
    $estimate = [double]$size * 1.25 + 1GB
    if ($drive.Free -lt $estimate) {
        throw ('Insufficient backup space on this drive. Estimated headroom: {0:N1} GiB; free: {1:N1} GiB. Run with -BackupDirectory on a drive with more space.' -f ($estimate / 1GB), ($drive.Free / 1GB))
    }
    $backupName = 'block-store-before-6033632-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + ([Guid]::NewGuid().ToString('N').Substring(0,8)) + '.bak'
    Write-Host "Backup folder: $BackupDirectory"
    Write-Host 'A complete logical backup will finish before the single missing record is written.'
    Write-Host 'Keep Master and the node stopped. Backup time depends on your database size and drive speed.'
    # Recheck immediately before the writable invocation. The helper also takes
    # Badger's exclusive database lock and repeats the complete preflight.
    if ((Docker-Text @('ps', '-q', '--filter', 'label=com.docker.compose.project=koinos-desktop-mainnet'))) { throw 'The node restarted. Repair cancelled.' }
    if (@(Get-Process -Name 'Master Koinos AI Node' -ErrorAction SilentlyContinue).Count -ne 0) { throw 'Master restarted. Repair cancelled.' }
    $repairArgs = $baseArgs + @('--mount', "type=bind,source=$database,target=/database", '--mount', "type=bind,source=$BackupDirectory,target=/backups", $image, '-c', "$launcher --db /database --repair --backup /backups/$backupName")
    & docker @repairArgs
    if ($LASTEXITCODE -ne 0) { throw 'Repair did not complete. Keep the node stopped, retain the backup and share this output.' }
    Write-Host ''
    Write-Host 'SUCCESS. Reopen Master and Start the node. Account history should now pass height 6,033,632.'
    Write-Host 'Keep the backup. Other historical gaps may still exist; full history is not yet verified.'
} catch {
    Write-Host ''
    Write-Host ('STOPPED: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
