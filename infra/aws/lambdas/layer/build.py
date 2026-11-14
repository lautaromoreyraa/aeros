"""Build the Lambda layer: DuckDB and H3 for linux/arm64, plus DuckDB's httpfs.

    python build.py <output-dir> [--cross]

`--cross` makes pip fetch Linux arm64 wheels from any host (Windows, macOS,
an x86 CI runner), so synth needs neither Docker nor an arm64 machine. Inside
the Lambda build image the flag is left out and pip resolves natively.

httpfs is downloaded at build time because a running function cannot write
outside /tmp and should not depend on reaching the extension repository.
DuckDB checks the extension's signature when it loads it.
"""

from __future__ import annotations

import gzip
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXTENSION_URL = "https://extensions.duckdb.org/v{version}/linux_arm64/httpfs.duckdb_extension.gz"
CROSS_FLAGS = [
    "--platform",
    "manylinux_2_28_aarch64",
    "--implementation",
    "cp",
    "--python-version",
    "3.12",
    "--only-binary=:all:",
]


def duckdb_version(requirements: Path) -> str:
    match = re.search(r"^duckdb==([\d.]+)\s*$", requirements.read_text(), re.MULTILINE)
    if not match:
        raise SystemExit("requirements.txt must pin duckdb with ==")
    return match[1]


def main(argv: list[str]) -> int:
    out = Path(argv[0])
    cross = "--cross" in argv[1:]
    requirements = HERE / "requirements.txt"
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--quiet",
            "--no-compile",
            "--disable-pip-version-check",
            "-r",
            str(requirements),
            "--target",
            str(out / "python"),
            *(CROSS_FLAGS if cross else []),
        ],
        check=True,
    )
    target = out / "duckdb" / "httpfs.duckdb_extension"
    target.parent.mkdir(parents=True, exist_ok=True)
    url = EXTENSION_URL.format(version=duckdb_version(requirements))
    # The extension host turns away urllib's default User-Agent.
    request = urllib.request.Request(url, headers={"User-Agent": "aeros-layer-build"})
    with urllib.request.urlopen(request, timeout=120) as response:  # noqa: S310 (fixed https URL)
        target.write_bytes(gzip.decompress(response.read()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
