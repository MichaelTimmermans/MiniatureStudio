#!/usr/bin/env bash
# Build the vendored focus-stack (git submodule vendor/focus-stack).
# Output: vendor/focus-stack/build/focus-stack — app.py picks it up automatically.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/vendor/focus-stack"

[ -f "$SRC/Makefile" ] || git -C "$ROOT" submodule update --init --recursive
[ -f "$SRC/Makefile" ] || { echo "vendor/focus-stack is missing" >&2; exit 1; }

# Pi 3B has 1 GB RAM: parallel C++ builds against OpenCV headers run out of memory.
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
JOBS=$(( MEM_MB < 2000 ? 1 : $(nproc) ))

echo "==> Building focus-stack (make -j$JOBS)"
make -C "$SRC" -j"$JOBS" build/focus-stack
"$SRC/build/focus-stack" --version
