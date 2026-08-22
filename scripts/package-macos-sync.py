#!/usr/bin/env python3
"""Build the macOS sync release with explicit Unix file modes."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tarfile
import tempfile
from io import BytesIO
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RELEASE_DIR = ROOT / "release"
EXPECTED_FILES = {
    "AI-Archive-Sync.command": 0o755,
    "openclaw-sync.cjs": 0o644,
    "README-MACOS-SYNC.md": 0o644,
}


def current_version() -> str:
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    return f"V{package['version']}"


def normalized_version(value: str) -> str:
    version = value if value.startswith("V") else f"V{value}"
    if not re.fullmatch(r"V\d+\.\d+\.\d+", version):
        raise ValueError(f"Invalid release version: {value}")
    return version


def add_file(
    archive: tarfile.TarFile,
    source: Path,
    archive_name: str,
    mode: int,
    *,
    normalize_lf: bool = False,
) -> None:
    if not source.is_file():
        raise FileNotFoundError(f"Required release input is missing: {source}")
    content = source.read_bytes()
    if normalize_lf:
        content = content.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    info = archive.gettarinfo(str(source), arcname=archive_name)
    info.mode = mode
    info.size = len(content)
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    archive.addfile(info, BytesIO(content))


def verify_archive(path: Path, version: str | None = None) -> tuple[int, str]:
    if not path.is_file():
        raise FileNotFoundError(f"Release archive does not exist: {path}")

    expected_root = f"macos-sync-{version}" if version else None
    with tarfile.open(path, "r:gz") as archive:
        members = {member.name.rstrip("/"): member for member in archive.getmembers()}
        roots = {name.split("/", 1)[0] for name in members}
        if expected_root is None:
            if len(roots) != 1:
                raise ValueError(f"Expected one archive root, found: {sorted(roots)}")
            expected_root = roots.pop()

        root = members.get(expected_root)
        if root is None or not root.isdir() or root.mode & 0o777 != 0o755:
            raise ValueError(f"Archive root must be a 0755 directory: {expected_root}")

        expected_names = {expected_root}
        for filename, expected_mode in EXPECTED_FILES.items():
            archive_name = f"{expected_root}/{filename}"
            expected_names.add(archive_name)
            member = members.get(archive_name)
            if member is None or not member.isfile():
                raise ValueError(f"Missing release file: {archive_name}")
            actual_mode = member.mode & 0o777
            if actual_mode != expected_mode:
                raise ValueError(
                    f"Incorrect mode for {archive_name}: "
                    f"{actual_mode:04o}, expected {expected_mode:04o}"
                )

        unexpected = set(members) - expected_names
        if unexpected:
            raise ValueError(f"Unexpected files in macOS release: {sorted(unexpected)}")

        command = archive.extractfile(f"{expected_root}/AI-Archive-Sync.command")
        command_content = command.read() if command is not None else b""
        if not command_content.startswith(b"#!/bin/sh\n"):
            raise ValueError("AI-Archive-Sync.command has an invalid shell entry point")
        if b"\r" in command_content:
            raise ValueError("AI-Archive-Sync.command must contain LF line endings only")

    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return path.stat().st_size, digest


def build_archive(version: str, output: Path) -> None:
    folder = f"macos-sync-{version}"
    inputs = {
        "AI-Archive-Sync.command": ROOT / "scripts" / "AI-Archive-Sync.command",
        "openclaw-sync.cjs": ROOT / "apps" / "openclaw-sync" / "dist" / "index.cjs",
        "README-MACOS-SYNC.md": ROOT / "docs" / "MACOS-SYNC.md",
    }
    for source in inputs.values():
        if not source.is_file():
            raise FileNotFoundError(f"Required release input is missing: {source}")

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=output.parent,
            prefix=f".{output.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)

        with tarfile.open(temporary_path, "w:gz", format=tarfile.PAX_FORMAT) as archive:
            directory = tarfile.TarInfo(folder)
            directory.type = tarfile.DIRTYPE
            directory.mode = 0o755
            directory.uid = 0
            directory.gid = 0
            directory.uname = "root"
            directory.gname = "root"
            directory.mtime = max(int(source.stat().st_mtime) for source in inputs.values())
            archive.addfile(directory)

            for filename, source in inputs.items():
                add_file(
                    archive,
                    source,
                    f"{folder}/{filename}",
                    EXPECTED_FILES[filename],
                    normalize_lf=filename == "AI-Archive-Sync.command",
                )

        verify_archive(temporary_path, version)
        os.replace(temporary_path, output)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", default=current_version())
    parser.add_argument("--output", type=Path)
    parser.add_argument("--verify", type=Path)
    args = parser.parse_args()

    if args.verify:
        archive = args.verify.resolve()
        version = None
    else:
        version = normalized_version(args.version)
        archive = (
            args.output.resolve()
            if args.output
            else RELEASE_DIR / f"ai-conversation-archive-macos-sync-{version}.tar.gz"
        )
        build_archive(version, archive)

    size, digest = verify_archive(archive, version)
    print(f"archive={archive}")
    print(f"size={size}")
    print(f"sha256={digest}")


if __name__ == "__main__":
    main()
