param(
  [Parameter(Mandatory = $true)][string]$ManifestPath,
  [Parameter(Mandatory = $true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'

$signTool = Get-Command signtool.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
if (-not $signTool) {
  $sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
  $signTool = Get-ChildItem -LiteralPath $sdkRoot -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName 'x64/signtool.exe' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
}
if (-not $signTool) { throw 'Windows SDK SignTool is required for release verification.' }

$files = @(Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json)
if ($files.Count -eq 0) { throw 'No Windows executables supplied for verification.' }
$results = @()
foreach ($file in $files) {
  $sig = Get-AuthenticodeSignature -LiteralPath $file
  $exitCode = -1
  if ($sig.Status -eq 'Valid') {
    # /pa checks public Authenticode trust; /all checks every embedded signature.
    # /tw warns for a missing timestamp. Both errors AND warnings fail the gate.
    & $signTool verify /pa /all /v /tw $file | Out-Host
    $exitCode = $LASTEXITCODE
  }
  $results += [pscustomobject]@{
    path = $file
    status = [string]$sig.Status
    signatureType = [string]$sig.SignatureType
    subject = $sig.SignerCertificate.Subject
    signerThumbprint = $sig.SignerCertificate.Thumbprint
    timestampThumbprint = $sig.TimeStamperCertificate.Thumbprint
    signToolExitCode = $exitCode
  }
}
ConvertTo-Json -InputObject $results -Depth 5 | Set-Content -LiteralPath $OutputPath -Encoding utf8
# Signature decisions are made by the caller for every returned file.
exit 0
