#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-help}"
shift || true
export CODELAB_HEADLESS_ROOT="$ROOT"
export CODELAB_HEADLESS_WIDTH="${CODELAB_HEADLESS_WIDTH:-1600}"
export CODELAB_HEADLESS_HEIGHT="${CODELAB_HEADLESS_HEIGHT:-1000}"
case "$MODE" in
  remote) exec node "$ROOT/runtime/remote-agent.mjs" "$@" ;;
  check)
    node --check "$ROOT/runtime/remote-agent.mjs"
    node --check "$ROOT/../public/codelab-headless-agent.js"
    command -v node >/dev/null
    echo "CodeLab headless remote worker: OK"
    ;;
  *) cat <<'EOF'
CodeLab Headless
  remote --url URL [--commands commands.json] [--auth-state state.json] [--screenshot]
  check
EOF
    ;;
esac
