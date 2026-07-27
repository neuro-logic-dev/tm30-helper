'use strict';

/**
 * The v2 worklist fixture for the A-WEB-4e autofill harness.
 *
 * Three villas, chosen to cover every branch of `mountAutofill`'s subscription:
 *
 *   Villa Suriyan 2  HAS credentials, TWO filings  → autofills; also proves one solve covers
 *                                                    every row in the group (014 §7.2)
 *   Villa Baan Ork   NO `account` key at all       → the NORMAL day-1 state (014 §7.9). Must NOT
 *                                                    autofill, must NOT error.
 *   Villa Anda       HAS credentials, DIFFERENT    → proves an A→B switch types B's password and
 *                    login+password                  never A's.
 *
 * Every check-in is TODAY so all three land in the "within 24h" main bucket — a postponed row is
 * collapsed out of sight by default and would prove nothing.
 */

const now = new Date();
const today =
  `${now.getUTCFullYear()}-` +
  `${String(now.getUTCMonth() + 1).padStart(2, '0')}-` +
  `${String(now.getUTCDate()).padStart(2, '0')}`;

const SURIYAN = { name: 'Suriyan 2 portal', login: 'suriyan2@tm30', pass: 's3cr3t-pass-101' };
const ANDA = { name: 'Anda portal', login: 'anda@tm30', pass: 'anda-pw-999' };

const worklist = [
  {
    filing_id: 101,
    villa: 'Villa Suriyan 2',
    checkin: today,
    status: 'sheet_ready',
    dot: 'due',
    sheet_download_url: 'https://drive.google.com/uc?export=download&id=FAKE101',
    folder_url: 'https://drive.google.com/drive/folders/FAKE101',
    return_url: 'https://example.invalid/reservation/reservations/101',
    account: SURIYAN,
  },
  {
    filing_id: 102,
    villa: 'Villa Suriyan 2',
    checkin: today,
    status: 'sheet_ready',
    dot: 'overdue',
    sheet_download_url: 'https://drive.google.com/uc?export=download&id=FAKE102',
    folder_url: 'https://drive.google.com/drive/folders/FAKE102',
    return_url: 'https://example.invalid/reservation/reservations/102',
    account: SURIYAN,
  },
  {
    // 🔴 No `account` KEY — not an empty one. `deeplink.js` normalises both to the same absent
    // state on purpose, and an always-present-never-usable `{login:'',pass:''}` is the shape that
    // made the v2 branch dead code (013 §5). The fixture must not reintroduce it.
    filing_id: 103,
    villa: 'Villa Baan Ork',
    checkin: today,
    status: 'sheet_ready',
    dot: 'due',
    sheet_download_url: 'https://drive.google.com/uc?export=download&id=FAKE103',
    folder_url: 'https://drive.google.com/drive/folders/FAKE103',
    return_url: 'https://example.invalid/reservation/reservations/103',
  },
  {
    filing_id: 104,
    villa: 'Villa Anda',
    checkin: today,
    status: 'sheet_ready',
    dot: 'due',
    sheet_download_url: 'https://drive.google.com/uc?export=download&id=FAKE104',
    folder_url: 'https://drive.google.com/drive/folders/FAKE104',
    return_url: 'https://example.invalid/reservation/reservations/104',
    account: ANDA,
  },
];

const encode = (payload) =>
  Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const b64url = encode({ v: 2, worklist });

/**
 * T3-03: the SAME worklist with `focus_filing_id: 104` (Villa Anda — credentialled, so the
 * focused boot must arm autofill exactly like a human click). Scenario 15 boots app.html with
 * this; every other scenario keeps the focus-less payload, which doubles as the regression
 * guard that a payload WITHOUT the field behaves exactly as before.
 */
const FOCUS_FILING_ID = 104;
const b64urlFocus = encode({ v: 2, worklist, focus_filing_id: FOCUS_FILING_ID });

module.exports = {
  worklist,
  b64url,
  b64urlFocus,
  FOCUS_FILING_ID,
  SURIYAN,
  ANDA,
  link: `tm30://open?d=${b64url}`,
};

// `node fixture.js` prints a deep link you can hand to the real Helper by hand.
if (require.main === module) process.stdout.write(`tm30://open?d=${b64url}\n`);
