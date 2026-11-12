@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deployment\stop-windows.ps1" %*
set "BLSD_EXIT=%ERRORLEVEL%"
if not "%BLSD_EXIT%"=="0" pause
exit /b %BLSD_EXIT%
