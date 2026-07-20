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
WEB_ROOT="$(cd "$HERE/../../.." && pwd)"
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
node --test
