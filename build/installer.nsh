; Koinos Code on the PATH (task #60 v3b). The shim lives in
; $INSTDIR\resources\bin (shipped via win.extraResources); these macros add
; that dir to the USER Path on install and remove it on uninstall. PowerShell
; does the registry surgery because [Environment]::SetEnvironmentVariable
; both writes HKCU\Environment and broadcasts WM_SETTINGCHANGE, so NEW
; terminals see koinos-code immediately — no NSIS plugin dependency, no
; reboot. nsExec failures never abort the install: a missing PATH entry is
; an inconvenience, a failed install is a support ticket.
; ($$ is NSIS for a literal $, so $$p / $$bin / $$_ reach PowerShell intact.)

!macro customInstall
  DetailPrint "Adding koinos-code to the user PATH"
  nsExec::ExecToLog `powershell -NoProfile -ExecutionPolicy Bypass -Command "$$bin = '$INSTDIR\resources\bin'; $$p = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($$null -eq $$p) { $$p = '' }; if (($$p -split ';') -notcontains $$bin) { [Environment]::SetEnvironmentVariable('Path', (($$p.TrimEnd(';') + ';' + $$bin).TrimStart(';')), 'User') }"`
  Pop $0
!macroend

!macro customUnInstall
  DetailPrint "Removing koinos-code from the user PATH"
  nsExec::ExecToLog `powershell -NoProfile -ExecutionPolicy Bypass -Command "$$bin = '$INSTDIR\resources\bin'; $$p = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($$p) { $$parts = ($$p -split ';') | Where-Object { $$_ -and $$_ -ne $$bin }; [Environment]::SetEnvironmentVariable('Path', ($$parts -join ';'), 'User') }"`
  Pop $0
!macroend
