@echo off
rem koinos-code — the coding agent CLI, run through the installed app's own
rem Electron (ELECTRON_RUN_AS_NODE makes it plain Node). Lives in
rem   <install dir>\resources\bin\  (this dir is added to the user PATH by
rem the installer and removed by the uninstaller). The CLI and its one
rem dependency (ui\agents.js) are asar-UNPACKED so a plain file path works.
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\Koinos AI.exe" "%~dp0..\app.asar.unpacked\cli\koinos-code.js" %*
exit /b %ERRORLEVEL%
