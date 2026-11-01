"""Exercise the launcher in Windows PowerShell 5.1 without registering real tasks."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which("powershell.exe")
HARNESS = r'''
param([string]$Root, [string]$Agent, [string]$Command, [string]$Mode)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
function Record-Task([string]$Event, $Value) {
  @{ event=$Event; value=$Value } | ConvertTo-Json -Depth 8 -Compress |
    Add-Content -LiteralPath $env:ARCHIVE_TEST_TASKS -Encoding UTF8
}
function New-ScheduledTaskAction { param($Execute,$Argument) return @{ Execute=$Execute; Argument=$Argument } }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn,$User) return @{ User=$User } }
function New-ScheduledTaskSettingsSet {
  param($MultipleInstances,$RestartCount,$RestartInterval,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,$ExecutionTimeLimit)
  return @{ MultipleInstances=$MultipleInstances }
}
function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel) return @{ UserId=$UserId; LogonType=$LogonType; RunLevel=$RunLevel } }
function Register-ScheduledTask {
  param($TaskName,$Action,$Trigger,$Settings,$Principal,$Description,[switch]$Force)
  Record-Task 'register' @{ TaskName=$TaskName; Trigger=$Trigger; Principal=$Principal; Action=$Action }
  if ($Mode -eq 'register-denied') { throw (New-Object UnauthorizedAccessException('Access is denied.')) }
}
function Start-ScheduledTask {
  param($TaskName)
  Record-Task 'start' $TaskName
  if ($Mode -eq 'start-denied') { throw (New-Object UnauthorizedAccessException('Access is denied.')) }
}
function Read-Host { param($Prompt) return 'ABCD1234' }
function Get-ScheduledTask {
  param($TaskName,$ErrorAction)
  return @{ State='Running'; TaskName=$TaskName }
}
function Stop-ScheduledTask { param($TaskName) Record-Task 'stop' $TaskName }
function Invoke-RestMethod {
  param($Uri,$Method,$ContentType,$Body,$TimeoutSec)
  Record-Task 'claim' @{ Uri=$Uri; Body=($Body | ConvertFrom-Json) }
  if ($Mode -eq 'claim-denied') { throw 'Pairing code expired' }
  if ($Mode -eq 'invalid-claim') { return @{ deviceId='invalid'; token='short' } }
  return @{ deviceId='11223344-5566-7788-99aa-bbccddeeff00'; token='synthetic-new-token-0123456789' }
}
& (Join-Path $Root 'scripts\sync-local-windows-core.ps1') -AgentPath $Agent -Command $Command
exit $LASTEXITCODE
'''


@unittest.skipUnless(POWERSHELL and os.name == "nt", "Windows PowerShell 5.1 required")
class LauncherTests(unittest.TestCase):
    def run_case(self, command, mode="success"):
        with tempfile.TemporaryDirectory(prefix="archive-launcher-test-") as folder:
            work = Path(folder)
            harness = work / "harness.ps1"
            harness.write_text(HARNESS, encoding="utf-8-sig")
            agent = work / "agent.cjs"
            agent.write_text("require('node:fs').writeFileSync(process.env.ARCHIVE_TEST_ARGS,JSON.stringify(process.argv.slice(2)))", encoding="utf-8")
            config = work / "config.json"
            self.original_config = {"serverUrl":"https://ai-archive.gyee.tech:18443", "deviceId":"00000000-0000-0000-0000-000000000001", "deviceToken":"synthetic-old-token-0123456789", "scanSeconds":45, "codexRoots":["D:/custom-codex"], "custom":{"keep":True}}
            config.write_text(json.dumps(self.original_config), encoding="utf-8")
            state = work / "openclaw-sync-state.json"
            state.write_bytes(b'{"cursor":"keep-progress"}')
            env = dict(os.environ)
            # A parent PowerShell 7 session can prepend incompatible Core
            # modules. Let the separate Desktop 5.1 process use its defaults.
            for key in list(env):
                if key.upper() == "PSMODULEPATH":
                    env.pop(key)
            env.update(AI_ARCHIVE_SYNC_CONFIG=str(config), ARCHIVE_TEST_ARGS=str(work / "args.json"), ARCHIVE_TEST_TASKS=str(work / "tasks.jsonl"))
            for key in ["AI_ARCHIVE_SAFE_RECENT_DAYS", "AI_ARCHIVE_SAFE_MAX_FILES", "AI_ARCHIVE_SAFE_MAX_FILE_MB", "AI_ARCHIVE_SAFE_MAX_MESSAGES", "AI_ARCHIVE_SYNC_DELAY_MS"]:
                env.pop(key, None)
            result = subprocess.run([POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(harness), "-Root", str(ROOT), "-Agent", str(agent), "-Command", command, "-Mode", mode], env=env, capture_output=True, encoding="utf-8", errors="replace", timeout=30)
            args = json.loads((work / "args.json").read_text()) if (work / "args.json").exists() else None
            tasks = [json.loads(line) for line in (work / "tasks.jsonl").read_text(encoding="utf-8-sig").splitlines()] if (work / "tasks.jsonl").exists() else []
            self.updated_config = json.loads(config.read_text(encoding="utf-8-sig"))
            self.updated_state = state.read_bytes()
            self.backups = [json.loads(path.read_text(encoding="utf-8-sig")) for path in work.glob("config.json.before-pair-*.bak")]
            self.temporary_files = list(work.glob("*.tmp"))
            return result, args, tasks

    def test_foreground_scans_then_watches_without_task_registration(self):
        for command in ("run", "RUN", "foreground"):
            with self.subTest(command=command):
                result, args, tasks = self.run_case(command)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(args, ["run", "--recent-days", "14", "--max-files", "60", "--max-file-mb", "50", "--max-messages", "12000", "--delay-ms", "750"])
                self.assertEqual(tasks, [])

    def test_existing_manual_commands_keep_their_behavior(self):
        for command, expected in (("watch-only", "run"), ("rebuild-only", "rebuild")):
            with self.subTest(command=command):
                result, args, tasks = self.run_case(command)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(args[0], expected)
                self.assertEqual("--skip-initial-scan" in args, command == "watch-only")
                self.assertEqual(tasks, [])

    def test_install_uses_the_same_user_for_trigger_and_limited_principal(self):
        result, args, tasks = self.run_case("install")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIsNone(args)
        self.assertEqual([t["event"] for t in tasks], ["register", "start"])
        registered = tasks[0]["value"]
        self.assertEqual(registered["Trigger"]["User"], registered["Principal"]["UserId"])
        self.assertEqual(registered["Principal"]["RunLevel"], "Limited")
        self.assertIn("-WindowStyle Hidden", registered["Action"]["Argument"])
        self.assertIn("Installed and started scheduled task", result.stdout)

    def test_permission_denials_fail_clearly_without_automatic_fallback(self):
        for mode in ("register-denied", "start-denied"):
            with self.subTest(mode=mode):
                result, args, tasks = self.run_case("install", mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("sync-local-windows.bat run", result.stdout)
                self.assertNotIn("Installed and started scheduled task", result.stdout)
                self.assertIsNone(args)
                self.assertEqual([t["event"] for t in tasks], ["register"] if mode == "register-denied" else ["register", "start"])

    def test_unknown_command_never_installs_a_task(self):
        result, args, tasks = self.run_case("rn")
        self.assertEqual(result.returncode, 2)
        self.assertIsNone(args)
        self.assertEqual(tasks, [])

    def test_repair_preserves_custom_configuration_and_progress(self):
        result, args, tasks = self.run_case("pair")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIsNone(args)
        self.assertEqual([t["event"] for t in tasks], ["stop", "claim", "start"])
        self.assertEqual(tasks[1]["value"]["Body"]["kind"], "openclaw_sync")
        self.assertEqual(tasks[1]["value"]["Uri"], "https://ai-archive.cuizhaoyang.cn/api/v1/devices/claim")
        expected = dict(self.original_config, serverUrl="https://ai-archive.cuizhaoyang.cn", deviceId="11223344-5566-7788-99aa-bbccddeeff00", deviceToken="synthetic-new-token-0123456789")
        self.assertEqual(self.updated_config, expected)
        self.assertEqual(self.updated_state, b'{"cursor":"keep-progress"}')
        self.assertEqual(self.backups, [self.original_config])
        self.assertEqual(self.temporary_files, [])
        self.assertNotIn(expected["deviceToken"], result.stdout + result.stderr)

    def test_failed_pairing_keeps_existing_credentials_and_stays_stopped(self):
        for mode in ("claim-denied", "invalid-claim"):
            with self.subTest(mode=mode):
                result, args, tasks = self.run_case("pair", mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(args)
                self.assertEqual([t["event"] for t in tasks], ["stop", "claim"])
                self.assertEqual(self.updated_config, self.original_config)
                self.assertEqual(self.updated_state, b'{"cursor":"keep-progress"}')
                self.assertEqual(self.temporary_files, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
