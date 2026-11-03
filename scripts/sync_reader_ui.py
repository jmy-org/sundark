"""Copy the canonical reader presentation (web/reader-ui.css) into the hosted Site checkout.

The Site is a separate repository, so it holds a generated copy, client/shared/reader-ui.css,
led by one header line that names this file and the sha256 of the body that follows it. The
Site build refuses a copy whose body does not match its header, and this repository's tests
compare the exported copy (hosted-reader/client/shared/reader-ui.css) with the source.

    uv run python scripts/sync_reader_ui.py --site /path/to/site           # write the copy
    uv run python scripts/sync_reader_ui.py --site /path/to/site --check   # fail on drift
"""

import argparse
import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "web" / "reader-ui.css"
TARGET = Path("client/shared/reader-ui.css")
HEADER = (
    "/* Generated from jmy-org/sundark web/reader-ui.css by scripts/sync_reader_ui.py."
    " sha256:{digest}. Do not edit. */\n"
)


def generated(source: bytes) -> bytes:
    """The Site copy of `source`: the header line, then the source bytes unchanged."""
    digest = hashlib.sha256(source).hexdigest()
    return HEADER.format(digest=digest).encode() + source


def body(copy: bytes) -> bytes:
    """The source bytes inside a generated copy; ValueError if its header does not match."""
    head, sep, rest = copy.partition(b"\n")
    digest = hashlib.sha256(rest).hexdigest()
    if not sep or head + b"\n" != HEADER.format(digest=digest).encode():
        raise ValueError("reader-ui.css copy: header missing or sha256 does not match")
    return rest


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Copy web/reader-ui.css into the Site."
    )
    parser.add_argument("--site", required=True, type=Path, help="Site checkout")
    parser.add_argument("--check", action="store_true", help="fail if the copy drifted")
    args = parser.parse_args(argv)
    target = args.site / TARGET
    want = generated(SOURCE.read_bytes())
    if args.check:
        if not target.exists() or target.read_bytes() != want:
            print(f"{target} differs from {SOURCE.relative_to(ROOT)}", file=sys.stderr)
            return 1
        return 0
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(want)
    print(f"wrote {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
