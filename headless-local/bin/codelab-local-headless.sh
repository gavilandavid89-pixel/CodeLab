#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -d "$SCRIPT_DIR/headless-local" ] && [ -d "$SCRIPT_DIR/headless-penpot" ]; then
  PACKAGE_ROOT="$SCRIPT_DIR"
  LOCAL_ROOT="$SCRIPT_DIR/headless-local"
else
  LOCAL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  PACKAGE_ROOT="$(cd "$LOCAL_ROOT/.." && pwd)"
fi
MODE="${1:-help}"
if [ "$#" -gt 0 ]; then shift; fi
export CODELAB_LOCAL_HEADLESS_ROOT="$LOCAL_ROOT"
export CODELAB_HEADLESS_WIDTH="${CODELAB_HEADLESS_WIDTH:-1600}"
export CODELAB_HEADLESS_HEIGHT="${CODELAB_HEADLESS_HEIGHT:-1000}"
APP_ROOT="$PACKAGE_ROOT/app"
PENPOT_ROOT="$PACKAGE_ROOT/headless-penpot"
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
    if [ ! -f "$APP_ROOT/server.js" ] || [ ! -f "$APP_ROOT/package.json" ] || [ ! -f "$APP_ROOT/public/index.html" ] || [ ! -f "$APP_ROOT/public/app.js" ]; then
      echo "Packaged CodeLab application is incomplete." >&2
      exit 2
    fi
    if [ ! -f "$LOCAL_ROOT/runtime/capabilities.json" ]; then
      echo "Local workbench capability manifest is missing." >&2
      exit 2
    fi
    if [ ! -x "$PENPOT_ROOT/bin/codelab-headless.sh" ] || [ ! -f "$PACKAGE_ROOT/penpot/dist/index.html" ]; then
      echo "Full compiled Penpot editor is missing from the local package." >&2
      exit 2
    fi
    node --check "$APP_ROOT/server.js"
    "$PENPOT_ROOT/bin/codelab-headless.sh" check
    echo "CodeLab Local Headless Workbench: OK"
    ;;
  design)
    export CODELAB_PENPOT_DIST="$PACKAGE_ROOT/penpot/dist"
    exec "$PENPOT_ROOT/bin/codelab-headless.sh" design "$@"
    ;;
  web|capture|export)
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
