#!/usr/bin/env bash
#
# Runs the A-WEB-4e credential-autofill harness.
#
# Unlike `run.sh` (the 4b emitter↔parser seam test, plain node), this one needs a real Electron
# window: the thing under test is a `<webview>` being injected into, and there is no way to
# exercise that outside Electron. It loads the SHIPPED `app.html` + `preload.js` and asserts on
# what actually lands in the portal's login fields.
#
# The portal on the other side of the webview is a local fake that reproduces the real one's
# TIMING (challenge → login form → token). It has to be: clearing the real Cloudflare challenge
# requires a human (010 §8), and automating it is precisely what the Portal NO-GO forbids. For the
# live portal, see `autofill/live-probe.js` — read-only, and the tool for the one open integration
# question.
#
# Usage: desktop/tm30-helper/test/run-autofill.sh
# Exit:  0 = every assertion held, 1 = something regressed.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$(cd "$HERE/.." && pwd)"

ELECTRON="$HELPER/node_modules/.bin/electron"
if [[ ! -x "$ELECTRON" ]]; then
  echo "✗ electron not found at $ELECTRON — run npm install in $HELPER first." >&2
  exit 1
fi

echo "→ running the 4e autofill harness (real app.html, fake portal)"
exec "$ELECTRON" "$HERE/autofill/harness.js" "$@"
