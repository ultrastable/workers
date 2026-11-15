#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
# One-command install for a new organization (PL-6, issue #40).
# Usage: ./install.sh [org-dir]   Creates a venv, installs the core, initialises a database and runs a tick.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dir="${1:-ultrastable-org}"
mkdir -p "$dir"
python3 -m venv "$dir/.venv"
"$dir/.venv/bin/pip" install --quiet "$here"
"$dir/.venv/bin/ultrastable" --db "$dir/ultrastable.db" init
"$dir/.venv/bin/ultrastable" --db "$dir/ultrastable.db" tick
"$dir/.venv/bin/ultrastable" --db "$dir/ultrastable.db" status
echo "Installed in $dir. Serve with: $dir/.venv/bin/ultrastable --db $dir/ultrastable.db serve"
