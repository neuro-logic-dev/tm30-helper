#!/usr/bin/env bash
#
# Runs the A-WEB-4f mark-submitted hand-back harness.
#
# Like `run.sh`, it compiles the REAL web sources rather than mirroring them into fixtures —
# `src/lib/tm30.ts` (the emitter that WRITES `return_url`) and `src/lib/reservation-url.ts` (the
# parser that READS it back). Both halves of the §8.4 seam are then run against each other for
# real. Like `run-autofill.sh`, it needs Electron: the hand-back only exists as renderer →
# preload → ipcMain → shell, and there is no way to exercise that outside a real app.
#
# The harness requires the SHIPPED `main.js` and passes it the fixture deep link in argv, so the
# window under test is opened by production code. Only `shell.openExternal` is stubbed — a real
# one would throw three browser tabs at whoever runs the suite.
#
# Usage: desktop/tm30-helper/test/run-handback.sh
# Exit:  0 = every assertion held, 1 = something regressed.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$(cd "$HERE/.." && pwd)"
# Resolved, not counted upward — see the box in web-root.js.
WEB_ROOT="$(node "$HERE/web-root.js")"
BUILD_DIR="$HERE/.build"

TSC="$WEB_ROOT/node_modules/.bin/tsc"
if [[ ! -x "$TSC" ]]; then
  echo "✗ tsc not found at $TSC — run pnpm install in $WEB_ROOT first." >&2
  exit 1
fi

ELECTRON="$HELPER/node_modules/.bin/electron"
if [[ ! -x "$ELECTRON" ]]; then
  echo "✗ electron not found at $ELECTRON — run npm install in $HELPER first." >&2
  exit 1
fi

echo "→ compiling both ends of the seam: src/lib/tm30.ts + src/lib/reservation-url.ts"
"$TSC" "$WEB_ROOT/src/lib/tm30.ts" "$WEB_ROOT/src/lib/reservation-url.ts" \
  --outDir "$BUILD_DIR" \
  --module commonjs \
  --target es2022 \
  --moduleResolution node \
  --strict \
  --skipLibCheck

echo "→ building the fixture deep link"
LINK="$(node "$HERE/handback/fixture.js")"

echo "→ running the 4f hand-back harness (real main.js, stubbed shell.openExternal)"
exec "$ELECTRON" "$HERE/handback/harness.js" "$LINK"
