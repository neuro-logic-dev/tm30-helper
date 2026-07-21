'use strict';

/**
 * The v2 worklist fixture for the A-WEB-4f hand-back harness.
 *
 * 🔴 `return_url` IS NOT TYPED HERE. Row 201's comes out of the REAL compiled emitter
 * (`src/lib/tm30.ts` → `buildTm30ReturnUrl`), for the same reason `roundtrip.test.mjs` compiles
 * it rather than mirroring it: a hand-typed copy of the URL under test is exactly the drift this
 * harness exists to catch (013 §5).
 *
 * Three rows, one per branch of `markSubmitted`:
 *
 *   201  real emitter `return_url`   → the happy hand-back, and the reopen after it
 *   202  NO `return_url` key at all  → an older/partial link. Must refuse loudly, never open.
 *   203  a NON-http(s) `return_url`  → `deeplink.js` copies any string through, so the renderer
 *                                      applies `main.js`'s own http(s) rule before firing IPC.
 */

const path = require('path');

const BUILD = path.join(__dirname, '..', '.build', 'tm30.js');
let emitter;
try {
  emitter = require(BUILD);
} catch (err) {
  throw new Error(
    'the compiled emitter is missing at test/.build/tm30.js — run test/run-handback.sh ' +
      '(it compiles src/lib/tm30.ts first). Original error: ' + err.message
  );
}

const ORIGIN = 'https://app.moestate.com';
const BOOKING_ID = 90210;

/** The exact string the web app would put on this row. Nothing here re-types it. */
const RETURN_URL = emitter.buildTm30ReturnUrl(BOOKING_ID, ORIGIN);

const now = new Date();
const today =
  `${now.getUTCFullYear()}-` +
  `${String(now.getUTCMonth() + 1).padStart(2, '0')}-` +
  `${String(now.getUTCDate()).padStart(2, '0')}`;

const ACCT = { name: 'Suriyan 2 portal', login: 'suriyan2@tm30', pass: 's3cr3t-pass-101' };

const worklist = [
  {
    filing_id: 201,
    villa: 'Villa Suriyan 2',
    checkin: today,
    status: 'sheet_ready',
    dot: 'due',
    sheet_download_url: 'https://drive.google.com/uc?export=download&id=FAKE201',
    folder_url: 'https://drive.google.com/drive/folders/FAKE201',
    return_url: RETURN_URL,
    account: ACCT,
  },
  {
    // No `return_url` KEY — `deeplink.js` drops it when it is not a string, so this is what an
    // older link actually looks like on arrival.
    filing_id: 202,
    villa: 'Villa Suriyan 2',
    checkin: today,
    status: 'sheet_ready',
    dot: 'due',
    sheet_download_url: 'https://drive.google.com/uc?export=download&id=FAKE202',
    folder_url: 'https://drive.google.com/drive/folders/FAKE202',
    account: ACCT,
  },
  {
    filing_id: 203,
    villa: 'Villa Baan Ork',
    checkin: today,
    status: 'sheet_ready',
    dot: 'due',
    sheet_download_url: 'https://drive.google.com/uc?export=download&id=FAKE203',
    folder_url: 'https://drive.google.com/drive/folders/FAKE203',
    return_url: 'javascript:alert(1)', // a string, and still not somewhere a browser may be sent
  },
];

const b64url = Buffer.from(JSON.stringify({ v: 2, worklist }), 'utf8')
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

module.exports = { worklist, b64url, RETURN_URL, ORIGIN, BOOKING_ID, ACCT,
  link: `tm30://open?d=${b64url}` };

// `node fixture.js` prints the deep link — run-handback.sh feeds it to the real main.js in argv.
if (require.main === module) process.stdout.write(`tm30://open?d=${b64url}\n`);
