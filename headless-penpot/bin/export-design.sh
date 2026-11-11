#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE=""
OUT="$ROOT/artifacts"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --output) OUT="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$WORKSPACE" ] || { echo "--workspace is required" >&2; exit 2; }
[ -d "$WORKSPACE" ] || { echo "Workspace does not exist: $WORKSPACE" >&2; exit 1; }
mkdir -p "$OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$OUT/codelab-design-$STAMP.tar.gz"
tar -C "$WORKSPACE" -czf "$ARCHIVE" .
sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"
echo "$ARCHIVE"
