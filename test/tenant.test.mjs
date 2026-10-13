/**
 * TENANT IN THE LINK — `tenant_name` / `tenant_key`, optional on v2, v3 and v4 alike.
 *
 * One Helper build serves every tenant. The tenant's name reaches the Helper only through the
 * link its own web app sends, and is shown in exactly one place: the "Open …" button of the
 * revoked-access banner. With no name the button says "Open web app".
 *
 *  ── PART A · THE PARSE (`deeplink.js`) ──────────────────────────────────────────────────────
 *  The normalisation rule (control chars → space, bidi marks removed, whitespace collapsed,
 *  ≤ 60 code points, empty → absent) on the fixtures of the approved mock, through every
 *  versioned shape. A junk value is never a reason to refuse a link.
 *
 *  ── PART B · THE MEMO AND THE WINDOW (`main.js`) ────────────────────────────────────────────
 *  The pair is written with the pairing, removed by a link that carries none, kept by a 401, and
 *  handed to the queue window as query `tenant` / `tenant_key`.
 *
 *  ── PART C · THE PARTITIONS (`app.html`, `insert-sheet.js`) ─────────────────────────────────
 *  A key prefixes the villa portal partition; no key keeps the pre-tenant name. The insert
 *  handler accepts only the calling window's own prefix.
 *
 * Run: node --test test/tenant.test.mjs
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
const { parseDeepLink, DeepLinkKind, payloadDigest, normalizeTenantName, normalizeTenantKey } =
    require(path.join(repo, 'deeplink.js'));

const API_BASE = 'https://api.coralbay.example';
const TOKEN = '4210.AbCdEfGhIjKlMnOpQrStUv';

const link = (payload) => {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `tm30://open?d=${encoded}&c=${payloadDigest(encoded)}`;
};

const v2 = (extra = {}) => ({
    v: 2,
    worklist: [{ filing_id: 1, villa: 'Sunset', checkin: '2026-10-20', status: 'sheet_ready' }],
    ...extra,
});
const v3 = (extra = {}) => ({
    v: 3,
    api_base: API_BASE,
    web_base: 'https://app.coralbay.example',
    drive_base: 'https://drive.google.com/drive/folders',
    rows: [{ filing_id: 1, booking_id: 9, villa: 'Sunset', checkin: '2026-10-20', status: 'x' }],
    villas: {},
    ...extra,
});
const v4 = (extra = {}) => ({ v: 4, api_base: API_BASE, token: TOKEN, ...extra });

// ────────────────────────────────────────────────────────────────────────────────────────────
// PART A · the parse
// ────────────────────────────────────────────────────────────────────────────────────────────

/** The mock's fixtures (MTU-4.3 §1), with the values its own `normalize()` produces. */
const FIXTURES = [
    ['coral', 'Coral Bay Villas', 'Coral Bay Villas'],
    [
        'long',
        'Coral Bay Villas & Residences Koh Samui — Bophut Hills Guest Management Co., Ltd. (Head Office)',
        'Coral Bay Villas & Residences Koh Samui — Bophut Hills Gues…',
    ],
    ['empty', '', null],
    ['space + controls + bidi', '   \u0007\t‮  ', null],
    ['absent', undefined, null],
];

for (const [label, raw, expected] of FIXTURES) {
    test(`normalizeTenantName — mock fixture "${label}"`, () => {
        assert.equal(normalizeTenantName(raw), expected);
    });
}

test('normalizeTenantName — controls become spaces, bidi marks vanish, runs collapse', () => {
    assert.equal(normalizeTenantName('  Coral\u0000\nBay‎ ⁦Villas⁩\u007F '), 'Coral Bay Villas');
    assert.equal(normalizeTenantName('‫HOST‬'), 'HOST');
});

test('normalizeTenantName — not a string is "no name", never an exception', () => {
    for (const junk of [null, 42, true, {}, ['Coral'], () => 'x']) {
        assert.equal(normalizeTenantName(junk), null);
    }
});

test('normalizeTenantName — the limit counts CODE POINTS, so an astral name is not split', () => {
    const sixty = '🌴'.repeat(60);
    assert.equal(normalizeTenantName(sixty), sixty, 'exactly 60 code points stays whole');
    const out = normalizeTenantName('🌴'.repeat(61));
    assert.equal(Array.from(out).length, 60);
    assert.ok(out.endsWith('🌴…'), 'cut on a code-point boundary, then the ellipsis');
});

test('normalizeTenantName — markup is kept as TEXT (the window writes it with textContent)', () => {
    assert.equal(normalizeTenantName('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
});

test('normalizeTenantKey — only [A-Za-z0-9_-]{1,32}; anything else is "no key"', () => {
    assert.equal(normalizeTenantKey('CORAL'), 'CORAL');
    assert.equal(normalizeTenantKey('host_2-b'), 'host_2-b');
    assert.equal(normalizeTenantKey('A'.repeat(32)), 'A'.repeat(32));
    for (const bad of ['', 'A'.repeat(33), '../etc', 'a b', 'a/b', 'ключ', ' CORAL', null, 7]) {
        assert.equal(normalizeTenantKey(bad), null, JSON.stringify(bad));
    }
});

for (const [shape, build] of [['v2', v2], ['v3', v3], ['v4', v4]]) {
    test(`${shape}: tenant_name and tenant_key are parsed and normalised`, () => {
        const r = parseDeepLink(
            link(build({ tenant_name: '  Coral‮ Bay  Villas ', tenant_key: 'CORAL' }))
        );
        assert.notEqual(r.kind, DeepLinkKind.ERROR, r.reason);
        assert.equal(r.tenant_name, 'Coral Bay Villas');
        assert.equal(r.tenant_key, 'CORAL');
    });

    test(`${shape}: absent or junk tenant fields leave the keys OFF and never fail the link`, () => {
        const plain = parseDeepLink(link(build()));
        assert.notEqual(plain.kind, DeepLinkKind.ERROR);
        assert.equal('tenant_name' in plain, false);
        assert.equal('tenant_key' in plain, false);

        const junk = parseDeepLink(link(build({ tenant_name: 12, tenant_key: '../x' })));
        assert.equal(junk.kind, plain.kind, 'junk tenant fields do not change the outcome');
        assert.equal('tenant_name' in junk, false);
        assert.equal('tenant_key' in junk, false);

        const blank = parseDeepLink(link(build({ tenant_name: ' ‏ ' })));
        assert.equal('tenant_name' in blank, false, 'empty after normalisation ⇒ absent');
    });
}

test('v1 account links are untouched by the tenant keys', () => {
    const r = parseDeepLink(link({ name: 'Sunset', login: 'u', pass: 'p', tenant_name: 'Coral' }));
    assert.equal(r.kind, DeepLinkKind.V1);
    assert.equal('tenant_name' in r, false);
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// PART B · the memo and the window — the real main.js, electron stubbed at the module loader
// ────────────────────────────────────────────────────────────────────────────────────────────

let userData = '';
const noop = () => {};
const handlers = new Map();
let nextWcId = 1;

class FakeBrowserWindow {
    static all = [];
    constructor(opts) {
        this.opts = opts;
        this.webContents = {
            id: nextWcId++,
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

const electronStub = {
    app: {
        requestSingleInstanceLock: () => true,
        setAsDefaultProtocolClient: () => true,
        getPath: () => userData,
        getVersion: () => '2.5.0',
        whenReady: () => new Promise(() => {}),
        isReady: () => true,
        isPackaged: false,
        on: noop,
        quit: noop,
    },
    BrowserWindow: FakeBrowserWindow,
    dialog: { showMessageBoxSync: () => 1, showErrorBox: noop },
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: noop },
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

const realFetch = globalThis.fetch;
function freshLaunch(initialState) {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tm30-tenant-'));
    FakeBrowserWindow.all.length = 0;
    if (initialState) writeFile(initialState);
    main.__resetForTest();
    main.loadInstallPage();
    main.loadReportDetails();
    // Nothing here may reach a network: the report and any fetch answer 204 locally.
    globalThis.fetch = async () => ({ status: 204, ok: true, json: async () => ({}) });
}
test.after(() => {
    globalThis.fetch = realFetch;
});

const lastQuery = () => FakeBrowserWindow.all.at(-1).loaded.opts.query;

test('memo: a v4 link with a tenant writes name and key beside api_base and the token', () => {
    freshLaunch({ install_url: 'https://app.coralbay.example/tm30-helper' });

    main.handleDeepLink(link(v4({ tenant_key: 'CORAL', tenant_name: 'Coral Bay Villas' })));

    const state = readFile();
    assert.equal(state.api_base, API_BASE);
    assert.equal(state.report_token, TOKEN);
    assert.equal(state.tenant_key, 'CORAL');
    assert.equal(state.tenant_name, 'Coral Bay Villas');
    assert.equal(lastQuery().tenant, 'Coral Bay Villas');
    assert.equal(lastQuery().tenant_key, 'CORAL');
});

test('memo: the next link WITHOUT tenant fields removes both (no stale name on another tenant)', () => {
    freshLaunch({ api_base: API_BASE, report_token: TOKEN, tenant_key: 'CORAL', tenant_name: 'Coral Bay Villas' });

    main.handleDeepLink(link(v4({ api_base: 'https://api.mo.example', token: 'other' })));

    const state = readFile();
    assert.equal(state.api_base, 'https://api.mo.example');
    assert.equal('tenant_key' in state, false);
    assert.equal('tenant_name' in state, false);
    assert.equal(lastQuery().tenant, undefined, 'the window says "Open web app"');
    assert.equal(lastQuery().tenant_key, undefined, 'pre-tenant partitions');
});

test('memo: a v2 link carries the tenant too', () => {
    freshLaunch();
    main.handleDeepLink(link(v2({ tenant_name: 'HOST', tenant_key: 'HOST' })));
    assert.equal(readFile().tenant_name, 'HOST');
    assert.equal(lastQuery().tenant, 'HOST');
});

test('memo: a 401 discards the token only — the name and install page stay for the button', () => {
    freshLaunch({
        api_base: API_BASE,
        report_token: TOKEN,
        install_url: 'https://app.coralbay.example/tm30-helper',
        tenant_key: 'CORAL',
        tenant_name: 'Coral Bay Villas',
    });

    main.discardReportToken();

    const state = readFile();
    assert.equal('report_token' in state, false);
    assert.equal(state.tenant_name, 'Coral Bay Villas');
    assert.equal(state.install_url, 'https://app.coralbay.example/tm30-helper');
});

test('Dock launch: a paired Helper opens the queue window with the remembered tenant', () => {
    freshLaunch({ api_base: API_BASE, report_token: TOKEN, tenant_key: 'CORAL', tenant_name: 'Coral Bay Villas' });

    main.openLaunchWindow();

    assert.equal(FakeBrowserWindow.all[0].loaded.file, 'app.html');
    assert.equal(lastQuery().tenant, 'Coral Bay Villas');
    assert.equal(lastQuery().tenant_key, 'CORAL');
});

test('Dock launch: a hand-edited memo is re-normalised on the way out', () => {
    freshLaunch({
        api_base: API_BASE,
        report_token: TOKEN,
        tenant_key: '../../evil',
        tenant_name: '‮' + 'x'.repeat(80),
    });

    main.openLaunchWindow();

    assert.equal(lastQuery().tenant_key, undefined, 'a bad key is no key');
    assert.equal(Array.from(lastQuery().tenant).length, 60);
    assert.ok(!lastQuery().tenant.includes('‮'));
});

test('R5: no link and no memo — the standalone window, and not a single request', () => {
    freshLaunch();
    const calls = [];
    globalThis.fetch = async (url) => {
        calls.push(url);
        return { status: 204 };
    };

    main.reportVersion();
    main.openLaunchWindow();

    assert.equal(FakeBrowserWindow.all[0].loaded.file, 'index.html');
    assert.deepEqual(calls, []);
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// PART C · the partitions
// ────────────────────────────────────────────────────────────────────────────────────────────

const appSrc = fs.readFileSync(path.join(repo, 'app.html'), 'utf8');

function lift(name) {
    const start = appSrc.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `app.html no longer declares ${name}()`);
    let depth = 0;
    for (let i = appSrc.indexOf('{', start); i < appSrc.length; i += 1) {
        if (appSrc[i] === '{') depth += 1;
        else if (appSrc[i] === '}' && --depth === 0) return appSrc.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces lifting ${name}`);
}

const partitionFor = (key) =>
    new Function('TENANT_KEY', `${lift('partitionFor')}; return partitionFor;`)(key);

test('app.html: no key ⇒ the pre-tenant partition, byte for byte (existing logins survive)', () => {
    assert.equal(partitionFor(null)('Sunset Villa'), 'persist:tm30-v-Sunset%20Villa');
});

test('app.html: a key prefixes the partition, so one villa name under two tenants never shares a jar', () => {
    assert.equal(partitionFor('CORAL')('Sunset'), 'persist:tm30-CORAL-v-Sunset');
    assert.notEqual(partitionFor('CORAL')('Sunset'), partitionFor('HOST')('Sunset'));
});

test('app.html: the tenant name is never handed to innerHTML / insertAdjacentHTML', () => {
    for (const line of appSrc.split('\n')) {
        if (/innerHTML|insertAdjacentHTML|outerHTML/.test(line)) {
            assert.ok(!/tenant/i.test(line), `markup sink near a tenant value: ${line.trim()}`);
        }
    }
});

test('insert-sheet: a keyed window may only insert into ITS OWN partition prefix', async () => {
    freshLaunch({ api_base: API_BASE, report_token: TOKEN, tenant_key: 'CORAL', tenant_name: 'Coral' });
    main.openLaunchWindow();
    const sender = FakeBrowserWindow.all[0].webContents;
    const insert = handlers.get('tm30:insert-sheet');
    const req = (partition) => ({ filing_id: 1, url: 'https://api.coralbay.example/s', partition });

    const legacy = await insert({ sender }, req('persist:tm30-v-Sunset'));
    assert.equal(legacy.stage, 'request', 'the unkeyed jar is not this window\'s');
    const other = await insert({ sender }, req('persist:tm30-HOST-v-Sunset'));
    assert.equal(other.stage, 'request', 'another tenant\'s jar is refused');
    const own = await insert({ sender }, req('persist:tm30-CORAL-v-Sunset'));
    assert.equal(own.stage, 'target', 'passes the guard; fails only because no pane is open here');
});

test('insert-sheet: a keyless window keeps the pre-tenant guard', async () => {
    freshLaunch({ api_base: API_BASE, report_token: TOKEN });
    main.openLaunchWindow();
    const sender = FakeBrowserWindow.all[0].webContents;
    const insert = handlers.get('tm30:insert-sheet');
    const r = await insert({ sender }, { filing_id: 1, url: 'https://a.example/s', partition: 'persist:tm30-v-Sunset' });
    assert.equal(r.stage, 'target');
});
