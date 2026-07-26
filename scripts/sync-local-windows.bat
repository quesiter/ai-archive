@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

if /I "%~1"=="help" goto :usage
if /I "%~1"=="/?" goto :usage
if /I "%~1"=="-h" goto :usage
if /I "%~1"=="--help" goto :usage

if /I not "%AI_ARCHIVE_ALLOW_HEAVY_SYNC%"=="YES_I_UNDERSTAND" (
  echo.
  echo Safety lock: this script can run a heavy full local history import.
  echo It is disabled by default after repeated Windows bugchecks on this machine.
  echo.
  echo To run it anyway, set:
  echo   set AI_ARCHIVE_ALLOW_HEAVY_SYNC=YES_I_UNDERSTAND
  echo.
  exit /b 2
)

set "ROOT=%~dp0.."
pushd "%ROOT%" >nul 2>nul
if errorlevel 1 (
  echo Failed to enter project root: %ROOT%
  exit /b 1
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
echo AI Conversation Archive - Windows local sync
echo Project: %CD%
echo Server : %SERVER_URL%
echo Codex  : %CODEX_ROOT%
echo Config : %CONFIG_PATH%
echo Safety: recent %SAFE_RECENT_DAYS%d, max %SAFE_MAX_FILES% files, max %SAFE_MAX_FILE_MB% MB/file, max %SAFE_MAX_MESSAGES% messages/session
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH. Install Node.js 22 or newer first.
  goto :failed
)

where pnpm >nul 2>nul
if errorlevel 1 (
  where corepack >nul 2>nul
  if errorlevel 1 (
    echo pnpm was not found, and corepack is also unavailable.
    goto :failed
  )
  echo Enabling pnpm through corepack...
  call corepack enable
  if errorlevel 1 goto :failed
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm is still unavailable after corepack enable.
  goto :failed
)

echo Installing dependencies if needed...
call pnpm install
if errorlevel 1 goto :failed

echo Building sync agent...
call pnpm --filter @ai-archive/contracts build
if errorlevel 1 goto :failed
call pnpm --filter @ai-archive/openclaw-sync build
if errorlevel 1 goto :failed

if not exist "%CONFIG_PATH%" (
  echo.
  echo First run: create an OpenClaw/Codex sync pairing code in the web console.
  set /p PAIR_CODE=Pairing code: 
  if "!PAIR_CODE!"=="" (
    echo Pairing code is required on first run.
    goto :failed
  )

  if not "%CLAUDE_CODE_ROOT%"=="" (
    call node apps/openclaw-sync/dist/index.cjs pair --server "%SERVER_URL%" --code "!PAIR_CODE!" --openclaw-root "%OPENCLAW_ROOT%" --codex-root "%CODEX_ROOT%" --claude-code-root "%CLAUDE_CODE_ROOT%"
  ) else (
    call node apps/openclaw-sync/dist/index.cjs pair --server "%SERVER_URL%" --code "!PAIR_CODE!" --openclaw-root "%OPENCLAW_ROOT%" --codex-root "%CODEX_ROOT%"
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
call node apps/openclaw-sync/dist/index.cjs rebuild --recent-days "%SAFE_RECENT_DAYS%" --max-files "%SAFE_MAX_FILES%" --max-file-mb "%SAFE_MAX_FILE_MB%" --max-messages "%SAFE_MAX_MESSAGES%" --delay-ms "%SAFE_DELAY_MS%"
if errorlevel 1 goto :failed

if /I "%~1"=="rebuild-only" goto :done
if /I "%~1"=="once" goto :done

:watch_only
echo.
echo Watching for new local conversations. Keep this window open.
echo Press Ctrl+C to stop.
call node apps/openclaw-sync/dist/index.cjs run --recent-days "%SAFE_RECENT_DAYS%" --max-files "%SAFE_MAX_FILES%" --max-file-mb "%SAFE_MAX_FILE_MB%" --max-messages "%SAFE_MAX_MESSAGES%" --delay-ms "%SAFE_DELAY_MS%" --skip-initial-scan
if errorlevel 1 goto :failed
goto :done

:full_rebuild
echo.
echo Full rebuild requested. This can be heavy on CPU, disk, network and the archive server.
echo Close other heavy apps first. The command will reset sync state and import all local transcript files.
call node apps/openclaw-sync/dist/index.cjs full-rebuild --delay-ms "%SAFE_DELAY_MS%"
if errorlevel 1 goto :failed

:done
echo.
echo Local sync finished.
popd >nul 2>nul
exit /b 0

:failed
echo.
echo Local sync failed. Check the error above.
popd >nul 2>nul
pause
exit /b 1

:usage
echo AI Conversation Archive Windows local sync
echo.
echo Usage:
echo   scripts\sync-local-windows.bat              Safe recent import, then watch future changes.
echo   scripts\sync-local-windows.bat rebuild-only Safe recent import once.
echo   scripts\sync-local-windows.bat once         Same as rebuild-only.
echo   scripts\sync-local-windows.bat watch-only   Watch future changes without an initial scan.
echo   scripts\sync-local-windows.bat full-rebuild Explicit full import of all local history.
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
