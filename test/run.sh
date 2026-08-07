#!/usr/bin/env bash
#
# Runs the A-WEB-4b emitter↔parser seam test.
#
# The producer half lives in the web app as TypeScript (`src/lib/tm30.ts`) and the consumer half
# is plain CommonJS here (`../deeplink.js`). Rather than re-type the emitter into a fixture — the
# very drift this test exists to catch — we compile the REAL source with the repo's own tsc and
# feed its actual output to the real parser.
#
# `src/lib/tm30.ts` is dependency-free (no imports), so a single-file compile is sufficient and
# needs no path-alias or bundler setup.
#
# Usage: desktop/tm30-helper/test/run.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Resolved, not counted upward: this repo is checked out both nested inside mo-reservation-fe
# and standalone beside it. See the box in web-root.js.
WEB_ROOT="$(node "$HERE/web-root.js")"
BUILD_DIR="$HERE/.build"

TSC="$WEB_ROOT/node_modules/.bin/tsc"
if [[ ! -x "$TSC" ]]; then
  echo "✗ tsc not found at $TSC — run pnpm install in $WEB_ROOT first." >&2
  exit 1
fi

echo "→ compiling the real emitter: src/lib/tm30.ts"
rm -rf "$BUILD_DIR"
"$TSC" "$WEB_ROOT/src/lib/tm30.ts" \
  --outDir "$BUILD_DIR" \
  --module commonjs \
  --target es2022 \
  --moduleResolution node \
  --strict \
  --skipLibCheck

echo "→ running the seam test"
cd "$HERE"
# Named explicitly, NOT discovered. `node --test` treats every .js under a directory called
# `test` as a test file, so a bare `node --test` also picked up the compiled emitter in
# `.build/` and — once A-WEB-4e added `autofill/` — tried to run two Electron entrypoints
# outside Electron, turning a green suite into 2 spurious failures. This file is the seam test;
# the 4e harness has its own runner (`run-autofill.sh`) because it needs a real Electron window.
node --test roundtrip.test.mjs
