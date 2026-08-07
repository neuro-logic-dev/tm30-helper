'use strict';

/**
 * Where the web app (`mo-reservation-fe`) lives, resolved rather than assumed.
 *
 * Several tests reach into the web app's source: the seam tests compile the REAL emitter
 * (`src/lib/tm30.ts`, `src/lib/reservation-url.ts`) instead of re-typing it into a fixture, and
 * the hand-back harness reads three components to assert the web side of the return trip. All of
 * them used to locate it by counting directories upward — `HELPER/../..` — which is only correct
 * while the Helper sits inside `mo-reservation-fe/desktop/tm30-helper`.
 *
 * 🔴 This repo is ALSO checked out standalone (`MO/tm30-helper`, beside `MO/mo-reservation-fe`),
 * and there the count lands on a directory that has no `src/` at all. The bash runners at least
 * said "tsc not found" and stopped; `handback/harness.js` threw inside an async callback, which
 * Electron reports as an UnhandledPromiseRejectionWarning and then keeps running — so the harness
 * timed out, having asserted nothing, and **exited 0**. A suite that cannot find the code it
 * tests must fail loudly; that one passed silently.
 *
 * `$MO_WEB_ROOT`, if set, is AUTHORITATIVE: it is validated and then either used or thrown on,
 * never quietly fallen back from. Falling back would reintroduce the failure this file exists to
 * remove — an explicit answer being wrong, and nothing saying so.
 *
 * Unset, the layouts this repo is actually checked out in are tried in order, first hit wins:
 *
 *   1. `<helper>/../..`       — nested:     mo-reservation-fe/desktop/tm30-helper
 *   2. `<helper>/../mo-reservation-fe` — standalone: MO/tm30-helper beside MO/mo-reservation-fe
 *
 * Usage from node:  const { webRoot } = require('./web-root.js')
 * Usage from bash:  WEB_ROOT="$(node "$HERE/web-root.js")"   — prints the path, or exits 1
 */

const path = require('path');
const fs = require('fs');

/** The file every candidate must have; also the first thing the seam tests compile. */
const MARKER = path.join('src', 'lib', 'tm30.ts');

const HELPER = path.resolve(__dirname, '..');

const LAYOUTS = [
  path.resolve(HELPER, '..', '..'),
  path.resolve(HELPER, '..', 'mo-reservation-fe'),
];

const holdsMarker = (dir) => fs.existsSync(path.join(dir, MARKER));

/**
 * @returns {string} the absolute web-app root
 * @throws if nothing usable is found — listing every path tried, because "web root not found"
 *         without them is a bug report nobody can act on.
 */
function resolveWebRoot() {
  if (process.env.MO_WEB_ROOT) {
    const pinned = path.resolve(process.env.MO_WEB_ROOT);
    if (holdsMarker(pinned)) return pinned;
    throw new Error(
      'MO_WEB_ROOT is set to ' + pinned + ', which has no ' + MARKER + '.\n' +
        'Unset it to fall back to the known layouts, or point it at the mo-reservation-fe checkout.'
    );
  }

  for (const dir of LAYOUTS) {
    if (holdsMarker(dir)) return dir;
  }

  throw new Error(
    'could not locate mo-reservation-fe — no known layout contains ' + MARKER + '.\n' +
      'Tried:\n' + LAYOUTS.map((c) => '  ' + c).join('\n') + '\n' +
      'Set MO_WEB_ROOT to the web app checkout if it lives somewhere else.'
  );
}

module.exports = { resolveWebRoot, get webRoot() { return resolveWebRoot(); } };

// `node web-root.js` prints the path — how the bash runners ask.
if (require.main === module) {
  try {
    process.stdout.write(resolveWebRoot() + '\n');
  } catch (err) {
    process.stderr.write('✗ ' + err.message + '\n');
    process.exit(1);
  }
}
