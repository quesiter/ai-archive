@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

if /I "%~1"=="help" goto :usage
if /I "%~1"=="/?" goto :usage
if /I "%~1"=="-h" goto :usage
if /I "%~1"=="--help" goto :usage

set "ROOT=%~dp0"
set "AGENT=%ROOT%openclaw-sync.cjs"
if not exist "%AGENT%" (
  echo Missing sync agent: %AGENT%
  echo Do not copy this .bat file alone.
  echo Please copy the whole extracted folder, or at least keep sync-local-windows.bat and openclaw-sync.cjs in the same folder.
  goto :failed
)

set "SERVER_URL=%AI_ARCHIVE_SERVER%"
if "%SERVER_URL%"=="" set "SERVER_URL=https://ai-archive.gyee.tech:18443"

set "CONFIG_PATH=%AI_ARCHIVE_SYNC_CONFIG%"
if "%CONFIG_PATH%"=="" set "CONFIG_PATH=%USERPROFILE%\.config\ai-archive\openclaw-sync.json"

set "CODEX_ROOT=%AI_ARCHIVE_CODEX_ROOT%"
if "%CODEX_ROOT%"=="" set "CODEX_ROOT=%USERPROFILE%\.codex"

set "OPENCLAW_ROOT=%AI_ARCHIVE_OPENCLAW_ROOT%"
if "%OPENCLAW_ROOT%"=="" set "OPENCLAW_ROOT=%USERPROFILE%\.openclaw"

set "CLAUDE_CODE_ROOT=%AI_ARCHIVE_CLAUDE_CODE_ROOT%"
if "%CLAUDE_CODE_ROOT%"=="" if exist "%USERPROFILE%\.claude" set "CLAUDE_CODE_ROOT=%USERPROFILE%\.claude"

set "SAFE_RECENT_DAYS=%AI_ARCHIVE_SAFE_RECENT_DAYS%"
if "%SAFE_RECENT_DAYS%"=="" set "SAFE_RECENT_DAYS=14"

set "SAFE_MAX_FILES=%AI_ARCHIVE_SAFE_MAX_FILES%"
if "%SAFE_MAX_FILES%"=="" set "SAFE_MAX_FILES=60"

set "SAFE_MAX_FILE_MB=%AI_ARCHIVE_SAFE_MAX_FILE_MB%"
if "%SAFE_MAX_FILE_MB%"=="" set "SAFE_MAX_FILE_MB=50"

set "SAFE_MAX_MESSAGES=%AI_ARCHIVE_SAFE_MAX_MESSAGES%"
if "%SAFE_MAX_MESSAGES%"=="" set "SAFE_MAX_MESSAGES=12000"

set "SAFE_DELAY_MS=%AI_ARCHIVE_SYNC_DELAY_MS%"
if "%SAFE_DELAY_MS%"=="" set "SAFE_DELAY_MS=750"

set "NODE_OPTIONS=--max-old-space-size=4096 %NODE_OPTIONS%"

echo.
echo AI Conversation Archive - Windows portable local sync
echo Folder : %ROOT%
echo Server : %SERVER_URL%
echo Codex  : %CODEX_ROOT%
echo Config : %CONFIG_PATH%
echo Safety: recent %SAFE_RECENT_DAYS%d, max %SAFE_MAX_FILES% files, max %SAFE_MAX_FILE_MB% MB/file, max %SAFE_MAX_MESSAGES% messages/session
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH. Install Node.js 22 or newer first.
  echo Download: https://nodejs.org/
  goto :failed
)
set "NODE_MAJOR="
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%v"
if "%NODE_MAJOR%"=="" (
  echo Could not check Node.js version.
  goto :failed
)
if %NODE_MAJOR% LSS 22 (
  for /f "delims=" %%v in ('node -v 2^>nul') do set "NODE_VERSION=%%v"
  echo Node.js 22 or newer is required. Current version: %NODE_VERSION%
  echo Download: https://nodejs.org/
  goto :failed
)

if not exist "%CONFIG_PATH%" (
  echo.
  echo First run: create an OpenClaw/Codex sync pairing code in the web console.
  set /p PAIR_CODE=Pairing code: 
  if "!PAIR_CODE!"=="" (
    echo Pairing code is required on first run.
    goto :failed
  )

  if not "%CLAUDE_CODE_ROOT%"=="" (
    call node "%AGENT%" pair --server "%SERVER_URL%" --code "!PAIR_CODE!" --openclaw-root "%OPENCLAW_ROOT%" --codex-root "%CODEX_ROOT%" --claude-code-root "%CLAUDE_CODE_ROOT%"
  ) else (
    call node "%AGENT%" pair --server "%SERVER_URL%" --code "!PAIR_CODE!" --openclaw-root "%OPENCLAW_ROOT%" --codex-root "%CODEX_ROOT%"
  )
  if errorlevel 1 goto :failed
) else (
  echo Existing pairing config found; pairing step skipped.
)

echo.
if /I "%~1"=="full-rebuild" goto :full_rebuild
if /I "%~1"=="rebuild-all" goto :full_rebuild
if /I "%~1"=="watch-only" goto :watch_only

echo Importing recent local history in safe mode...
call node "%AGENT%" rebuild --recent-days "%SAFE_RECENT_DAYS%" --max-files "%SAFE_MAX_FILES%" --max-file-mb "%SAFE_MAX_FILE_MB%" --max-messages "%SAFE_MAX_MESSAGES%" --delay-ms "%SAFE_DELAY_MS%"
if errorlevel 1 goto :failed

if /I "%~1"=="rebuild-only" goto :done
if /I "%~1"=="once" goto :done

:watch_only
echo.
echo Watching for new local conversations. Keep this window open.
echo Press Ctrl+C to stop.
call node "%AGENT%" run --recent-days "%SAFE_RECENT_DAYS%" --max-files "%SAFE_MAX_FILES%" --max-file-mb "%SAFE_MAX_FILE_MB%" --max-messages "%SAFE_MAX_MESSAGES%" --delay-ms "%SAFE_DELAY_MS%" --skip-initial-scan
if errorlevel 1 goto :failed
goto :done

:full_rebuild
echo.
echo Full rebuild requested. This can be heavy on CPU, disk, network and the archive server.
echo Close other heavy apps first. The command will reset sync state and import all local transcript files.
call node "%AGENT%" full-rebuild --delay-ms "%SAFE_DELAY_MS%"
if errorlevel 1 goto :failed

:done
echo.
echo Local sync finished.
exit /b 0

:failed
echo.
echo Local sync failed. Check the error above.
pause
exit /b 1

:usage
echo AI Conversation Archive Windows portable local sync
echo.
echo Usage:
echo   sync-local-windows.bat              Safe recent import, then watch future changes.
echo   sync-local-windows.bat rebuild-only Safe recent import once.
echo   sync-local-windows.bat once         Same as rebuild-only.
echo   sync-local-windows.bat watch-only   Watch future changes without an initial scan.
echo   sync-local-windows.bat full-rebuild Explicit full import of all local history.
echo.
echo Requirements:
echo   Node.js 22 or newer must be installed and available in PATH.
echo.
echo Environment overrides:
echo   AI_ARCHIVE_SERVER=https://ai-archive.gyee.tech:18443
echo   AI_ARCHIVE_CODEX_ROOT=%%USERPROFILE%%\.codex
echo   AI_ARCHIVE_OPENCLAW_ROOT=%%USERPROFILE%%\.openclaw
echo   AI_ARCHIVE_CLAUDE_CODE_ROOT=%%USERPROFILE%%\.claude
echo   AI_ARCHIVE_SYNC_CONFIG=%%USERPROFILE%%\.config\ai-archive\openclaw-sync.json
echo   AI_ARCHIVE_SAFE_RECENT_DAYS=14
echo   AI_ARCHIVE_SAFE_MAX_FILES=60
echo   AI_ARCHIVE_SAFE_MAX_FILE_MB=50
echo   AI_ARCHIVE_SAFE_MAX_MESSAGES=12000
echo   AI_ARCHIVE_SYNC_DELAY_MS=750
exit /b 0
