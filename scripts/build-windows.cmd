@echo off
rem -------------------------------------------------------------------------
rem build-windows.cmd — convenience wrapper around build-windows.ps1
rem
rem PowerShell scripts won't run by default on a clean Windows install
rem because the default ExecutionPolicy is "Restricted". This wrapper
rem launches the script with `-ExecutionPolicy Bypass` so users don't
rem have to permanently change their system policy just to build the app.
rem
rem Pass any flags through verbatim, e.g.:
rem   build-windows.cmd -Clean
rem -------------------------------------------------------------------------

setlocal
set "SCRIPT_DIR=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%build-windows.ps1" %*
exit /b %ERRORLEVEL%
