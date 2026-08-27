@echo off
setlocal EnableExtensions
chcp 65001 >nul
set "ROOT=%~dp0"
set "CORE=%ROOT%sync-local-windows-core.ps1"
set "AGENT=%ROOT%openclaw-sync.cjs"
powershell -NoProfile -ExecutionPolicy Bypass -File "%CORE%" -AgentPath "%AGENT%" -Command "%~1"
exit /b %ERRORLEVEL%
