@echo off
setlocal EnableExtensions
chcp 65001 >nul
set "ROOT=%~dp0.."
set "CORE=%~dp0sync-local-windows-core.ps1"
set "AGENT=%ROOT%\apps\openclaw-sync\dist\index.cjs"
powershell -NoProfile -ExecutionPolicy Bypass -File "%CORE%" -AgentPath "%AGENT%" -ProjectRoot "%ROOT%" -BuildFromSource -Command "%~1"
exit /b %ERRORLEVEL%
