#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/../vendor/penpot/frontend/target/dist"
[ -n "$CODELAB_PENPOT_DIST" ] && DIST="$CODELAB_PENPOT_DIST"
WORKSPACE="$ROOT/workspace"
[ -n "$CODELAB_HEADLESS_WORKSPACE" ] && WORKSPACE="$CODELAB_HEADLESS_WORKSPACE"
PORT=4310
[ -n "$CODELAB_HEADLESS_DESIGN_PORT" ] && PORT="$CODELAB_HEADLESS_DESIGN_PORT"
[ -f "$DIST/index.html" ] || { echo "Missing compiled Penpot editor: $DIST" >&2; exit 1; }
mkdir -p "$WORKSPACE"
"$ROOT/bin/check-deps.sh"
SCREEN="$CODELAB_HEADLESS_WIDTH"x"$CODELAB_HEADLESS_HEIGHT"x"$CODELAB_HEADLESS_DEPTH"
exec xvfb-run -a -s "-screen 0 $SCREEN -nolisten tcp"   env CODELAB_HEADLESS_WORKSPACE="$WORKSPACE"   node "$ROOT/runtime/design-server.mjs" --dist "$DIST" --workspace "$WORKSPACE" --port "$PORT" "$@"
