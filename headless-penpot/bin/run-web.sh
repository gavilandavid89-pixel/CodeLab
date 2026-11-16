#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL=""
CAPTURE=""
EXTRA=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --capture) CAPTURE="--capture"; shift ;;
    --commands|--report|--output) EXTRA+=("$1" "$2"); shift 2 ;;
    --allow-external|--no-networkidle) EXTRA+=("$1"); shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$URL" ] || { echo "--url is required" >&2; exit 2; }
"$ROOT/bin/check-deps.sh"
SCREEN="$CODELAB_HEADLESS_WIDTH"x"$CODELAB_HEADLESS_HEIGHT"x"$CODELAB_HEADLESS_DEPTH"
exec xvfb-run -a -s "-screen 0 $SCREEN -nolisten tcp" \
  node "$ROOT/runtime/web-test.mjs" --url "$URL" $CAPTURE "${EXTRA[@]}"
