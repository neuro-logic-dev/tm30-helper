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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// The emitter is browser-only by design (`window.btoa`). Node 20 has a global `btoa`, so the
// single browser global it touches is all that needs standing up — the emitter itself is the
// real, unmodified compiled source.
globalThis.window = { btoa: globalThis.btoa };

const emitter = require(path.join(here, '.build', 'tm30.js'));
const { parseDeepLink, DeepLinkKind, payloadDigest, compareVersions } = require(path.join(here, '..', 'deeplink.js'));

const {
    buildTm30DeepLink,
    buildTm30DeepLinkV2,
    buildTm30HelperLink,
    toTm30HelperWorklistV3,
    tm30PayloadDigest,
    TM30_MIN_HELPER_VERSION,
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
    // BUG-2: the row's download URL is OUR streaming endpoint, not the stored Drive webViewLink
    // (a Sheets /edit page behind Google auth, which the Helper cannot fetch). This fixture said
    // Drive for as long as the code has said otherwise — corrected 2026-08-10, and it is what
    // `resolveApiBase` reads to build the v3 `api_base`.
    sheet_download_url: 'https://api.moestate.com/tm30/filings/4821/sheet',
    folder_url: 'https://drive.google.com/drive/folders/1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVw',
    // Display-only, and both were silently dropped by `normalizeRow` for as long as they had
    // been on the wire — the emitter forwarded them, the parser's allowlist did not copy them,
    // and the pane just showed less. This seam is where that had to be caught.
    checkout: '2026-07-26',
    internal_id: 'C100-22072026-001',
};

/** The DAILY case (014 §7.9): credentials start empty, so `account` is simply absent. */
const wireRowNoAccount = {
    filing_id: 4822,
    booking_id: 90211,
    villa: 'Baan Ora Chon — Kamala',
    checkin: '2026-07-23T00:00:00.000Z',
    status: 'sheet_ready',
    dot: 'due',
    sheet_download_url: 'https://api.moestate.com/tm30/filings/4822/sheet',
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

    // The stay's end and the human booking reference — display-only, but the pane prints both,
    // so a drop here is invisible rather than loud.
    assert.equal(row.checkout, wireRowWithAccount.checkout);
    assert.equal(row.internal_id, wireRowWithAccount.internal_id);

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

    // Same omission style for the display-only pair: this fixture carries neither, so neither
    // key may be invented. A backend older than these fields is not an error.
    assert.ok(!('checkout' in row), '`checkout` must be absent, not an empty string');
    assert.ok(!('internal_id' in row), '`internal_id` must be absent, not an empty string');
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

// ───────────────── focus_filing_id (T3-03) — optional, backward compatible both ways ─────────────────

test('focus: focus_filing_id survives emitter → parser next to an intact worklist', () => {
    const url = buildTm30DeepLinkV2({
        worklist: toTm30HelperWorklist([wireRowWithAccount, wireRowNoAccount], ORIGIN),
        focus_filing_id: 4822,
    });
    const result = parseDeepLink(url);

    assert.equal(result.kind, DeepLinkKind.V2);
    assert.equal(result.focus_filing_id, 4822);
    // The focus rides ALONGSIDE the worklist; it must not perturb the rows themselves.
    assert.deepEqual(result.worklist.map((r) => r.filing_id), [4821, 4822]);
});

test('focus: an UNFOCUSED link carries no focus_filing_id key — emitted JSON and parse result', () => {
    const url = buildTm30DeepLinkV2({
        worklist: toTm30HelperWorklist([wireRowWithAccount], ORIGIN),
    });
    const json = Buffer.from(
        url.split('d=')[1].replace(/-/g, '+').replace(/_/g, '/'),
        'base64'
    ).toString('utf8');

    // The key must be ABSENT from the wire (not `null`-stubbed) so a focus-less link stays
    // byte-identical to what pre-T3-03 emitters produced — old Helpers see nothing new.
    assert.ok(!json.includes('focus_filing_id'), 'unfocused link must not carry the key');
    const result = parseDeepLink(url);
    assert.equal(result.kind, DeepLinkKind.V2);
    assert.ok(!('focus_filing_id' in result), 'parse result must not fabricate a focus');
});

test('focus: a junk focus value degrades to "no focus", never to an error', () => {
    const encode = (obj) =>
        'tm30://open?d=' +
        Buffer.from(JSON.stringify(obj), 'utf8')
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

    // The worklist is fully usable; the focus is an enhancement. A stale/garbled focus must
    // not take the whole payload down with it (contrast the row checks, which stay LOUD).
    for (const junk of ['4821', null, {}, NaN]) {
        const result = parseDeepLink(encode({ v: 2, worklist: [], focus_filing_id: junk }));
        assert.equal(result.kind, DeepLinkKind.V2, `junk focus ${String(junk)} must stay v2`);
        assert.ok(!('focus_filing_id' in result), 'junk focus must be dropped, not forwarded');
    }
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

// ═══════════════════ (e) v3 — THE NEGOTIATED SEAM (ADR-0015) ═══════════════════════════
//
// The half that did not exist when DD-6 shipped the parser. `deeplink-v3.test.mjs` tests the
// parser against its own fixtures; THIS tests it against the real emitter's real output, which
// is the only arrangement that catches the drift 013 §5 row 3 shipped with.

/** Enough distinct villas and filings to push a v2 link over the 8192 ceiling. */
const bigWorklist = (n) =>
    Array.from({ length: n }, (_, i) => ({
        ...wireRowWithAccount,
        filing_id: 4900 + i,
        booking_id: 91000 + i,
        villa: `Villa Number ${Math.floor(i / 3)} — Bang Tao, Phuket`,
        sheet_download_url: `https://api.moestate.com/tm30/filings/${4900 + i}/sheet`,
        account: {
            ...wireRowWithAccount.account,
            name: `Villa Number ${Math.floor(i / 3)} — Bang Tao, Phuket`,
            login: `villa${Math.floor(i / 3)}.tm30@moestate.com`,
        },
    }));

test('(e1) a SMALL worklist still emits v2 — an un-updated Helper is never worse off', () => {
    const url = buildTm30HelperLink([wireRowWithAccount, wireRowNoAccount], ORIGIN);
    const result = parseDeepLink(url);
    assert.equal(result.kind, DeepLinkKind.V2);
    assert.equal(result.payload_version, 2, 'v2 is used while it fits — no ordering constraint');
});

test('(e2) a worklist too big for v2 drops to v3 and still parses', () => {
    const items = bigWorklist(16);
    // The v2 builder THROWS above the ceiling, so its own error carries the length. Calling it
    // for the measurement is the point: the fixture has to genuinely overflow v2, or (e2) would
    // be asserting a fallback that never fired.
    let v2Length = 0;
    try {
        buildTm30DeepLinkV2({ worklist: toTm30HelperWorklist(items, ORIGIN) });
    } catch (err) {
        v2Length = err.urlLength;
    }
    assert.ok(v2Length > TM30_DEEP_LINK_MAX_URL_CHARS, 'fixture must actually overflow v2');

    const result = parseDeepLink(buildTm30HelperLink(items, ORIGIN));
    assert.equal(result.kind, DeepLinkKind.V2);
    assert.equal(result.payload_version, 3);
    assert.equal(result.worklist.length, 16, 'every filing survives — nothing is dropped');
});

test('🔴 (e3) v3 carries the SAME information as v2 — row for row, key for key', () => {
    // The claim ADR-0015 rests on: compaction removes redundancy, never content. Both shapes are
    // parsed and compared, so an omission on either side fails here rather than in the pane.
    const items = [wireRowWithAccount, wireRowNoAccount];

    const viaV2 = parseDeepLink(
        buildTm30DeepLinkV2({ worklist: toTm30HelperWorklist(items, ORIGIN) }),
    );
    const v3Body = toTm30HelperWorklistV3(items, ORIGIN);
    assert.ok(v3Body, 'v3 must be representable for this worklist');
    const viaV3 = parseDeepLink(
        'tm30://open?d=' +
            Buffer.from(JSON.stringify({ v: 3, ...v3Body }), 'utf8').toString('base64url'),
    );

    assert.equal(viaV3.kind, DeepLinkKind.V2);
    assert.deepEqual(viaV3.worklist, viaV2.worklist);
});

test('(e4) the cred-less row survives compaction as an ABSENT account, never a stub', () => {
    const items = bigWorklist(15).concat([wireRowNoAccount]);
    const result = parseDeepLink(buildTm30HelperLink(items, ORIGIN));
    assert.equal(result.payload_version, 3);
    const credless = result.worklist.find((r) => r.filing_id === wireRowNoAccount.filing_id);
    assert.equal('account' in credless, false);
});

test('(e5) focus survives the drop to v3', () => {
    const items = bigWorklist(16);
    const result = parseDeepLink(buildTm30HelperLink(items, ORIGIN, items[3].filing_id));
    assert.equal(result.payload_version, 3);
    assert.equal(result.focus_filing_id, items[3].filing_id);
});

test('🔴 (e6) over the ceiling even in v3, the emitter still REFUSES — never truncates', () => {
    const items = bigWorklist(60);
    assert.throws(
        () => buildTm30HelperLink(items, ORIGIN),
        Tm30DeepLinkTooLargeError,
        'a silently shortened worklist is the one outcome worse than failing',
    );
});

test('(e7) v3 is skipped, not guessed, when it cannot honestly represent the worklist', () => {
    // No row carries a sheet URL ⇒ `api_base` is unknowable. The emitter stays on v2 rather than
    // inventing an origin, and refuses if v2 does not fit.
    const noSheets = bigWorklist(16).map(({ sheet_download_url: _drop, ...rest }) => rest);
    assert.equal(toTm30HelperWorklistV3(noSheets, ORIGIN), null);
    assert.throws(() => buildTm30HelperLink(noSheets, ORIGIN), Tm30DeepLinkTooLargeError);
});

test('(e8) payload size: v3 measured through the REAL emitter', () => {
    let fits = 0;
    for (let n = 1; n <= 40; n += 1) {
        const items = bigWorklist(n);
        const body = toTm30HelperWorklistV3(items, ORIGIN);
        if (!body) break;
        const url =
            'tm30://open?d=' +
            Buffer.from(JSON.stringify({ v: 3, ...body }), 'utf8').toString('base64url');
        if (url.length <= TM30_DEEP_LINK_MAX_URL_CHARS) fits = n;
    }
    const body = toTm30HelperWorklistV3(bigWorklist(40), ORIGIN);
    const per = Math.round(
        ('tm30://open?d=' +
            Buffer.from(JSON.stringify({ v: 3, ...body }), 'utf8').toString('base64url')).length / 40,
    );
    console.log(`  ≈ ${per} chars per filing (v3, real emitter) → ceiling at ≈ ${fits} filings`);
    /*
      MEASURED, and BELOW the ≥20 the plan's AC-18 assumed — that target came from a lighter
      estimate than this fixture, whose villa names are long and whose every row carries a
      folder id, a checkout and an internal_id. Real figures: v2 ≈10 filings, v3 ≈16 (+60%).
      Two further compactions were measured and deliberately NOT built (villa-by-index → 19,
      plus a day-only `checkin` → 20); see the DD-7 report. The floor below guards erosion of
      what was actually achieved; it is deliberately not the aspirational number.
    */
    assert.ok(fits >= 15, `v3 should fit ≥15 filings, fitted ${fits}`);
});

// ═══════════════ (f) THE `c=` SUBSTITUTION GUARD — both halves, at last ════════════════
//
// 🔴 The emitter has appended `&c=<FNV-1a>` to every worklist link since the digest existed, and
// the parser never read it. Producer-only guard, invisible to this file because every assertion
// above tests round-trip SUCCESS rather than verification. Closed 2026-08-10.

test('(f1) the two FNV implementations agree — byte for byte, on the real emitter', () => {
    // They live in different repos and different languages-of-record. This is the only thing
    // standing between them and a silent divergence.
    for (const sample of ['', 'a', 'abc', 'tm30', 'A'.repeat(1000), '🛂 unicode ✓']) {
        assert.equal(payloadDigest(sample), tm30PayloadDigest(sample), `digest differs for ${sample.slice(0, 20)}`);
    }
});

test('(f2) an intact link verifies and parses, v2 and v3 alike', () => {
    assert.equal(parseDeepLink(buildTm30HelperLink([wireRowWithAccount], ORIGIN)).kind, DeepLinkKind.V2);
    assert.equal(parseDeepLink(buildTm30HelperLink(bigWorklist(16), ORIGIN)).payload_version, 3);
});

test('🔴 (f3) SUBSTITUTION is now caught — the failure mode the digest was built for', () => {
    const url = buildTm30HelperLink([wireRowWithAccount, wireRowNoAccount], ORIGIN);
    const dStart = url.indexOf('d=') + 2;
    const dEnd = url.indexOf('&c=');

    let accepted = 0;
    let altered = 0;
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

    for (let i = dStart; i < dEnd; i += 7) {
        const original = url[i];
        const swap = ALPHABET[(ALPHABET.indexOf(original) + 17) % ALPHABET.length];
        if (swap === original) continue;
        const mutated = url.slice(0, i) + swap + url.slice(i + 1);
        const result = parseDeepLink(mutated);
        if (result.kind !== DeepLinkKind.ERROR) {
            accepted += 1;
            const rows = result.worklist ?? [];
            if (rows.some((r) => r.villa !== wireRowWithAccount.villa && r.villa !== wireRowNoAccount.villa)) {
                altered += 1;
            }
        }
    }

    assert.equal(accepted, 0, `${accepted} mutated links were accepted (${altered} with altered values)`);
});

test('(f4) a link with NO checksum is still accepted — v1 and the chooser carry none', () => {
    assert.equal(parseDeepLink('tm30://open').kind, DeepLinkKind.CHOOSER);
    const v1 = buildTm30DeepLink({ name: 'Villa A', login: 'a@b.c', pass: 'p' });
    assert.equal(v1.includes('&c='), false, 'the v1 emitter has never sent one');
    assert.equal(parseDeepLink(v1).kind, DeepLinkKind.V1);
});

test('(f5) a checksum that is PRESENT but wrong is loud, and says what to do', () => {
    const url = buildTm30HelperLink([wireRowWithAccount], ORIGIN);
    const broken = url.replace(/&c=[0-9a-f]{8}$/, '&c=00000000');
    const result = parseDeepLink(broken);
    assert.equal(result.kind, DeepLinkKind.ERROR);
    assert.match(result.reason, /checksum/);
    assert.match(result.reason, /Reopen the Helper/);
});

test('(f6) the digest is checked BEFORE the payload is decoded', () => {
    // A payload that is both mangled AND undecodable must report the checksum, not the decode:
    // the checksum is the actionable message ("get a fresh link"), and it is the earlier gate.
    const url = buildTm30HelperLink([wireRowWithAccount], ORIGIN);
    const dStart = url.indexOf('d=') + 2;
    const mutated = url.slice(0, dStart) + '!!!' + url.slice(dStart + 3);
    const result = parseDeepLink(mutated);
    assert.equal(result.kind, DeepLinkKind.ERROR);
    assert.match(result.reason, /checksum/);
});

// ═══════ (g) THE VERSION FLOOR — Layer 2 of MO-TM30-HELPER-VERSIONING ═══════════════════
//
// The spec was retired on 2026-08-03 because "the Helper updates itself". It does — on Windows.
// `build.mac.identity` is null, the mac target is dmg-only (electron-updater needs a zip) and no
// `latest-mac.yml` is published, so on macOS nothing updates itself and nothing noticed. Layer 2
// is the half that needs no network and no signing.

test('(g1) the emitter puts the floor on BOTH payload shapes', () => {
    const small = parseDeepLink(buildTm30HelperLink([wireRowWithAccount], ORIGIN));
    assert.equal(small.payload_version, 2);
    assert.equal(small.min_helper_version, TM30_MIN_HELPER_VERSION);

    const big = parseDeepLink(buildTm30HelperLink(bigWorklist(16), ORIGIN));
    assert.equal(big.payload_version, 3);
    assert.equal(big.min_helper_version, TM30_MIN_HELPER_VERSION);
});

test('(g2) the floor the emitter sends is one this Helper actually satisfies', () => {
    // Catches the release-order mistake directly: bump the emitter's floor above the Helper you
    // are shipping and every link this build receives would be refused by it.
    const shipping = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
    assert.notEqual(
        compareVersions(shipping, TM30_MIN_HELPER_VERSION),
        -1,
        `this Helper is ${shipping} but the web emitter demands >= ${TM30_MIN_HELPER_VERSION}`,
    );
});

test('(g3) a junk or absent floor leaves the key off — never refuses the link', () => {
    const enc = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
    for (const bad of ['2.3', 'latest', '', 'v2.3.0', 2.3, null, {}]) {
        const r = parseDeepLink(
            'tm30://open?d=' + enc({ v: 2, worklist: [], min_helper_version: bad }),
        );
        assert.equal(r.kind, DeepLinkKind.V2, `a floor of ${JSON.stringify(bad)} must not break the link`);
        assert.equal('min_helper_version' in r, false);
    }
    const none = parseDeepLink('tm30://open?d=' + enc({ v: 2, worklist: [] }));
    assert.equal('min_helper_version' in none, false);
});

test('(g4) compareVersions: ordering, equality, and `null` for anything unparseable', () => {
    assert.equal(compareVersions('2.2.0', '2.3.0'), -1);
    assert.equal(compareVersions('2.3.0', '2.3.0'), 0);
    assert.equal(compareVersions('2.3.1', '2.3.0'), 1);
    assert.equal(compareVersions('2.10.0', '2.9.0'), 1, 'numeric, not lexicographic');
    assert.equal(compareVersions('10.0.0', '9.9.9'), 1);
    // 🔴 `null` is the honest answer, and every caller treats it as "no opinion" and lets the
    // work through — a malformed floor must never lock an operator out of their own queue.
    for (const junk of ['2.3', 'v2.3.0', '2.3.0-beta', '', null, undefined, 'x.y.z']) {
        assert.equal(compareVersions(junk, '2.3.0'), null);
        assert.equal(compareVersions('2.3.0', junk), null);
    }
});
