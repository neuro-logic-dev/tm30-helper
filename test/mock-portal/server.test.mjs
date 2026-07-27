'use strict';

/**
 * T3-07 — integration tests for the mock portal server (`server.mjs`): login flow, session-cookie
 * gating, and the upload → validate → receipt/rejection round trip, over real HTTP.
 *
 * No Electron here — plain node http + fetch. The Helper-facing half (webview + shipped
 * autofill against these very pages) is the manual e2e in the README.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createMockPortal } from './server.mjs';
import { buildSheetBuffer, GOLDEN_ROWS } from './build-sheet.mjs';

let server;
let base;

before(async () => {
    server = createMockPortal({ user: null, pass: null }); // any non-empty pair
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = (path, headers = {}) => fetch(base + path, { redirect: 'manual', headers });

async function login({ user = 'op@tm30', pass = 'pw', token = 'MOCK.token.ok' } = {}) {
    const body = new URLSearchParams({ user, pass, 'cf-turnstile-response': token });
    return fetch(base + '/login', { method: 'POST', body, redirect: 'manual' });
}

function sidOf(res) {
    const m = /tm30mock_sid=([a-f0-9]+)/.exec(res.headers.get('set-cookie') || '');
    return m ? `tm30mock_sid=${m[1]}` : null;
}

async function upload(cookie, buffer, filename) {
    const fd = new FormData();
    fd.append('sheet', new Blob([buffer]), filename);
    return fetch(base + '/notify', {
        method: 'POST',
        body: fd,
        redirect: 'manual',
        headers: cookie ? { cookie } : {}
    });
}

test('GET / and GET /notify without a session redirect to /login', async () => {
    for (const path of ['/', '/notify']) {
        const res = await get(path);
        assert.equal(res.status, 302, path);
        assert.equal(res.headers.get('location'), '/login', path);
    }
});

test('GET /login serves the autofill targets: #user, #pass, empty cf-turnstile-response', async () => {
    const res = await get('/login');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /id="user" name="user"/);
    assert.match(html, /id="pass" name="pass"/);
    assert.match(html, /name="cf-turnstile-response" value=""/);
});

test('POST /login without a solved challenge token is refused', async () => {
    const res = await login({ token: '' });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /Challenge not solved/);
    assert.equal(sidOf(res), null);
});

test('POST /login with an empty credential is refused', async () => {
    const res = await login({ pass: '' });
    assert.equal(res.status, 401);
    assert.match(await res.text(), /required/);
});

test('POST /login with any non-empty pair (unpinned mode) sets the cookie and redirects to /notify', async () => {
    const res = await login();
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/notify');
    assert.ok(sidOf(res));
});

test('pinned MOCK_TM30_USER/MOCK_TM30_PASS: only the exact pair signs in', async () => {
    const pinnedSrv = createMockPortal({ user: 'villa9', pass: 'right-pass' });
    await new Promise((r) => pinnedSrv.listen(0, '127.0.0.1', r));
    const pinnedBase = `http://127.0.0.1:${pinnedSrv.address().port}`;
    try {
        const post = (user, pass) =>
            fetch(pinnedBase + '/login', {
                method: 'POST',
                body: new URLSearchParams({ user, pass, 'cf-turnstile-response': 't' }),
                redirect: 'manual'
            });
        const wrong = await post('villa9', 'wrong-pass');
        assert.equal(wrong.status, 401);
        assert.match(await wrong.text(), /Invalid username or password/);
        const right = await post('villa9', 'right-pass');
        assert.equal(right.status, 302);
    } finally {
        pinnedSrv.close();
    }
});

test('the session cookie gates /notify; /logout drops it again (fresh-login semantics)', async () => {
    const cookie = sidOf(await login());
    const authed = await get('/notify', { cookie });
    assert.equal(authed.status, 200);
    assert.match(await authed.text(), /type="file" name="sheet"/);

    const out = await get('/logout', { cookie });
    assert.equal(out.status, 302);
    const afterLogout = await get('/notify', { cookie });
    assert.equal(afterLogout.status, 302);
    assert.equal(afterLogout.headers.get('location'), '/login');
});

test('POST /notify without a session redirects to /login — no anonymous uploads', async () => {
    const res = await upload(null, await buildSheetBuffer(), 'x_TM30.xlsx');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');
});

test('a valid sheet yields a receipt: number + every guest in the summary table', async () => {
    const cookie = sidOf(await login());
    const res = await upload(cookie, await buildSheetBuffer(), 'Villa_Demo_2026-07-27_2026-08-02_TM30.xlsx');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Notification accepted/);
    assert.match(html, /MOCK-TM30-[0-9A-F]{8}-\d{4}/);
    for (const row of GOLDEN_ROWS) assert.ok(html.includes(row[4]), `passport ${row[4]} missing from receipt`);
});

test('a broken sheet yields an ITEMIZED rejection with row-numbered messages', async () => {
    const cookie = sidOf(await login());
    const rows = [['', '', 'KOWALSKA', 'X', 'ZK1234567', 'PL', '1985-06-17', '02/08/2026', '']];
    const res = await upload(cookie, await buildSheetBuffer({ rows }), 'broken_TM30.xlsx');
    assert.equal(res.status, 422);
    const html = await res.text();
    assert.match(html, /Notification rejected — 4 violation\(s\)/);
    assert.match(html, /row 2: First Name is required/);
    assert.match(html, /row 2: Gender must be .*got .*X/);
    assert.match(html, /row 2: Nationality/);
    assert.match(html, /row 2: Birth Date/);
});

test('uploading no file at all is a specific rejection, not a crash', async () => {
    const cookie = sidOf(await login());
    const fd = new FormData();
    fd.append('unrelated', 'value');
    const res = await fetch(base + '/notify', { method: 'POST', body: fd, headers: { cookie } });
    assert.equal(res.status, 422);
    assert.match(await res.text(), /no file was uploaded/);
});
