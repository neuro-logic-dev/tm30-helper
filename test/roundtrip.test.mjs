/**
 * 🔴 THE SEAM TEST (A-WEB-4b).
 *
 * 013 §5 row 3 shipped broken because the web v2 deep-link EMITTER and the Helper's PARSER were
 * built in separate tickets and drifted. "Both sides compile" did not catch it and never would
 * have — each side was green in isolation. So this test feeds the REAL emitter's output straight
 * into the REAL parser:
 *
 *   - producer: `src/lib/tm30.ts`, compiled from source by `run.sh` (NOT re-typed here — a
 *     mirrored fixture is exactly the drift this test exists to prevent)
 *   - consumer: `../deeplink.js`, the same module `main.js` requires
 *
 * Run with `node --test` via `./run.sh`, which compiles the TypeScript first.
 *
 * Covers, per the ticket: (a) v2 with an account, (b) v2 with a cred-less row, (c) v1 legacy,
 * (d) truncated/corrupt → LOUD, never silent. Plus the payload-size measurement (014 §7.4 Q4)
 * and a NEGATIVE CONTROL proving these assertions have teeth.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// The emitter is browser-only by design (`window.btoa`). Node 20 has a global `btoa`, so the
// single browser global it touches is all that needs standing up — the emitter itself is the
// real, unmodified compiled source.
globalThis.window = { btoa: globalThis.btoa };

const emitter = require(path.join(here, '.build', 'tm30.js'));
const { parseDeepLink, DeepLinkKind } = require(path.join(here, '..', 'deeplink.js'));

const {
    buildTm30DeepLink,
    buildTm30DeepLinkV2,
    buildTm30ReturnUrl,
    toTm30HelperWorklist,
    toBase64Url: _unused,
    TM30_DEEP_LINK_MAX_URL_CHARS,
    Tm30DeepLinkTooLargeError,
} = emitter;

const ORIGIN = 'https://app.moestate.com';

/**
 * Wire rows shaped EXACTLY like `villas-be-core` `Tm30WorklistItem`. Deliberately realistic —
 * long villa names, real-length Drive URLs — because these same fixtures produce the byte
 * measurement below, and a toy fixture would under-measure the payload.
 */
const wireRowWithAccount = {
    filing_id: 4821,
    booking_id: 90210,
    villa: 'Villa Sunset Palms — Bang Tao, Phuket',
    checkin: '2026-07-22T00:00:00.000Z',
    status: 'sheet_ready',
    report_status: 'rejected',
    dot: 'overdue',
    account: {
        name: 'Villa Sunset Palms — Bang Tao, Phuket',
        login: 'sunsetpalms.tm30@moestate.com',
        pass: 'Wq7!ktm30-SunsetPalms',
    },
    sheet_download_url: 'https://drive.google.com/uc?export=download&id=1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVw',
    folder_url: 'https://drive.google.com/drive/folders/1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVw',
};

/** The DAILY case (014 §7.9): credentials start empty, so `account` is simply absent. */
const wireRowNoAccount = {
    filing_id: 4822,
    booking_id: 90211,
    villa: 'Baan Ora Chon — Kamala',
    checkin: '2026-07-23T00:00:00.000Z',
    status: 'sheet_ready',
    dot: 'due',
    sheet_download_url: 'https://drive.google.com/uc?export=download&id=2b3C4d5E6f7G8h9I0j1KlMnOpQrStUvWx',
    folder_url: 'https://drive.google.com/drive/folders/2b3C4d5E6f7G8h9I0j1KlMnOpQrStUvWx',
};

/** @returns the parser's verdict for a link the emitter actually produced. */
const roundTrip = (items) =>
    parseDeepLink(buildTm30DeepLinkV2({ worklist: toTm30HelperWorklist(items, ORIGIN) }));

// ───────────────────────────── (a) v2 WITH an account ─────────────────────────────

test('(a) v2 round-trip: a row with credentials survives emitter → parser intact', () => {
    const result = roundTrip([wireRowWithAccount]);

    assert.equal(result.kind, DeepLinkKind.V2, 'must parse as v2, not fall back');
    assert.equal(result.worklist.length, 1);

    const row = result.worklist[0];
    assert.equal(row.filing_id, wireRowWithAccount.filing_id);
    assert.equal(row.status, wireRowWithAccount.status);
    assert.equal(row.report_status, wireRowWithAccount.report_status);
    assert.equal(row.checkin, wireRowWithAccount.checkin);

    // Server-computed; the client must NOT recompute it (014 §7.3 defect 3).
    assert.equal(row.dot, 'overdue');

    // NEVER SPLIT A NAME (009 §10) — villa and account name cross the wire whole, em-dash,
    // comma and all.
    assert.equal(row.villa, 'Villa Sunset Palms — Bang Tao, Phuket');
    assert.equal(row.account.name, 'Villa Sunset Palms — Bang Tao, Phuket');

    assert.equal(row.account.login, wireRowWithAccount.account.login);
    assert.equal(row.account.pass, wireRowWithAccount.account.pass);

    assert.equal(row.sheet_download_url, wireRowWithAccount.sheet_download_url);
    assert.equal(row.folder_url, wireRowWithAccount.folder_url);

    // return_url is derived by the EMITTER from booking_id — the backend deliberately does not
    // send it (014 §7.3 defect 2). It must arrive with `tab` and `confirm` intact.
    assert.equal(row.return_url, buildTm30ReturnUrl(wireRowWithAccount.booking_id, ORIGIN));
    assert.match(row.return_url, /\?action=manage_booking&tab=tm30&confirm=submitted$/);
    assert.ok(row.return_url.includes('/reservation/reservations/90210'));
});

// ─────────────────────── (b) v2 with a CRED-LESS row — the daily case ───────────────────────

test('(b) v2 round-trip: a cred-less row is KEPT, and `account` is omitted, never stubbed', () => {
    const result = roundTrip([wireRowNoAccount]);

    // The whole point: a cred-less row is NOT a broken link. It must open.
    assert.equal(result.kind, DeepLinkKind.V2, 'a cred-less row must still parse as v2');
    assert.equal(result.worklist.length, 1, 'the row must NOT be dropped');

    const row = result.worklist[0];
    assert.equal(row.filing_id, 4822);
    assert.equal(row.villa, 'Baan Ora Chon — Kamala');
    assert.equal(row.dot, 'due');

    // 🔴 Absent, not empty. `{login:'',pass:''}` — always present, never usable — is the shape
    // that made the v2 branch dead code (013 §5). Assert the KEY is gone, not merely falsy.
    assert.ok(!('account' in row), '`account` key must be absent, not an empty object');
});

test('(b2) the emitted JSON itself never contains an empty-but-present account', () => {
    const url = buildTm30DeepLinkV2({
        worklist: toTm30HelperWorklist([wireRowNoAccount], ORIGIN),
    });
    const json = Buffer.from(
        url.split('d=')[1].replace(/-/g, '+').replace(/_/g, '/'),
        'base64'
    ).toString('utf8');

    assert.ok(!json.includes('"account"'), 'the cred-less row must not carry an `account` key');
    assert.ok(!json.includes('"login":""'), 'must never emit a blank login');
});

test('(b3) mixed payload: cred-ful and cred-less rows coexist, order preserved', () => {
    const result = roundTrip([wireRowWithAccount, wireRowNoAccount]);

    assert.equal(result.kind, DeepLinkKind.V2);
    assert.equal(result.worklist.length, 2, 'neither row may be dropped');
    // Server order is preserved — the emitter does not sort, and grouping is 4c's job (014 §7.2).
    assert.deepEqual(
        result.worklist.map((r) => r.filing_id),
        [4821, 4822]
    );
    assert.ok(result.worklist[0].account, 'row 0 keeps its credentials');
    assert.ok(!('account' in result.worklist[1]), 'row 1 stays cred-less');
});

// ───────────────────────────── (c) v1 legacy — must NOT change ─────────────────────────────

test('(c) v1 legacy round-trip still works, untouched (013 §5 row 4)', () => {
    const account = { name: 'Villa Ananda', login: 'ananda@moestate.com', pass: 's3cret' };
    const result = parseDeepLink(buildTm30DeepLink(account));

    assert.equal(result.kind, DeepLinkKind.V1);
    assert.deepEqual(result.account, account);
});

test('(c2) `tm30://open` with no payload still opens the chooser — a legitimate request', () => {
    const result = parseDeepLink(buildTm30DeepLink());
    assert.equal(result.kind, DeepLinkKind.CHOOSER);
});

// ──────────────── (d) truncated / corrupt → LOUD, never a silent chooser ────────────────

test('(d) a truncated v2 link fails LOUDLY at every truncation point', () => {
    const url = buildTm30DeepLinkV2({
        worklist: toTm30HelperWorklist([wireRowWithAccount, wireRowNoAccount], ORIGIN),
    });

    let checked = 0;
    // Walk the payload and chop it at many points — argv truncation can land anywhere.
    for (let cut = 40; cut < url.length; cut += 17) {
        const result = parseDeepLink(url.slice(0, cut));

        assert.equal(
            result.kind,
            DeepLinkKind.ERROR,
            `truncation at ${cut} must be an ERROR, got "${result.kind}"`
        );
        // The specific regression being locked out: silent degradation to the chooser.
        assert.notEqual(result.kind, DeepLinkKind.CHOOSER, 'must never degrade to the chooser');
        assert.ok(result.reason && result.reason.length > 0, 'an error must carry a reason');
        checked += 1;
    }

    assert.ok(checked > 20, `expected many truncation points, only tested ${checked}`);
});

test('(d2) a single corrupted character is caught by the integrity check', () => {
    const url = buildTm30DeepLinkV2({
        worklist: toTm30HelperWorklist([wireRowWithAccount], ORIGIN),
    });
    const mid = Math.floor(url.length / 2);
    // Swap one base64 character — the kind of damage that can slip past JSON.parse.
    const corrupted = url.slice(0, mid) + (url[mid] === 'A' ? 'B' : 'A') + url.slice(mid + 1);

    const result = parseDeepLink(corrupted);
    assert.equal(result.kind, DeepLinkKind.ERROR);
});

test('(d3) malformed rows and unknown versions are errors, not silent fallbacks', () => {
    const encode = (obj) =>
        'tm30://open?d=' +
        Buffer.from(JSON.stringify(obj), 'utf8')
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

    // A future version the Helper does not understand — must not be treated as v1.
    assert.equal(parseDeepLink(encode({ v: 3, worklist: [] })).kind, DeepLinkKind.ERROR);
    // v2 with no worklist array at all.
    assert.equal(parseDeepLink(encode({ v: 2 })).kind, DeepLinkKind.ERROR);
    // A row missing its filing_id — corruption, not a cred-less row.
    assert.equal(
        parseDeepLink(encode({ v: 2, worklist: [{ villa: 'X' }] })).kind,
        DeepLinkKind.ERROR
    );
    // Neither v1 nor v2.
    assert.equal(parseDeepLink(encode({ hello: 'world' })).kind, DeepLinkKind.ERROR);

    // ...but an EMPTY worklist is well-formed: nothing is due. Not an error.
    assert.equal(parseDeepLink(encode({ v: 2, worklist: [] })).kind, DeepLinkKind.V2);
});

// ───────────────────── NEGATIVE CONTROL — do these assertions have teeth? ─────────────────────

test('NEGATIVE CONTROL: the OLD parser silently swallows the very payload the new one accepts', () => {
    /** Verbatim `main.js:26-43` as it stood before this ticket. */
    const legacyParseDeepLink = (url) => {
        try {
            if (!url || !url.startsWith('tm30://')) return null;
            const d = new URL(url).searchParams.get('d');
            if (!d) return null;
            const b64 = d.replace(/-/g, '+').replace(/_/g, '/');
            const acc = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
            if (!acc || !acc.login) return null;
            return { name: String(acc.name || acc.login), login: String(acc.login) };
        } catch {
            return null;
        }
    };

    const url = buildTm30DeepLinkV2({
        worklist: toTm30HelperWorklist([wireRowWithAccount], ORIGIN),
    });

    // The bug, reproduced: a perfectly good v2 link → null → silent v1-chooser fallback.
    assert.equal(legacyParseDeepLink(url), null, 'the old parser did drop v2 links');
    // ...and the same link through the new parser is fine. If the fix regressed, this fails.
    assert.equal(parseDeepLink(url).kind, DeepLinkKind.V2);

    // Teeth check on the loud path too: the old parser was equally silent on a truncated link,
    // returning the SAME null it returns for a healthy chooser link — indistinguishable.
    assert.equal(legacyParseDeepLink(url.slice(0, 120)), null);
    assert.equal(legacyParseDeepLink('tm30://open'), null);
    // The new parser tells those two apart. That difference is the whole ticket.
    assert.equal(parseDeepLink(url.slice(0, 120)).kind, DeepLinkKind.ERROR);
    assert.equal(parseDeepLink('tm30://open').kind, DeepLinkKind.CHOOSER);
});

// ───────────────────── PAYLOAD SIZE — 014 §7.4 Q4, measured not guessed ─────────────────────

test('payload size: a realistic multi-villa worklist is measured against the 8192 ceiling', () => {
    const villas = [
        'Villa Sunset Palms — Bang Tao, Phuket',
        'Baan Ora Chon — Kamala',
        'Villa Amanzi — Kamala Beach',
        'The Sanctuary Villa — Layan',
        'Villa Bellissima — Surin Heights',
        'Baan Wanora — Laguna',
        'Villa Cielo — Cape Yamu',
        'Villa Rak Tawan — Kata Noi',
    ];

    const mkRow = (i) => ({
        filing_id: 4800 + i,
        booking_id: 90200 + i,
        villa: villas[i % villas.length],
        checkin: '2026-07-22T00:00:00.000Z',
        status: 'sheet_ready',
        dot: i % 2 ? 'due' : 'overdue',
        account: {
            name: villas[i % villas.length],
            login: `villa${i}.tm30@moestate.com`,
            pass: `Wq7!ktm30-Villa${i}`,
        },
        sheet_download_url: `https://drive.google.com/uc?export=download&id=1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTu${i}`,
        folder_url: `https://drive.google.com/drive/folders/1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTu${i}`,
    });

    const measure = (n) => {
        const url = buildTm30DeepLinkV2({
            worklist: toTm30HelperWorklist(
                Array.from({ length: n }, (_, i) => mkRow(i)),
                ORIGIN
            ),
        });
        return url.length;
    };

    console.log('\n  ── MEASURED tm30:// URL length (all rows WITH credentials) ──');
    console.log(`  ceiling: ${TM30_DEEP_LINK_MAX_URL_CHARS} chars`);
    let perVilla = 0;
    for (const n of [1, 2, 4, 8, 11, 16]) {
        let len;
        try {
            len = measure(n);
        } catch (err) {
            console.log(`  ${String(n).padStart(2)} filings: REFUSED — ${err.name}`);
            continue;
        }
        if (n === 8) perVilla = Math.round(len / n);
        console.log(
            `  ${String(n).padStart(2)} filings: ${String(len).padStart(5)} chars` +
                `  (${Math.round(len / n)}/filing)  ${len > TM30_DEEP_LINK_MAX_URL_CHARS ? '❌ over' : '✅ under'}`
        );
    }
    console.log(`  ≈ ${perVilla} chars per filing → ceiling reached at ` +
        `≈ ${Math.floor(TM30_DEEP_LINK_MAX_URL_CHARS / perVilla)} filings\n`);

    // A realistic 8-filing multi-villa run must fit comfortably.
    assert.ok(measure(8) < TM30_DEEP_LINK_MAX_URL_CHARS, '8 filings must fit under the ceiling');

    // And whatever fits, round-trips.
    const parsed = parseDeepLink(
        buildTm30DeepLinkV2({
            worklist: toTm30HelperWorklist(
                Array.from({ length: 8 }, (_, i) => mkRow(i)),
                ORIGIN
            ),
        })
    );
    assert.equal(parsed.kind, DeepLinkKind.V2);
    assert.equal(parsed.worklist.length, 8);
});

test('overflow REFUSES rather than truncating (the silent failure mode 014 §7.9 names)', () => {
    const huge = Array.from({ length: 400 }, (_, i) => ({
        filing_id: i,
        booking_id: i,
        villa: `Villa Number ${i} — Somewhere Long Enough To Matter`,
        checkin: '2026-07-22T00:00:00.000Z',
        status: 'sheet_ready',
        dot: 'due',
        account: { name: `Villa ${i}`, login: `v${i}@moestate.com`, pass: 'passwordish' },
        sheet_download_url: `https://drive.google.com/uc?export=download&id=${'x'.repeat(33)}${i}`,
        folder_url: `https://drive.google.com/drive/folders/${'x'.repeat(33)}${i}`,
    }));

    assert.throws(
        () => buildTm30DeepLinkV2({ worklist: toTm30HelperWorklist(huge, ORIGIN) }),
        Tm30DeepLinkTooLargeError,
        'an over-ceiling worklist must throw, not emit a link the OS will chop'
    );
});
