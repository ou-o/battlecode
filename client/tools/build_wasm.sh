#!/usr/bin/env bash
# Build wasm/apriltag.wasm from AprilTag C sources + wasm/wxat.c wrapper.
#
# Prerequisites:
#   - Emscripten SDK activated (emcc on PATH): https://emscripten.org/docs/getting_started/
#
# Usage:
#   tools/build_wasm.sh
#
# The AprilTag repo is cloned (pinned commit) into a build dir and compiled
# as a standalone (no-JS-glue) WASM module.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${BUILD_DIR:-$ROOT/.build/apriltag}"
APRILTAG_REPO="https://github.com/AprilRobotics/apriltag.git"
APRILTAG_COMMIT="b7c0ebe9aa20f82ec7a828579004f9e706bfecd9"

if ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc not found. Install & activate emsdk first." >&2
  exit 1
fi

mkdir -p "$BUILD_DIR"
if [ ! -d "$BUILD_DIR/apriltag-src" ]; then
  git clone "$APRILTAG_REPO" "$BUILD_DIR/apriltag-src"
fi
cd "$BUILD_DIR/apriltag-src"
git fetch --depth 1 origin "$APRILTAG_COMMIT" 2>/dev/null || true
git checkout -q "$APRILTAG_COMMIT"

SRC="$BUILD_DIR/apriltag-src"
OUT="$ROOT/wasm/apriltag.wasm"

emcc -O3 \
  -s STANDALONE_WASM --no-entry \
  -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=67108864 \
  -s EXPORTED_FUNCTIONS=_wxat_init,_wxat_detect_rgba,_wxat_shutdown,_wxat_set_decimate,_malloc,_free \
  -I"$SRC" \
  "$ROOT/wasm/wxat.c" \
  "$SRC/apriltag.c" "$SRC/apriltag_quad_thresh.c" \
  "$SRC/tag25h9.c" \
  "$SRC/common/image_u8.c" "$SRC/common/image_u8_parallel.c" \
  "$SRC/common/image_u8x3.c" "$SRC/common/image_u8x4.c" \
  "$SRC/common/matd.c" "$SRC/common/g2d.c" "$SRC/common/homography.c" \
  "$SRC/common/zarray.c" "$SRC/common/zhash.c" "$SRC/common/zmaxheap.c" \
  "$SRC/common/unionfind.c" "$SRC/common/workerpool.c" \
  "$SRC/common/string_util.c" "$SRC/common/time_util.c" "$SRC/common/pthreads_cross.c" \
  "$SRC/common/pnm.c" "$SRC/common/pam.c" "$SRC/common/pjpeg.c" "$SRC/common/pjpeg-idct.c" \
  -o "$OUT"

echo "built: $OUT ($(wc -c < "$OUT") bytes)"
