#!/usr/bin/env python3
"""Build and verify the clean-install NAS source archive."""

from __future__ import annotations

import argparse
import gzip
import io
import json
import os
from pathlib import Path, PurePosixPath
import stat
import tarfile
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_DIRECTORIES = {
    ".e2e-data",
    ".codex-tmp",
    ".git",
    ".output",
    ".pnpm-store",
    ".wxt",
    "__pycache__",
    "coverage",
    "data",
    "dist",
    "node_modules",
    "release",
    "tmp",
}
EXCLUDED_FILES = {".env", ".DS_Store", "Thumbs.db", "desktop.ini"}
REQUIRED_FILES = {
    "Dockerfile",
    "package.json",
    "pnpm-lock.yaml",
    "deploy/docker-compose.yml",
    "apps/server/migrations/0022_tag_identity_hardening.sql",
    "apps/server/migrations/0023_conversation_lineage.sql",
    "apps/server/migrations/0024_accumulated_conversations.sql",
    "apps/server/migrations/0025_recapture_jobs.sql",
    "apps/server/migrations/0026_search_content_trigram.sql",
    "apps/server/src/services/restore.ts",
    "docs/08-部署与发布.md",
}


def version_name() -> str:
    value = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    return value if str(value).startswith("V") else f"V{value}"


def component_version(component: str) -> str:
    value = json.loads((ROOT / "apps" / component / "package.json").read_text(encoding="utf-8"))["version"]
    return f"V{value}"


def embedded_release_files() -> set[str]:
    chrome_version = component_version("extension")
    sync_version = component_version("openclaw-sync")
    return {
        f"release/ai-archiveextension-{chrome_version}-chrome.zip",
        f"release/ai-conversation-archive-windows-sync-{sync_version}.zip",
        f"release/ai-conversation-archive-macos-sync-{sync_version}.tar.gz",
    }


def verify_component(filename: str, data: bytes) -> None:
    """Reject stale or mislabeled client bundles before including them in a NAS release."""
    if "-chrome.zip" in filename:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            files = safe_zip_files(archive)
            manifest = json.loads(archive.read("manifest.json"))
            if manifest.get("version") != component_version("extension").removeprefix("V"):
                raise ValueError(f"Chrome manifest version does not match source: {filename}")
            build_root = ROOT / "apps" / "extension" / ".output" / "chrome-mv3"
            expected = {path.relative_to(build_root).as_posix(): source_bytes(path)
                        for path in build_root.rglob("*") if path.is_file()}
            if not {"manifest.json", "background.js", "popup.html", "content-scripts/content.js"} <= expected.keys():
                raise ValueError("Build the Chrome extension before packaging")
            compare_files(files, expected, filename)
    else:
        binary = ROOT / "apps" / "openclaw-sync" / "dist" / "index.cjs"
        if not binary.is_file():
            raise ValueError("Build the sync agent before packaging")
        if filename.endswith(".zip"):
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                files = safe_zip_files(archive)
            prefix = "ai-conversation-archive-windows-sync/"
            inputs = {
                "openclaw-sync.cjs": binary,
                "sync-local-windows.bat": ROOT / "scripts/sync-local-windows-portable.bat",
                **{name: ROOT / "scripts" / name for name in (
                    "sync-local-windows-core.ps1", "repair-windows-sync-pairing.ps1",
                    "sync-local-windows-background.ps1", "install-windows-sync-task.ps1",
                    "uninstall-windows-sync-task.ps1")},
                "README.md": numbered_guide("11-Windows*.md"),
            }
            expected = {}
            for name, path in inputs.items():
                content = source_bytes(path)
                if path.suffix == ".ps1":
                    content = b"\xef\xbb\xbf" + content.removeprefix(b"\xef\xbb\xbf")
                expected[prefix + name] = content
            compare_files(files, expected, filename)
        else:
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
                files = safe_tar_files(archive)
                prefix = f"macos-sync-{component_version('openclaw-sync')}/"
                for member in archive.getmembers():
                    expected_mode = 0o755 if member.isdir() or member.name.endswith("/AI-Archive-Sync.command") else 0o644
                    if member.mode & 0o7777 != expected_mode:
                        raise ValueError(f"Incorrect macOS archive file mode: {member.name}")
            compare_files(files, {
                prefix + "openclaw-sync.cjs": source_bytes(binary),
                prefix + "AI-Archive-Sync.command": normalize_lf(source_bytes(ROOT / "scripts/AI-Archive-Sync.command")),
                prefix + "README-MACOS-SYNC.md": source_bytes(numbered_guide("12-*.md")),
            }, filename)


def numbered_guide(pattern: str) -> Path:
    matches = sorted((ROOT / "docs").glob(pattern))
    if len(matches) != 1:
        raise ValueError(f"Expected one current guide matching {pattern}")
    return matches[0]


def normalize_lf(data: bytes) -> bytes:
    return data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")


def source_bytes(path: Path) -> bytes:
    if path.is_symlink():
        raise ValueError(f"Release input must not be a symbolic link: {path}")
    return path.read_bytes()


def safe_name(name: str) -> str:
    normalized = name.removeprefix("./").rstrip("/")
    pure = PurePosixPath(normalized)
    if "\\" in name or ":" in name or "\x00" in name or pure.is_absolute() or ".." in pure.parts:
        raise ValueError(f"Unsafe archive path: {name}")
    return pure.as_posix() if normalized else ""


def safe_zip_files(archive: zipfile.ZipFile) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    names: set[str] = set()
    for member in archive.infolist():
        name = safe_name(member.filename)
        if not name or name.casefold() in names:
            raise ValueError(f"Duplicate or empty archive path: {member.filename}")
        names.add(name.casefold())
        file_type = stat.S_IFMT(member.external_attr >> 16)
        if file_type not in {0, stat.S_IFREG, stat.S_IFDIR}:
            raise ValueError(f"Archive links or special files are not allowed: {member.filename}")
        if file_type == stat.S_IFDIR and not member.is_dir():
            raise ValueError(f"Archive directory must have a directory path: {member.filename}")
        if not member.is_dir():
            files[name] = archive.read(member)
    verify_directories(names, files)
    return files


def safe_tar_files(archive: tarfile.TarFile) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    names: set[str] = set()
    for member in archive.getmembers():
        name = safe_name(member.name)
        if not name or name.casefold() in names:
            raise ValueError(f"Duplicate or empty archive path: {member.name}")
        names.add(name.casefold())
        if not member.isfile() and not member.isdir():
            raise ValueError(f"Archive links or special files are not allowed: {member.name}")
        if member.isfile():
            source = archive.extractfile(member)
            if source is None:
                raise ValueError(f"Archive member must be readable: {member.name}")
            files[name] = source.read()
    verify_directories(names, files)
    return files


def verify_directories(names: set[str], files: dict[str, bytes]) -> None:
    allowed = {str(parent).casefold() for name in files for parent in PurePosixPath(name).parents if str(parent) != "."}
    unexpected = names - {name.casefold() for name in files} - allowed
    if unexpected:
        raise ValueError(f"Unexpected archive directories: {sorted(unexpected)}")


def compare_files(actual: dict[str, bytes], expected: dict[str, bytes], filename: str) -> None:
    if actual.keys() != expected.keys():
        raise ValueError(f"Client bundle file set does not match the current build/source: {filename}")
    stale = [name for name in expected if actual[name] != expected[name]]
    if stale:
        raise ValueError(f"Client bundle does not match the current build/source: {filename}: {', '.join(stale)}")


def should_include(path: Path) -> bool:
    if path.is_symlink():
        return False
    relative = path.relative_to(ROOT)
    if relative.parts and relative.parts[0] == "release":
        return relative.as_posix() in embedded_release_files() and path.is_file()
    if any(part in EXCLUDED_DIRECTORIES or part.startswith(".tmp-") for part in relative.parts):
        return False
    if excluded_file(path.name):
        return False
    return path.is_file()


def source_files():
    # Prune excluded trees before traversal; large local databases and installed
    # dependencies must not be walked just to discard their files afterward.
    for directory, children, filenames in os.walk(ROOT, followlinks=False):
        parent = Path(directory)
        children[:] = [name for name in children
                       if name not in EXCLUDED_DIRECTORIES and not name.startswith(".tmp-")
                       and not (parent / name).is_symlink()]
        for name in filenames:
            path = parent / name
            if should_include(path):
                yield path
    for name in sorted(embedded_release_files()):
        yield ROOT / name


def excluded_file(name: str) -> bool:
    return (name in EXCLUDED_FILES or name.startswith(".tmp-") or name.endswith((".log", ".tsbuildinfo"))
            or "_Conflict." in name or (name.startswith(".env.") and not name.endswith(".example")))


def archive_bytes(path: Path) -> bytes:
    data = source_bytes(path)
    if path.suffix in {".sh", ".command"}:
        # Packages are commonly built from a Windows checkout. Shell scripts
        # must still be directly executable by BusyBox/dash on the NAS.
        data = normalize_lf(data)
    return data


def normalized_info(path: Path, archive_name: str, size: int) -> tarfile.TarInfo:
    info = tarfile.TarInfo(archive_name)
    info.size = size
    info.mtime = 0
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    info.mode = 0o755 if path.suffix in {".sh", ".command"} else 0o644
    return info


def build(output: Path) -> None:
    output = output.resolve()
    release_root = (ROOT / "release").resolve()
    if output.parent != release_root:
        raise ValueError(f"NAS archive must be written directly under {release_root}")
    output.parent.mkdir(parents=True, exist_ok=True)
    for name in sorted(embedded_release_files()):
        component = ROOT / name
        if not component.is_file():
            raise ValueError(f"Missing current client bundle: {component}; build all client packages first")
        verify_component(name, component.read_bytes())
    files = sorted(source_files(), key=str)
    fd, temporary_name = tempfile.mkstemp(prefix="nas-release-", suffix=".tar.gz", dir=output.parent)
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        with temporary.open("wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                    root_info = tarfile.TarInfo("./")
                    root_info.type = tarfile.DIRTYPE
                    root_info.mode = 0o755
                    root_info.mtime = 0
                    archive.addfile(root_info)
                    for path in files:
                        relative = path.relative_to(ROOT).as_posix()
                        data = archive_bytes(path)
                        archive.addfile(
                            normalized_info(path, f"./{relative}", len(data)),
                            io.BytesIO(data),
                        )
        verify(temporary)
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Created {output} ({output.stat().st_size} bytes, {len(files)} files)")


def verify(path: Path) -> None:
    path = path.resolve()
    allowed_release_files = embedded_release_files()
    with tarfile.open(path, "r:gz") as archive:
        names: set[str] = set()
        root_seen = False
        for member in archive.getmembers():
            normalized = safe_name(member.name)
            pure = PurePosixPath(normalized)
            if not member.isfile() and not member.isdir():
                raise ValueError(f"Archive links are not allowed: {member.name}")
            if normalized in {"", "."}:
                if not member.isdir():
                    raise ValueError(f"Archive root must be a directory: {member.name}")
                if root_seen:
                    raise ValueError(f"Duplicate archive root: {member.name}")
                root_seen = True
                continue
            if normalized.rstrip("/") in names:
                raise ValueError(f"Duplicate archive path: {member.name}")
            if normalized:
                names.add(normalized.rstrip("/"))
            if normalized.startswith("release/"):
                if normalized not in allowed_release_files:
                    raise ValueError(f"Unexpected release artifact leaked into archive: {member.name}")
                source = archive.extractfile(member)
                if source is None:
                    raise ValueError(f"Client bundle must be a file: {member.name}")
                verify_component(normalized, source.read())
            elif any(part in EXCLUDED_DIRECTORIES for part in pure.parts):
                raise ValueError(f"Excluded directory leaked into archive: {member.name}")
            if excluded_file(pure.name):
                raise ValueError(f"Excluded file leaked into archive: {member.name}")
            if "_Conflict." in pure.name:
                raise ValueError(f"Conflict copy leaked into archive: {member.name}")
            if pure.suffix in {".sh", ".command"} and member.isfile():
                source = archive.extractfile(member)
                if source is None or b"\r" in source.read():
                    raise ValueError(f"Shell script must use LF line endings: {member.name}")
        missing = sorted((REQUIRED_FILES | allowed_release_files) - names)
        if missing:
            raise ValueError(f"NAS archive is missing required files: {', '.join(missing)}")
    print(f"Verified {path}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    parser.add_argument("--verify", type=Path)
    args = parser.parse_args()
    if args.verify:
        verify(args.verify)
        return
    output = args.output or ROOT / "release" / (
        f"ai-conversation-archive-nas-{version_name()}-clean-install.tar.gz"
    )
    build(output)


if __name__ == "__main__":
    main()
