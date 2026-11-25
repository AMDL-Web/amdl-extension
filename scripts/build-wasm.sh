#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_WASM="$ROOT_DIR/src/wasm/temari.wasm"
CARGO_CACHE_DIR="${CARGO_CACHE_DIR:-/tmp/amdl-cargo-cache}"

mkdir -p "$(dirname "$OUT_WASM")" "$CARGO_CACHE_DIR"

if command -v rustc >/dev/null 2>&1 && rustup target list --installed | grep -q '^wasm32-unknown-unknown$'; then
  (
    cd "$ROOT_DIR/crates/temari-wasm"
    cargo build --release --target wasm32-unknown-unknown
    cp target/wasm32-unknown-unknown/release/temari_wasm.wasm "$OUT_WASM"
  )
else
  docker run --rm \
    -v "$ROOT_DIR/crates/temari-wasm:/work:ro" \
    -v "$CARGO_CACHE_DIR:/cargo-cache" \
    -w /work \
    -e CARGO_TARGET_DIR=/cargo-cache/target \
    rust:1.85-slim \
    bash -c '
      set -euo pipefail
      if ! rustup target list --installed | grep -q "^wasm32-unknown-unknown$"; then
        rustup target add wasm32-unknown-unknown
      fi
      cargo build --release --target wasm32-unknown-unknown
      cp "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/temari_wasm.wasm" /cargo-cache/temari_wasm.wasm
    '
  cp "$CARGO_CACHE_DIR/temari_wasm.wasm" "$OUT_WASM"
  chmod 644 "$OUT_WASM"
fi

ls -lh "$OUT_WASM"
