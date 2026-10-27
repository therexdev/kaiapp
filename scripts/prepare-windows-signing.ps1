[CmdletBinding()]
param(
  [switch]$VerifyOnly,
  [switch]$AutoloadOnly
)

$script:KaiTrustedSigningScriptPath = $PSCommandPath

# electron-builder starts a fresh pwsh process for each signature. An
# Install-Module process can exit successfully after a non-terminating error,
# so a successful download command alone is not proof signing can begin.
function Assert-KaiTrustedSigning {
  param([switch]$Autoload)
  $ErrorActionPreference = 'Stop'
  $minimum = [version]'0.5.0' # Same minimum required by the locked builder.
  if (-not $Autoload) {
    $available = @(Get-Module -ListAvailable -Name TrustedSigning | Where-Object { $_.Version -ge $minimum })
    if ($available.Count -eq 0) { throw 'TrustedSigning is not installed in this PowerShell module search path.' }
    Import-Module -Name TrustedSigning -MinimumVersion $minimum -Force -ErrorAction Stop
  }
  $command = Get-Command -Name Invoke-TrustedSigning -ErrorAction Stop
  if ($command.ModuleName -ne 'TrustedSigning' -or $command.Module.Version -lt $minimum) {
    throw 'Invoke-TrustedSigning did not resolve to the required TrustedSigning module.'
  }
  Write-Output ('TrustedSigning {0}: {1} verified.' -f $command.Module.Version, $(if ($Autoload) { 'fresh-process autoload' } else { 'explicit import' }))
}

function Initialize-KaiTrustedSigning {
  $ErrorActionPreference = 'Stop'
  $powerShell = (Get-Command -Name pwsh.exe -ErrorAction Stop).Source
  if (-not $powerShell) { throw 'PowerShell 7 is required for Windows signing.' }
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      if (-not (Get-PackageProvider -Name NuGet -ListAvailable -ErrorAction SilentlyContinue)) {
        Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser -ErrorAction Stop | Out-Null
      }
      Install-Module -Name TrustedSigning -MinimumVersion 0.5.0 -Force -Repository PSGallery -Scope CurrentUser -ErrorAction Stop
      & $powerShell -NoProfile -NonInteractive -File $script:KaiTrustedSigningScriptPath -VerifyOnly
      if ($LASTEXITCODE -ne 0) { throw 'TrustedSigning explicit-import verification failed.' }
      & $powerShell -NoProfile -NonInteractive -File $script:KaiTrustedSigningScriptPath -AutoloadOnly
      if ($LASTEXITCODE -ne 0) { throw 'TrustedSigning fresh-process command verification failed.' }
      return
    } catch {
      if ($attempt -eq 3) { throw 'TrustedSigning installation or command verification failed after three attempts. Windows packaging was not started.' }
      Write-Warning ('TrustedSigning preparation attempt {0} failed; retrying the module installation.' -f $attempt)
      Start-Sleep -Seconds (2 * $attempt)
    }
  }
}

# Dot-sourcing supports isolated native tests with an in-memory installer stub;
# the release calls this file directly and never substitutes the signer.
if ($MyInvocation.InvocationName -ne '.') {
  $ErrorActionPreference = 'Stop'
  if (-not $IsWindows) { throw 'This signing prerequisite is for Windows runners only.' }
  if ($VerifyOnly -and $AutoloadOnly) { throw 'Choose one verification mode.' }
  if ($VerifyOnly) { Assert-KaiTrustedSigning }
  elseif ($AutoloadOnly) { Assert-KaiTrustedSigning -Autoload }
  else { Initialize-KaiTrustedSigning }
}
