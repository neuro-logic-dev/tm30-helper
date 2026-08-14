/**
 * The v3 (compact) deep-link payload — PARSER side (ADR-0015, MO-TM30-DUE-DATE-001).
 *
 * Why a separate file from `roundtrip.test.mjs`: that one is the emitter↔parser SEAM test and
 * compiles the real emitter out of the web app. The v3 emitter lands in DD-7; until it does,
 * the seam has only one end, and a parser that cannot be tested until its producer exists is
 * how the two halves drifted in the first place (013 §5 row 3). This file tests the end that
 * exists, with zero dependencies. **DD-7 must extend `roundtrip.test.mjs` with the v3 seam —
 * this file does not replace it.**
 *
 * Run: node --test test/deeplink-v3.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { parseDeepLink, DeepLinkKind } = require(path.join(here, '..', 'deeplink.js'));

const link = (payload) =>
    'tm30://open?d=' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

const BASES = {
    api_base: 'https://api.mo.example',
    web_base: 'https://app.mo.example',
    drive_base: 'https://drive.google.com/drive/folders',
};

const V3_ROW = {
    filing_id: 3568,
    booking_id: 3572,
    villa: 'Malee V11',
    checkin: '2026-08-22T07:00:00.000Z',
    checkout: '2026-08-31',
    internal_id: 'C100-04082026-001',
    status: 'sheet_ready',
    dot: 'upcoming',
    sheet: true,
    folder_id: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345',
};

const v3 = (over = {}) => ({
    v: 3,
    ...BASES,
    villas: { 'Malee V11': { login: 'malee_v11', pass: 's3cr3t' } },
    rows: [V3_ROW],
    ...over,
});

test('v3 normalises to the SAME internal row a v2 payload produces', () => {
    const out = parseDeepLink(link(v3()));
    assert.equal(out.kind, DeepLinkKind.V2, 'both shapes resolve to the worklist kind');
    assert.equal(out.payload_version, 3);
    assert.deepEqual(out.worklist[0], {
        filing_id: 3568,
        villa: 'Malee V11',
        checkin: '2026-08-22T07:00:00.000Z',
        status: 'sheet_ready',
        dot: 'upcoming',
        checkout: '2026-08-31',
        internal_id: 'C100-04082026-001',
        sheet_download_url: 'https://api.mo.example/tm30/filings/3568/sheet',
        folder_url:
            'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz012345',
        return_url:
            'https://app.mo.example/reservation/reservations/3572' +
            '?action=manage_booking&tab=tm30&confirm=submitted',
        account: { name: 'Malee V11', login: 'malee_v11', pass: 's3cr3t' },
    });
});

test('a trailing slash on a base never produces a doubled slash', () => {
    const out = parseDeepLink(
        link(v3({ api_base: 'https://api.mo.example/', web_base: 'https://app.mo.example//' })),
    );
    assert.equal(out.worklist[0].sheet_download_url, 'https://api.mo.example/tm30/filings/3568/sheet');
    assert.ok(out.worklist[0].return_url.startsWith('https://app.mo.example/reservation/'));
});

test('sheet:false means NO download url — absence is the meaningful state', () => {
    const out = parseDeepLink(link(v3({ rows: [{ ...V3_ROW, sheet: false }] })));
    assert.equal('sheet_download_url' in out.worklist[0], false);
});

test('a villa absent from `villas` is the NORMAL cred-less row, not an error', () => {
    const out = parseDeepLink(link(v3({ villas: {} })));
    assert.equal(out.kind, DeepLinkKind.V2);
    assert.equal('account' in out.worklist[0], false, 'the key is omitted, never stubbed');
});

test('an empty-but-present login is normalised to absent, as in v2', () => {
    const out = parseDeepLink(link(v3({ villas: { 'Malee V11': { login: '', pass: '' } } })));
    assert.equal('account' in out.worklist[0], false);
});

test('one credential set serves EVERY row of that villa — the reason v3 exists', () => {
    const out = parseDeepLink(
        link(
            v3({
                rows: [V3_ROW, { ...V3_ROW, filing_id: 3569, booking_id: 3573 }],
            }),
        ),
    );
    assert.equal(out.worklist[0].account.login, 'malee_v11');
    assert.equal(out.worklist[1].account.login, 'malee_v11');
    assert.equal(out.worklist[1].return_url.includes('/reservations/3573'), true);
});

test('all three dot values survive; an unknown one is dropped, not rendered', () => {
    for (const dot of ['due', 'overdue', 'upcoming']) {
        const out = parseDeepLink(link(v3({ rows: [{ ...V3_ROW, dot }] })));
        assert.equal(out.worklist[0].dot, dot);
    }
    const junk = parseDeepLink(link(v3({ rows: [{ ...V3_ROW, dot: 'imminent' }] })));
    assert.equal(junk.worklist[0].dot, undefined, 'a word the Helper has no art for is dropped');
});

test('an empty rows array is well-formed — nothing is due, not broken', () => {
    const out = parseDeepLink(link(v3({ rows: [] })));
    assert.equal(out.kind, DeepLinkKind.V2);
    assert.deepEqual(out.worklist, []);
});

test('a missing base fails LOUDLY rather than deriving "undefined/..." urls', () => {
    for (const key of ['api_base', 'web_base', 'drive_base']) {
        const payload = v3();
        delete payload[key];
        const out = parseDeepLink(link(payload));
        assert.equal(out.kind, DeepLinkKind.ERROR, `${key} missing must be an error`);
        assert.match(out.reason, new RegExp(key));
    }
});

test('a row without booking_id is an error — the hand-back url would be unbuildable', () => {
    const row = { ...V3_ROW };
    delete row.booking_id;
    const out = parseDeepLink(link(v3({ rows: [row] })));
    assert.equal(out.kind, DeepLinkKind.ERROR);
    assert.match(out.reason, /booking_id/);
});

test('malformed rows and a missing rows array are errors, never silent fallbacks', () => {
    assert.equal(parseDeepLink(link(v3({ rows: undefined }))).kind, DeepLinkKind.ERROR);
    assert.equal(parseDeepLink(link(v3({ rows: [{ villa: 'X' }] }))).kind, DeepLinkKind.ERROR);
    assert.equal(
        parseDeepLink(link(v3({ rows: [{ ...V3_ROW, villa: '' }] }))).kind,
        DeepLinkKind.ERROR,
    );
});

test('an unknown version is STILL loud — v5 must not be guessed at', () => {
    // 🔴 This case named v4 until ADR-0021 gave v4 a meaning (a pointer: `{api_base, token}`).
    // The RULE it was written to protect is untouched and is what is asserted here: a version
    // this build does not know is an ERROR, never a guess and never a fallback. It has simply
    // moved up a number. That a v3 body wearing `v: 4` is still loud — for the pointer's own
    // reason now, since it carries no token — is the second assertion, and it is the one that
    // says the new branch did not turn a mislabelled worklist into a silent empty queue.
    const unknown = parseDeepLink(link({ ...v3(), v: 5 }));
    assert.equal(unknown.kind, DeepLinkKind.ERROR);
    assert.match(unknown.reason, /unsupported deep-link version "5"/);

    const mislabelled = parseDeepLink(link({ ...v3(), v: 4 }));
    assert.equal(mislabelled.kind, DeepLinkKind.ERROR);
    assert.match(mislabelled.reason, /token/);
});

test('focus_filing_id behaves exactly as it does in v2', () => {
    const withFocus = parseDeepLink(link(v3({ focus_filing_id: 3568 })));
    assert.equal(withFocus.focus_filing_id, 3568);
    const without = parseDeepLink(link(v3()));
    assert.equal('focus_filing_id' in without, false);
    const junk = parseDeepLink(link(v3({ focus_filing_id: 'nope' })));
    assert.equal('focus_filing_id' in junk, false, 'junk focus degrades, never errors');
});

test('truncation is still caught by the integrity check', () => {
    const url = link(v3());
    // Chop the payload; the base64 round-trip check must reject it rather than parse a
    // silently shorter worklist.
    const cut = url.slice(0, url.length - 12);
    const out = parseDeepLink(cut);
    assert.equal(out.kind, DeepLinkKind.ERROR);
});

/**
 * 🔴 THE MEASUREMENT ADR-0015 requires in the report, not an estimate. The v2 figure comes from
 * `roundtrip.test.mjs`, which measures the real emitter: ≈746 URL chars per filing, ceiling at
 * ≈10. This measures the v3 shape the parser above accepts.
 */
test('payload size: v3 fits materially more filings under the 8192 ceiling', () => {
    const CEILING = 8192;
    const villas = {};
    const rows = [];
    for (let i = 0; i < 24; i += 1) {
        const villa = `Villa Number ${Math.floor(i / 3)} Bangtao`;
        villas[villa] = { login: `villa_${Math.floor(i / 3)}_portal`, pass: 's3cr3t-pass-101' };
        rows.push({ ...V3_ROW, filing_id: 4000 + i, booking_id: 5000 + i, villa });
    }

    let fits = 0;
    for (let n = 1; n <= rows.length; n += 1) {
        const url = link({ v: 3, ...BASES, villas, rows: rows.slice(0, n) });
        if (url.length <= CEILING) fits = n;
        // Every size the ceiling admits must still parse — a shape that fits but does not
        // survive the integrity check would be worse than one that refuses.
        if (url.length <= CEILING) {
            assert.equal(parseDeepLink(url).kind, DeepLinkKind.V2);
        }
    }

    const perFiling = Math.round(link({ v: 3, ...BASES, villas, rows }).length / rows.length);
    console.log(`  ≈ ${perFiling} chars per filing (v3) → ceiling reached at ≈ ${fits} filings`);

    // The point of ADR-0015. v2 measures ≈10; anything at or below that means v3 bought nothing.
    assert.ok(fits >= 18, `v3 should fit ≥18 filings, fitted ${fits}`);
});
