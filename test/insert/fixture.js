'use strict';

/**
 * T3-08 — the worklist fixture for the ⇥ insert harness.
 *
 * The sheet URLs point at the HARNESS's own file server, whose port is only known at runtime —
 * so this module exports a BUILDER, not a payload. Villas are chosen to cover the gate matrix:
 *
 *   Villa Suriyan 2  creds, filing 301 (VALID sheet) + 302 (BROKEN sheet) → the full mock-portal
 *                    e2e: receipt for 301, itemized rejection for 302 (real bytes both ways)
 *   Villa Anda       creds, filing 303                → the NON-ACTIVE villa: its ⇥ stays
 *                    disabled while Suriyan is active
 *   Villa Baan Ork   no account, filing 304, NO sheet → ⇥ disabled for "no sheet yet"; its
 *                    partition also serves the "portal pane not open" IPC guard
 *
 * Credentials are reused from the autofill fixture — the mock portal accepts any non-empty pair.
 */

const { SURIYAN, ANDA } = require('../autofill/fixture.js');

const now = new Date();
const today =
  `${now.getUTCFullYear()}-` +
  `${String(now.getUTCMonth() + 1).padStart(2, '0')}-` +
  `${String(now.getUTCDate()).padStart(2, '0')}`;

const VALID_SHEET_NAME = 'Villa_Suriyan_2_TM30.xlsx';
const BROKEN_SHEET_NAME = 'broken_TM30.xlsx';

function buildWorklist(sheetBase) {
  return [
    {
      filing_id: 301,
      villa: 'Villa Suriyan 2',
      checkin: today,
      status: 'sheet_ready',
      dot: 'due',
      sheet_download_url: sheetBase + '/sheets/valid.xlsx',
      folder_url: 'https://drive.google.com/drive/folders/FAKE301',
      return_url: 'https://example.invalid/reservation/reservations/301',
      account: SURIYAN,
    },
    {
      filing_id: 302,
      villa: 'Villa Suriyan 2',
      checkin: today,
      status: 'sheet_ready',
      dot: 'due',
      sheet_download_url: sheetBase + '/sheets/broken.xlsx',
      folder_url: 'https://drive.google.com/drive/folders/FAKE302',
      return_url: 'https://example.invalid/reservation/reservations/302',
      account: SURIYAN,
    },
    {
      filing_id: 303,
      villa: 'Villa Anda',
      checkin: today,
      status: 'sheet_ready',
      dot: 'due',
      sheet_download_url: sheetBase + '/sheets/valid.xlsx',
      folder_url: 'https://drive.google.com/drive/folders/FAKE303',
      return_url: 'https://example.invalid/reservation/reservations/303',
      account: ANDA,
    },
    {
      // no sheet_download_url at all — the "no sheet yet" disabled state
      filing_id: 304,
      villa: 'Villa Baan Ork',
      checkin: today,
      status: 'sheet_pending',
      dot: 'due',
      folder_url: 'https://drive.google.com/drive/folders/FAKE304',
      return_url: 'https://example.invalid/reservation/reservations/304',
    },
  ];
}

const encode = (payload) =>
  Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const buildPayload = (sheetBase) => encode({ v: 2, worklist: buildWorklist(sheetBase) });

module.exports = { buildWorklist, buildPayload, VALID_SHEET_NAME, BROKEN_SHEET_NAME, SURIYAN, ANDA };
