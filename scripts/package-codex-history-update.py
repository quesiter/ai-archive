"""Build one portable BAT containing the tested updater and released sync agent.

First build the helper with:
pnpm --filter @ai-archive/openclaw-sync exec tsup ../../scripts/repair-codex-history.ts --out-dir ../../.e2e-data/company-helper --no-sourcemap
"""
from pathlib import Path
import base64
import hashlib
import io
import zipfile

ROOT = Path(__file__).resolve().parents[1]
version = "V2.3.3"
payload = io.BytesIO()
with zipfile.ZipFile(payload, "w", zipfile.ZIP_DEFLATED) as package:
    source = ROOT / f"release/ai-conversation-archive-windows-sync-{version}.zip"
    with zipfile.ZipFile(source) as published:
        for name in ["openclaw-sync.cjs", "sync-local-windows-background.ps1", "install-windows-sync-task.ps1"]:
            matches = [entry for entry in published.namelist() if entry.endswith("/" + name)]
            if len(matches) != 1:
                raise RuntimeError(f"Missing or ambiguous published file: {name}")
            package.writestr(name, published.read(matches[0]))
    package.write(ROOT / ".e2e-data/company-helper/repair-codex-history.cjs", "repair-codex-history.cjs")
    powershell = (ROOT / "scripts/update-codex-history-windows.ps1").read_text(encoding="utf-8-sig")
    package.writestr("update-codex-history-windows.ps1", powershell.encode("utf-8-sig"))

data = payload.getvalue()
digest = hashlib.sha256(data).hexdigest()
bootstrap = (
    "$ErrorActionPreference='Stop'; try { "
    "$text=[IO.File]::ReadAllText($env:AI_ARCHIVE_UPDATE_BAT); "
    r"$marker=[regex]::Match($text,'(?m)^:__ARCHIVE_PAYLOAD__\r?$'); "
    "if(-not $marker.Success){throw 'Update package marker is missing'}; "
    "$bytes=[Convert]::FromBase64String($text.Substring($marker.Index+$marker.Length).Trim()); "
    "$hash=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-','').ToLowerInvariant(); "
    f"if($hash -ne '{digest}'){{throw 'Update package checksum failed'}}; "
    r"$stage=Join-Path $env:LOCALAPPDATA ('AIArchive\UpdateStaging\'+[guid]::NewGuid().ToString('N')); "
    "[IO.Directory]::CreateDirectory($stage)|Out-Null; "
    "$prefix=[IO.Path]::GetFullPath($stage)+[IO.Path]::DirectorySeparatorChar; "
    "Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; "
    "$stream=New-Object IO.MemoryStream(,$bytes); "
    "$zip=New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Read); "
    "try { foreach($entry in $zip.Entries){ "
    "$destination=[IO.Path]::GetFullPath((Join-Path $stage $entry.FullName)); "
    "if(-not $destination.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid update package path'}; "
    "[IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$destination,$false) "
    "} } finally { $zip.Dispose(); $stream.Dispose() }; "
    "$script=Join-Path $stage 'update-codex-history-windows.ps1'; "
    "if($env:AI_ARCHIVE_UPDATE_DRY_RUN -eq '1'){& $script -DryRun}else{& $script}; exit $LASTEXITCODE "
    "} catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }"
)
bat = (
    "@echo off\r\n"
    "setlocal EnableExtensions DisableDelayedExpansion\r\n"
    "chcp 65001 >nul\r\n"
    "title Codex history update V2.3.3\r\n"
    "set \"AI_ARCHIVE_UPDATE_BAT=%~f0\"\r\n"
    "set \"AI_ARCHIVE_UPDATE_DRY_RUN=0\"\r\n"
    'if /i "%~1"=="--dry-run" set "AI_ARCHIVE_UPDATE_DRY_RUN=1"\r\n'
    f'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "{bootstrap}"\r\n'
    'set "AI_ARCHIVE_UPDATE_EXIT=%ERRORLEVEL%"\r\n'
    "echo.\r\n"
    'if "%AI_ARCHIVE_UPDATE_EXIT%"=="0" (echo Update finished successfully.) else (echo Update failed. Please keep the error text above.)\r\n'
    'if not "%AI_ARCHIVE_UPDATE_NO_PAUSE%"=="1" pause\r\n'
    "exit /b %AI_ARCHIVE_UPDATE_EXIT%\r\n"
    ":__ARCHIVE_PAYLOAD__\r\n"
    + "\r\n".join(base64.b64encode(data).decode()[i:i+100] for i in range(0, len(base64.b64encode(data)), 100))
    + "\r\n"
)
target = ROOT / f"release/company-codex-history-update-{version}.bat"
target.write_bytes(bat.encode("ascii"))
print(f"Created {target} ({target.stat().st_size} bytes)")
