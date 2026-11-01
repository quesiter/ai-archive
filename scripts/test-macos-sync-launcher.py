"""Exercise the macOS shell launcher without pairing devices or loading launchd jobs."""
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
GIT_BASH = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe"
BASH = str(GIT_BASH) if os.name == "nt" and GIT_BASH.is_file() else shutil.which("bash")
NODE_STUB = r'''#!/bin/sh
case "$1" in
  -p) echo 22; exit 0 ;;
  -v) echo v22.0.0; exit 0 ;;
esac
shift
printf 'node' >> "$ARCHIVE_TEST_EVENTS"
for arg do printf '\t%s' "$arg" >> "$ARCHIVE_TEST_EVENTS"; done
printf '\n' >> "$ARCHIVE_TEST_EVENTS"
printf '%s' "$AI_ARCHIVE_SYNC_CONFIG" > "$ARCHIVE_TEST_CONFIG_ENV"
case "$1" in
  pair)
    if [ "${ARCHIVE_TEST_PAIR_STATUS:-0}" -ne 0 ]; then
      echo 'Pairing code expired' >&2
      exit "$ARCHIVE_TEST_PAIR_STATUS"
    fi
    mkdir -p "$(dirname "$AI_ARCHIVE_SYNC_CONFIG")"
    printf '{"paired":true}\n' > "$AI_ARCHIVE_SYNC_CONFIG"
    ;;
  run|rebuild)
    if [ "${ARCHIVE_TEST_SYNC_STATUS:-0}" -ne 0 ]; then
      echo 'AuthenticationRevoked: AUTH_REVOKED: device authorization is invalid' >&2
      exit "$ARCHIVE_TEST_SYNC_STATUS"
    fi
    ;;
esac
'''
LAUNCHCTL_STUB = r'''#!/bin/sh
printf 'launchctl' >> "$ARCHIVE_TEST_EVENTS"
for arg do printf '\t%s' "$arg" >> "$ARCHIVE_TEST_EVENTS"; done
printf '\n' >> "$ARCHIVE_TEST_EVENTS"
case "$1" in
  print) exit "${ARCHIVE_TEST_JOB_ABSENT:-1}" ;;
  bootout) exit "${ARCHIVE_TEST_BOOTOUT_STATUS:-0}" ;;
  bootstrap) exit "${ARCHIVE_TEST_BOOTSTRAP_STATUS:-0}" ;;
esac
'''
PLISTBUDDY_STUB = r'''#!/bin/sh
exec "$ARCHIVE_TEST_PYTHON" "$ARCHIVE_TEST_PLISTBUDDY_HELPER" "$@"
'''
PLISTBUDDY_HELPER = r'''
from pathlib import Path
import plistlib
import sys
try:
    if len(sys.argv) != 4 or sys.argv[1] != "-c":
        raise ValueError("Unsupported PlistBuddy command")
    with Path(sys.argv[3]).open("rb") as source:
        value = plistlib.load(source)
    for key in sys.argv[2].removeprefix("Print :").split(":"):
        value = value[int(key)] if isinstance(value, list) else value[key]
    if isinstance(value, list):
        print("Array {")
        for item in value:
            print("    " + str(item))
        print("}")
    elif isinstance(value, dict):
        print("Dict {")
    else:
        print(value)
except Exception:
    sys.exit(1)
'''
OLD_SAFETY_ARGS = [
    "--recent-days", "30", "--max-files", "100", "--max-file-mb", "10",
    "--max-messages", "3000", "--delay-ms", "2000",
]


@unittest.skipUnless(BASH, "Bash or Git Bash required")
class MacOSLauncherTests(unittest.TestCase):
    def run_case(self, command, *, existing=True, loaded=False, input_text="CODE1234\n\n", server=None, pair_status=0, sync_status=0, bootout_status=0, bootstrap_status=0, installed_args=None, installed_bytes=None, safety_env=None):
        with tempfile.TemporaryDirectory(prefix="archive-macos-launcher-") as folder:
            work = Path(folder)
            launcher = work / "AI-Archive-Sync.command"
            shutil.copyfile(ROOT / "scripts/AI-Archive-Sync.command", launcher)
            (work / "openclaw-sync.cjs").touch()
            bin_dir = work / "bin"
            bin_dir.mkdir()
            for name, script in (("node", NODE_STUB), ("launchctl", LAUNCHCTL_STUB), ("PlistBuddy", PLISTBUDDY_STUB)):
                target = bin_dir / name
                target.write_text(script, encoding="utf-8", newline="\n")
                target.chmod(0o755)
            plist_helper = work / "plistbuddy.py"
            plist_helper.write_text(PLISTBUDDY_HELPER, encoding="utf-8")
            plist_path = work / "Library/LaunchAgents/com.ai-archive.openclaw-sync.plist"
            if installed_args is not None:
                installed_bytes = plistlib.dumps({
                    "Label": "com.ai-archive.openclaw-sync",
                    "ProgramArguments": ["/old/node", "/old/openclaw-sync.cjs", "run", *installed_args],
                    "KeepAlive": True,
                })
            if installed_bytes is not None:
                plist_path.parent.mkdir(parents=True)
                plist_path.write_bytes(installed_bytes)
            self.original_plist_bytes = installed_bytes
            config = work / "custom config.json"
            original = b'{"serverUrl":"https://custom.invalid","codexRoots":["/custom"],"scanSeconds":45}'
            if existing:
                config.write_bytes(original)
            env = {key: value for key, value in os.environ.items() if not key.startswith("AI_ARCHIVE_")}
            env.update(
                HOME=work.as_posix(),
                PATH=bin_dir.as_posix() + (";" if os.name == "nt" else ":") + os.environ["PATH"],
                AI_ARCHIVE_SYNC_CONFIG=config.as_posix(),
                ARCHIVE_TEST_EVENTS=(work / "events.txt").as_posix(),
                ARCHIVE_TEST_CONFIG_ENV=(work / "config-env.txt").as_posix(),
                ARCHIVE_TEST_JOB_ABSENT="0" if loaded else "1",
                ARCHIVE_TEST_PAIR_STATUS=str(pair_status),
                ARCHIVE_TEST_SYNC_STATUS=str(sync_status),
                ARCHIVE_TEST_BOOTOUT_STATUS=str(bootout_status),
                ARCHIVE_TEST_BOOTSTRAP_STATUS=str(bootstrap_status),
                ARCHIVE_TEST_PYTHON=Path(sys.executable).as_posix(),
                ARCHIVE_TEST_PLISTBUDDY_HELPER=plist_helper.as_posix(),
            )
            env.update(safety_env or {})
            if server is not None:
                env["AI_ARCHIVE_SERVER"] = server
            # Keep LF input on Windows too; native text-mode pipes add CR to
            # read values in the POSIX shell and do not model a macOS terminal.
            result = subprocess.run([BASH, launcher.as_posix(), command], env=env, input=input_text.encode("utf-8"), capture_output=True, timeout=15)
            result.stdout = result.stdout.decode("utf-8", errors="replace")
            result.stderr = result.stderr.decode("utf-8", errors="replace")
            events_path = work / "events.txt"
            self.events = [line.split("\t") for line in events_path.read_text(encoding="utf-8").splitlines()] if events_path.exists() else []
            self.config_bytes = config.read_bytes() if config.exists() else None
            self.original_config = original
            self.config_env = (work / "config-env.txt").read_text(encoding="utf-8") if (work / "config-env.txt").exists() else None
            self.expected_config_path = config.as_posix()
            self.plist_bytes = plist_path.read_bytes() if plist_path.exists() else None
            try:
                self.plist = plistlib.loads(self.plist_bytes) if self.plist_bytes else None
            except plistlib.InvalidFileException:
                self.plist = None
            return result

    def node_events(self):
        return [event for event in self.events if event[0] == "node"]

    def test_repair_ignores_existing_config_skip_and_preserves_options(self):
        result = self.run_case("pair")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.node_events(), [["node", "pair", "--code", "CODE1234", "--preserve-config"]])
        self.assertEqual(self.config_env, self.expected_config_path)
        self.assertIsNone(self.plist)
        self.assertIn('AI-Archive-Sync.command" run', result.stdout)
        self.assertIn('AI-Archive-Sync.command" install', result.stdout)

    def test_repair_server_changes_only_with_explicit_override(self):
        result = self.run_case("re-pair", server="https://replacement.invalid")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.node_events()[0][-2:], ["--server", "https://replacement.invalid"])
        self.assertIn("--preserve-config", self.node_events()[0])

    def test_repair_stops_loaded_job_before_pair_and_restarts_only_on_success(self):
        result = self.run_case("pair", loaded=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        actions = [(event[0], event[1]) for event in self.events]
        self.assertEqual(actions, [("launchctl", "print"), ("launchctl", "bootout"), ("node", "pair"), ("launchctl", "bootout"), ("launchctl", "bootstrap"), ("launchctl", "enable")])
        self.assertIn("--auth-revoked-exit-success", self.plist["ProgramArguments"])
        self.assertEqual(self.plist["KeepAlive"], {"SuccessfulExit": False})
        self.assertEqual(self.plist["EnvironmentVariables"]["AI_ARCHIVE_SYNC_CONFIG"], self.expected_config_path)

    def test_failed_repair_keeps_config_and_job_stopped(self):
        result = self.run_case("pair", loaded=True, pair_status=1)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertEqual(self.config_bytes, self.original_config)
        self.assertFalse(any(event[1] in ("bootstrap", "enable") for event in self.events))
        self.assertIn("Pairing code expired", result.stderr)
        self.assertIn("Press Enter to close", result.stdout)

    def test_repair_preserves_installed_safety_limits(self):
        result = self.run_case("pair", loaded=True, installed_args=OLD_SAFETY_ARGS)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.plist["ProgramArguments"][4:], OLD_SAFETY_ARGS)
        self.assertIn("--auth-revoked-exit-success", self.plist["ProgramArguments"])
        self.assertNotIn("/old/node", self.plist["ProgramArguments"])
        self.assertEqual(self.plist["KeepAlive"], {"SuccessfulExit": False})

    def test_repair_honors_explicit_safety_overrides(self):
        result = self.run_case("pair", loaded=True, installed_args=OLD_SAFETY_ARGS, safety_env={
            "AI_ARCHIVE_SAFE_RECENT_DAYS": "7", "AI_ARCHIVE_SAFE_MAX_FILES": "20",
            "AI_ARCHIVE_SAFE_MAX_FILE_MB": "5", "AI_ARCHIVE_SAFE_MAX_MESSAGES": "1000",
            "AI_ARCHIVE_SYNC_DELAY_MS": "2500",
        })
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.plist["ProgramArguments"][4:], [
            "--recent-days", "7", "--max-files", "20", "--max-file-mb", "5",
            "--max-messages", "1000", "--delay-ms", "2500",
        ])

    def test_repair_preserves_limits_without_overrides_individually(self):
        result = self.run_case("pair", loaded=True, installed_args=OLD_SAFETY_ARGS, safety_env={"AI_ARCHIVE_SAFE_MAX_FILES": "25"})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        expected = OLD_SAFETY_ARGS.copy()
        expected[3] = "25"
        self.assertEqual(self.plist["ProgramArguments"][4:], expected)

    def test_repair_preserves_equals_syntax_and_first_duplicate_value(self):
        result = self.run_case("pair", loaded=True, installed_args=["--max-files=25", "--max-files", "100"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        arguments = self.plist["ProgramArguments"]
        self.assertEqual(arguments[arguments.index("--max-files") + 1], "25")

    def test_unreadable_installed_limits_cancel_before_pairing_or_stopping(self):
        for installed_bytes in (b"not a plist", plistlib.dumps({"ProgramArguments": "not an array"}), plistlib.dumps({"ProgramArguments": ["node", "agent", "run", "--max-files"]})):
            with self.subTest(installed_bytes=installed_bytes):
                result = self.run_case("pair", loaded=True, installed_bytes=installed_bytes)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertEqual(self.events, [])
                self.assertEqual(self.config_bytes, self.original_config)
                self.assertEqual(self.plist_bytes, self.original_plist_bytes)

    def test_explicit_install_keeps_normal_defaults(self):
        result = self.run_case("install", installed_args=OLD_SAFETY_ARGS)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.plist["ProgramArguments"][4:], [
            "--recent-days", "14", "--max-files", "60", "--max-file-mb", "50",
            "--max-messages", "12000", "--delay-ms", "750",
        ])

    def test_failed_stop_cancels_pairing(self):
        result = self.run_case("pair", loaded=True, bootout_status=1)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertEqual(self.node_events(), [])
        self.assertEqual(self.config_bytes, self.original_config)

    def test_failed_restart_is_reported_even_inside_pairing_conditional(self):
        result = self.run_case("pair", loaded=True, bootstrap_status=1)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("could not be restarted", result.stdout)
        self.assertFalse(any(event[1] == "enable" for event in self.events))

    def test_first_pair_failure_never_continues_into_sync_or_install(self):
        for command in ("run", "install", "rebuild", "menu"):
            with self.subTest(command=command):
                result = self.run_case(command, existing=False, pair_status=1)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertEqual([event[1] for event in self.node_events()], ["pair"])
                self.assertIsNone(self.config_bytes)
                self.assertIsNone(self.plist)

    def test_first_pair_has_server_and_roots_then_runs(self):
        result = self.run_case("run", existing=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        pair, run = self.node_events()
        self.assertIn("--server", pair)
        self.assertIn("--codex-root", pair)
        self.assertNotIn("--preserve-config", pair)
        self.assertEqual(run[1], "run")

    def test_existing_run_skips_pairing_and_reports_revoked_authorization(self):
        result = self.run_case("run", sync_status=3)
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertEqual([event[1] for event in self.node_events()], ["run"])
        self.assertIn("AUTH_REVOKED", result.stderr)
        self.assertIn('AI-Archive-Sync.command" pair', result.stdout)
        self.assertIn("option 5", result.stdout)
        self.assertIn("Press Enter to close", result.stdout)

    def test_menu_option_five_forces_repair(self):
        result = self.run_case("menu", input_text="5\nCODE1234\n\n")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual([event[1] for event in self.node_events()], ["pair"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
