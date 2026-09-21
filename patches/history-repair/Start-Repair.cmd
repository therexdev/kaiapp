@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Repair-History.ps1"
if errorlevel 1 (
  echo Repair stopped. Keep this window open and share its output.
)
pause
