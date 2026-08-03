#!/usr/bin/env python3
"""Install the exact Rust toolchain required for LCM's Linux helper."""

from __future__ import annotations

import argparse
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile
from dataclasses import dataclass
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener


RUST_VERSION = "1.93.0"
RUST_COMMIT = "254b59607d4417e9dffbc307138ae5c86280fe4c"
CARGO_COMMIT = "083ac5135f967fd9dc906ab057a2315861c7a80d"
HOST = "x86_64-unknown-linux-gnu"
TARGET = "x86_64-unknown-linux-musl"


@dataclass(frozen=True)
class Component:
    name: str
    url: str
    sha256: str


COMPONENTS = (
    Component(
        "rustc",
        "https://static.rust-lang.org/dist/2026-01-22/rustc-1.93.0-x86_64-unknown-linux-gnu.tar.xz",
        "00c6e6740ea6a795e33568cd7514855d58408a1180cd820284a7bbf7c46af715",
    ),
    Component(
        "cargo",
        "https://static.rust-lang.org/dist/2026-01-22/cargo-1.93.0-x86_64-unknown-linux-gnu.tar.xz",
        "c23de3ae709ff33eed5e4ae59d1f9bcd75fa4dbaa9fb92f7b06bfb534b8db880",
    ),
    Component(
        "rust-std-host",
        "https://static.rust-lang.org/dist/2026-01-22/rust-std-1.93.0-x86_64-unknown-linux-gnu.tar.xz",
        "a849a418d0f27e69573e41763c395e924a0b98c16fcdc55599c1c79c27c1c777",
    ),
    Component(
        "rust-std-musl",
        "https://static.rust-lang.org/dist/2026-01-22/rust-std-1.93.0-x86_64-unknown-linux-musl.tar.xz",
        "874658d2ced1ed2b9bf66c148b78a2e10cad475d0a4db32e68a08900905b89b8",
    ),
)


class NoRedirect(HTTPRedirectHandler):
    """Fail instead of silently changing one of the pinned artifact URLs."""

    def redirect_request(self, request, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        raise HTTPError(request.full_url, code, "redirects are not permitted", headers, fp)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", required=True, type=Path)
    return parser.parse_args()


def download(component: Component, downloads_dir: Path) -> Path:
    destination = downloads_dir / Path(component.url).name
    request = Request(component.url, headers={"User-Agent": "lcm-verified-rust-toolchain"})
    opener = build_opener(NoRedirect())
    with opener.open(request, timeout=60) as response, destination.open("xb") as artifact:
        shutil.copyfileobj(response, artifact)
        artifact.flush()
        os.fsync(artifact.fileno())
    return destination


def verify_archive(component: Component, archive: Path, checksums_dir: Path) -> None:
    checksum_file = checksums_dir / f"{component.name}.sha256"
    checksum_file.write_text(f"{component.sha256}  {archive}\n", encoding="ascii")
    subprocess.run(
        ["sha256sum", "--check", "--strict", str(checksum_file)],
        check=True,
    )


def safe_extract(archive: Path, destination: Path) -> Path:
    with tarfile.open(archive, mode="r:xz") as bundle:
        members = bundle.getmembers()
        for member in members:
            member_path = PurePosixPath(member.name)
            link_path = PurePosixPath(member.linkname)
            if member_path.is_absolute() or ".." in member_path.parts:
                raise ValueError(f"unsafe archive member {member.name!r}")
            if (member.issym() or member.islnk()) and (link_path.is_absolute() or ".." in link_path.parts):
                raise ValueError(f"unsafe archive link {member.name!r}")
        bundle.extractall(destination, members=members)

    roots = [path for path in destination.iterdir() if path.is_dir()]
    if len(roots) != 1 or not (roots[0] / "install.sh").is_file():
        raise ValueError(f"unexpected Rust component archive layout for {archive.name}")
    return roots[0]


def install_component(component_root: Path, prefix: Path) -> None:
    subprocess.run(
        [str(component_root / "install.sh"), f"--prefix={prefix}", "--disable-ldconfig"],
        check=True,
    )


def verify_toolchain(prefix: Path) -> None:
    rustc = prefix / "bin" / "rustc"
    cargo = prefix / "bin" / "cargo"
    target_std = prefix / "lib" / "rustlib" / TARGET / "lib"
    if not rustc.is_file() or not cargo.is_file() or not target_std.is_dir():
        raise RuntimeError("installed Rust toolchain is incomplete")

    for name, executable, commit in (("rustc", rustc, RUST_COMMIT), ("cargo", cargo, CARGO_COMMIT)):
        version = subprocess.run(
            [str(executable), "--version", "--verbose"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        if f"release: {RUST_VERSION}" not in version or f"commit-hash: {commit}" not in version:
            raise RuntimeError(
                f"installed {name} does not match the pinned Rust {RUST_VERSION} toolchain",
            )


def main() -> None:
    args = parse_args()
    prefix = args.prefix.resolve()
    if prefix == Path(prefix.anchor) or prefix.exists() and any(prefix.iterdir()):
        raise RuntimeError(f"refusing to install into non-empty prefix {prefix}")
    prefix.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(dir=prefix, prefix=".verified-rust-") as temporary:
        temporary_path = Path(temporary)
        downloads_dir = temporary_path / "downloads"
        checksums_dir = temporary_path / "checksums"
        downloads_dir.mkdir()
        checksums_dir.mkdir()

        archives = [(component, download(component, downloads_dir)) for component in COMPONENTS]
        for component, archive in archives:
            verify_archive(component, archive, checksums_dir)
        for component, archive in archives:
            component_dir = safe_extract(archive, temporary_path / component.name)
            install_component(component_dir, prefix)

    verify_toolchain(prefix)


if __name__ == "__main__":
    main()
