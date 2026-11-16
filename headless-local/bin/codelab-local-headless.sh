#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$(basename "$(dirname "$SCRIPT_DIR")")" = "headless-local" ]; then
  # Running from the source checkout: the repository itself is the CodeLab app.
  LOCAL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  PACKAGE_ROOT="$(cd "$LOCAL_ROOT/.." && pwd)"
  APP_ROOT="$PACKAGE_ROOT"
  PENPOT_ROOT="$PACKAGE_ROOT/headless-penpot"
  PENPOT_DIST="$PACKAGE_ROOT/vendor/penpot/frontend/target/dist"
else
  # Running from the downloadable artifact: app, Penpot and manifest are siblings.
  PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  LOCAL_ROOT="$PACKAGE_ROOT/headless-local"
  APP_ROOT="$PACKAGE_ROOT/app"
  PENPOT_ROOT="$PACKAGE_ROOT/headless-penpot"
  PENPOT_DIST="$PACKAGE_ROOT/penpot/dist"
fi
MODE="${1:-help}"
if [ "$#" -gt 0 ]; then shift; fi
export CODELAB_LOCAL_HEADLESS_ROOT="$LOCAL_ROOT"
export CODELAB_HEADLESS_WIDTH="${CODELAB_HEADLESS_WIDTH:-1600}"
export CODELAB_HEADLESS_HEIGHT="${CODELAB_HEADLESS_HEIGHT:-1000}"
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
      echo "Ignoring inherited DATABASE_URL for safety. Set CODELAB_LOCAL_ALLOW_DATABASE=1 to opt in to an external database." >&2
      unset DATABASE_URL
    fi
    if [ "${CODELAB_LOCAL_NO_DATABASE:-0}" != "1" ] && [ -z "${DATABASE_URL:-}" ]; then
      if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
        echo "The full local CodeLab backend requires Docker Compose. Run 'bin/codelab-local-headless.sh db-up' first, or set CODELAB_LOCAL_NO_DATABASE=1 for frontend-only inspection." >&2
        exit 2
      fi
      docker compose -p codelab-local-headless -f "$LOCAL_ROOT/docker-compose.yml" up -d db
      export DATABASE_URL="postgres://codelab_local:codelab_local_only@127.0.0.1:55432/codelab_local"
      for attempt in $(seq 1 30); do
        if docker compose -p codelab-local-headless -f "$LOCAL_ROOT/docker-compose.yml" exec -T db pg_isready -U codelab_local -d codelab_local >/dev/null 2>&1; then break; fi
        sleep 1
      done
      docker compose -p codelab-local-headless -f "$LOCAL_ROOT/docker-compose.yml" exec -T db pg_isready -U codelab_local -d codelab_local >/dev/null
    fi
    exec node server.js "$@"
    ;;
  db-up)
    command -v docker >/dev/null 2>&1 || { echo "Docker is required for the local PostgreSQL service." >&2; exit 2; }
    docker compose -p codelab-local-headless -f "$LOCAL_ROOT/docker-compose.yml" up -d db
    ;;
  db-down)
    command -v docker >/dev/null 2>&1 || { echo "Docker is required for the local PostgreSQL service." >&2; exit 2; }
    docker compose -p codelab-local-headless -f "$LOCAL_ROOT/docker-compose.yml" stop db
    ;;
  check)
    if [ ! -f "$APP_ROOT/server.js" ] || [ ! -f "$APP_ROOT/package.json" ] || [ ! -f "$APP_ROOT/public/index.html" ] || [ ! -f "$APP_ROOT/public/app.js" ]; then
      echo "Packaged CodeLab application is incomplete." >&2
      exit 2
    fi
    if [ ! -f "$LOCAL_ROOT/runtime/capabilities.json" ] || [ ! -s "$LOCAL_ROOT/docker-compose.yml" ]; then
      echo "Local workbench capability manifest or PostgreSQL service definition is missing." >&2
      exit 2
    fi
    if [ ! -x "$PENPOT_ROOT/bin/codelab-headless.sh" ] || [ ! -s "$PENPOT_DIST/index.html" ]; then
      echo "Full compiled Penpot editor is missing from the local package." >&2
      exit 2
    fi
    node --check "$APP_ROOT/server.js"
    "$PENPOT_ROOT/bin/codelab-headless.sh" check
    echo "CodeLab Local Headless Workbench: OK"
    ;;
  design)
    export CODELAB_PENPOT_DIST="$PENPOT_DIST"
    exec "$PENPOT_ROOT/bin/codelab-headless.sh" design "$@"
    ;;
  web|capture|export)
    exec "$PENPOT_ROOT/bin/codelab-headless.sh" "$MODE" "$@"
    ;;
  *)
    cat <<'EOF'
CodeLab Local Headless Workbench (Headless #1)
  app                              run CodeLab with its isolated local PostgreSQL
  db-up                            start the persistent local PostgreSQL service
  db-down                          stop the local PostgreSQL service (keeps data)
  design                           run the full native Penpot editor
  web --url URL [--commands FILE]  inspect and operate a CodeLab page
  capture --url URL                capture a page
  export --workspace DIR           export the native design workspace
  check                            validate the local workbench
EOF
    ;;
esac
