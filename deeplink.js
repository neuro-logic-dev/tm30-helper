'use strict';

/**
 * `tm30://` deep-link parser — the CONSUMER half of the A-WEB-4b wire.
 *
 * Extracted out of `main.js` on purpose: `main.js` requires `electron` at module load, so
 * nothing there can be exercised by a plain-node test. The producer half lives in the web app
 * (`src/lib/tm30.ts`); `test/roundtrip.test.mjs` feeds THAT emitter's real output straight into
 * THIS parser. 013 §5 row 3 shipped broken precisely because producer and consumer were built
 * in separate tickets and drifted, so the two halves are joined by a test, not by hope.
 *
 * ── The three outcomes this parser must keep DISTINCT (014 §7.9) ──
 * The old `parseDeepLink` collapsed all of them into `return null`, which `handleDeepLink` read
 * as "open the account chooser". That single silent branch is the bug:
 *
 *   1. `chooser`  — `tm30://open` with no payload. A LEGITIMATE request for the chooser.
 *   2. `v1`/`v2`  — a usable payload. **A v2 row with NO `account` is usable**: credentials
 *                   start empty (2026-07-20), so a cred-less villa is the NORMAL launch state,
 *                   not an error. The row must survive parsing; rendering "log in by hand" is
 *                   A-WEB-4c's job.
 *   3. `error`    — malformed / truncated / undecodable / unknown version. This MUST be loud
 *                   (`main.js` shows a native error box) and must NEVER degrade to the chooser,
 *                   which is what made a broken link look like a working one.
 *
 * "No credentials" and "broken link" are different states and must look different.
 *
 * Zero dependencies (no electron, no npm) so the test can require it directly.
 */

const PROTOCOL = 'tm30';

/** Discriminant of every {@link parseDeepLink} result. */
const DeepLinkKind = {
    /** Legacy `{ name, login, pass }` — behaviour UNCHANGED (013 §5 row 4 must keep working). */
    V1: 'v1',
    /**
     * A WORKLIST payload. Both `{v:2, worklist:[…]}` (014 §7.3) and the compact
     * `{v:3, rows:[…]}` (ADR-0015) resolve to this one kind, because they normalise to the same
     * internal rows and nothing downstream should be able to tell them apart — that is the whole
     * point of normalising here rather than in `app.html`.
     *
     * The VALUE stays `'v2'` deliberately: it is compared by `main.js` and would be a gratuitous
     * breaking rename. `result.payload_version` carries which shape actually arrived, for the log.
     */
    V2: 'v2',
    /** `tm30://open` with no `d` — the operator asked for the account chooser. */
    CHOOSER: 'chooser',
    /** 🔴 The loud path. A payload that was sent but cannot be trusted. */
    ERROR: 'error',
};

/** @internal every failure carries a human-readable reason — it is shown, not swallowed. */
const fail = (reason) => ({ kind: DeepLinkKind.ERROR, reason });

/**
 * @internal The server's urgency vocabulary. `'upcoming'` (ADR-0014) = sheet ready, deadline not
 * reached. An unrecognised value is dropped to `undefined` rather than passed through, so a
 * newer backend can add a fourth value without this Helper rendering a word it has no art for.
 */
const DOT_VALUES = new Set(['due', 'overdue', 'upcoming']);

/** @internal `https://x/` → `https://x`. A base joined with `/path` must not produce `//path`. */
const trimSlashes = (s) => String(s).replace(/\/+$/, '');

/**
 * @internal FNV-1a (32-bit) over the encoded payload, as 8 lowercase hex characters.
 *
 * 🔴 THE CONSUMER HALF OF THE `c=` GUARD, which was missing until 2026-08-10.
 *
 * The emitter (`mo-reservation-fe/src/lib/tm30.ts` `tm30PayloadDigest`) has appended `&c=` to
 * every worklist link for as long as the digest has existed, and its docblock says exactly why:
 * the base64 round-trip below catches TRUNCATION but not SUBSTITUTION. Swapping one valid base64
 * character for another round-trips cleanly and very often still parses as JSON — measured there
 * at 133 of 441 single-character mutations accepted, 31 of them silently ALTERING a value
 * ("Malee V11" arriving as "M@lee V11"). The emitter even annotates the function "exported only
 * so the Helper's parser can be tested against the real function". This side never read it.
 *
 * NOT a signature, and not claimed to be: it detects a MANGLED link — argv quoting, a copy-paste
 * that lost a character, a shell that ate one — not a hostile one. Anyone who can rewrite the URL
 * can rewrite the digest with it. It must stay byte-identical to the emitter's implementation;
 * `roundtrip.test.mjs` compares the two against the REAL emitter so they cannot drift.
 */
function payloadDigest(encoded) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < encoded.length; i += 1) {
        hash ^= encoded.charCodeAt(i);
        // × 16777619 in 32-bit space, via shifts — `*` would lose precision above 2^53.
        hash =
            (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/**
 * @internal base64url → JSON, with an INTEGRITY CHECK.
 *
 * `Buffer.from(x, 'base64')` is deliberately lenient: it skips characters it cannot decode and
 * stops early rather than throwing, so a URL truncated by an OS argv limit (the 014 §7.4 Q4
 * failure mode) decodes to a SHORTER-but-clean buffer instead of an error. Re-encoding the
 * decoded bytes and comparing against the input catches exactly that: any dropped or mangled
 * character changes the round-trip. Without this, truncation could reach `JSON.parse` and — on
 * an unlucky boundary — parse as a valid but SILENTLY SHORTER worklist. Losing filings quietly
 * is the one outcome worse than failing.
 */
function decodeBase64UrlJson(d) {
    const b64 = String(d).replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Buffer.from(b64, 'base64');

    const reencoded = bytes
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    if (reencoded !== String(d).replace(/=+$/, '')) {
        throw new Error('payload is truncated or corrupt (base64 integrity check failed)');
    }

    return JSON.parse(bytes.toString('utf8'));
}

/**
 * @internal Normalises one v2 worklist row.
 *
 * `dot` and `status` are passed through UNTOUCHED — they are server-computed and the client is
 * forbidden to re-derive them (014 §7.3 defect 3). `villa` and `account.name` are copied whole:
 * NEVER SPLIT A NAME (009 §10).
 *
 * @returns the normalised row, or a string describing why the row is corrupt.
 */
function normalizeRow(row, index) {
    if (!row || typeof row !== 'object') return `row ${index} is not an object`;
    if (!Number.isFinite(row.filing_id)) return `row ${index} has no usable filing_id`;
    if (typeof row.villa !== 'string' || row.villa === '') return `row ${index} has no villa`;

    const out = {
        filing_id: row.filing_id,
        villa: row.villa,
        checkin: typeof row.checkin === 'string' ? row.checkin : '',
        status: typeof row.status === 'string' ? row.status : '',
        dot: DOT_VALUES.has(row.dot) ? row.dot : undefined,
    };

    if (typeof row.report_status === 'string') out.report_status = row.report_status;
    if (typeof row.sheet_download_url === 'string') out.sheet_download_url = row.sheet_download_url;
    if (typeof row.folder_url === 'string') out.folder_url = row.folder_url;
    if (typeof row.return_url === 'string') out.return_url = row.return_url;

    /**
     * DISPLAY-ONLY, and deliberately so.
     *
     * Both have been on the wire since the backend added them (`Tm30WorklistItem`) and the
     * emitter forwards them (`src/lib/tm30.ts`), but this allowlist never copied them across, so
     * every row reached the pane without either field. Nothing broke — the renderer guards on
     * both — which is exactly why it went unnoticed: the pane simply showed less than it had.
     *
     *  - `checkout` — the stay's end. The urgency bucket is check-IN's alone (014 §7.1 Q2);
     *    nothing downstream may derive a dot, a rank or a bucket from this one.
     *  - `internal_id` — `contract.internal_id`, e.g. `C100-04082026-001`. The reference humans
     *    use for the stay, so a filing can be matched to a booking without translating between
     *    two identifier systems.
     *
     * Absent keys stay absent (the `account` omission style): a backend older than these fields
     * is not an error, and the row renders without them.
     */
    if (typeof row.checkout === 'string') out.checkout = row.checkout;
    if (typeof row.internal_id === 'string') out.internal_id = row.internal_id;

    /**
     * 🔴 The daily case (014 §7.9). An absent `account` is a REAL, EXPECTED state — the row is
     * kept and the key is simply omitted. An empty-but-present `{login:'',pass:''}` is normalised
     * to the same absent state rather than propagated: that always-present-never-usable shape is
     * what made the v2 branch dead code (013 §5), and it must not be reintroduced from the wire
     * side either. Neither case is an error.
     */
    const acc = row.account;
    if (acc && typeof acc === 'object' && typeof acc.login === 'string' && acc.login !== '') {
        out.account = {
            name: typeof acc.name === 'string' && acc.name !== '' ? acc.name : row.villa,
            login: acc.login,
            pass: typeof acc.pass === 'string' ? acc.pass : '',
        };
    }

    return out;
}

/**
 * @internal Normalises one v3 (compact) row into the SAME shape {@link normalizeRow} produces.
 *
 * v3 exists because the whole worklist rides inside the `tm30://` URL and the emitter REFUSES to
 * emit above 8192 characters rather than truncating (ADR-0015). Measured, the v2 shape costs 564
 * chars per row — about ten filings — and three of those costs are pure repetition: the villa's
 * credentials are repeated on every row of that villa, and two of the three URLs are mechanically
 * derivable from a base plus an id. v3 hoists the credentials into `villas` and sends the bases
 * once.
 *
 * 🔴 Everything derived here is derived from SERVER-SUPPLIED bases. The Helper hardcodes no
 * origin and no URL shape — not even Drive's — because the moment it does, a deployment that
 * moves is a Helper release rather than a config change.
 *
 * @returns the normalised row, or a string describing why the row is corrupt.
 */
function normalizeRowV3(row, index, bases, villas) {
    if (!row || typeof row !== 'object') return `row ${index} is not an object`;
    if (!Number.isFinite(row.filing_id)) return `row ${index} has no usable filing_id`;
    if (!Number.isFinite(row.booking_id)) return `row ${index} has no usable booking_id`;
    if (typeof row.villa !== 'string' || row.villa === '') return `row ${index} has no villa`;

    const out = {
        filing_id: row.filing_id,
        villa: row.villa,
        checkin: typeof row.checkin === 'string' ? row.checkin : '',
        status: typeof row.status === 'string' ? row.status : '',
        dot: DOT_VALUES.has(row.dot) ? row.dot : undefined,
    };

    if (typeof row.report_status === 'string') out.report_status = row.report_status;
    if (typeof row.checkout === 'string') out.checkout = row.checkout;
    if (typeof row.internal_id === 'string') out.internal_id = row.internal_id;

    // `sheet` is a boolean because ABSENCE is the meaningful state: no generated sheet yet. The
    // v2 wire said the same thing by omitting the URL, and `rowState` still reads it that way.
    if (row.sheet === true) {
        out.sheet_download_url = `${bases.api}/tm30/filings/${row.filing_id}/sheet`;
    }
    if (typeof row.folder_id === 'string' && row.folder_id !== '') {
        out.folder_url = `${bases.drive}/${row.folder_id}`;
    }
    // §8.4 hand-back. Built here from `booking_id`, which v2 deliberately omitted because the
    // emitter had already spelled the URL out; v3 trades ~105 characters of URL for ~10 of id.
    out.return_url =
        `${bases.web}/reservation/reservations/${row.booking_id}` +
        `?action=manage_booking&tab=tm30&confirm=submitted`;

    /**
     * 🔴 A villa absent from `villas` is the NORMAL cred-less state, not an error — the same rule
     * v2's row-level `account` follows, expressed once per villa instead of once per row. An
     * empty-but-present `{login:''}` is normalised to absent for the same reason it is in v2.
     */
    const acc = villas[row.villa];
    if (acc && typeof acc === 'object' && typeof acc.login === 'string' && acc.login !== '') {
        out.account = {
            name: typeof acc.name === 'string' && acc.name !== '' ? acc.name : row.villa,
            login: acc.login,
            pass: typeof acc.pass === 'string' ? acc.pass : '',
        };
    }

    return out;
}

/**
 * Parses a `tm30://` URL into a discriminated result.
 *
 * @param {string} url
 * @returns {{kind:'v1',account:object}
 *          |{kind:'v2',worklist:object[],focus_filing_id?:number}
 *          |{kind:'chooser'}
 *          |{kind:'error',reason:string}
 *          |null} `null` ONLY when the URL is not a `tm30://` link at all (nothing to do);
 *          every genuine tm30 link resolves to one of the four kinds above.
 */
function parseDeepLink(url) {
    if (!url || typeof url !== 'string' || !url.startsWith(PROTOCOL + '://')) return null;

    let d;
    let c;
    try {
        const params = new URL(url).searchParams;
        d = params.get('d');
        c = params.get('c');
    } catch {
        return fail('deep link is not a valid URL');
    }

    // `tm30://open` — no payload was ever sent. The chooser is the CORRECT answer here, and it
    // is the only path that may still reach the chooser.
    if (!d) return { kind: DeepLinkKind.CHOOSER };

    /**
     * 🔴 Verified BEFORE the payload is decoded, let alone trusted — the whole point of `c`
     * riding alongside `d` rather than inside it.
     *
     * ABSENT `c` is tolerated, not rejected: `tm30://open` and the v1 account link carry no
     * digest, and neither does a link built by a web deploy older than the digest. The threat
     * model here is a MANGLED link, and a mangling that removes exactly `&c=…` while leaving a
     * valid `d` is not a failure mode anyone has seen — whereas one that alters a character
     * inside `d` is, and is now caught. Present-but-wrong is always loud.
     */
    if (c !== null && c !== undefined && c !== '') {
        const expected = payloadDigest(String(d));
        if (expected !== String(c).toLowerCase()) {
            return fail(
                'the link payload does not match its checksum — it was altered or mangled in ' +
                    'transit. Reopen the Helper from the web tab to get a fresh link.'
            );
        }
    }

    let payload;
    try {
        payload = decodeBase64UrlJson(d);
    } catch (err) {
        return fail(`could not decode the link payload — ${err.message}`);
    }

    if (!payload || typeof payload !== 'object') return fail('link payload is not an object');

    // ── v2 / v3: the whole Stage-B worklist (014 §7.3, ADR-0015) ──
    if (payload.v !== undefined) {
        if (payload.v !== 2 && payload.v !== 3) {
            return fail(`unsupported deep-link version "${payload.v}"`);
        }

        const worklist = [];

        if (payload.v === 3) {
            if (!Array.isArray(payload.rows)) return fail('v3 payload has no rows array');
            for (const key of ['api_base', 'web_base', 'drive_base']) {
                if (typeof payload[key] !== 'string' || payload[key] === '') {
                    // Loud, not silent: without a base the derived URLs would be strings like
                    // "undefined/tm30/filings/12/sheet", which fail later and further away.
                    return fail(`v3 payload has no ${key}`);
                }
            }
            const bases = {
                api: trimSlashes(payload.api_base),
                web: trimSlashes(payload.web_base),
                drive: trimSlashes(payload.drive_base),
            };
            const villas =
                payload.villas && typeof payload.villas === 'object' ? payload.villas : {};

            for (let i = 0; i < payload.rows.length; i += 1) {
                const row = normalizeRowV3(payload.rows[i], i, bases, villas);
                if (typeof row === 'string') return fail(`v3 payload is malformed — ${row}`);
                worklist.push(row);
            }
        } else {
            if (!Array.isArray(payload.worklist)) return fail('v2 payload has no worklist array');
            for (let i = 0; i < payload.worklist.length; i += 1) {
                const row = normalizeRow(payload.worklist[i], i);
                if (typeof row === 'string') return fail(`v2 payload is malformed — ${row}`);
                worklist.push(row);
            }
        }

        // An EMPTY worklist is well-formed, not broken: nothing is due right now. The window
        // layer says so; it is not a reason to fall back to the chooser.
        const result = { kind: DeepLinkKind.V2, worklist, payload_version: payload.v };

        /**
         * T3-03: the OPTIONAL focus — the filing the window boots pre-selected on. Tolerant
         * BY DESIGN, unlike the row checks above: focus is an enhancement on top of a payload
         * that is otherwise fully usable, so an absent or junk value degrades to "no focus"
         * (the key stays OFF the result), never to the loud ERROR path.
         */
        if (Number.isFinite(payload.focus_filing_id)) {
            result.focus_filing_id = payload.focus_filing_id;
        }
        return result;
    }

    // ── v1 legacy: `{ name, login, pass }`. UNCHANGED behaviour (013 §5 row 4). ──
    if (typeof payload.login === 'string' && payload.login !== '') {
        return {
            kind: DeepLinkKind.V1,
            account: {
                name: String(payload.name || payload.login),
                login: String(payload.login),
                pass: String(payload.pass || ''),
            },
        };
    }

    // A payload was sent but is neither v1 nor v2. Previously `return null` → silent chooser.
    return fail('link payload is neither a v1 account nor a v2/v3 worklist');
}

module.exports = { parseDeepLink, DeepLinkKind, PROTOCOL, payloadDigest };
