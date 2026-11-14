#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
command -v xvfb-run >/dev/null || { echo "xvfb-run is required" >&2; exit 1; }

# Resolve bundled Node dependencies from the worker package, not the caller's
# current directory (the package is commonly extracted elsewhere).
cd "$ROOT"
node --input-type=module -e "await import('playwright-core')" || {
  echo "playwright-core is required in the worker package" >&2
  exit 1
}

for p in "${CHROMIUM_PATH:-}" /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome /usr/bin/google-chrome-stable; do
  [ -n "$p" ] && [ -x "$p" ] && exit 0
done
if command -v chromium >/dev/null; then
  exit 0
fi

# The portable package ships Chromium through @sparticuz/chromium. Extract it
# once here so subsequent Playwright launches can use its actual executable.
node --input-type=commonjs -e "const c=require('@sparticuz/chromium'); c.executablePath().then(p=>{if(!p)process.exit(1)}).catch(()=>process.exit(1))" || {
  echo "A system Chromium or bundled @sparticuz/chromium is required" >&2
  exit 1
}
