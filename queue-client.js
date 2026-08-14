'use strict';

/**
 * ADR-0021 — the Helper's MAIN-PROCESS HTTP client. Every request this app makes to OUR backend
 * goes through here, and nothing else in the repo is allowed to hold a token and a URL at the
 * same time.
 *
 * ── WHY THIS FILE EXISTS AT ALL (the third occurrence) ──
 * `main.js` used to carry the version report inline, under a comment that said in as many words:
 * "this is shaped like `checkForNewerRelease()` and it stays that way … duplicate until the third
 * occurrence." ADR-0021 IS the third occurrence — the worklist fetch and the mark-submitted write
 * arrive together, and all three want the same four things (one attempt, a hard abort, a failure
 * that cannot escape as an exception, a token that never reaches a log line). So the shape is
 * folded here now, exactly as that comment instructed, and `main.js` keeps only the things that
 * are genuinely its own: WHERE the token came from and WHETHER this launch already reported.
 *
 * `checkForNewerRelease()` is deliberately NOT folded in. It answers to GitHub's release feed,
 * not to our contract; it has no token, no error kinds and no caller that reacts to its failure.
 * Pulling it in would couple two things that only look alike.
 *
 * ── WHAT THIS MODULE IS NOT ALLOWED TO BECOME (ADR-0021, spec D-3) ──
 *   • No timer, no polling loop, no retry. A failed request is a failed request; the operator's
 *     Retry control (AC-3) is the only thing that tries again, and re-fetch triggers are the
 *     window's business (AC-5), not this file's.
 *   • No disk. Not a cache of rows, not a token store, not a log file. Worklist rows carry villa
 *     portal credentials (spec decision (i)) and AC-6 is absolute: memory only. This module holds
 *     no module-level state whatsoever — everything it knows arrives as an argument.
 *   • No `electron`. Like `deeplink.js`, this must be requireable from a plain `node --test`
 *     file; the moment it imports `app` it can only be tested inside a real Electron process.
 *
 * ── NEVER THROWS ──
 * Every method resolves. A rejected promise from here would land in a UI event handler or in the
 * launch sequence, and the failure mode we are protecting against is precisely the one AC-3 names:
 * an error that gets swallowed somewhere upstream and reaches the operator as an empty queue that
 * looks like "no tasks today". A failure is a VALUE, with a `kind` the UI can render honestly.
 *
 * ── NEVER LOGS THE TOKEN ──
 * The token appears in exactly two places: the `Authorization` header built inside `send()`, and
 * the version report's request body (its own pre-ADR-0021 contract, C-2). It is never returned to
 * a caller, never interpolated into a message, and never part of a URL — so no log line anywhere
 * downstream can leak it either, however carelessly it prints one of our result objects.
 */

/** The queue read and the submitted write. Long enough for a bad hotel Wi-Fi, short enough to fail. */
const REQUEST_TIMEOUT_MS = 8000;

/** The version report keeps its own, tighter budget — it runs during launch and blocks nothing. */
const REPORT_TIMEOUT_MS = 3000;

/** One page is the whole queue in practice; pagination exists so a future one does not truncate. */
const WORKLIST_PAGE_SIZE = 50;

/**
 * Every way a request can fail, as far as a CALLER cares. Exported so the window layer switches
 * on a constant instead of re-typing the strings — a typo in `'unauthorised'` would silently fall
 * through to the generic error branch and lose AC-4's "re-pair" message.
 */
const ErrorKind = {
  /** The request never got an answer: DNS, TLS, offline, connection reset. */
  NETWORK: 'network',
  /** We gave up first. A distinct kind because "the server is slow" reads differently to a user. */
  TIMEOUT: 'timeout',
  /** 401/403. AC-4: say so, discard the stored token, and do NOT retry. */
  UNAUTHORIZED: 'unauthorized',
  /** 400 — the server understood and declined (AC-11a). `message` carries its words verbatim. */
  REFUSED: 'refused',
  /** 5xx, 404, or an answer we could not read. Something is wrong that the operator cannot fix. */
  SERVER: 'server',
};

/** `status` when there was no HTTP response at all. Never `undefined`: `r.status === 401` must be safe. */
const NO_RESPONSE = 0;

/** @returns {{ok: false, kind: string, status: number, message?: string}} */
function failure(kind, status, message) {
  const out = { ok: false, kind, status };
  if (message) out.message = message;
  return out;
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** A positive integer id, whether it arrived as `3568` or as `'3568'`. Anything else is `null`. */
function positiveInt(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * A throw from `fetch` is either "we ran out of patience" or "the network said no". Node's
 * `AbortSignal.timeout` raises a `TimeoutError`; older runtimes and a manual abort raise
 * `AbortError`. Both are our own clock, not the network's, so both are TIMEOUT.
 */
function classifyThrow(e) {
  const name = e && e.name;
  return name === 'TimeoutError' || name === 'AbortError' ? ErrorKind.TIMEOUT : ErrorKind.NETWORK;
}

/**
 * 403 joins 401 because AC-4 names them together: from the Helper's side "your token is not good
 * here" is one situation with one remedy — open the web app once and re-pair. 400 is the server
 * declining a request it understood (AC-11a, "filing is no longer sheet_ready"), which the row
 * shows verbatim. Everything else — 404 included — is SERVER: not the operator's fault, not
 * fixable by re-pairing, and not something we can put words to.
 */
function classifyStatus(status) {
  if (status === 401 || status === 403) return ErrorKind.UNAUTHORIZED;
  if (status === 400) return ErrorKind.REFUSED;
  return ErrorKind.SERVER;
}

/**
 * The server's own words, so a refusal reaches the operator as written rather than as our guess
 * at what it meant. Nest sends `{ statusCode, message, error }` with `message` either a string or
 * an array of validation lines; both shapes are read, anything else is simply absent.
 */
function serverMessage(body) {
  if (!body || typeof body !== 'object') return undefined;
  const raw = body.message !== undefined ? body.message : body.error;
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  if (Array.isArray(raw)) {
    const joined = raw.filter((line) => typeof line === 'string' && line.trim() !== '').join('; ');
    if (joined !== '') return joined;
  }
  return undefined;
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * The Helper's HTTP client.
 *
 * @param {object} opts
 * @param {string} [opts.apiBase]   Origin of the backend, e.g. `https://api.mo.example`. Learned
 *                                  from the deep link; absent until the Helper has been paired,
 *                                  which is why every method re-checks it instead of throwing here.
 * @param {string} [opts.token]     The opaque operator token (ADR-0021 D-2). Opaque END TO END:
 *                                  this module never parses it, stores it or shows it.
 * @param {Function} [opts.fetchImpl] Injected only by tests. Left unset in production ON PURPOSE:
 *                                  `globalThis.fetch` is resolved at CALL time, because the
 *                                  existing `version-report.test.mjs` swaps the global AFTER
 *                                  `main.js` has been required, and capturing it here would make
 *                                  that suite test a function nobody calls.
 */
function createQueueClient({ apiBase, token, fetchImpl } = {}) {
  const base = typeof apiBase === 'string' ? apiBase.trim().replace(/\/+$/, '') : '';
  const bearer = typeof token === 'string' ? token.trim() : '';
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (...args) => globalThis.fetch(...args);

  /**
   * One attempt, one hard deadline, no exception. Returns the live `Response` on any status the
   * server actually produced — deciding what a status MEANS is each caller's job, because a 404
   * is "unknown filing" for one route and simply "server" for another.
   */
  async function send({ url, method, timeoutMs, authorize, body }) {
    const headers = {};
    if (authorize) headers.Authorization = `Bearer ${bearer}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    try {
      const res = await doFetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { ok: true, res, status: res.status };
    } catch (e) {
      // The message describes the transport (a host, a timeout) and can never contain the token:
      // the token travels in a header or a body, neither of which appears in a fetch error.
      return failure(classifyThrow(e), NO_RESPONSE, (e && e.message) || String(e));
    }
  }

  /** A request we can prove is malformed is refused HERE, and never sent. */
  function refuseLocally(reason) {
    return failure(ErrorKind.REFUSED, NO_RESPONSE, reason);
  }

  return {
    /**
     * AC-1 — the company queue, live over HTTPS.
     *
     * `bookingId` is the focus hint from a deep link (AC-15); omitted, the whole queue comes back.
     *
     * 🔴 The decoded body is handed on UNTOUCHED. Not reshaped, not filtered, not defaulted —
     * AC-16 says a field this build has never heard of must reach the renderer inert rather than
     * be dropped on the way. And a body we cannot read is a SERVER failure, never `{worklist: []}`:
     * a fabricated empty queue presented as "no tasks" is the exact lie AC-3 forbids.
     *
     * @returns {Promise<{ok: true, worklist: object} | {ok: false, kind: string, status: number, message?: string}>}
     */
    async fetchWorklist({ bookingId } = {}) {
      if (!isHttpUrl(base)) return refuseLocally('No backend address — open the Helper from the web app once.');
      if (bearer === '') return refuseLocally('Not paired — open the Helper from the web app once.');

      const query = new URLSearchParams({ limit: String(WORKLIST_PAGE_SIZE), offset: '0' });
      const focus = positiveInt(bookingId);
      if (focus !== null) query.set('booking_id', String(focus));

      const sent = await send({
        url: `${base}/tm30/helper/worklist?${query.toString()}`,
        method: 'GET',
        timeoutMs: REQUEST_TIMEOUT_MS,
        authorize: true,
      });
      if (!sent.ok) return sent;

      const body = await readJson(sent.res);
      if (sent.status !== 200) return failure(classifyStatus(sent.status), sent.status, serverMessage(body));
      if (!body || typeof body !== 'object') return failure(ErrorKind.SERVER, sent.status);
      return { ok: true, worklist: body };
    },

    /**
     * AC-11 — the one click. The server owns the transition; we report what it says.
     *
     * AC-11a in one line: on a refusal the row shows the server's words and re-fetches. There is
     * no optimistic local "✓ Submitted" anywhere in this path, which is why nothing here returns
     * a synthesised success.
     *
     * @returns {Promise<{ok: true, filing: object} | {ok: false, kind: string, status: number, message?: string}>}
     */
    async markSubmitted(filingId, { receiptNo } = {}) {
      if (!isHttpUrl(base)) return refuseLocally('No backend address — open the Helper from the web app once.');
      if (bearer === '') return refuseLocally('Not paired — open the Helper from the web app once.');
      const id = positiveInt(filingId);
      if (id === null) return refuseLocally(`Unusable filing id: ${JSON.stringify(filingId)}`);

      // Omitted rather than sent as null when there is no receipt: the field is optional on the
      // wire, and `{receipt_no: null}` is a different statement from "I am not telling you one".
      const body = {};
      if (typeof receiptNo === 'string' && receiptNo.trim() !== '') body.receipt_no = receiptNo.trim();

      const sent = await send({
        url: `${base}/tm30/helper/filings/${id}/submitted`,
        method: 'POST',
        timeoutMs: REQUEST_TIMEOUT_MS,
        authorize: true,
        body,
      });
      if (!sent.ok) return sent;

      const payload = await readJson(sent.res);
      if (sent.status !== 200) return failure(classifyStatus(sent.status), sent.status, serverMessage(payload));
      if (!payload || typeof payload !== 'object') return failure(ErrorKind.SERVER, sent.status);
      return { ok: true, filing: payload };
    },

    /**
     * ADR-0001 / contract C-2 — the version report, folded in here unchanged.
     *
     * It is the odd one out and stays that way: its own 3-second budget, its token in the BODY
     * rather than in a header (C-2 froze that body to exactly four keys), 204 as the only success,
     * and a failure nobody reacts to. It answers to a different contract than the queue routes do,
     * so it borrows only the transport.
     *
     * The console lines came with it, verbatim, because they ARE its observable behaviour — this
     * call has no other output. The caller ignores the return value; it exists so the shape stays
     * uniform and so a test can assert on it.
     *
     * WHAT IT MUST NEVER DO: block, retry, or rethrow. The "already sent this launch" memo lives
     * in `main.js` with the token that keys it, deliberately: state in here would be state that
     * survives a token rotation.
     */
    async reportVersion({ reportUrl, installationId, version, platform }) {
      if (!isHttpUrl(reportUrl)) return refuseLocally('No report address'); // nobody told us where
      if (bearer === '') return refuseLocally('No report token');

      const sent = await send({
        url: reportUrl.trim(),
        method: 'POST',
        timeoutMs: REPORT_TIMEOUT_MS,
        authorize: false,
        body: { token: bearer, installation_id: installationId, version, platform },
      });

      if (!sent.ok) {
        console.log('[tm30-helper] version report skipped:', sent.message);
        return sent;
      }
      if (sent.status === 204) {
        console.log(`[tm30-helper] reported version ${version} (${platform})`);
        return { ok: true, status: sent.status };
      }
      console.log(`[tm30-helper] version report not stored: HTTP ${sent.status}`);
      return failure(classifyStatus(sent.status), sent.status);
    },
  };
}

module.exports = {
  createQueueClient,
  ErrorKind,
  REQUEST_TIMEOUT_MS,
  REPORT_TIMEOUT_MS,
  WORKLIST_PAGE_SIZE,
};
