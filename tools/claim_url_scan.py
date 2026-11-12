#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""Scan a transcript for a leaked Cloudflare claim URL or API key (issue #24). Exit 1 when anything is found.

  python tools/claim_url_scan.py FILE [FILE ...]      # prints findings with the secret masked, never the secret
  python tools/claim_url_scan.py --redact < in > out  # masks them in a stream
"""
from __future__ import annotations

import re
import sys

PATTERNS = {
    "claim-url": re.compile(r"https?://[^\s\"'<>]*claim[^\s\"'<>]*", re.I),
    "cloudflare-token": re.compile(r"\bcfut_[A-Za-z0-9_-]{20,}"),
    "bearer": re.compile(r"Bearer\s+[A-Za-z0-9_.-]{20,}"),
    "api-key-assignment": re.compile(r"(?:CLOUDFLARE_API_TOKEN|ANTHROPIC_API_KEY|GITHUB_TOKEN)\s*[=:]\s*['\"]?[A-Za-z0-9_.-]{16,}"),
}


def scan(text: str) -> list[tuple[str, int]]:
    """(kind, line number) for each leak. Never returns the secret itself."""
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        for kind, rx in PATTERNS.items():
            if rx.search(line):
                out.append((kind, n))
    return out


def redact(text: str) -> str:
    for kind, rx in PATTERNS.items():
        text = rx.sub(f"[redacted {kind}]", text)
    return text


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["--redact"]:
        sys.stdout.write(redact(sys.stdin.read())); return 0
    bad = 0
    for f in argv:
        for kind, n in scan(open(f, encoding="utf-8", errors="replace").read()):
            print(f"{f}:{n}: {kind}"); bad += 1
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
