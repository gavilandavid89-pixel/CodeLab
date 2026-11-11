#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL=""
OUT="$ROOT/artifacts/capture.png"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --output) OUT="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$URL" ] || { echo "--url is required" >&2; exit 2; }
mkdir -p "$(dirname "$OUT")"
SCREEN="$CODELAB_HEADLESS_WIDTH"x"$CODELAB_HEADLESS_HEIGHT"x"$CODELAB_HEADLESS_DEPTH"
exec xvfb-run -a -s "-screen 0 $SCREEN -nolisten tcp"   node "$ROOT/runtime/web-test.mjs" --url "$URL" --capture --output "$OUT"
