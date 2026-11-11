#!/usr/bin/env bash
set -euo pipefail
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
command -v xvfb-run >/dev/null || { echo "xvfb-run is required" >&2; exit 1; }
node -e "import('playwright-core').then(() => {}).catch(() => process.exit(1))" || {
  echo "playwright-core is required in the worker environment" >&2
  exit 1
}
for p in /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome /usr/bin/google-chrome-stable; do
  [ -x "$p" ] && exit 0
done
command -v chromium >/dev/null && exit 0
echo "A Chromium executable is required" >&2
exit 1
