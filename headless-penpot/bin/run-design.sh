#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="${CODELAB_PENPOT_DIST:-$ROOT/../vendor/penpot/frontend/target/dist}"
WORKSPACE="${CODELAB_HEADLESS_WORKSPACE:-$ROOT/workspace}"
PORT="${CODELAB_HEADLESS_DESIGN_PORT:-4310}"
WIDTH="${CODELAB_HEADLESS_WIDTH:-1600}"
HEIGHT="${CODELAB_HEADLESS_HEIGHT:-1000}"
DEPTH="${CODELAB_HEADLESS_DEPTH:-24}"
[ -f "$DIST/index.html" ] || { echo "Missing compiled Penpot editor: $DIST" >&2; exit 1; }
mkdir -p "$WORKSPACE"
"$ROOT/bin/check-deps.sh"
SCREEN="$WIDTH"x"$HEIGHT"x"$DEPTH"
exec xvfb-run -a -s "-screen 0 $SCREEN -nolisten tcp" \
  env CODELAB_HEADLESS_WORKSPACE="$WORKSPACE" \
  node "$ROOT/runtime/design-server.mjs" --dist "$DIST" --workspace "$WORKSPACE" --port "$PORT" "$@"
