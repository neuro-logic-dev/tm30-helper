'use strict';

/**
 * T3-07 — the MOCK TM30 portal. node stdlib http + exceljs (via validate-sheet.mjs), nothing else.
 *
 * Purpose: let the WHOLE submission mechanism be exercised internally — Helper webview → login
 * (shipped autofill included) → accommodation-notify upload → server-side xlsx validation →
 * receipt or itemized rejection — without ever touching the real immigration service.
 *
 *   node test/mock-portal/server.mjs             # http://localhost:8630
 *   node test/mock-portal/server.mjs --port 9000
 *
 * Point the Helper at it: TM30_PORTAL_BASE_URL=http://localhost:8630 (see README, «Mock-portal e2e»).
 *
 * Credentials: when MOCK_TM30_USER / MOCK_TM30_PASS are BOTH set, the pair must match; otherwise
 * any non-empty user+pass signs in. The login POST also requires a non-empty
 * cf-turnstile-response — the fake challenge must have been "solved" (one button click).
 *
 * Sessions are in-memory cookies (`tm30mock_sid`). /notify without a valid cookie redirects to
 * /login — that is what lets per-villa partition isolation and ↻ fresh-login be exercised: each
 * villa webview lives in its own cookie jar, so each needs its own login, and clearing the
 * partition drops the mock session exactly like the real one.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { validateSheetBuffer } from './validate-sheet.mjs';
import { loginPage, notifyPage, receiptPage, rejectPage } from './pages.mjs';

export const DEFAULT_PORT = 8630;
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const COOKIE = 'tm30mock_sid';

// ── tiny helpers ──────────────────────────────────────────────────────────────────────────

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('body too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function cookieValue(req, name) {
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
        const [k, ...rest] = part.trim().split('=');
        if (k === name) return rest.join('=');
    }
    return null;
}

/**
 * Minimal multipart/form-data parser — ONE small upload from our own <form>, not a general
 * implementation. Returns [{name, filename, data}].
 */
export function parseMultipart(body, contentType) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || '');
    if (!m) return [];
    const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
    const parts = [];

    let pos = body.indexOf(boundary);
    while (pos !== -1) {
        pos += boundary.length;
        if (body.slice(pos, pos + 2).toString('latin1') === '--') break; // closing delimiter
        if (body.slice(pos, pos + 2).toString('latin1') === '\r\n') pos += 2;

        const headerEnd = body.indexOf('\r\n\r\n', pos);
        if (headerEnd === -1) break;
        const headers = body.slice(pos, headerEnd).toString('utf8');

        const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), boundary]), headerEnd + 4);
        if (next === -1) break;
        const data = body.slice(headerEnd + 4, next);

        const nameM = /name="([^"]*)"/.exec(headers);
        const fileM = /filename="([^"]*)"/.exec(headers);
        parts.push({
            name: nameM ? nameM[1] : '',
            filename: fileM ? fileM[1] : null,
            data
        });
        pos = next + 2; // land on the boundary again
    }
    return parts;
}

// ── the portal ────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} [opts]
 * @param {string|null} [opts.user] pinned username (default: env MOCK_TM30_USER or null = any)
 * @param {string|null} [opts.pass] pinned password (default: env MOCK_TM30_PASS or null = any)
 * @returns {http.Server} not yet listening — callers do server.listen(port)
 */
export function createMockPortal(opts = {}) {
    const pinnedUser = opts.user !== undefined ? opts.user : process.env.MOCK_TM30_USER || null;
    const pinnedPass = opts.pass !== undefined ? opts.pass : process.env.MOCK_TM30_PASS || null;
    const pinned = Boolean(pinnedUser && pinnedPass);

    /** sid → username */
    const sessions = new Map();
    let receiptSeq = 0;

    const html = (res, status, body, extraHeaders = {}) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...extraHeaders });
        res.end(body);
    };
    const redirect = (res, to, extraHeaders = {}) => {
        res.writeHead(302, { Location: to, ...extraHeaders });
        res.end();
    };

    return http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://mock');
        const route = `${req.method} ${url.pathname}`;
        const sid = cookieValue(req, COOKIE);
        const user = sid !== null ? sessions.get(sid) : undefined;

        try {
            switch (route) {
                case 'GET /': // the Helper webview's src is the BASE url — land it on the flow
                    return redirect(res, user !== undefined ? '/notify' : '/login');

                case 'GET /login':
                    return html(res, 200, loginPage());

                case 'POST /login': {
                    const form = new URLSearchParams((await readBody(req)).toString('utf8'));
                    const u = (form.get('user') || '').trim();
                    const p = form.get('pass') || '';
                    const token = form.get('cf-turnstile-response') || '';
                    if (!token) return html(res, 403, loginPage({ error: 'Challenge not solved — click “✓ I am human” first.' }));
                    if (!u || !p) return html(res, 401, loginPage({ error: 'Username and password are required.' }));
                    if (pinned && (u !== pinnedUser || p !== pinnedPass)) {
                        return html(res, 401, loginPage({ error: 'Invalid username or password.' }));
                    }
                    const newSid = crypto.randomBytes(16).toString('hex');
                    sessions.set(newSid, u);
                    return redirect(res, '/notify', {
                        'Set-Cookie': `${COOKIE}=${newSid}; Path=/; HttpOnly; SameSite=Lax`
                    });
                }

                case 'GET /logout': {
                    if (sid !== null) sessions.delete(sid);
                    return redirect(res, '/login', { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0` });
                }

                case 'GET /notify': {
                    if (user === undefined) return redirect(res, '/login');
                    // ?uploader=plain pins the classic keep-the-file input; default is the
                    // real portal's CONSUMING uploader (see notifyPage).
                    const uploader = url.searchParams.get('uploader') === 'plain' ? 'plain' : 'consuming';
                    return html(res, 200, notifyPage({ user, uploader }));
                }

                case 'POST /notify': {
                    if (user === undefined) return redirect(res, '/login');
                    const body = await readBody(req);
                    const parts = parseMultipart(body, req.headers['content-type']);
                    const file = parts.find((p) => p.name === 'sheet' && p.filename !== null);
                    if (!file || file.data.length === 0) {
                        return html(res, 422, rejectPage({
                            filename: '(no file)',
                            violations: [{ row: null, message: 'no file was uploaded — choose the TM30 .xlsx sheet first' }]
                        }));
                    }
                    const verdict = await validateSheetBuffer(file.data);
                    if (!verdict.ok) {
                        console.log(`[mock-portal] REJECTED "${file.filename}" — ${verdict.violations.length} violation(s)`);
                        return html(res, 422, rejectPage({ filename: file.filename, violations: verdict.violations }));
                    }
                    receiptSeq += 1;
                    const receiptNo = `MOCK-TM30-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${String(receiptSeq).padStart(4, '0')}`;
                    console.log(`[mock-portal] ACCEPTED "${file.filename}" — ${verdict.guests.length} guest(s), receipt ${receiptNo}`);
                    return html(res, 200, receiptPage({ receiptNo, filename: file.filename, guests: verdict.guests }));
                }

                default:
                    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                    return res.end('mock portal: not found\n');
            }
        } catch (err) {
            console.error('[mock-portal] request failed:', err);
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('mock portal: internal error\n');
        }
    });
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
    const flag = process.argv.indexOf('--port');
    const port = flag !== -1 ? Number(process.argv[flag + 1]) : DEFAULT_PORT;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        console.error(`--port must be a port number, got "${process.argv[flag + 1]}"`);
        process.exit(1);
    }
    const server = createMockPortal();
    server.listen(port, () => {
        const cred = process.env.MOCK_TM30_USER && process.env.MOCK_TM30_PASS
            ? `pinned to MOCK_TM30_USER="${process.env.MOCK_TM30_USER}"`
            : 'any non-empty user/pass accepted (set MOCK_TM30_USER/MOCK_TM30_PASS to pin)';
        console.log(`[mock-portal] listening on http://localhost:${port}  (credentials: ${cred})`);
        console.log(`[mock-portal] point the Helper at it:  TM30_PORTAL_BASE_URL=http://localhost:${port}`);
    });
}
