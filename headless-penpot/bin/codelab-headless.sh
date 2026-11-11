#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE=help
[ "$#" -gt 0 ] && MODE="$1"
[ "$#" -gt 0 ] && shift
export CODELAB_HEADLESS_ROOT="$ROOT"
WIDTH=1600
HEIGHT=1000
DEPTH=24
[ -n "$CODELAB_HEADLESS_WIDTH" ] && WIDTH="$CODELAB_HEADLESS_WIDTH"
[ -n "$CODELAB_HEADLESS_HEIGHT" ] && HEIGHT="$CODELAB_HEADLESS_HEIGHT"
[ -n "$CODELAB_HEADLESS_DEPTH" ] && DEPTH="$CODELAB_HEADLESS_DEPTH"
export CODELAB_HEADLESS_WIDTH="$WIDTH"
export CODELAB_HEADLESS_HEIGHT="$HEIGHT"
export CODELAB_HEADLESS_DEPTH="$DEPTH"

case "$MODE" in
  design) exec "$ROOT/bin/run-design.sh" "$@" ;;
  web) exec "$ROOT/bin/run-web.sh" "$@" ;;
  capture) exec "$ROOT/bin/capture.sh" "$@" ;;
  export) exec "$ROOT/bin/export-design.sh" "$@" ;;
  check) exec "$ROOT/bin/check-deps.sh" ;;
  *) cat <<'EOF'
CodeLab Headless Penpot Worker
  design [--capture]             run the full Penpot editor under Xvfb
  web --url URL [--capture]      test a local CodeLab web app under Xvfb
  capture --url URL              capture a local page
  export --workspace DIR         package the native design workspace
  check                          validate offline runtime dependencies
EOF
    ;;
esac
