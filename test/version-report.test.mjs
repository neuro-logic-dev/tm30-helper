/**
 * V-2 / ADR-0001 — THE VERSION REPORT: the deep-link keys, the memo on disk, the one POST.
 *
 * Three things are under test and they fail in different ways, so they are asserted separately:
 *
 *  ── PART A · THE PAYLOAD KEYS (`deeplink.js`) ───────────────────────────────────────────────
 *  `report_url` / `report_token` arrive on both the v2 and the v3 shape, junk in either one is
 *  dropped without ever failing the link, and — 🔴 THE ONE THAT PROTECTS EVERY OPERATOR WHO HAS
 *  NOT UPDATED — a 2.4-shaped payload fed to the parser that SHIPPED IN 2.3.4 produces the same
 *  worklist as the same payload without the new keys (AC-20). That parser is read out of git at
 *  tag `v2.3.4`, not re-typed here: a mirrored copy of the code under test proves nothing.
 *
 *  ── PART B · THE MEMO (`main.js`, `tm30-state.json`) ────────────────────────────────────────
 *  A 2.3.4-era file (only `install_url`) loads, unknown keys survive a write, and
 *  `installation_id` is generated once and then never again.
 *
 *  ── PART C · THE REPORT (`main.js`) ─────────────────────────────────────────────────────────
 *  Exactly the four contract fields, to the remembered address, once per launch, and silent —
 *  console-only — through every failure a network can produce.
 *
 * B and C drive the REAL `main.js` with `electron` stubbed in the module loader, rather than a
 * re-typed copy of the memo: `main.js` cannot be extracted here (the memo needs
 * `app.getPath('userData')`, the report needs `app.getVersion()`), and a fixture that mirrors
 * the file format is exactly the drift `roundtrip.test.mjs` exists to catch.
 *
 * Run: node --test test/version-report.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const require = createRequire(import.meta.url);
const { parseDeepLink, DeepLinkKind } = require(path.join(repo, 'deeplink.js'));

const link = (payload) =>
    'tm30://open?d=' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

const REPORT_URL = 'https://api.mo.example/tm30/helper-report';
const REPORT_TOKEN = '4210.AbCdEfGhIjKlMnOpQrStUv';

// ────────────────────────────────────────────────────────────────────────────────────────────
// PART A · the payload keys
// ────────────────────────────────────────────────────────────────────────────────────────────

const V2_ROW = {
    filing_id: 3568,
    villa: 'Malee V11',
    checkin: '2026-08-22T07:00:00.000Z',
    status: 'sheet_ready',
    dot: 'due',
    return_url: 'https://app.mo.example/reservation/reservations/3572?tab=tm30',
    account: { name: 'Malee V11', login: 'malee_v11', pass: 's3cr3t' },
};

const v2 = (over = {}) => ({ v: 2, worklist: [V2_ROW], ...over });

const V3_BASES = {
    api_base: 'https://api.mo.example',
    web_base: 'https://app.mo.example',
    drive_base: 'https://drive.google.com/drive/folders',
};

const v3 = (over = {}) => ({
    v: 3,
    ...V3_BASES,
    villas: { 'Malee V11': { login: 'malee_v11', pass: 's3cr3t' } },
    rows: [{ filing_id: 3568, booking_id: 3572, villa: 'Malee V11', checkin: '2026-08-22', sheet: true }],
    ...over,
});

test('a v2 link carrying the reporting details surfaces both keys', () => {
    const out = parseDeepLink(link(v2({ report_url: REPORT_URL, report_token: REPORT_TOKEN })));
    assert.equal(out.kind, DeepLinkKind.V2);
    assert.equal(out.report_url, REPORT_URL);
    assert.equal(out.report_token, REPORT_TOKEN);
});

test('a v3 link carrying the reporting details surfaces both keys', () => {
    const out = parseDeepLink(link(v3({ report_url: REPORT_URL, report_token: REPORT_TOKEN })));
    assert.equal(out.kind, DeepLinkKind.V2, 'v3 still resolves to the worklist kind');
    assert.equal(out.payload_version, 3);
    assert.equal(out.report_url, REPORT_URL);
    assert.equal(out.report_token, REPORT_TOKEN);
});

test('a link WITHOUT them behaves exactly as today — the keys stay off (AC-14)', () => {
    const out = parseDeepLink(link(v2()));
    assert.equal(out.kind, DeepLinkKind.V2);
    assert.equal('report_url' in out, false, 'absent keys are never stubbed');
    assert.equal('report_token' in out, false);
});

test('junk in either key still parses and still opens the filing (keys dropped)', () => {
    const junk = [
        { report_url: 'not a url', report_token: REPORT_TOKEN },
        { report_url: 'javascript:alert(1)', report_token: REPORT_TOKEN },
        { report_url: 'ftp://api.mo.example/x', report_token: REPORT_TOKEN },
        { report_url: 42, report_token: REPORT_TOKEN },
        { report_url: REPORT_URL, report_token: '' },
        { report_url: REPORT_URL, report_token: { nope: true } },
        { report_url: null, report_token: null },
    ];
    for (const over of junk) {
        for (const payload of [v2(over), v3(over)]) {
            const out = parseDeepLink(link(payload));
            assert.equal(out.kind, DeepLinkKind.V2, `junk must not fail the link: ${JSON.stringify(over)}`);
            assert.equal(out.worklist.length, 1, 'the filing is still there');
            const goodUrl = over.report_url === REPORT_URL;
            const goodToken = over.report_token === REPORT_TOKEN;
            assert.equal('report_url' in out, goodUrl, `report_url kept? ${JSON.stringify(over)}`);
            assert.equal('report_token' in out, goodToken, `report_token kept? ${JSON.stringify(over)}`);
        }
    }
});

test('surrounding whitespace is trimmed rather than persisted into a POST target', () => {
    const out = parseDeepLink(
        link(v2({ report_url: `  ${REPORT_URL}  `, report_token: ` ${REPORT_TOKEN} ` })),
    );
    assert.equal(out.report_url, REPORT_URL);
    assert.equal(out.report_token, REPORT_TOKEN);
});

/**
 * 🔴 AC-20 — THE REGRESSION THAT MATTERS MOST.
 *
 * Every operator still on 2.3.4 keeps receiving links from a web app that has started sending
 * the new keys. If that parser did anything but ignore them, filings would stop opening for the
 * exact population this whole feature is about. The parser under test here is the SHIPPED one,
 * read out of git at its release tag — not a description of it.
 */
const shipped234Parser = () => {
    for (const ref of ['v2.3.4', 'main']) {
        try {
            const src = execFileSync('git', ['show', `${ref}:deeplink.js`], {
                cwd: repo,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            if (src.includes('report_url')) continue; // not a pre-2.4 parser — try the next ref
            const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tm30-234-')), 'deeplink.js');
            fs.writeFileSync(file, src, 'utf8');
            return { ref, parse: require(file).parseDeepLink };
        } catch {
            /* ref missing or git unavailable — fall through to the next candidate */
        }
    }
    return null;
};

test('AC-20: the 2.3.4 parser reads a 2.4-shaped payload exactly as it reads a 2.3-shaped one', (t) => {
    const shipped = shipped234Parser();
    if (!shipped) {
        t.skip('neither v2.3.4 nor main resolved — cannot read the shipped parser out of git');
        return;
    }
    console.log(`  parser under test: deeplink.js @ ${shipped.ref}`);

    for (const build of [v2, v3]) {
        const plain = build({ min_helper_version: '2.0.0', focus_filing_id: 3568 });
        const enriched = { ...plain, report_url: REPORT_URL, report_token: REPORT_TOKEN };

        const before = shipped.parse(link(plain));
        const after = shipped.parse(link(enriched));

        assert.equal(after.kind, DeepLinkKind.V2, 'a 2.4-shaped link still opens the filing');
        assert.deepEqual(after.worklist, before.worklist, 'the worklist is byte-identical');
        assert.deepEqual(after, before, 'so is every other field the old parser derives');
        // And the keys it has never heard of are simply not there — not copied, not echoed.
        assert.equal('report_url' in after, false);
        assert.equal('report_token' in after, false);
    }
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// PART B+C · the real main.js, with electron stubbed at the module loader
// ────────────────────────────────────────────────────────────────────────────────────────────

const APP_VERSION = '2.4.0';

/** Rebound per test; every state-file read in `main.js` goes through `app.getPath`. */
let userData = '';

const noop = () => {};

class FakeBrowserWindow {
    static all = [];
    constructor(opts) {
        this.opts = opts;
        this.webContents = { on: noop, send: noop, executeJavaScript: async () => {}, setWindowOpenHandler: noop };
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
        // The launch sequence is driven by the tests, one function at a time — a resolving
        // whenReady would open a window at import time and race every assertion below.
        whenReady: () => new Promise(() => {}),
        isReady: () => true,
        isPackaged: false,
        on: noop,
        quit: noop,
    },
    BrowserWindow: FakeBrowserWindow,
    dialog: { showMessageBoxSync: () => 1, showErrorBox: noop },
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
    if (initialState) writeFile(initialState);
    main.__resetForTest();
}

/** Replaces `fetch` and records every call. `respond` may throw to simulate the network. */
function recordFetch(respond = () => ({ status: 204 })) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
        return respond(calls.length);
    };
    return calls;
}
const realFetch = globalThis.fetch;

test.after(() => {
    globalThis.fetch = realFetch;
});

// ── PART B · the memo ───────────────────────────────────────────────────────────────────────

test('a 2.3.4-era file (only install_url) loads without complaint', () => {
    freshLaunch({ install_url: 'https://app.mo.example/tm30-helper' });
    const calls = recordFetch();

    main.loadInstallPage();
    main.loadReportDetails();

    assert.deepEqual(main.readState(), { install_url: 'https://app.mo.example/tm30-helper' });
    assert.equal(calls.length, 0, 'a 2.3.4 memo names no report address, so nothing is sent');
});

test('a missing file, an empty file and a hand-edited one are all just "we do not know"', () => {
    freshLaunch();
    assert.deepEqual(main.readState(), {}, 'first launch');

    fs.writeFileSync(statePath(), '', 'utf8');
    assert.deepEqual(main.readState(), {}, 'empty file');

    fs.writeFileSync(statePath(), '{ this is not json', 'utf8');
    assert.deepEqual(main.readState(), {}, 'hand-edited into nonsense');

    fs.writeFileSync(statePath(), '["not", "an", "object"]', 'utf8');
    assert.deepEqual(main.readState(), {}, 'valid json of the wrong shape');

    // …and none of it threw, which is the actual assertion: the memo never fails a launch.
    main.loadInstallPage();
    main.loadReportDetails();
});

test('a union write preserves keys this build has never heard of', () => {
    freshLaunch({
        install_url: 'https://app.mo.example/tm30-helper',
        some_future_key: { written_by: '2.9.0' },
    });

    main.rememberReportDetails({ report_url: REPORT_URL, report_token: REPORT_TOKEN });
    const id = main.ensureInstallationId();

    assert.deepEqual(readFile(), {
        install_url: 'https://app.mo.example/tm30-helper',
        some_future_key: { written_by: '2.9.0' },
        report_url: REPORT_URL,
        report_token: REPORT_TOKEN,
        installation_id: id,
    });
});

test('remembering a new install page no longer destroys the reporting details', () => {
    freshLaunch({ report_url: REPORT_URL, report_token: REPORT_TOKEN, installation_id: 'keep-me' });
    main.loadReportDetails();

    main.rememberInstallPage([{ return_url: 'https://staging.mo.example/reservation/x' }]);

    assert.deepEqual(readFile(), {
        report_url: REPORT_URL,
        report_token: REPORT_TOKEN,
        installation_id: 'keep-me',
        install_url: 'https://staging.mo.example/tm30-helper',
    });
});

test('installation_id is generated once and is stable across launches', () => {
    freshLaunch();
    const first = main.ensureInstallationId();
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(main.ensureInstallationId(), first, 'twice in one launch');

    main.__resetForTest(); // a later launch of the same install: same directory, new process
    assert.equal(main.ensureInstallationId(), first, 'and after a restart');
    assert.equal(readFile().installation_id, first);
});

test('a hand-edited report_url that is not http(s) is never restored, and never POSTed to', () => {
    freshLaunch({ report_url: 'file:///etc/passwd', report_token: REPORT_TOKEN });
    const calls = recordFetch();

    main.loadReportDetails();
    return main.reportVersion().then(() => {
        assert.equal(calls.length, 0);
    });
});

// ── PART C · the report ─────────────────────────────────────────────────────────────────────

test('AC-11: a launch with details on disk posts exactly the C-2 body, once', async () => {
    freshLaunch({ report_url: REPORT_URL, report_token: REPORT_TOKEN });
    const calls = recordFetch();

    main.loadReportDetails();
    await main.reportVersion();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, REPORT_URL);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
    assert.ok(calls[0].init.signal instanceof AbortSignal, 'a hard timeout, not an open request');

    // AC-15 — the entire payload. An extra key here is a Tier-1 decision, not a worker's call.
    assert.deepEqual(Object.keys(calls[0].body).sort(), [
        'installation_id',
        'platform',
        'token',
        'version',
    ]);
    assert.equal(calls[0].body.token, REPORT_TOKEN);
    assert.equal(calls[0].body.version, APP_VERSION);
    assert.equal(calls[0].body.platform, process.platform);
    assert.equal(calls[0].body.installation_id, readFile().installation_id);
});

test('behaviour 4: nothing on disk and nothing in the link ⇒ nothing is sent, silently', async () => {
    freshLaunch();
    const calls = recordFetch();

    main.loadReportDetails();
    await main.reportVersion();
    main.handleDeepLink(link(v2())); // an older web deploy: no reporting details on the link
    await main.reportVersion();

    assert.equal(calls.length, 0);
    // The link still taught us the install page, exactly as it does today — and NOTHING else.
    // In particular no installation_id was minted for a Helper that has nobody to tell.
    assert.deepEqual(main.readState(), { install_url: 'https://app.mo.example/tm30-helper' });
});

test('AC-12: a deep link carrying the details persists them AND reports immediately', async () => {
    freshLaunch();
    const calls = recordFetch();

    main.handleDeepLink(link(v2({ report_url: REPORT_URL, report_token: REPORT_TOKEN })));
    await new Promise((r) => setImmediate(r));

    const file = readFile();
    assert.equal(file.report_url, REPORT_URL);
    assert.equal(file.report_token, REPORT_TOKEN);
    assert.equal(calls.length, 1, 'reported at once — this is the bootstrap launch');
    assert.equal(calls[0].body.installation_id, file.installation_id);

    // …and the filing still opened. The report is a passenger, never a gate.
    assert.equal(FakeBrowserWindow.all.at(-1).loaded.file, 'app.html');
});

test('one attempt per launch: the same details are not sent twice', async () => {
    freshLaunch({ report_url: REPORT_URL, report_token: REPORT_TOKEN });
    const calls = recordFetch();

    main.loadReportDetails();
    await main.reportVersion();
    // The whenReady report, then a deep link repeating what we already knew.
    main.handleDeepLink(link(v2({ report_url: REPORT_URL, report_token: REPORT_TOKEN })));
    await main.reportVersion();

    assert.equal(calls.length, 1);
});

test('a link carrying ROTATED details reports again — that is a new fact, not a retry', async () => {
    freshLaunch({ report_url: REPORT_URL, report_token: 'stale.token' });
    const calls = recordFetch((n) => ({ status: n === 1 ? 404 : 204 }));

    main.loadReportDetails();
    await main.reportVersion(); // 404: the secret rotated under us
    main.handleDeepLink(link(v2({ report_url: REPORT_URL, report_token: REPORT_TOKEN })));
    await new Promise((r) => setImmediate(r));

    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.token, REPORT_TOKEN);
    assert.equal(readFile().report_token, REPORT_TOKEN, 'the new token is what survives');
    assert.equal(
        calls[0].body.installation_id,
        calls[1].body.installation_id,
        'a rotated token is still the same installation',
    );
});

test('AC-13: every failure is swallowed, and none of them is retried', async () => {
    const failures = [
        () => {
            throw new TypeError('fetch failed');
        },
        () => {
            const e = new Error('The operation was aborted due to timeout');
            e.name = 'TimeoutError';
            throw e;
        },
        () => ({ status: 500 }),
        () => ({ status: 404 }),
        () => ({ status: 200 }), // a wrong-but-successful answer is still not "stored"
    ];

    for (const respond of failures) {
        freshLaunch({ report_url: REPORT_URL, report_token: REPORT_TOKEN });
        const calls = recordFetch(respond);
        main.loadReportDetails();

        await main.reportVersion(); // must not reject
        await main.reportVersion(); // must not try again

        assert.equal(calls.length, 1, 'exactly one attempt, whatever happened to it');
    }
});

test('AC-11/AC-13: a report that never answers does not delay the window by one tick', () => {
    freshLaunch({ report_url: REPORT_URL, report_token: REPORT_TOKEN });
    let hung = false;
    globalThis.fetch = () => {
        hung = true;
        return new Promise(() => {}); // the endpoint accepts the connection and says nothing
    };
    main.loadReportDetails();

    const before = FakeBrowserWindow.all.length;
    main.handleDeepLink(link(v2({ report_url: REPORT_URL, report_token: REPORT_TOKEN })));

    // No `await` anywhere between: the window exists on the same synchronous turn as the
    // request that will never come back.
    assert.equal(hung, true, 'the report really was in flight');
    assert.equal(FakeBrowserWindow.all.length, before + 1);
    assert.equal(FakeBrowserWindow.all.at(-1).loaded.file, 'app.html');
});

test('the token is never written to the console', async () => {
    freshLaunch({ report_url: REPORT_URL, report_token: REPORT_TOKEN });
    recordFetch();
    main.loadReportDetails();

    const said = [];
    const realLog = console.log;
    const realErr = console.error;
    console.log = (...a) => said.push(a.join(' '));
    console.error = (...a) => said.push(a.join(' '));
    try {
        await main.reportVersion();
        main.handleDeepLink(link(v2({ report_url: REPORT_URL, report_token: REPORT_TOKEN })));
        await new Promise((r) => setImmediate(r));
    } finally {
        console.log = realLog;
        console.error = realErr;
    }

    assert.ok(said.length > 0, 'it does log — silence in the log is not the goal');
    for (const line of said) {
        assert.equal(line.includes(REPORT_TOKEN), false, `token leaked into: ${line}`);
    }
});
