#!/usr/bin/env python3
"""Build and verify the clean-install NAS source archive."""

from __future__ import annotations

import argparse
import gzip
import json
import os
from pathlib import Path, PurePosixPath
import tarfile
import tempfile


ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_DIRECTORIES = {
    ".git",
    ".output",
    ".pnpm-store",
    ".wxt",
    "coverage",
    "data",
    "dist",
    "node_modules",
    "release",
}
EXCLUDED_FILES = {".env", ".DS_Store", "Thumbs.db", "desktop.ini"}
REQUIRED_FILES = {
    "Dockerfile",
    "package.json",
    "pnpm-lock.yaml",
    "deploy/docker-compose.yml",
    "apps/server/migrations/0021_restore_freeze_hardening.sql",
    "apps/server/src/services/restore.ts",
    "docs/08-部署与发布.md",
}


def version_name() -> str:
    value = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    return value if str(value).startswith("V") else f"V{value}"


def embedded_release_files() -> set[str]:
    version = version_name()
    return {
        f"release/ai-archiveextension-{version}-chrome.zip",
        f"release/ai-conversation-archive-windows-sync-{version}.zip",
        f"release/ai-conversation-archive-macos-sync-{version}.tar.gz",
    }


def should_include(path: Path) -> bool:
    relative = path.relative_to(ROOT)
    if relative.parts and relative.parts[0] == "release":
        return relative.as_posix() in embedded_release_files() and path.is_file()
    if any(part in EXCLUDED_DIRECTORIES or part.startswith(".tmp-") for part in relative.parts):
        return False
    if path.name in EXCLUDED_FILES or path.name.endswith(".log") or "_Conflict." in path.name:
        return False
    if path.name.endswith(".tsbuildinfo"):
        return False
    return path.is_file()


def normalized_info(path: Path, archive_name: str) -> tarfile.TarInfo:
    info = tarfile.TarInfo(archive_name)
    stat_result = path.stat()
    info.size = stat_result.st_size
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
    files = sorted((path for path in ROOT.rglob("*") if should_include(path)), key=str)
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
                        with path.open("rb") as source:
                            archive.addfile(normalized_info(path, f"./{relative}"), source)
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    verify(output)
    print(f"Created {output} ({output.stat().st_size} bytes, {len(files)} files)")


def verify(path: Path) -> None:
    path = path.resolve()
    allowed_release_files = embedded_release_files()
    with tarfile.open(path, "r:gz") as archive:
        names: set[str] = set()
        for member in archive.getmembers():
            normalized = member.name.removeprefix("./")
            pure = PurePosixPath(normalized)
            if pure.is_absolute() or ".." in pure.parts:
                raise ValueError(f"Unsafe archive path: {member.name}")
            if normalized:
                names.add(normalized.rstrip("/"))
            if normalized.startswith("release/"):
                if normalized not in allowed_release_files:
                    raise ValueError(f"Unexpected release artifact leaked into archive: {member.name}")
            elif any(part in EXCLUDED_DIRECTORIES for part in pure.parts):
                raise ValueError(f"Excluded directory leaked into archive: {member.name}")
            if "_Conflict." in pure.name:
                raise ValueError(f"Conflict copy leaked into archive: {member.name}")
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
