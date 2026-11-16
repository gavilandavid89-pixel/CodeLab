#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-help}"
if [ "$#" -gt 0 ]; then shift; fi
export CODELAB_LOCAL_HEADLESS_ROOT="$ROOT"
export CODELAB_HEADLESS_WIDTH="${CODELAB_HEADLESS_WIDTH:-1600}"
export CODELAB_HEADLESS_HEIGHT="${CODELAB_HEADLESS_HEIGHT:-1000}"
APP_ROOT="$ROOT/app"
PENPOT_ROOT="$ROOT/headless-penpot"
case "$MODE" in
  app)
    if [ ! -f "$APP_ROOT/server.js" ]; then
      echo "Packaged CodeLab app source is missing: $APP_ROOT" >&2
      exit 2
    fi
    cd "$APP_ROOT"
    export NODE_ENV="${NODE_ENV:-development}"
    export PORT="${PORT:-3000}"
    export CODELAB_LOCAL_MODE=1
    if [ -n "${DATABASE_URL:-}" ] && [ "${CODELAB_LOCAL_ALLOW_DATABASE:-0}" != "1" ]; then
      echo "Ignoring inherited DATABASE_URL for safety. Set CODELAB_LOCAL_ALLOW_DATABASE=1 to opt in to a database." >&2
      unset DATABASE_URL
    fi
    exec node server.js "$@"
    ;;
  check)
    if [ ! -f "$APP_ROOT/server.js" ] || [ ! -f "$APP_ROOT/package.json" ] || [ ! -f "$APP_ROOT/public/index.html" ]; then
      echo "Packaged CodeLab application is incomplete." >&2
      exit 2
    fi
    if [ ! -x "$PENPOT_ROOT/bin/codelab-headless.sh" ]; then
      echo "Full Penpot worker is missing from the local package." >&2
      exit 2
    fi
    node --check "$APP_ROOT/server.js"
    "$PENPOT_ROOT/bin/codelab-headless.sh" check
    echo "CodeLab Local Headless Workbench: OK"
    ;;
  design|web|capture|export)
    if [ ! -x "$PENPOT_ROOT/bin/codelab-headless.sh" ]; then
      echo "Full Penpot worker is missing from the local package." >&2
      exit 2
    fi
    exec "$PENPOT_ROOT/bin/codelab-headless.sh" "$MODE" "$@"
    ;;
  *)
    cat <<'EOF'
CodeLab Local Headless Workbench (Headless #1)
  app                              run the packaged CodeLab application
  design                           run the full native Penpot editor
  web --url URL [--capture]        inspect a local CodeLab page
  capture --url URL                capture a page
  export --workspace DIR           export the native design workspace
  check                            validate the local workbench
EOF
    ;;
esac
