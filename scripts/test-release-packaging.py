"""Regression tests for complete, current and safely published client bundles."""
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

SCRIPTS = Path(__file__).resolve().parent


def load_script(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), SCRIPTS / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


nas = load_script("package-nas-release.py")
macos = load_script("package-macos-sync.py")


class PackagingFixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ai-archive-package-test-")
        self.root = Path(self.temp.name).resolve()
        self.addCleanup(self.temp.cleanup)
        for module in (nas, macos):
            root_patch = patch.object(module, "ROOT", self.root)
            root_patch.start()
            self.addCleanup(root_patch.stop)
        for name in nas.REQUIRED_FILES:
            self.write(name, b"source\n")
        self.write("package.json", b'{"version":"1.0.0"}')
        self.write("apps/extension/package.json", b'{"version":"1.2.3"}')
        self.write("apps/openclaw-sync/package.json", b'{"version":"1.4.5"}')
        self.chrome_files = {
            "manifest.json": json.dumps({"version": "1.2.3", "permissions": ["tabs"]}).encode(),
            "background.js": b"current chrome background",
            "content-scripts/content.js": b"current chrome content",
            "popup.html": b'<script src="chunks/popup.js"></script>',
            "chunks/popup.js": b"current popup",
            "assets/popup.css": b"current styles",
        }
        for name, content in self.chrome_files.items():
            self.write("apps/extension/.output/chrome-mv3/" + name, content)
        self.write("apps/openclaw-sync/dist/index.cjs", b"current sync")
        self.windows_files = {
            "openclaw-sync.cjs": b"current sync",
            "sync-local-windows.bat": b"@echo off\r\n",
            "README.md": b"current Windows guide\n",
        }
        for name in ("sync-local-windows-core.ps1", "repair-windows-sync-pairing.ps1",
                     "sync-local-windows-background.ps1", "install-windows-sync-task.ps1",
                     "uninstall-windows-sync-task.ps1"):
            source = 'Write-Output "当前版本"\r\n'.encode("utf-8")
            self.write("scripts/" + name, source)
            self.windows_files[name] = b"\xef\xbb\xbf" + source
        self.write("scripts/sync-local-windows-portable.bat", self.windows_files["sync-local-windows.bat"])
        self.write("scripts/AI-Archive-Sync.command", b"#!/bin/sh\r\necho current launcher\r\n")
        self.write("docs/11-Windows本地同步代理.md", self.windows_files["README.md"])
        self.write("docs/12-macOS本地同步代理.md", b"current macOS guide\n")
        self.chrome_name = "release/ai-archiveextension-V1.2.3-chrome.zip"
        self.windows_name = "release/ai-conversation-archive-windows-sync-V1.4.5.zip"
        self.macos_name = "release/ai-conversation-archive-macos-sync-V1.4.5.tar.gz"
        self.write_zip(self.chrome_name, self.chrome_files)
        self.write_zip(self.windows_name, {"ai-conversation-archive-windows-sync/" + name: content
                                          for name, content in self.windows_files.items()})
        macos.build_archive("V1.4.5", self.root / self.macos_name)
        self.bundles = {name: (self.root / name).read_bytes()
                        for name in (self.chrome_name, self.windows_name, self.macos_name)}
        self.output = self.root / "release" / "nas.tar.gz"

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    def write_zip(self, filename, contents):
        result = io.BytesIO()
        with zipfile.ZipFile(result, "w") as archive:
            for name, content in contents.items():
                archive.writestr(name, content)
        self.write(filename, result.getvalue())

    def append_zip_member(self, filename, name, content=b"unsafe", *, link=False):
        result = io.BytesIO(self.bundles[filename])
        with warnings.catch_warnings(), zipfile.ZipFile(result, "a") as archive:
            warnings.simplefilter("ignore", UserWarning)
            entry = zipfile.ZipInfo(name)
            if link:
                entry.create_system = 3
                entry.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(entry, content)
        return result.getvalue()

    def append_tar_member(self, original, name, content=b"unsafe", *, link=False):
        result = io.BytesIO()
        with tarfile.open(fileobj=io.BytesIO(original), mode="r:gz") as source, \
                tarfile.open(fileobj=result, mode="w:gz") as destination:
            for member in source.getmembers():
                destination.addfile(member, source.extractfile(member) if member.isfile() else None)
            extra = tarfile.TarInfo(name)
            extra.size = len(content)
            if link:
                extra.type = tarfile.SYMTYPE
                extra.linkname = "../../outside"
                extra.size = 0
            destination.addfile(extra, None if link else io.BytesIO(content))
        return result.getvalue()


class ReleasePackagingTests(PackagingFixture, unittest.TestCase):
    def test_embeds_component_versions_and_excludes_old_bundles_and_temporary_files(self):
        self.write("release/ai-archiveextension-V1.0.0-chrome.zip", b"stale")
        self.write("release/.tmp-windows-sync-interrupted.zip", b"partial")
        self.write(".tmp-diagnostic.sql", b"private diagnostic")
        self.write("deploy/.env.production", b"private runtime secret")
        self.write("deploy/.env.synology.example", b"safe sample")
        nas.build(self.output)
        with tarfile.open(self.output) as archive:
            names = {entry.name.removeprefix("./") for entry in archive.getmembers()}
        self.assertTrue(nas.embedded_release_files() <= names)
        self.assertNotIn("release/ai-archiveextension-V1.0.0-chrome.zip", names)
        self.assertNotIn("release/.tmp-windows-sync-interrupted.zip", names)
        self.assertNotIn(".tmp-diagnostic.sql", names)
        self.assertNotIn("deploy/.env.production", names)
        self.assertIn("deploy/.env.synology.example", names)

    def test_mislabeled_chrome_preserves_previous_release(self):
        self.output.write_bytes(b"previous valid release")
        self.write_zip(self.chrome_name, {**self.chrome_files, "manifest.json": b'{"version":"1.0.0"}'})
        with self.assertRaisesRegex(ValueError, "manifest version"):
            nas.build(self.output)
        self.assertEqual(self.output.read_bytes(), b"previous valid release")

    def test_every_chrome_file_and_the_exact_file_set_must_match_current_build(self):
        for name in self.chrome_files:
            with self.subTest(file=name):
                stale = b'{"version":"1.2.3","permissions":[]}' if name == "manifest.json" else b"stale same-version code"
                self.write_zip(self.chrome_name, {**self.chrome_files, name: stale})
                with self.assertRaisesRegex(ValueError, "current build"):
                    nas.build(self.output)
        self.write_zip(self.chrome_name, {**self.chrome_files, "chunks/obsolete.js": b"old"})
        with self.assertRaisesRegex(ValueError, "file set"):
            nas.build(self.output)
        self.write_zip(self.chrome_name, {name: data for name, data in self.chrome_files.items() if name != "chunks/popup.js"})
        with self.assertRaisesRegex(ValueError, "file set"):
            nas.build(self.output)

    def test_stale_sync_binary_or_each_launcher_and_guide_is_rejected(self):
        sources = ["apps/openclaw-sync/dist/index.cjs", "scripts/AI-Archive-Sync.command",
                   "docs/11-Windows本地同步代理.md", "docs/12-macOS本地同步代理.md",
                   "scripts/sync-local-windows-portable.bat"]
        sources += ["scripts/" + name for name in self.windows_files if name.endswith(".ps1")]
        for name in sources:
            with self.subTest(source=name):
                path = self.root / name
                original = path.read_bytes()
                path.write_bytes(original + b"changed source\n")
                try:
                    with self.assertRaisesRegex(ValueError, "current build/source"):
                        nas.build(self.output)
                finally:
                    path.write_bytes(original)

    def test_nested_zip_traversal_links_and_duplicates_are_rejected(self):
        for filename, existing in [(self.chrome_name, "background.js"),
                                   (self.windows_name, "ai-conversation-archive-windows-sync/openclaw-sync.cjs")]:
            for name, link in [("../outside", False), ("C:/outside", False), ("..\\outside", False),
                               ("linked-file", True), (existing, False), (existing.upper(), False)]:
                with self.subTest(bundle=filename, member=name, link=link):
                    data = self.append_zip_member(filename, name, link=link)
                    with self.assertRaisesRegex(ValueError, "Unsafe|links|Duplicate"):
                        nas.verify_component(filename, data)

    def test_nested_tar_traversal_links_and_duplicates_are_rejected(self):
        for name, link in [("../outside", False), ("C:/outside", False), ("..\\outside", False),
                           ("linked-file", True), ("macos-sync-V1.4.5/openclaw-sync.cjs", False)]:
            with self.subTest(member=name, link=link):
                data = self.append_tar_member(self.bundles[self.macos_name], name, link=link)
                with self.assertRaisesRegex(ValueError, "Unsafe|links|Duplicate"):
                    nas.verify_component(self.macos_name, data)
                self.write(self.macos_name, data)
                with self.assertRaisesRegex(ValueError, "Unsafe|links|Duplicate"):
                    macos.verify_archive(self.root / self.macos_name)

    def test_nas_verifier_rejects_excluded_files_links_and_duplicates(self):
        nas.build(self.output)
        original = self.output.read_bytes()
        for name, link in [("./.env", False), ("./deploy/.env.production", False), ("./.tmp-secret", False), ("./../outside", False),
                           ("./linked-file", True), ("./package.json", False)]:
            with self.subTest(member=name, link=link):
                self.output.write_bytes(self.append_tar_member(original, name, link=link))
                with self.assertRaisesRegex(ValueError, "Excluded|Unsafe|links|Duplicate"):
                    nas.verify(self.output)

    def test_postwrite_verification_failure_preserves_release_and_cleans_temporary_archive(self):
        self.output.write_bytes(b"previous valid release")
        with patch.object(nas, "verify", side_effect=ValueError("simulated verification failure")):
            with self.assertRaisesRegex(ValueError, "simulated"):
                nas.build(self.output)
        self.assertEqual(self.output.read_bytes(), b"previous valid release")
        self.assertEqual(list(self.output.parent.glob("nas-release-*")), [])

    def test_missing_current_bundle_is_actionable(self):
        (self.root / self.chrome_name).unlink()
        with self.assertRaisesRegex(ValueError, "build all client packages first"):
            nas.build(self.output)

    def test_macos_verifier_rejects_changed_launcher_or_guide(self):
        for source in ("scripts/AI-Archive-Sync.command", "docs/12-macOS本地同步代理.md"):
            with self.subTest(source=source):
                path = self.root / source
                original = path.read_bytes()
                path.write_bytes(original + b"changed source\n")
                try:
                    with self.assertRaisesRegex(ValueError, "current build/source"):
                        macos.verify_archive(self.root / self.macos_name)
                finally:
                    path.write_bytes(original)

    def test_macos_postwrite_verification_failure_preserves_previous_release(self):
        path = self.root / self.macos_name
        original = path.read_bytes()
        with patch.object(macos, "verify_archive", side_effect=ValueError("simulated verification failure")):
            with self.assertRaisesRegex(ValueError, "simulated"):
                macos.build_archive("V1.4.5", path)
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(list(path.parent.glob(".*.tmp")), [])

    def test_macos_cli_builds_sources_before_packaging_and_preserves_existing_output_on_build_failure(self):
        path = self.root / self.macos_name
        original = path.read_bytes()
        with patch.object(sys, "argv", ["package-macos-sync.py", "--output", str(path)]), \
                patch.object(macos, "build_sync_agent", side_effect=subprocess.CalledProcessError(1, "pnpm")):
            with self.assertRaises(subprocess.CalledProcessError):
                macos.main()
        self.assertEqual(path.read_bytes(), original)
        with patch.object(macos.shutil, "which", return_value="pnpm"), patch.object(macos.subprocess, "run") as run:
            macos.build_sync_agent()
        self.assertEqual([call.args[0][2] for call in run.call_args_list],
                         ["@ai-archive/contracts", "@ai-archive/openclaw-sync"])
        self.assertTrue(all(call.kwargs["check"] for call in run.call_args_list))


@unittest.skipUnless(os.name == "nt", "Windows PowerShell packaging integration")
class WindowsPublicationTests(PackagingFixture, unittest.TestCase):
    def run_packager(self, compress_override=""):
        script = self.root / "scripts/package-windows-sync.ps1"
        script.write_bytes((SCRIPTS / "package-windows-sync.ps1").read_bytes())
        quoted = str(script).replace("'", "''")
        command = "function global:pnpm { $global:LASTEXITCODE = 0 }; " + compress_override + " & '" + quoted + "'"
        return subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
                              capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)

    def test_windows_success_publishes_verified_full_contents_and_bom_compatible_scripts(self):
        self.write(self.windows_name, b"previous valid release")
        result = self.run_packager()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        nas.verify_component(self.windows_name, (self.root / self.windows_name).read_bytes())
        self.assertEqual(list((self.root / "release").glob(".tmp-windows-sync-*")), [])

    def test_windows_first_publication_does_not_require_an_existing_release(self):
        (self.root / self.windows_name).unlink()
        result = self.run_packager()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        nas.verify_component(self.windows_name, (self.root / self.windows_name).read_bytes())

    def test_windows_compression_failure_does_not_replace_previous_release(self):
        self.write(self.windows_name, b"previous valid release")
        override = ('function global:Compress-Archive { param($LiteralPath,$DestinationPath,$CompressionLevel) '
                    '[IO.File]::WriteAllText($DestinationPath,"partial archive"); throw "simulated compression failure" };')
        result = self.run_packager(override)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / self.windows_name).read_bytes(), b"previous valid release")
        self.assertEqual(list((self.root / "release").glob(".tmp-windows-sync-*")), [])

    def test_windows_verification_failure_does_not_replace_previous_release(self):
        self.write(self.windows_name, b"previous valid release")
        override = ('function global:Compress-Archive { param($LiteralPath,$DestinationPath,$CompressionLevel) '
                    'Add-Type -AssemblyName System.IO.Compression.FileSystem; '
                    '$zip=[IO.Compression.ZipFile]::Open($DestinationPath,[IO.Compression.ZipArchiveMode]::Create); '
                    '$null=$zip.CreateEntry("unexpected.txt"); $zip.Dispose() };')
        result = self.run_packager(override)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / self.windows_name).read_bytes(), b"previous valid release")
        self.assertEqual(list((self.root / "release").glob(".tmp-windows-sync-*")), [])


if __name__ == "__main__":
    unittest.main()
