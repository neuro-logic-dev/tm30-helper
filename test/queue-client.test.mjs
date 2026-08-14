/**
 * ADR-0021 / C-7 — the main-process HTTP client.
 *
 * `queue-client.js` is the only place in the Helper where a token meets a URL, so this suite is
 * mostly about the two promises the module makes to everything downstream:
 *
 *   1. IT NEVER THROWS. Every failure a network, a proxy or a server can produce comes back as a
 *      VALUE with a `kind` the UI can render. A rejected promise here would surface as an empty
 *      queue somewhere upstream — the "no tasks today" lie AC-3 exists to prevent.
 *   2. IT NEVER LEAKS THE TOKEN. Not into a result object, not into a URL, not into a log line.
 *      Asserted globally rather than case-by-case: every call in this file runs with the console
 *      captured, and the token is grepped for in everything the module said and returned.
 *
 * `fetchImpl` is injected throughout, so nothing here touches a network. The DEFAULT path — a
 * late-bound `globalThis.fetch` — is exercised by `version-report.test.mjs`, which swaps the
 * global after `main.js` is loaded and would fail instantly if this module captured it at import.
 *
 * Run: node --test test/queue-client.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createQueueClient, ErrorKind, REQUEST_TIMEOUT_MS, REPORT_TIMEOUT_MS } =
    require(path.join(repo, 'queue-client.js'));

const API_BASE = 'https://api.mo.example';
const TOKEN = '4210.AbCdEfGhIjKlMnOpQrStUv';

/** A real worklist body, unknown future field included on purpose (AC-16). */
const WORKLIST = {
    filings: [
        {
            filing_id: 3568,
            booking_id: 3572,
            villa: 'Malee V11',
            status: 'sheet_ready',
            account: { login: 'malee_v11', pass: 's3cr3t' },
        },
    ],
    total: 1,
    task_type: 'tm30', // a field this build has never heard of must survive untouched
};

const FILING = { filing_id: 3568, status: 'submitted', receipt_no: 'TM30-2026-0001' };

/** A `Response` as far as this module is concerned. `body === undefined` ⇒ unreadable. */
const reply = (status, body) => ({
    status,
    json: async () => {
        if (body === undefined) throw new SyntaxError('Unexpected end of JSON input');
        return body;
    },
});

const thrown = (name, message) => () => {
    const e = new Error(message);
    e.name = name;
    throw e;
};

/** Records every request. `handler(n)` returns the reply for the n-th call, or throws. */
function recorder(handler = () => reply(200, WORKLIST)) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
        return handler(calls.length);
    };
    return { calls, fetchImpl };
}

const client = (fetchImpl, over = {}) =>
    createQueueClient({ apiBase: API_BASE, token: TOKEN, fetchImpl, ...over });

/**
 * 🔴 THE GLOBAL LEAK CHECK. Everything the module says and everything it returns, for every test
 * in this file, ends up here — so a token that escapes through any path fails the suite, not just
 * the one test that thought to look.
 */
const everythingSaid = [];

async function capturing(fn) {
    const realLog = console.log;
    const realErr = console.error;
    const realWarn = console.warn;
    const said = [];
    const sink = (...a) => said.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    console.log = sink;
    console.error = sink;
    console.warn = sink;
    let result;
    try {
        result = await fn();
    } finally {
        console.log = realLog;
        console.error = realErr;
        console.warn = realWarn;
    }
    everythingSaid.push(...said, JSON.stringify(result ?? null));
    return { result, said };
}

test.after(() => {
    assert.ok(everythingSaid.length > 0, 'the sweep only means something if something was collected');
    for (const line of everythingSaid) {
        assert.equal(String(line).includes(TOKEN), false, `token leaked into: ${line}`);
    }
});

// ── fetchWorklist · the happy path ──────────────────────────────────────────────────────────

test('AC-1: a 200 hands the decoded body back untouched, unknown fields and all (AC-16)', async () => {
    const { calls, fetchImpl } = recorder();
    const { result } = await capturing(() => client(fetchImpl).fetchWorklist({}));

    assert.deepEqual(result, { ok: true, worklist: WORKLIST });
    assert.deepEqual(result.worklist.task_type, 'tm30', 'a field we do not understand still arrives');
    assert.equal(calls.length, 1, 'one attempt — no retry loop anywhere in this module');
    assert.equal(calls[0].init.method, 'GET');
});

test('the Bearer header is present and correctly formed, and the token is nowhere else', async () => {
    const { calls, fetchImpl } = recorder();
    await capturing(() => client(fetchImpl).fetchWorklist({}));

    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(calls[0].url.includes(TOKEN), false, 'never in the URL — URLs reach logs and proxies');
    assert.equal(calls[0].body, null, 'a GET carries no body');
});

test('the query string: limit/offset always, booking_id only when there is one', async () => {
    const { calls, fetchImpl } = recorder();
    const c = client(fetchImpl);

    await capturing(() => c.fetchWorklist({}));
    await capturing(() => c.fetchWorklist());
    await capturing(() => c.fetchWorklist({ bookingId: 3572 }));
    await capturing(() => c.fetchWorklist({ bookingId: '3572' }));
    await capturing(() => c.fetchWorklist({ bookingId: null }));
    await capturing(() => c.fetchWorklist({ bookingId: 'all of them' }));

    const q = calls.map((c2) => new URL(c2.url).search);
    assert.equal(q[0], '?limit=50&offset=0', 'omitted');
    assert.equal(q[1], '?limit=50&offset=0', 'no argument object at all');
    assert.equal(q[2], '?limit=50&offset=0&booking_id=3572', 'present');
    assert.equal(q[3], '?limit=50&offset=0&booking_id=3572', 'a numeric string is the same booking');
    assert.equal(q[4], '?limit=50&offset=0', 'null is not a focus hint');
    assert.equal(q[5], '?limit=50&offset=0', 'junk is dropped, never sent as booking_id=NaN');

    for (const call of calls) assert.equal(new URL(call.url).pathname, '/tm30/helper/worklist');
});

test('a trailing slash on apiBase does not produce a double slash in the path', async () => {
    const { calls, fetchImpl } = recorder();
    await capturing(() => client(fetchImpl, { apiBase: 'https://api.mo.example//' }).fetchWorklist({}));
    assert.equal(calls[0].url.startsWith('https://api.mo.example/tm30/helper/worklist?'), true, calls[0].url);
});

// ── fetchWorklist · every way it fails ──────────────────────────────────────────────────────

test('AC-4: 401 and 403 are both `unauthorized`, and carry the status', async () => {
    for (const status of [401, 403]) {
        const { fetchImpl } = recorder(() => reply(status, { message: 'Unauthorized' }));
        const { result } = await capturing(() => client(fetchImpl).fetchWorklist({}));
        assert.equal(result.ok, false);
        assert.equal(result.kind, ErrorKind.UNAUTHORIZED);
        assert.equal(result.status, status);
    }
});

test('AC-3: a 5xx is `server` — never an empty worklist', async () => {
    const { fetchImpl } = recorder(() => reply(503, { message: 'upstream is down' }));
    const { result } = await capturing(() => client(fetchImpl).fetchWorklist({}));

    assert.equal(result.kind, ErrorKind.SERVER);
    assert.equal(result.status, 503);
    assert.equal('worklist' in result, false, 'a failure never carries rows, not even empty ones');
});

test('AC-3: a network failure is `network`, and a timeout is a DIFFERENT kind', async () => {
    const cases = [
        [thrown('TypeError', 'fetch failed'), ErrorKind.NETWORK],
        [() => Promise.reject(new TypeError('fetch failed')), ErrorKind.NETWORK],
        [thrown('TimeoutError', 'The operation was aborted due to timeout'), ErrorKind.TIMEOUT],
        [thrown('AbortError', 'This operation was aborted'), ErrorKind.TIMEOUT],
    ];
    for (const [handler, kind] of cases) {
        const { fetchImpl } = recorder(handler);
        const { result } = await capturing(() => client(fetchImpl).fetchWorklist({}));
        assert.equal(result.ok, false);
        assert.equal(result.kind, kind);
        assert.equal(result.status, 0, 'there was no HTTP response, and 0 says so without being undefined');
    }
});

test('AC-3: a 200 we cannot read is a `server` failure, NOT "no tasks"', async () => {
    for (const body of [undefined, null, 'a login page', 42]) {
        const { fetchImpl } = recorder(() => reply(200, body));
        const { result } = await capturing(() => client(fetchImpl).fetchWorklist({}));
        assert.equal(result.ok, false, `body: ${JSON.stringify(body)}`);
        assert.equal(result.kind, ErrorKind.SERVER);
        assert.equal(result.status, 200);
    }
});

test('nothing is ever sent without an address or a token — and it is not called a network error', async () => {
    for (const over of [{ apiBase: undefined }, { apiBase: 'not a url' }, { token: '' }, { token: undefined }]) {
        const { calls, fetchImpl } = recorder();
        const { result } = await capturing(() => client(fetchImpl, over).fetchWorklist({}));
        assert.equal(calls.length, 0, `must not leave the machine: ${JSON.stringify(over)}`);
        assert.equal(result.ok, false);
        assert.equal(result.kind, ErrorKind.REFUSED);
        assert.ok(result.message, 'a locally refused request always says why');
    }
});

// ── markSubmitted ───────────────────────────────────────────────────────────────────────────

test('AC-11: a 200 hands back the server\'s filing view', async () => {
    const { calls, fetchImpl } = recorder(() => reply(200, FILING));
    const { result } = await capturing(() =>
        client(fetchImpl).markSubmitted(3568, { receiptNo: 'TM30-2026-0001' }),
    );

    assert.deepEqual(result, { ok: true, filing: FILING });
    assert.equal(calls[0].url, `${API_BASE}/tm30/helper/filings/3568/submitted`);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
    assert.deepEqual(calls[0].body, { receipt_no: 'TM30-2026-0001' });
});

test('no receipt ⇒ the key is absent, not null', async () => {
    const { calls, fetchImpl } = recorder(() => reply(200, FILING));
    const c = client(fetchImpl);

    await capturing(() => c.markSubmitted(3568));
    await capturing(() => c.markSubmitted(3568, {}));
    await capturing(() => c.markSubmitted(3568, { receiptNo: '   ' }));

    for (const call of calls) assert.deepEqual(call.body, {}, 'an empty object, never {receipt_no: null}');
});

test('AC-11a: a 400 is `refused` and carries the server\'s words VERBATIM', async () => {
    const message = 'Filing 3568 is no longer sheet_ready (current status: submitted)';
    const { fetchImpl } = recorder(() => reply(400, { statusCode: 400, message, error: 'Bad Request' }));
    const { result } = await capturing(() => client(fetchImpl).markSubmitted(3568));

    assert.equal(result.ok, false);
    assert.equal(result.kind, ErrorKind.REFUSED);
    assert.equal(result.status, 400);
    assert.equal(result.message, message, 'the row shows this string, so it must not be rewritten');
});

test('a Nest validation array becomes one readable line, and a bodyless 400 still refuses', async () => {
    const { fetchImpl } = recorder(() => reply(400, { message: ['receipt_no must be a string', 'too long'] }));
    const { result } = await capturing(() => client(fetchImpl).markSubmitted(3568));
    assert.equal(result.message, 'receipt_no must be a string; too long');

    const bare = recorder(() => reply(400, undefined));
    const { result: r2 } = await capturing(() => client(bare.fetchImpl).markSubmitted(3568));
    assert.equal(r2.kind, ErrorKind.REFUSED);
    assert.equal(r2.status, 400);
    assert.equal('message' in r2, false, 'no words from the server ⇒ no invented ones');
});

test('404 is `server`, not `refused` — an unknown filing is not something the operator can answer', async () => {
    const { fetchImpl } = recorder(() => reply(404, { message: 'Not Found' }));
    const { result } = await capturing(() => client(fetchImpl).markSubmitted(3568));
    assert.equal(result.kind, ErrorKind.SERVER);
    assert.equal(result.status, 404);
});

test('markSubmitted fails the same way fetchWorklist does', async () => {
    const cases = [
        [() => reply(401, {}), ErrorKind.UNAUTHORIZED, 401],
        [() => reply(500, {}), ErrorKind.SERVER, 500],
        [thrown('TypeError', 'fetch failed'), ErrorKind.NETWORK, 0],
        [thrown('TimeoutError', 'aborted'), ErrorKind.TIMEOUT, 0],
        [() => reply(200, undefined), ErrorKind.SERVER, 200],
    ];
    for (const [handler, kind, status] of cases) {
        const { fetchImpl } = recorder(handler);
        const { result } = await capturing(() => client(fetchImpl).markSubmitted(3568));
        assert.equal(result.ok, false);
        assert.equal(result.kind, kind);
        assert.equal(result.status, status);
        assert.equal('filing' in result, false, 'a failure never carries a filing');
    }
});

test('an unusable filing id is refused locally and never becomes a URL', async () => {
    for (const id of [undefined, null, 0, -1, 'abc', 1.5, {}]) {
        const { calls, fetchImpl } = recorder(() => reply(200, FILING));
        const { result } = await capturing(() => client(fetchImpl).markSubmitted(id));
        assert.equal(calls.length, 0, `id ${JSON.stringify(id)} must not be sent`);
        assert.equal(result.kind, ErrorKind.REFUSED);
    }
});

// ── the timeouts, and the fold ──────────────────────────────────────────────────────────────

test('C-7: 8s on the queue routes, 3s on the version report — and always a real signal', async () => {
    const realTimeout = AbortSignal.timeout;
    const budgets = [];
    AbortSignal.timeout = (ms) => {
        budgets.push(ms);
        return realTimeout.call(AbortSignal, ms);
    };
    try {
        const { calls, fetchImpl } = recorder(() => reply(204));
        const c = client(fetchImpl);
        await capturing(() => c.fetchWorklist({}));
        await capturing(() => c.markSubmitted(3568));
        await capturing(() =>
            c.reportVersion({
                reportUrl: 'https://api.mo.example/tm30/helper-report',
                installationId: 'i-1',
                version: '2.5.0',
                platform: 'darwin',
            }),
        );
        assert.deepEqual(budgets, [REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS, REPORT_TIMEOUT_MS]);
        assert.equal(REQUEST_TIMEOUT_MS, 8000);
        assert.equal(REPORT_TIMEOUT_MS, 3000);
        for (const call of calls) assert.ok(call.init.signal instanceof AbortSignal, 'a hard abort, not an open request');
    } finally {
        AbortSignal.timeout = realTimeout;
    }
});

/**
 * The version report's own contract (C-2, ADR-0001) survived the fold: four body keys, the token
 * in the BODY rather than a header, 204 as the only success, and silence on everything else.
 * `version-report.test.mjs` proves the same thing through the real `main.js`; this proves it at
 * the seam, where a future edit to the shared transport would break it first.
 */
test('the folded version report keeps its C-2 shape', async () => {
    const { calls, fetchImpl } = recorder(() => reply(204));
    const { result, said } = await capturing(() =>
        client(fetchImpl).reportVersion({
            reportUrl: 'https://api.mo.example/tm30/helper-report',
            installationId: 'i-1',
            version: '2.5.0',
            platform: 'darwin',
        }),
    );

    assert.deepEqual(result, { ok: true, status: 204 });
    assert.equal(calls[0].url, 'https://api.mo.example/tm30/helper-report');
    assert.deepEqual(Object.keys(calls[0].body).sort(), ['installation_id', 'platform', 'token', 'version']);
    assert.equal(calls[0].body.token, TOKEN, 'C-2 puts the token in the body — not a Bearer header');
    assert.equal('Authorization' in calls[0].init.headers, false);
    assert.deepEqual(said, ['[tm30-helper] reported version 2.5.0 (darwin)']);
});

test('every version-report failure is swallowed and merely mentioned', async () => {
    const cases = [
        [() => reply(500), 'version report not stored: HTTP 500'],
        [() => reply(404), 'version report not stored: HTTP 404'],
        [() => reply(200), 'version report not stored: HTTP 200'],
        [thrown('TypeError', 'fetch failed'), 'version report skipped: fetch failed'],
    ];
    for (const [handler, expected] of cases) {
        const { fetchImpl } = recorder(handler);
        const { result, said } = await capturing(() =>
            client(fetchImpl).reportVersion({
                reportUrl: 'https://api.mo.example/tm30/helper-report',
                installationId: 'i-1',
                version: '2.5.0',
                platform: 'darwin',
            }),
        );
        assert.equal(result.ok, false, expected); // resolved — the caller never sees a rejection
        assert.deepEqual(said, [`[tm30-helper] ${expected}`]);
    }
});

test('a report with nowhere to go is not sent, and does not throw', async () => {
    const { calls, fetchImpl } = recorder(() => reply(204));
    const args = { installationId: 'i-1', version: '2.5.0', platform: 'darwin' };

    for (const reportUrl of [undefined, '', 'file:///etc/passwd', 'javascript:alert(1)']) {
        const { result } = await capturing(() => client(fetchImpl).reportVersion({ ...args, reportUrl }));
        assert.equal(result.ok, false);
    }
    const { result } = await capturing(() =>
        client(fetchImpl, { token: '' }).reportVersion({ ...args, reportUrl: 'https://api.mo.example/r' }),
    );
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
});

// ── the promise the whole module rests on ───────────────────────────────────────────────────

test('C-7: nothing in here can reject, whatever the caller or the network does', async () => {
    const hostile = [
        thrown('TypeError', 'fetch failed'),
        () => Promise.reject(new Error('rejected, not thrown')),
        () => {
            throw 'a bare string, not an Error'; // eslint-disable-line no-throw-literal
        },
        () => null, // a "response" that is not one
        () => ({ status: 200 }), // …and one with no json() at all
    ];

    for (const handler of hostile) {
        const c = client(recorder(handler).fetchImpl);
        for (const call of [
            () => c.fetchWorklist({ bookingId: 3572 }),
            () => c.markSubmitted(3568, { receiptNo: 'x' }),
            () => c.reportVersion({ reportUrl: 'https://api.mo.example/r', installationId: 'i', version: '1', platform: 'p' }),
        ]) {
            const { result } = await capturing(call);
            assert.equal(typeof result, 'object');
            assert.equal(result.ok, false);
            assert.ok(Object.values(ErrorKind).includes(result.kind), `unknown kind: ${result.kind}`);
        }
    }
});

test('a client built with no arguments at all still answers instead of exploding', async () => {
    const { result } = await capturing(() => createQueueClient().fetchWorklist({}));
    assert.equal(result.ok, false);
    assert.equal(result.kind, ErrorKind.REFUSED);
});
