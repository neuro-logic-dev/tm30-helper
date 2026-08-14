/**
 * Q-5 — THE FETCHED QUEUE WINDOW: its states, its copy, and where a launch goes.
 *
 * Three things are under test, and they fail for three different reasons:
 *
 *  ── PART A · THE COPY (`app.html`, pure functions lifted by name) ───────────────────────────
 *  The window gained five states it never had to draw, and the whole point of AC-3 is that two
 *  of them must never be confused: "no tasks" is a claim about the operator's work, and a fetch
 *  that failed has made no such claim. The functions that produce that copy are pure and are
 *  lifted out of the inline script BY NAME — deliberately brittle, exactly as
 *  `worklist-render.test.mjs` explains: rename one and this fails loudly rather than silently
 *  covering nothing.
 *
 *  ── PART B · THE ERROR-KIND MIRROR ──────────────────────────────────────────────────────────
 *  The renderer cannot `require` a CommonJS module (contextIsolation + a sandboxed preload), so
 *  `app.html` carries a copy of `queue-client.js`'s `ErrorKind`. A copy of a contract is drift
 *  waiting to happen, so it is PINNED here against the original. A typo in `'unauthorised'`
 *  fails this test instead of silently losing AC-4's re-pair message.
 *
 *  ── PART C · THE ROUTING AND THE HANDLERS (`main.js`, electron stubbed) ─────────────────────
 *  ADR-0022's one branch — a launch with no payload opens the QUEUE when the machine is paired
 *  and the standalone portal window when it is not — plus the three IPC verbs, driven through
 *  the REAL `main.js` and the REAL `queue-client.js` with only `fetch` replaced. AC-4's discard
 *  is asserted against the file on disk, because a token that survives in the memo is a token
 *  that comes back on the next launch.
 *
 * Run: node --test test/queue-window.test.mjs
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
const src = fs.readFileSync(path.join(repo, 'app.html'), 'utf8');

/**
 * The file with its commentary removed.
 *
 * 🔴 Needed because the "is it gone?" assertions below are about CODE, and this codebase
 * deliberately keeps long comments naming what it deleted and why — ADR-0023 requires exactly
 * that ("a superseded rule left in the code reads as current"). Grepping the raw text would make
 * the documentation of a removal look like the removal never happened, and the only way to pass
 * would be to delete the explanation.
 */
const codeOnly = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/.*$/gm, '');

// ────────────────────────────────────────────────────────────────────────────────────────────
// PART A · the copy — pure functions lifted out of app.html
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Lift one `function name(...) { ... }` out of the inline script, braces balanced. */
function lift(name) {
    const start = src.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `app.html no longer declares ${name}() — update this test`);
    let depth = 0;
    let i = src.indexOf('{', start);
    for (; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
            depth -= 1;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error(`unbalanced braces lifting ${name}`);
}

/** The state-copy functions, evaluated on their own — none of them closes over anything. */
const copy = new Function(`
    ${lift('relativeAge')}
    ${lift('freshnessText')}
    ${lift('queueNotice')}
    ${lift('queuePlaceholder')}
    ${lift('windowTitle')}
    return { relativeAge, freshnessText, queueNotice, queuePlaceholder, windowTitle };
`)();

const queue = (over = {}) => ({
    paired: true,
    phase: 'ready',
    fetchedAt: null,
    error: null,
    inFlight: false,
    ...over,
});

// ── state 1 · live queue ────────────────────────────────────────────────────────────────────

test('state 1 — the head strip dates the queue: wall clock AND relative age', () => {
    const at = new Date(2026, 7, 14, 12, 4, 0).getTime();
    const line = copy.freshnessText(queue({ phase: 'ready', fetchedAt: at }), at + 3_000);

    assert.equal(line, 'refreshed 12:04 · just now');
    assert.match(line, /^refreshed \d\d:\d\d · /, 'the artifact\'s shape, not a bare timestamp');
});

test('relative age reads the way the artifact draws it, at every scale', () => {
    assert.equal(copy.relativeAge(0), 'just now');
    assert.equal(copy.relativeAge(9_000), 'just now');
    assert.equal(copy.relativeAge(30_000), 'a moment ago');
    assert.equal(copy.relativeAge(2 * 60_000), '2 min ago');
    assert.equal(copy.relativeAge(24 * 60_000), '24 min ago');
    assert.equal(copy.relativeAge(3 * 3600_000), '3 h ago');
    // A clock that went backwards must not produce "-4 min ago".
    assert.equal(copy.relativeAge(-5_000), 'just now');
});

test('a window that has never fetched dates nothing — it does not invent a timestamp', () => {
    // The old-style launch: rows came in the link, no fetch has ever happened, and the line hides.
    assert.equal(copy.freshnessText(queue({ paired: false, fetchedAt: null }), Date.now()), '');
});

// ── state 4 vs state 6 · the distinction AC-3 is about ──────────────────────────────────────

test('🔴 AC-3 — a failed fetch and an empty queue share NOT ONE LINE of text', () => {
    const failed = copy.queuePlaceholder(queue({ phase: 'failed', fetchedAt: 1 }), 0);
    const empty = copy.queuePlaceholder(queue({ phase: 'ready', fetchedAt: 1 }), 0);
    const banner = copy.queueNotice(queue({ phase: 'failed' }));

    const failedText = [failed.heading, failed.body, banner.title, banner.body].join(' ');
    const emptyText = [empty.badge, empty.heading, empty.body].filter(Boolean).join(' ');

    // Every sentence in one, absent from the other. Not a substring check on the whole blob:
    // these must be different STATEMENTS, not different arrangements of the same words.
    for (const line of [failed.heading, failed.body, banner.title, banner.body]) {
        assert.equal(emptyText.includes(line), false, `state 6 must not say: ${line}`);
    }
    for (const line of [empty.badge, empty.body]) {
        assert.equal(failedText.includes(line), false, `state 4 must not say: ${line}`);
    }
    // And the one word that would undo all of it.
    assert.equal(/no tasks|nothing waiting|all clear/i.test(failedText), false);
});

test('state 4 — the banner is loud, names the cause, and offers exactly one action', () => {
    const n = copy.queueNotice(queue({ phase: 'failed' }));
    assert.equal(n.tone, 'err');
    assert.equal(n.title, 'Could not load the queue');
    assert.equal(n.body, 'No answer from the server. Check the connection and try again.');
    assert.equal(n.action, 'Retry');
});

test('state 4 — the list says it is a GAP, never a verdict on the operator', () => {
    const p = copy.queuePlaceholder(queue({ phase: 'failed', fetchedAt: 1 }), 0);
    assert.equal(p.heading, 'Nothing to show yet');
    assert.match(p.body, /it is a gap\.$/);
    assert.equal(p.badge, undefined, 'no "all clear" badge on a failure');
});

test('state 4 — the freshness line changes its VERB, because it no longer means "refreshed"', () => {
    const at = new Date(2026, 7, 14, 11, 40, 0).getTime();
    assert.equal(
        copy.freshnessText(queue({ phase: 'failed', fetchedAt: at }), at + 24 * 60_000),
        'last loaded 11:40 · 24 min ago'
    );
});

// ── state 5 · access revoked ────────────────────────────────────────────────────────────────

test('state 5 — amber not red, the true cause, and the one action that fixes it', () => {
    const n = copy.queueNotice(queue({ phase: 'revoked' }));
    assert.equal(n.tone, 'warn', 'nothing is broken — access ended');
    assert.equal(n.title, 'Access to the queue has ended');
    assert.equal(n.body, 'Open the Helper once from MO to reconnect this computer.');
    assert.equal(n.action, 'Open MO');
});

test('state 5 — says the key was discarded, and that the portal is untouched', () => {
    const p = copy.queuePlaceholder(queue({ phase: 'revoked' }), 0);
    assert.equal(p.heading, 'Queue disconnected');
    assert.match(p.body, /saved key was discarded/);
    assert.match(p.body, /portal below are untouched/);
    assert.equal(copy.freshnessText(queue({ phase: 'revoked', fetchedAt: 1 }), 2), 'not connected');
});

// ── state 6 · nothing due ───────────────────────────────────────────────────────────────────

test('state 6 — the good state reads as one, and says what will fill it', () => {
    const p = copy.queuePlaceholder(queue({ phase: 'ready', fetchedAt: 1 }), 0);
    assert.equal(p.badge, 'all clear');
    assert.equal(
        p.body,
        'Nothing waiting to be filed. New arrivals appear here once their sheet is ready.'
    );
    assert.equal(p.heading, undefined);
});

test('🔴 only a READY phase may present an empty list as "nothing due"', () => {
    // The whole of AC-3 in one loop: every other phase that can show an empty list must not.
    for (const phase of ['idle', 'loading', 'failed', 'revoked']) {
        const p = copy.queuePlaceholder(queue({ phase }), 0);
        assert.notEqual(p.badge, 'all clear', `${phase} must not claim the queue is clear`);
    }
    assert.equal(copy.queuePlaceholder(queue({ phase: 'ready' }), 0).badge, 'all clear');
});

test('with rows on screen there is no placeholder at all', () => {
    for (const phase of ['ready', 'failed', 'revoked', 'loading']) {
        assert.equal(copy.queuePlaceholder(queue({ phase }), 6), null);
    }
});

// ── the window title ────────────────────────────────────────────────────────────────────────

test('the title counts tasks, and says nothing when it does not know', () => {
    assert.equal(copy.windowTitle(queue({ phase: 'ready' }), 12), 'TM30 Helper — 12 tasks');
    assert.equal(copy.windowTitle(queue({ phase: 'ready' }), 1), 'TM30 Helper — 1 task');
    assert.equal(copy.windowTitle(queue({ phase: 'ready' }), 0), 'TM30 Helper — no tasks');
    assert.equal(copy.windowTitle(queue({ phase: 'failed' }), 0), 'TM30 Helper');
    assert.equal(copy.windowTitle(queue({ phase: 'revoked' }), 0), 'TM30 Helper');
});

// ── the structural promises AC-5 makes ──────────────────────────────────────────────────────

test('🔴 AC-5 — no polling. Nothing in this window puts the queue on a timer.', () => {
    /*
      `setInterval` DOES appear in app.html — T3-11's auto-insert watcher polls the portal page
      for an upload form, which is a different thing on a different subject and predates this
      task. What must not exist is a timer that touches the queue, so this asserts on the SUBJECT
      rather than on the word: no scheduled call may reach the fetch.
    */
    const timers = [...src.matchAll(/set(?:Interval|Timeout)\s*\(([\s\S]{0,240}?)\)\s*;/g)];
    for (const [, body] of timers) {
        assert.equal(
            /refreshQueue|fetchWorklist|markSubmitted/.test(body),
            false,
            `a timer reaches the queue — AC-5 allows four triggers and no clock:\n${body}`
        );
    }
    assert.match(src, /window\.addEventListener\('focus', function \(\) \{ refreshQueue/);
});

test('🔴 the renderer has no fetch of its own — the request is made by main', () => {
    // 014 §2.5 is superseded for the APP, not for this document: the renderer still cannot reach
    // the network, and everything it learns arrives through a named preload verb.
    assert.equal(/\b(fetch|XMLHttpRequest)\s*\(/.test(codeOnly(src)), false);
    assert.match(src, /window\.tm30Native\.fetchWorklist\(\)/);
    assert.match(src, /window\.tm30Native\.markSubmitted\(row\.filing_id, \{\}\)/);
});

test('🔴 ADR-0023 — the optimistic local "submitted" machinery is gone from the pane', () => {
    // Its return would mean a row can look finished while the server still says `sheet_ready`,
    // which is the defect this whole feature was opened on (0 of 13 filings ever transitioned).
    const code = codeOnly(src);
    assert.equal(/local\.submitted/.test(code), false, '`local.submitted` is retired');
    assert.equal(/Reopen confirm/.test(code), false, 'and so is the control it produced');
    // The removal must stay EXPLAINED, or the next reader restores it as an obvious improvement.
    assert.match(src, /ADR-0023/, 'the superseded ruling is cited where it was superseded');
    // The hand-back itself SURVIVES — ADR-0023 keeps it for rows with no token path.
    assert.match(src, /tm30Native\.openExternal\(row\.return_url\)/);
});

test('the preload exposes the three queue verbs, and never the token', () => {
    const preload = fs.readFileSync(path.join(repo, 'preload.js'), 'utf8');
    assert.match(preload, /fetchWorklist: \(\) => ipcRenderer\.invoke\('tm30:fetch-worklist'\)/);
    assert.match(preload, /markSubmitted: \(filingId, opts\) =>/);
    assert.match(preload, /getQueueStatus: \(\) => ipcRenderer\.invoke\('tm30:queue-status'\)/);
    // Fields picked explicitly — the caller's object never crosses as itself.
    assert.match(preload, /filing_id: filingId/);
    /*
      🔴 No verb may CARRY a token. Asserted on code rather than on prose: the docblocks talk
      about the token at length, and should — the reason it stays in main is the most important
      thing about this file. What must not exist is a token-shaped identifier in the bridge's own
      expressions, which is what an accidental `token: …` field or a `getToken` verb would look
      like.
    */
    assert.equal(/token/i.test(codeOnly(preload)), false, 'no verb may name a token — main holds it');
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// PART B · the ErrorKind mirror
// ────────────────────────────────────────────────────────────────────────────────────────────

test('🔴 app.html\'s QUEUE_ERROR is queue-client\'s ErrorKind, exactly', () => {
    const { ErrorKind } = require(path.join(repo, 'queue-client.js'));
    const start = src.indexOf('var QUEUE_ERROR = {');
    assert.notEqual(start, -1, 'app.html no longer declares QUEUE_ERROR — update this test');
    const mirrored = new Function(`${src.slice(start, src.indexOf('};', start) + 2)}
        return QUEUE_ERROR;`)();

    assert.deepEqual(mirrored, ErrorKind, 'the renderer switches on a copy — it must not drift');
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// PART C · the routing and the handlers — the real main.js, electron stubbed
// ────────────────────────────────────────────────────────────────────────────────────────────

const API_BASE = 'https://api.mo.example';
const TOKEN = '4210.AbCdEfGhIjKlMnOpQrStUv';
/** Above every v4 floor, so the version gate is not what this file is measuring. */
const APP_VERSION = '2.5.0';

let userData = '';
const noop = () => {};
const errorBoxes = [];
const opened = [];
/** Every `ipcMain.handle` registration, so a test can invoke the production handler. */
const handlers = new Map();

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
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on: noop },
    session: { fromPartition: () => ({ clearStorageData: async () => {} }) },
    shell: { openExternal: async (u) => opened.push(u) },
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

function freshLaunch(initialState) {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tm30-queuewin-'));
    errorBoxes.length = 0;
    opened.length = 0;
    FakeBrowserWindow.all.length = 0;
    if (initialState) fs.writeFileSync(statePath(), JSON.stringify(initialState) + '\n', 'utf8');
    main.__resetForTest();
    main.loadReportDetails();
    main.loadInstallPage();
}

const realFetch = globalThis.fetch;
test.after(() => {
    globalThis.fetch = realFetch;
});

/** One canned HTTP answer, plus a record of what was asked. */
function answerWith({ status, body }) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url, method: init.method, headers: init.headers, body: init.body });
        return { status, json: async () => body };
    };
    return calls;
}

const PAIRED = { report_token: TOKEN, api_base: API_BASE };

// ── ADR-0022 · where a payload-less launch goes ─────────────────────────────────────────────

test('🔴 AC-1 — a Dock launch on a PAIRED machine opens the queue window, in fetch mode', () => {
    freshLaunch(PAIRED);

    main.openLaunchWindow();

    assert.equal(FakeBrowserWindow.all.length, 1);
    const win = FakeBrowserWindow.all[0];
    assert.equal(win.loaded.file, 'app.html', 'the QUEUE window, not the portal card');
    assert.ok(win.opts.webPreferences.preload, 'and it has its preload — the queue needs the seam');
    // Boots empty: there are no rows to hand it, which is the whole of ADR-0021.
    const payload = JSON.parse(
        Buffer.from(win.loaded.opts.query.d, 'base64url').toString('utf8')
    );
    assert.deepEqual(payload.worklist, []);
});

test('🔴 AC-2 — an UNPAIRED Dock launch keeps today\'s standalone window, preload and all', () => {
    freshLaunch(); // nothing on disk: never opened from the web app

    main.openLaunchWindow();

    assert.equal(FakeBrowserWindow.all.length, 1);
    const win = FakeBrowserWindow.all[0];
    assert.equal(win.loaded.file, 'index.html');
    // 013 §3.5 — the standalone window is granted NO channel to main, then or now.
    assert.equal(win.opts.webPreferences && win.opts.webPreferences.preload, undefined);
});

test('a token with no address is NOT paired — there is nowhere to fetch from', () => {
    freshLaunch({ report_token: TOKEN });
    assert.equal(main.isPaired(), false);
    main.openLaunchWindow();
    assert.equal(FakeBrowserWindow.all[0].loaded.file, 'index.html');
});

test('an address with no token is NOT paired either', () => {
    freshLaunch({ api_base: API_BASE });
    assert.equal(main.isPaired(), false);
    main.openLaunchWindow();
    assert.equal(FakeBrowserWindow.all[0].loaded.file, 'index.html');
});

test('AC-2 — the standalone window says what pairing is and how it happens', () => {
    const standalone = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
    assert.match(standalone, /This computer is not connected to MO yet/);
    assert.match(standalone, /Upcoming Reservations → TM30/);
    assert.match(standalone, /Your queue then appears here on every launch\./);
});

test('the queue window is told where MO lives, so state 5 has somewhere to send the operator', () => {
    freshLaunch({ ...PAIRED, install_url: 'https://app.mo.example/tm30-helper' });

    main.openLaunchWindow();

    assert.equal(
        FakeBrowserWindow.all[0].loaded.opts.query.install,
        'https://app.mo.example/tm30-helper'
    );
});

test('a v4 pointer opens the queue window and carries its focus into it', () => {
    freshLaunch();
    answerWith({ status: 204, body: null });
    const payload = Buffer.from(
        JSON.stringify({ v: 4, api_base: API_BASE, token: TOKEN, focus_filing_id: 3568 }),
        'utf8'
    ).toString('base64url');
    const { payloadDigest } = require(path.join(repo, 'deeplink.js'));

    main.handleDeepLink(`tm30://open?d=${payload}&c=${payloadDigest(payload)}`);

    assert.deepEqual(errorBoxes, [], 'a pointer is a valid link');
    assert.equal(FakeBrowserWindow.all.length, 1);
    const win = FakeBrowserWindow.all[0];
    assert.equal(win.loaded.file, 'app.html');
    const boot = JSON.parse(Buffer.from(win.loaded.opts.query.d, 'base64url').toString('utf8'));
    assert.deepEqual(boot.worklist, [], 'no rows in a pointer — the window fetches them');
    assert.equal(boot.focus_filing_id, 3568, 'resolved later, against the fetched queue');
});

// ── the three verbs ─────────────────────────────────────────────────────────────────────────

test('getQueueStatus answers `paired` — and never the token', async () => {
    freshLaunch(PAIRED);
    const status = await handlers.get('tm30:queue-status')();

    assert.deepEqual(status, { paired: true, apiBase: API_BASE });
    assert.equal(JSON.stringify(status).includes(TOKEN), false, '🔴 the token never crosses');
});

test('AC-1 — fetchWorklist presents the token as a Bearer and hands the body back untouched', async () => {
    freshLaunch(PAIRED);
    const body = { items: [{ filing_id: 1, villa: 'V', unknown_future_key: 7 }], total_due: 1 };
    const calls = answerWith({ status: 200, body });

    const res = await handlers.get('tm30:fetch-worklist')();

    assert.deepEqual(res, { ok: true, worklist: body });
    assert.equal(res.worklist.items[0].unknown_future_key, 7, 'AC-16: inert, not dropped');
    assert.match(calls[0].url, /^https:\/\/api\.mo\.example\/tm30\/helper\/worklist\?/);
    assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    // 🔴 The focus is NOT a booking filter: narrowing the queue to one booking would hide the
    // operator's other work. The highlight is resolved renderer-side against the full queue.
    assert.equal(/booking_id/.test(calls[0].url), false);
});

test('AC-3 — a 5xx comes back as a KIND, never as an empty queue', async () => {
    freshLaunch(PAIRED);
    answerWith({ status: 503, body: {} });

    const res = await handlers.get('tm30:fetch-worklist')();

    assert.equal(res.ok, false);
    assert.equal(res.kind, 'server');
    assert.equal('worklist' in res, false, 'nothing empty was fabricated');
    assert.equal(readFile().report_token, TOKEN, 'a 5xx is not a revocation — the token stays');
});

test('🔴 AC-4 — a 401 discards the stored token, from memory AND from disk', async () => {
    freshLaunch(PAIRED);
    answerWith({ status: 401, body: { message: 'nope' } });

    const res = await handlers.get('tm30:fetch-worklist')();

    assert.equal(res.kind, 'unauthorized');
    assert.equal(main.isPaired(), false, 'the Helper stops being paired at once');
    assert.equal('report_token' in readFile(), false, '🔴 the key is GONE, not blanked');
    assert.equal(readFile().api_base, API_BASE, 'the address is not a secret and survives');
    // And the next launch really is unpaired — this is the half a memory-only drop would miss.
    main.__resetForTest();
    main.loadReportDetails();
    assert.equal(main.isPaired(), false);
});

test('🔴 Q-3\'s trap — a MISSING token is `refused`/0, and must not be read as a revocation', async () => {
    freshLaunch({ api_base: API_BASE }); // an address, no token: never paired, nothing to discard
    answerWith({ status: 200, body: { items: [] } });

    const res = await handlers.get('tm30:fetch-worklist')();

    assert.equal(res.kind, 'refused');
    assert.equal(res.status, 0, 'no HTTP request was ever made');
    assert.equal(readFile().api_base, API_BASE, 'nothing was discarded — there was nothing to');
});

test('AC-11 — markSubmitted POSTs to the filing, with no user_id anywhere in it', async () => {
    freshLaunch(PAIRED);
    const calls = answerWith({ status: 200, body: { filing_id: 3568, status: 'submitted' } });

    const res = await handlers.get('tm30:mark-submitted')({}, { filing_id: 3568 });

    assert.deepEqual(res, { ok: true, filing: { filing_id: 3568, status: 'submitted' } });
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, `${API_BASE}/tm30/helper/filings/3568/submitted`);
    assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    // ADR-0023: the actor is the token's operator, resolved server-side. Claiming one is not
    // merely ignored — it is never sent.
    assert.equal(/user_id/.test(calls[0].body), false);
});

test('a receipt number rides along when there is one, and is absent when there is not', async () => {
    freshLaunch(PAIRED);
    let calls = answerWith({ status: 200, body: {} });
    await handlers.get('tm30:mark-submitted')({}, { filing_id: 1, receipt_no: 'TM30-99' });
    assert.deepEqual(JSON.parse(calls[0].body), { receipt_no: 'TM30-99' });

    calls = answerWith({ status: 200, body: {} });
    await handlers.get('tm30:mark-submitted')({}, { filing_id: 1 });
    assert.deepEqual(JSON.parse(calls[0].body), {}, 'omitted, not sent as null');
});

test('🔴 AC-11a — a refusal returns the SERVER\'S words, for the row to show verbatim', async () => {
    freshLaunch(PAIRED);
    answerWith({
        status: 400,
        body: { message: 'Cannot mark submitted: filing is submitted, not sheet_ready.' },
    });

    const res = await handlers.get('tm30:mark-submitted')({}, { filing_id: 3568 });

    assert.equal(res.ok, false);
    assert.equal(res.kind, 'refused');
    assert.equal(res.message, 'Cannot mark submitted: filing is submitted, not sheet_ready.');
    assert.equal(readFile().report_token, TOKEN, 'a refusal is not a revocation');
});

test('a 401 on the SUBMIT route discards the token too — it is the same key', async () => {
    freshLaunch(PAIRED);
    answerWith({ status: 403, body: {} });

    const res = await handlers.get('tm30:mark-submitted')({}, { filing_id: 3568 });

    assert.equal(res.kind, 'unauthorized');
    assert.equal('report_token' in readFile(), false);
});
