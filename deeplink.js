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
    /**
     * A POINTER payload — `{v:4, api_base, token, focus_filing_id?}` (ADR-0021). No rows, no
     * credentials: the Helper fetches the worklist over HTTPS instead of receiving it.
     *
     * 🔴 Deliberately NOT folded into {@link DeepLinkKind.V2}, which is exactly what v3 was.
     * v3 folded because it NORMALISES to the same rows and nothing downstream can tell them
     * apart. v4 carries no rows at all, so folding it would hand `main.js` a `V2` result with an
     * empty `worklist` — a pointer that has not been followed yet, wearing the face of an
     * operator with nothing to do. That is the 014 §7.9 silent-degradation failure again, and it
     * is why this is its own kind: a caller that has not been taught to follow a pointer must
     * fail to match it, loudly, rather than quietly render it as an empty queue.
     */
    V4: 'v4',
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

/**
 * Compare two `x.y.z` versions. `-1 | 0 | 1`, and `null` when either side is not a bare triple.
 *
 * 🔴 Deliberately strict, and `null` is the honest answer rather than a guess: a version we
 * cannot parse must never be treated as "old enough to block" — a malformed floor would lock an
 * operator out of their own queue over a typo in a payload field. Every caller treats `null` as
 * "no opinion" and lets the work through.
 *
 * No semver library: this file is required by `main.js` at startup and has ZERO dependencies by
 * design. Pre-release tags are not used by this project's releases and are not supported.
 */
function compareVersions(a, b) {
    const parse = (v) => {
        const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v == null ? '' : v).trim());
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const pa = parse(a);
    const pb = parse(b);
    if (!pa || !pb) return null;
    for (let i = 0; i < 3; i += 1) {
        if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
    }
    return 0;
}

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
 * @internal The OPTIONAL top-level keys a versioned payload may carry, applied to an
 * already-validated result. Shared by every version branch — v2, v3 and v4 — because none of
 * them is about rows: they describe the LINK, not its contents.
 *
 * Extracted (not retyped) when v4 arrived: the floor in particular has to work identically on a
 * pointer, and a second copy of the version-gate's input is precisely how a v4 link would end up
 * silently un-gated. Every block below is verbatim what the v2/v3 branch ran inline before.
 *
 * All four are TOLERANT: a junk value leaves the key OFF the result and is never a reason to
 * fail a link. Absent is the normal state for all of them.
 */
function applyOptionalKeys(result, payload) {
    /**
     * MO-TM30-HELPER-VERSIONING §5 Layer 2 — the floor THIS link needs.
     *
     * Expresses what Layer 1's "is there a newer release" cannot: *this particular link
     * requires ≥ X*. That is the honest signal when the web app has just started sending a
     * field an older Helper would silently drop — the failure mode §1 of that spec is
     * entirely about (`focus_filing_id` did exactly this to pre-T3-03 Helpers).
     *
     * Carried through as data only. The COMPARISON and the block live in `main.js`, because
     * this module is pure and testable and must not own a dialog. Tolerant like
     * `focus_filing_id`: a junk value leaves the key off rather than failing the link, since
     * a malformed floor must not be a reason to refuse work.
     */
    if (typeof payload.min_helper_version === 'string' &&
        /^\d+\.\d+\.\d+$/.test(payload.min_helper_version.trim())) {
        result.min_helper_version = payload.min_helper_version.trim();
    }

    /**
     * ADR-0001 / V-2 C-1 — WHERE TO REPORT THIS HELPER'S VERSION, and who to say it is.
     *
     * Two additive, OPTIONAL top-level keys on the v2, the v3 and the v4 shape alike (this block
     * sits outside the version branch, so no shape has to know about them). Same tolerance as
     * `min_helper_version` directly above: validated shallowly, carried as DATA, and never a
     * reason to fail a link. A junk value leaves the key off — a Helper that cannot report is
     * a Helper with a stale badge, which must never cost the operator their filing.
     *
     * The URL is re-validated in `main.js` with its own `isHttpUrl` before it is POSTed to or
     * written to disk; this module stays dependency-free and does not own that rule. The
     * token is opaque here on purpose: it identifies an operator to the backend and this
     * side has no way — and no need — to tell a real one from a wrong one.
     *
     * A C-1 pointer carries NEITHER key (it names one address and one token, and the report
     * endpoint is derived from `api_base`); absent keys simply stay off, so applying the block
     * to v4 costs nothing and keeps a future pointer that does carry them working.
     */
    if (typeof payload.report_url === 'string') {
        const raw = payload.report_url.trim();
        try {
            const proto = new URL(raw).protocol;
            if (proto === 'http:' || proto === 'https:') result.report_url = raw;
        } catch {
            /* not a URL at all — the key stays off, exactly as a junk floor does */
        }
    }
    if (typeof payload.report_token === 'string' && payload.report_token.trim() !== '') {
        result.report_token = payload.report_token.trim();
    }

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

/**
 * @internal Parses the v4 POINTER payload (ADR-0021 C-1): `{api_base, token, focus_filing_id?}`.
 *
 * 🔴 BOTH REQUIRED FIELDS FAIL LOUD, in the digest's failure class rather than the
 * `focus_filing_id` one. Everything else in this parser that is missing has a usable degraded
 * meaning — no account means "log in by hand", no focus means "no focus", an empty worklist
 * means "nothing is due". A pointer missing its address or its token has none: it cannot be
 * followed, and the ONLY other thing it could turn into is a window showing zero filings, which
 * is indistinguishable from an operator who is done for the day. A queue that cannot be read
 * must never look like a queue that is empty (014 §7.9).
 *
 * `api_base` is checked for an http(s) protocol here, one notch stricter than v3's
 * string-and-non-empty check on the same key. v3 can afford lax: its bases only decorate rows
 * that arrived anyway, so a junk base costs a broken download link on a row the operator can
 * still see. A junk base on a pointer costs the entire queue. `main.js` re-validates with its
 * own `isHttpUrl` before anything is POSTed or written to disk — this shallow check exists so
 * the failure is reported at the link, where the operator can act on it.
 *
 * The token is opaque, here as everywhere: a non-empty string is the whole contract (ADR-0021).
 * Unknown keys are ignored, never errors (AC-16).
 */
function parseV4Pointer(payload) {
    const rawBase = typeof payload.api_base === 'string' ? payload.api_base.trim() : '';
    if (rawBase === '') return fail('v4 payload has no api_base — the pointer has no address');
    let apiBase;
    try {
        const proto = new URL(rawBase).protocol;
        if (proto !== 'http:' && proto !== 'https:') throw new Error('not http(s)');
        apiBase = trimSlashes(rawBase);
    } catch {
        return fail(`v4 payload has an unusable api_base "${rawBase}"`);
    }

    const token = typeof payload.token === 'string' ? payload.token.trim() : '';
    if (token === '') return fail('v4 payload has no token — the pointer cannot be followed');

    return applyOptionalKeys({ kind: DeepLinkKind.V4, api_base: apiBase, token }, payload);
}

/**
 * Parses a `tm30://` URL into a discriminated result.
 *
 * @param {string} url
 * @returns {{kind:'v1',account:object}
 *          |{kind:'v2',worklist:object[],focus_filing_id?:number}
 *          |{kind:'v4',api_base:string,token:string,focus_filing_id?:number}
 *          |{kind:'chooser'}
 *          |{kind:'error',reason:string}
 *          |null} `null` ONLY when the URL is not a `tm30://` link at all (nothing to do);
 *          every genuine tm30 link resolves to one of the five kinds above.
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

    // ── v2 / v3: the whole Stage-B worklist (014 §7.3, ADR-0015). v4: a pointer to it ──
    if (payload.v !== undefined) {
        if (payload.v !== 2 && payload.v !== 3 && payload.v !== 4) {
            return fail(`unsupported deep-link version "${payload.v}"`);
        }

        // ADR-0021 — the rows stopped travelling in the URL. Its own kind, its own branch, and
        // it shares only what is genuinely shared: the digest above and the optional keys below.
        if (payload.v === 4) return parseV4Pointer(payload);

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

        return applyOptionalKeys(result, payload);
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

module.exports = { parseDeepLink, DeepLinkKind, PROTOCOL, payloadDigest, compareVersions };
