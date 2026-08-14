/**
 * ADR-0021 / C-1 — THE v4 POINTER: `{v:4, api_base, token, focus_filing_id?}`.
 *
 * The rows stopped travelling in the URL. What arrives instead is an address and an opaque
 * operator token, and this file asserts the two halves of receiving one:
 *
 *  ── PART A · THE PARSE (`deeplink.js`) ──────────────────────────────────────────────────────
 *  A pointer parses to its OWN kind — never to a `v2` result with an empty worklist, which would
 *  be a queue that has not been fetched wearing the face of a queue that is empty (014 §7.9).
 *  🔴 The two required fields fail LOUD: a pointer missing its address or its token is an ERROR,
 *  in the digest's failure class, not a silent empty result. The digest guard and the
 *  `min_helper_version` floor are the SAME machinery v3 goes through — asserted here by feeding
 *  both shapes the same mangling and comparing the answers, so a future refactor cannot fix one
 *  and forget the other. Unknown keys stay inert (AC-16).
 *
 *  ── PART B · THE MEMO (`main.js`, `tm30-state.json`) ────────────────────────────────────────
 *  AC-7: the pointer's `token` is remembered exactly as `report_token` is remembered today —
 *  the SAME field, because it is the same secret doing a second job — and `api_base` joins it in
 *  the same union-merge memo. AC-14: a v2/v3 link teaches `api_base` too, derived from a row's
 *  sheet URL, which is what makes it bootstrap material rather than only a snapshot.
 *
 *  What is deliberately NOT here: fetching a queue, and opening a window on one. Both are task
 *  Q-5's. This build learns a pointer and stops, and PART B pins that it stops QUIETLY — a
 *  pointer must not reach the broken-link dialog.
 *
 * PART B drives the REAL `main.js` with `electron` stubbed in the module loader, for the reason
 * `version-report.test.mjs` does: the memo needs `app.getPath('userData')` and a fixture that
 * mirrors the file format is exactly the drift `roundtrip.test.mjs` exists to catch.
 *
 * Run: node --test test/deeplink-v4.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const require = createRequire(import.meta.url);
const { parseDeepLink, DeepLinkKind, payloadDigest, compareVersions } = require(
    path.join(repo, 'deeplink.js')
);

const API_BASE = 'https://api.mo.example';
const TOKEN = '4210.AbCdEfGhIjKlMnOpQrStUv';
const FLOOR = '2.5.0';

/** The emitter's envelope, digest and all — `buildTm30DeepLinkV4` builds exactly this. */
const link = (payload, { digest = true } = {}) => {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `tm30://open?d=${encoded}` + (digest ? `&c=${payloadDigest(encoded)}` : '');
};

/** The same envelope with one character of `d` swapped — the substitution `c=` exists to catch. */
const mangled = (payload) => {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const swapped = encoded.slice(0, -1) + (encoded.slice(-1) === 'A' ? 'B' : 'A');
    return `tm30://open?d=${swapped}&c=${payloadDigest(encoded)}`;
};

const v4 = (over = {}) => ({
    v: 4,
    min_helper_version: FLOOR,
    api_base: API_BASE,
    token: TOKEN,
    ...over,
});

/** A v3 link, for the "same machinery" comparisons. Shape copied from the emitter's output. */
const v3 = (over = {}) => ({
    v: 3,
    api_base: API_BASE,
    web_base: 'https://app.mo.example',
    drive_base: 'https://drive.google.com/drive/folders',
    villas: { 'Malee V11': { login: 'malee_v11', pass: 's3cr3t' } },
    rows: [
        { filing_id: 3568, booking_id: 3572, villa: 'Malee V11', checkin: '2026-08-22', sheet: true },
    ],
    ...over,
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// PART A · the parse
// ────────────────────────────────────────────────────────────────────────────────────────────

test('a v4 pointer parses to its own kind, carrying the address, the token and the focus', () => {
    const out = parseDeepLink(link(v4({ focus_filing_id: 3568 })));

    assert.deepEqual(out, {
        kind: DeepLinkKind.V4,
        api_base: API_BASE,
        token: TOKEN,
        min_helper_version: FLOOR,
        focus_filing_id: 3568,
    });
    // 🔴 The one thing it must never be mistaken for.
    assert.notEqual(out.kind, DeepLinkKind.V2, 'a pointer is not an empty worklist');
    assert.equal('worklist' in out, false, 'and it carries no rows to be mistaken for one');
});

test('the focus is optional in both directions, and junk in it never costs the link', () => {
    const without = parseDeepLink(link(v4()));
    assert.equal(without.kind, DeepLinkKind.V4);
    assert.equal('focus_filing_id' in without, false, 'absent stays absent, not undefined');

    for (const junk of ['3568', null, NaN, {}]) {
        const out = parseDeepLink(link(v4({ focus_filing_id: junk })));
        assert.equal(out.kind, DeepLinkKind.V4, `focus ${JSON.stringify(junk)} still opens`);
        assert.equal('focus_filing_id' in out, false);
    }
});

test('AC-16: keys this build has never heard of are inert — never an error, never echoed', () => {
    const out = parseDeepLink(
        link(v4({ task_type: 'visa_extension', rows: [{ filing_id: 1 }], scopes: ['queue'] }))
    );

    assert.equal(out.kind, DeepLinkKind.V4);
    assert.equal(out.api_base, API_BASE);
    assert.equal(out.token, TOKEN);
    for (const key of ['task_type', 'rows', 'scopes']) {
        assert.equal(key in out, false, `${key} was carried through instead of ignored`);
    }
});

test('the trailing slash comes off api_base, exactly as it does off v3 bases', () => {
    assert.equal(parseDeepLink(link(v4({ api_base: 'https://api.mo.example/' }))).api_base, API_BASE);
    assert.equal(
        parseDeepLink(link(v4({ api_base: 'https://api.mo.example/api//' }))).api_base,
        'https://api.mo.example/api',
        'only the trailing slashes go — a base that carries a path prefix survives whole'
    );
});

test('🔴 a pointer with no api_base FAILS LOUD — it must never look like an empty queue', () => {
    for (const missing of [undefined, '', '   ', null, 42]) {
        const payload = v4();
        if (missing === undefined) delete payload.api_base;
        else payload.api_base = missing;

        const out = parseDeepLink(link(payload));
        assert.equal(out.kind, DeepLinkKind.ERROR, `api_base ${JSON.stringify(missing)}`);
        assert.match(out.reason, /api_base/);
        assert.notEqual(out.kind, DeepLinkKind.CHOOSER);
    }
});

test('🔴 an api_base that is not an http(s) address fails loud as well', () => {
    for (const bad of ['ftp://api.mo.example', 'file:///etc/passwd', 'api.mo.example', '/tm30']) {
        const out = parseDeepLink(link(v4({ api_base: bad })));
        assert.equal(out.kind, DeepLinkKind.ERROR, `api_base ${bad}`);
        assert.match(out.reason, /api_base/);
    }
});

test('🔴 a pointer with no token FAILS LOUD — the address alone cannot be followed', () => {
    for (const missing of [undefined, '', '   ', null, 7]) {
        const payload = v4();
        if (missing === undefined) delete payload.token;
        else payload.token = missing;

        const out = parseDeepLink(link(payload));
        assert.equal(out.kind, DeepLinkKind.ERROR, `token ${JSON.stringify(missing)}`);
        assert.match(out.reason, /token/);
    }
});

test('the token is opaque: anything non-empty is the whole contract', () => {
    for (const token of ['x', ' padded ', 'a'.repeat(4096), '{"not":"json"}']) {
        const out = parseDeepLink(link(v4({ token })));
        assert.equal(out.kind, DeepLinkKind.V4);
        assert.equal(out.token, token.trim(), 'stored verbatim but for the surrounding space');
    }
});

test('the digest guard is the SAME machinery v3 goes through, word for word', () => {
    const pointer = parseDeepLink(mangled(v4()));
    const worklist = parseDeepLink(mangled(v3()));

    assert.equal(pointer.kind, DeepLinkKind.ERROR);
    assert.equal(worklist.kind, DeepLinkKind.ERROR);
    assert.equal(pointer.reason, worklist.reason, 'one guard, one message, both tiers');
    assert.match(pointer.reason, /checksum/);
});

test('an absent digest is tolerated on a pointer exactly as on a worklist', () => {
    const out = parseDeepLink(link(v4(), { digest: false }));
    assert.equal(out.kind, DeepLinkKind.V4, 'a web deploy older than `c=` is not a broken link');
});

test('a truncated pointer is caught by the base64 integrity check, not decoded halfway', () => {
    const encoded = Buffer.from(JSON.stringify(v4()), 'utf8').toString('base64url');
    const out = parseDeepLink(`tm30://open?d=${encoded.slice(0, -5)}`);
    assert.equal(out.kind, DeepLinkKind.ERROR);
});

test('AC-14: the floor rides on a pointer and is compared by the existing version machinery', () => {
    const out = parseDeepLink(link(v4()));
    assert.equal(out.min_helper_version, FLOOR);

    // Precisely the comparison `refusedForVersion` makes in main.js — no second implementation.
    assert.equal(compareVersions('2.4.0', out.min_helper_version), -1, 'an old Helper is refused');
    assert.equal(compareVersions('2.5.0', out.min_helper_version), 0, 'this floor, exactly');
    assert.equal(compareVersions('2.6.1', out.min_helper_version), 1, 'a newer one goes through');
});

test('a junk floor leaves the key off rather than refusing the work — as on v2/v3', () => {
    for (const junk of ['2.5', 'latest', '', 250, null]) {
        const out = parseDeepLink(link(v4({ min_helper_version: junk })));
        assert.equal(out.kind, DeepLinkKind.V4, `floor ${JSON.stringify(junk)}`);
        assert.equal('min_helper_version' in out, false);
    }
});

test('v1/v2/v3 still parse as they did — the v4 branch is additive', () => {
    const worklist = parseDeepLink(link(v3({ min_helper_version: '2.3.0', focus_filing_id: 3568 })));
    assert.equal(worklist.kind, DeepLinkKind.V2, 'v3 still folds into the v2 kind');
    assert.equal(worklist.payload_version, 3);
    assert.equal(worklist.worklist.length, 1);
    assert.equal(worklist.min_helper_version, '2.3.0');
    assert.equal(worklist.focus_filing_id, 3568);

    const account = parseDeepLink(link({ name: 'Malee V11', login: 'malee_v11', pass: 's3cr3t' }));
    assert.equal(account.kind, DeepLinkKind.V1);

    assert.equal(parseDeepLink('tm30://open').kind, DeepLinkKind.CHOOSER);
    assert.equal(parseDeepLink('https://example.com'), null);
    assert.equal(parseDeepLink(link({ v: 5, api_base: API_BASE })).kind, DeepLinkKind.ERROR);
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// PART B · the memo — the real main.js, with electron stubbed at the module loader
// ────────────────────────────────────────────────────────────────────────────────────────────

const APP_VERSION = '2.4.0';

/** Rebound per test; every state-file read in `main.js` goes through `app.getPath`. */
let userData = '';

const noop = () => {};
const errorBoxes = [];

class FakeBrowserWindow {
    static all = [];
    constructor(opts) {
        this.opts = opts;
        this.webContents = {
            on: noop,
            send: noop,
            executeJavaScript: async () => {},
            setWindowOpenHandler: noop,
        };
        FakeBrowserWindow.all.push(this);
    }
    loadFile(file, opts) {
        this.loaded = { file, opts };
    }
    focus() {}
    on() {}
    isDestroyed() {
        return false;
    }
    static getAllWindows() {
        return FakeBrowserWindow.all;
    }
}
FakeBrowserWindow.prototype.setWindowOpenHandler = noop;

const electronStub = {
    app: {
        requestSingleInstanceLock: () => true,
        setAsDefaultProtocolClient: () => true,
        getPath: () => userData,
        getVersion: () => APP_VERSION,
        // Never resolves: a resolving whenReady would open a window at import time and race
        // every assertion below. The launch sequence is driven by the tests instead.
        whenReady: () => new Promise(() => {}),
        isReady: () => true,
        isPackaged: false,
        on: noop,
        quit: noop,
    },
    BrowserWindow: FakeBrowserWindow,
    dialog: {
        showMessageBoxSync: () => 1,
        showErrorBox: (title, body) => errorBoxes.push({ title, body }),
    },
    ipcMain: { handle: noop, on: noop },
    session: { fromPartition: () => ({ clearStorageData: async () => {} }) },
    shell: { openExternal: async () => {} },
    webContents: { getAllWebContents: () => [] },
};

const realLoad = Module._load;
Module._load = function patched(request, ...rest) {
    if (request === 'electron') return electronStub;
    if (request === 'electron-updater') {
        return { autoUpdater: { on: noop, checkForUpdates: async () => {}, quitAndInstall: noop } };
    }
    return realLoad.call(this, request, ...rest);
};
const main = require(path.join(repo, 'main.js'));
Module._load = realLoad;

const statePath = () => path.join(userData, 'tm30-state.json');
const readFile = () => JSON.parse(fs.readFileSync(statePath(), 'utf8'));
const writeFile = (obj) => fs.writeFileSync(statePath(), JSON.stringify(obj) + '\n', 'utf8');

/** A fresh userData directory and a fresh module state — i.e. a fresh launch. */
function freshLaunch(initialState) {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tm30-userdata-'));
    errorBoxes.length = 0;
    FakeBrowserWindow.all.length = 0;
    if (initialState) writeFile(initialState);
    main.__resetForTest();
}

const realFetch = globalThis.fetch;
/** Replaces `fetch` and records every call — nothing here may reach a real network. */
function recordFetch() {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
        return { status: 204 };
    };
    return calls;
}
test.after(() => {
    globalThis.fetch = realFetch;
});

test('AC-7/AC-12: a pointer link stores its token in report_token, and the address beside it', () => {
    freshLaunch({ install_url: 'https://app.mo.example/tm30-helper', future_key: { by: '2.9.0' } });
    const calls = recordFetch();

    main.handleDeepLink(link(v4({ focus_filing_id: 3568 })));

    assert.deepEqual(readFile(), {
        install_url: 'https://app.mo.example/tm30-helper',
        future_key: { by: '2.9.0' }, // 🔴 the union write, unchanged
        report_token: TOKEN,
        api_base: API_BASE,
    });
    assert.equal('token' in readFile(), false, 'ONE token on disk, under the name it already had');
    assert.equal(calls.length, 0, 'no report address was ever taught — so nothing is sent');
});

test('a pointer opens no window and, above all, no broken-link dialog', () => {
    freshLaunch();
    recordFetch();

    main.handleDeepLink(link(v4()));

    assert.deepEqual(errorBoxes, [], 'a pointer is a valid link — Q-5 gives it its window');
    assert.equal(FakeBrowserWindow.all.length, 0);
});

test('🔴 a pointer that cannot be followed DOES reach the broken-link dialog', () => {
    freshLaunch();
    recordFetch();

    main.handleDeepLink(link(v4({ token: '' })));

    assert.equal(errorBoxes.length, 1, 'loud, not silent');
    assert.match(errorBoxes[0].body, /token/);
    assert.deepEqual(main.readState(), {}, 'and nothing half-true was written');
});

test('AC-7: a newer link replaces the stored token, whichever tier it arrives on', () => {
    freshLaunch({ report_url: 'https://api.mo.example/tm30/helper-report', report_token: 'stale' });
    const calls = recordFetch();
    main.loadReportDetails();

    main.handleDeepLink(link(v4({ token: 'rotated.token' })));

    const file = readFile();
    assert.equal(file.report_token, 'rotated.token');
    assert.equal(file.report_url, 'https://api.mo.example/tm30/helper-report', 'kept, not dropped');
    assert.equal(file.api_base, API_BASE);
    assert.equal(calls.length, 1, 'a rotated token against a known address is a new fact to report');
    assert.equal(calls[0].body.token, 'rotated.token');
});

test('the memo is read back on the next launch: the same pointer twice writes once', () => {
    freshLaunch();
    recordFetch();
    main.handleDeepLink(link(v4()));
    const first = fs.statSync(statePath()).mtimeMs;

    // A LATER launch of the same install: same directory, new process, nothing in memory.
    main.__resetForTest();
    main.loadReportDetails();
    main.handleDeepLink(link(v4()));

    assert.deepEqual(readFile(), { report_token: TOKEN, api_base: API_BASE });
    assert.equal(fs.statSync(statePath()).mtimeMs, first, 'already known — nothing was rewritten');
});

test('AC-14: a v3 link teaches api_base too — its rows are bootstrap material, not just a queue', () => {
    freshLaunch();
    const calls = recordFetch();

    main.handleDeepLink(
        link(
            v3({
                min_helper_version: '2.3.0',
                report_url: 'https://api.mo.example/tm30/helper-report',
                report_token: TOKEN,
            })
        )
    );

    const file = readFile();
    assert.equal(file.api_base, API_BASE, 'derived from the row sheet URL, as the emitter derives it');
    assert.equal(file.report_token, TOKEN);
    assert.equal(file.report_url, 'https://api.mo.example/tm30/helper-report');
    assert.equal(calls.length, 1, 'and the version report still goes out, unchanged');
});

test('a v2 link with nothing generated yet teaches no address, and that is a supported state', () => {
    freshLaunch();
    recordFetch();

    main.handleDeepLink(
        link({
            v: 2,
            worklist: [
                {
                    filing_id: 3568,
                    villa: 'Malee V11',
                    checkin: '2026-08-22',
                    status: 'draft',
                    return_url: 'https://app.mo.example/reservation/reservations/3572?tab=tm30',
                },
            ],
        })
    );

    assert.deepEqual(readFile(), { install_url: 'https://app.mo.example/tm30-helper' });
});
