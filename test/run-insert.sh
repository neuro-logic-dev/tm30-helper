#!/usr/bin/env bash
#
# Runs the T3-08 ⇥ insert-sheet harness.
#
# Like `run-autofill.sh`, it needs a real Electron window: the thing under test is a file being
# placed into a `<webview>`'s file input over CDP (and the in-page fallback), and there is no
# way to exercise that outside Electron. It loads the SHIPPED `app.html` + `preload.js` and
# registers the SHIPPED `insert-sheet.js` engine — the production handler, not a copy — then
# drives the REAL T3-07 mock portal end to end: login → ⇥ insert → the mock's own submit →
# receipt (valid sheet) / itemized rejection (broken sheet).
#
# Usage: desktop/tm30-helper/test/run-insert.sh [--no-sandbox]
#        INSERT_HEADFUL=1 test/run-insert.sh     # visible window + PNG screenshots
# Exit:  0 = every assertion held, 1 = something regressed.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$(cd "$HERE/.." && pwd)"

ELECTRON="$HELPER/node_modules/.bin/electron"
if [[ ! -x "$ELECTRON" ]]; then
  echo "✗ electron not found at $ELECTRON — run npm install in $HELPER first." >&2
  exit 1
fi

echo "→ running the T3-08 insert harness (real app.html + insert-sheet.js, real mock portal)"
exec "$ELECTRON" "$HERE/insert/harness.js" "$@"
