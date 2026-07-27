'use strict';

/**
 * T3-08 — THE ⇥ INSERT-SHEET HARNESS.
 *
 * Runs the REAL, SHIPPED `app.html` + `preload.js` + `insert-sheet.js` in a real Electron
 * window against the REAL T3-07 mock portal (login → /notify upload → server-side xlsx
 * validation → receipt / itemized rejection). The insert IPC handler under test is the
 * PRODUCTION one — this harness boots itself instead of main.js (same pattern as the autofill
 * harness), but the engine lives in `insert-sheet.js` precisely so both register the same code
 * and nothing is replicated.
 *
 * What is proven end to end, with no file dialog anywhere:
 *   · mechanism A (CDP DOM.setFileInputFiles) places the row's sheet into the mock portal's
 *     CONSUMING uploader (the default, mirroring the real portal: it eats the File on `change`
 *     and clears the input), guardrail C's STAGE 2 confirms it via the echoed filename (a SOFT
 *     "accepted", never a mismatch), and the mock's own submit (the human's click) turns those
 *     REAL BYTES into a receipt — and, for the broken sheet, into an itemized rejection;
 *   · the PLAIN uploader (?uploader=plain) keeps the file, so guardrail C's STAGE 1 byte
 *     read-back "verified" holds — the other verification path;
 *   · mechanism B (TM30_INSERT_MODE=inpage) passes the same e2e (stage-2 accept);
 *   · guardrail C failure: a hostile page that clears its input AND echoes nothing produces the
 *     LOUD do-NOT-submit mismatch, never a false ✓;
 *   · the gate matrix: non-active villa rows disabled (with the reason), no-sheet rows
 *     disabled, IPC refuses bad requests / closed panes / concurrent inserts;
 *   · the per-task path: {userData}/tm30-sheets/{filing_id}/{name}.xlsx, overwritten in place.
 *
 * The "human" in the flow (fake-Turnstile click, Sign in, the portal's submit) is simulated by
 * the harness driving the MOCK portal — the shipped Helper code never clicks any of it.
 *
 * Usage:  test/run-insert.sh [--no-sandbox]
 *         INSERT_HEADFUL=1 test/run-insert.sh    # visible window + PNG shots (INSERT_SHOTS_DIR)
 * Exit:   0 = every assertion held, 1 = something regressed.
 */

const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const HELPER = path.resolve(__dirname, '..', '..'); // desktop/tm30-helper
const { buildPayload, VALID_SHEET_NAME, BROKEN_SHEET_NAME, SURIYAN, ANDA } = require('./fixture.js');

// 🔴 An isolated userData: the per-task downloads land under app.getPath('userData'), and the
// harness must be free to assert on (and destroy) that tree without touching a real profile.
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tm30-insert-harness-'));
app.setPath('userData', USER_DATA);

// THE production handler — the thing under test. Registered exactly as main.js registers it.
require(path.join(HELPER, 'insert-sheet.js')).registerInsertSheet();

const HEADFUL = process.env.INSERT_HEADFUL === '1';
const SHOTS_DIR = process.env.INSERT_SHOTS_DIR || path.join(os.tmpdir(), 'tm30-insert-shots');

const out = (s) => process.stdout.write(s + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) {
    passed += 1;
    out(`   ✓ ${label}`);
  } else {
    failed += 1;
    out(`   ✗ ${label}`);
    if (detail !== undefined) out(`       got: ${JSON.stringify(detail)}`);
  }
}

/** The partition scheme `app.html` uses — asserted against, so spelled out here verbatim. */
const PART = (villa) => 'persist:tm30-v-' + encodeURIComponent(villa);

/** A hang is a failure, not a suite that never finishes (mirrors the other harnesses). */
const HARNESS_TIMEOUT_MS = 240_000;
setTimeout(() => {
  out('✗ the harness timed out — nothing finished it.');
  app.exit(1);
}, HARNESS_TIMEOUT_MS).unref();

async function waitFor(fn, opts = {}) {
  const { timeout = 20_000, every = 150, label = 'condition' } = opts;
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; } // mid-navigation probes may reject — keep polling
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timed out waiting for ' + label);
    await sleep(every);
  }
}

// ── the two "hostile" pages for guardrail C and the ambiguity refusal ──────────────────────
const HOSTILE_PAGE = `<!doctype html><html><body>
  <h3>hostile page — clears its file input on change</h3>
  <input type="file" id="f">
  <script>
    document.getElementById('f').addEventListener('change', function () { this.value = ''; });
  </script>
</body></html>`;

const TWIN_PAGE = `<!doctype html><html><body>
  <h3>two visible file inputs — must refuse to guess</h3>
  <input type="file" id="a"> <input type="file" id="b">
</body></html>`;

app.whenReady().then(async () => {
  // ── the REAL mock portal (T3-07) + the harness's own sheet/file server ──────────────────
  const { createMockPortal } = await import(pathToFileURL(path.join(HELPER, 'test', 'mock-portal', 'server.mjs')).href);
  const { buildSheetBuffer } = await import(pathToFileURL(path.join(HELPER, 'test', 'mock-portal', 'build-sheet.mjs')).href);

  const validBuf = await buildSheetBuffer();
  const brokenBuf = await buildSheetBuffer({
    rows: [
      ['', '', 'KOWALSKA', 'X', 'ZK1234567', 'PL', '1985-06-17', '02/08/2026', ''],
      ['JOHN', '', 'DOE', 'M', '', 'USA', '17/06/1985', '32/13/2026', ''],
    ],
  });

  const mock = createMockPortal(); // any non-empty user/pass — the fixture creds sign in
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockUrl = `http://127.0.0.1:${mock.address().port}`;
  out(`▸ mock portal at ${mockUrl}`);

  const files = http.createServer((req, res) => {
    const sheet = (buf, name) => {
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Content-Length': buf.length,
      });
      res.end(buf);
    };
    const html = (body) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    if (req.url === '/sheets/valid.xlsx') return sheet(validBuf, VALID_SHEET_NAME);
    if (req.url === '/sheets/broken.xlsx') return sheet(brokenBuf, BROKEN_SHEET_NAME);
    if (req.url === '/hostile.html') return html(HOSTILE_PAGE);
    if (req.url === '/twin.html') return html(TWIN_PAGE);
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((r) => files.listen(0, '127.0.0.1', r));
  const filesUrl = `http://127.0.0.1:${files.address().port}`;
  out(`▸ sheet/file server at ${filesUrl}  (valid ${validBuf.length} B, broken ${brokenBuf.length} B)`);

  // ── the window: same options as main.js openWorklistWindow, portal pointed at the mock ──
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: HEADFUL,
    webPreferences: { webviewTag: true, preload: path.join(HELPER, 'preload.js') },
  });

  const attached = new Set();
  win.webContents.on('did-attach-webview', (_e, wc) => attached.add(wc));
  win.webContents.on('console-message', (_e, _l, m) => {
    if (m.indexOf('[tm30-helper]') === 0) out('   helper │ ' + m.replace('[tm30-helper] ', ''));
  });

  /** Attached webContents → villa, through the partition (same mapping as the 4e harness). */
  const wcFor = (villa) => {
    const target = session.fromPartition(PART(villa));
    for (const wc of attached) if (!wc.isDestroyed() && wc.session === target) return wc;
    return null;
  };

  await win.loadFile(path.join(HELPER, 'app.html'), {
    query: { d: buildPayload(filesUrl), portal: mockUrl },
  });
  await sleep(600);

  const R = (js) => win.webContents.executeJavaScript(js);
  const select = (villa) => R(`window.tm30Shell.setActiveVilla(${JSON.stringify(villa)})`);
  const statusline = () => R("document.getElementById('statusline').textContent");

  if (HEADFUL) fs.mkdirSync(SHOTS_DIR, { recursive: true });
  let shotSeq = 0;
  async function shot(name, wc) {
    if (!HEADFUL) return;
    try {
      const img = await (wc || win.webContents).capturePage();
      shotSeq += 1;
      const p = path.join(SHOTS_DIR, `${String(shotSeq).padStart(2, '0')}-${name}.png`);
      fs.writeFileSync(p, img.toPNG());
      out(`   📸 ${p}`);
    } catch (e) {
      out(`   (screenshot "${name}" failed: ${e.message})`);
    }
  }

  /** Every row's ⇥ button state, for the gate-matrix scenarios. */
  const INSERT_GATES = `
    Array.prototype.map.call(document.querySelectorAll('.row'), function (r) {
      var b = r.querySelector('.act-insert');
      return {
        id: r.getAttribute('data-filing-id'),
        villa: r.getAttribute('data-villa'),
        present: !!b,
        disabled: b ? b.disabled : null,
        title: b ? b.title : null
      };
    })`;
  const gateOf = (gates, id) => gates.filter((g) => g.id === String(id))[0];

  /** Click a row's ⇥ button and wait for the flow's verdict in rowLocal. */
  async function insertViaButton(filingId) {
    await R(
      `delete window.tm30Shell.state.rowLocal[${filingId}]; window.tm30Shell.renderList(); true`
    );
    const clicked = await R(`(function () {
      var b = document.querySelector('.row[data-filing-id="${filingId}"] .act-insert');
      if (!b) return 'NO BUTTON';
      if (b.disabled) return 'DISABLED';
      b.click();
      return 'clicked';
    })()`);
    if (clicked !== 'clicked') throw new Error(`insert button on ${filingId}: ${clicked}`);
    return waitFor(
      async () => {
        const local = await R(`(window.tm30Shell.state.rowLocal[${filingId}] || null)`);
        return local && (local.insert || local.insertError) ? local : null;
      },
      { timeout: 40_000, label: `insert verdict for filing ${filingId}` }
    );
  }

  /** What the PORTAL page's file input actually holds — the other end of the pipe. */
  const portalInput = (villa) =>
    wcFor(villa).executeJavaScript(`(function () {
      var t = document.querySelector('input[type="file"]');
      var f = t && t.files && t.files[0];
      return f ? { name: f.name, size: f.size } : null;
    })()`);

  /** The CONSUMING uploader's display box — what the page echoed after eating the File. */
  const portalFilebox = (villa) =>
    wcFor(villa).executeJavaScript(`(function () {
      var b = document.getElementById('filebox');
      return b ? b.textContent : null;
    })()`);

  const rawInsert = (req) => R(`window.tm30Native.insertSheet(${JSON.stringify(req)})`);
  const taskDir = (id) => path.join(USER_DATA, 'tm30-sheets', String(id));

  /** The T3-11 auto-insert banner: `{ hidden, text }` — helper chrome, read from the app window. */
  const banner = () => R(`(function () {
    var b = document.getElementById('insert-banner');
    return { hidden: b.classList.contains('hidden'), text: b.textContent };
  })()`);

  /** The row's Helper-local insert result (or null) — what auto-insert writes, same as manual. */
  const rowLocal = (id) => R(`(window.tm30Shell.state.rowLocal[${id}] || null)`);

  /**
   * Drive a villa's webview through the mock login exactly as the "human" does in scenario 4
   * (fake Turnstile click → shipped autofill types the creds → the human presses Sign in),
   * landing it on the /notify upload page. Used by the auto-insert scenarios that need a SECOND
   * signed-in villa (Villa Anda) or a fresh Suriyan session.
   */
  async function loginVilla(villa, account) {
    const wc = await waitFor(() => wcFor(villa), { label: villa + ' webview to attach' });
    await waitFor(() => wc.executeJavaScript('!!document.getElementById("user")'),
      { label: villa + ' login form' });
    await wc.executeJavaScript('document.getElementById("solve").click(); true');
    await waitFor(
      () => wc.executeJavaScript(
        `(document.getElementById("user") || {}).value === ${JSON.stringify(account.login)}`),
      { label: villa + ' shipped autofill to land' });
    await wc.executeJavaScript('document.getElementById("signin").click(); true');
    await waitFor(() => wc.executeJavaScript('location.pathname === "/notify"'),
      { label: villa + ' /notify page' });
    return wc;
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 1 — BOOT: the ⇥ slot exists on every row, and NOTHING is insertable yet ═');
  {
    const gates = await R(INSERT_GATES);
    gates.forEach((g) =>
      out(`      row ${g.id}: ${g.villa.padEnd(16)} ⇥ ${g.disabled ? 'DISABLED' : 'enabled'} — "${(g.title || '').slice(0, 60)}…"`)
    );
    check('every row carries the ⇥ insert slot', gates.length === 4 && gates.every((g) => g.present), gates);
    check('no villa is active → every ⇥ is disabled', gates.every((g) => g.disabled === true));
    check('no-sheet row explains itself, not the villa gate',
      /nothing to insert yet/.test(gateOf(gates, 304).title), gateOf(gates, 304));
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 2 — GATE MATRIX: only the ACTIVE villa\'s rows are insertable ════════════');
  await select('Villa Suriyan 2');
  await sleep(400);
  {
    const gates = await R(INSERT_GATES);
    check('active villa rows (301, 302) are ENABLED',
      gateOf(gates, 301).disabled === false && gateOf(gates, 302).disabled === false, gates);
    check('🔴 NON-active villa row (303) is DISABLED…', gateOf(gates, 303).disabled === true, gates);
    check('…with the active-villa reason on hover',
      /ACTIVE villa/.test(gateOf(gates, 303).title), gateOf(gates, 303).title);
    check('no-sheet row (304) stays disabled', gateOf(gates, 304).disabled === true);
    await shot('gate-matrix');
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 3 — IPC GUARDS: the bridge refuses everything that is not a live row ════');
  {
    const badId = await rawInsert({ filing_id: 'x', url: filesUrl + '/sheets/valid.xlsx', partition: PART('Villa Suriyan 2') });
    check('non-numeric filing_id → {ok:false, stage:request}',
      badId && badId.ok === false && badId.stage === 'request', badId);
    const badUrl = await rawInsert({ filing_id: 301, url: 'file:///etc/passwd', partition: PART('Villa Suriyan 2') });
    check('non-http(s) sheet url is refused', badUrl && badUrl.ok === false && badUrl.stage === 'request', badUrl);
    const badPart = await rawInsert({ filing_id: 301, url: filesUrl + '/sheets/valid.xlsx', partition: 'persist:not-ours' });
    check('🔴 a non-tm30 partition is refused', badPart && badPart.ok === false && badPart.stage === 'request', badPart);
    const closed = await rawInsert({ filing_id: 304, url: filesUrl + '/sheets/valid.xlsx', partition: PART('Villa Baan Ork') });
    check('a villa whose portal pane was never opened → {stage:target}',
      closed && closed.ok === false && closed.stage === 'target', closed);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 4 — THE HUMAN LOGS IN (mock portal, fake Turnstile + shipped autofill) ══');
  {
    const wcS = wcFor('Villa Suriyan 2');
    await waitFor(() => wcS.executeJavaScript('!!document.getElementById("user")'),
      { label: 'the mock login form to mount' });
    await wcS.executeJavaScript('document.getElementById("solve").click(); true'); // the "human"
    await waitFor(
      () => wcS.executeJavaScript(
        `(document.getElementById("user") || {}).value === ${JSON.stringify(SURIYAN.login)}`),
      { label: 'the shipped autofill to land' }
    );
    out('   the shipped autofill typed the credentials after the fake challenge');
    await wcS.executeJavaScript('document.getElementById("signin").click(); true'); // the "human"
    await waitFor(() => wcS.executeJavaScript('location.pathname === "/notify"'),
      { label: 'the /notify upload page' });
    check('signed in — the villa webview is on the mock /notify upload page', true);
    await shot('notify-page', wcS);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 5 — MECHANISM A · CONSUMING uploader: ⇥ → stage-2 SOFT ✓ → submit → receipt ═');
  // The default /notify uploader mirrors the REAL portal: it eats the File on `change` and
  // CLEARS the input, so the byte read-back (stage 1) comes back empty. The insert STILL worked
  // — stage 2 confirms it by finding the filename the page echoed, and reports a soft success.
  let cdpEventsSeen = null; // the empirical answer for the deliverable
  {
    const local = await insertViaButton(301);
    out(`      verdict: ${JSON.stringify(local.insert || local.insertError)}`);
    check('insert reported ok', !!local.insert, local);
    const res = local.insert || {};
    check('🔴 mechanism A (CDP) did the placement — no fallback', res.mechanism === 'cdp', res);
    check('🔴 verification is STAGE-2 "accepted" (consuming uploader cleared the input)',
      res.verification === 'accepted', res);
    check('the soft success still names the row\'s file + byte size',
      res.filename === VALID_SHEET_NAME && res.size === validBuf.length, res);
    cdpEventsSeen = { cdpEvents: res.cdpEvents, dispatchedEvents: res.dispatchedEvents };
    out(`      CDP fired events itself: ${JSON.stringify(res.cdpEvents)} · manual dispatch needed: ${res.dispatchedEvents}`);

    check('per-task path is {userData}/tm30-sheets/301/' + VALID_SHEET_NAME,
      res.path === path.join(taskDir(301), VALID_SHEET_NAME), res.path);
    check('…and the file is really there, byte-identical',
      fs.existsSync(res.path) && fs.statSync(res.path).size === validBuf.length);
    check('…and it is NOT the ~/Downloads dedup path', res.path.indexOf(USER_DATA) === 0, res.path);

    const box = await portalFilebox('Villa Suriyan 2');
    check('🔴 the MOCK PORTAL\'s display box shows the row\'s filename — the page consumed the input',
      box === VALID_SHEET_NAME, box);
    const status5 = await statusline();
    check('status line reads "inserted ✓ <filename>"',
      new RegExp('inserted ✓ ' + VALID_SHEET_NAME).test(status5), status5);
    check('🔴 the soft-success status does NOT shout "do NOT submit"',
      !/do NOT submit/.test(status5), status5);
    check('…and it names the consumed-input state ("accepted by the page")',
      /accepted by the page/.test(status5), status5);
    await shot('inserted-valid');
    await shot('inserted-valid-portal', wcFor('Villa Suriyan 2'));

    // The HUMAN decision the Helper never makes: the portal's own submit. The consuming
    // uploader reattaches the held File on submit, so the normal multipart POST still carries it.
    const wcS = wcFor('Villa Suriyan 2');
    await wcS.executeJavaScript('document.querySelector(\'form[action="/notify"] button[type="submit"]\').click(); true');
    await waitFor(() => wcS.executeJavaScript('!!document.getElementById("receipt-no")'),
      { label: 'the mock receipt page' });
    const receipt = await wcS.executeJavaScript('document.getElementById("receipt-no").textContent');
    out(`      receipt: ${receipt}`);
    check('🔴 the mock VALIDATED the real bytes and issued a receipt', /^MOCK-TM30-/.test(receipt), receipt);
    await shot('receipt', wcS);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 5B — PLAIN uploader (?uploader=plain): stage-1 byte read-back verifies ✓ ══');
  // The classic input that KEEPS the file — the other verification path: the read-back finds
  // the bytes still in the input, so the insert reports a HARD "verified", not the soft accept.
  {
    const wcS = wcFor('Villa Suriyan 2');
    await wcS.loadURL(mockUrl + '/notify?uploader=plain');
    await waitFor(() => wcS.executeJavaScript('!!document.querySelector(\'input[type="file"]\')'),
      { label: 'the plain upload form' });

    const local = await insertViaButton(301);
    const res = local.insert || {};
    out(`      verdict: ${JSON.stringify(res)}`);
    check('insert reported ok on the plain uploader', !!local.insert, local);
    check('🔴 verification is STAGE-1 "verified" (input kept the file)', res.verification === 'verified', res);
    check('read-back matched name + byte size',
      res.filename === VALID_SHEET_NAME && res.size === validBuf.length, res);
    const inPortal = await portalInput('Villa Suriyan 2');
    check('🔴 the plain input still HOLDS the row\'s sheet — the byte read-back can see it',
      inPortal && inPortal.name === VALID_SHEET_NAME && inPortal.size === validBuf.length, inPortal);
    check('status line reads "inserted ✓ <filename>" and does NOT say do NOT submit',
      new RegExp('inserted ✓ ' + VALID_SHEET_NAME).test(await statusline()) &&
        !/do NOT submit/.test(await statusline()), await statusline());
    await shot('inserted-plain');
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 6 — BROKEN SHEET: same pipe, real bytes → itemized rejection ════════════');
  {
    const wcS = wcFor('Villa Suriyan 2');
    await wcS.loadURL(mockUrl + '/notify'); // the "human" goes back to the upload page
    await waitFor(() => wcS.executeJavaScript('!!document.querySelector(\'input[type="file"]\')'),
      { label: 'the upload form again' });

    const local = await insertViaButton(302);
    const res = local.insert || {};
    check('the broken sheet INSERTS fine (validity is the server\'s verdict, not ours)',
      !!local.insert && res.filename === BROKEN_SHEET_NAME && res.size === brokenBuf.length, local);
    check('…via the consuming uploader\'s stage-2 soft accept', res.verification === 'accepted', res);

    await wcS.executeJavaScript('document.querySelector(\'form[action="/notify"] button[type="submit"]\').click(); true');
    await waitFor(() => wcS.executeJavaScript('!!document.getElementById("violations")'),
      { label: 'the mock rejection page' });
    const rejection = await wcS.executeJavaScript(`(function () {
      return {
        heading: document.querySelector('h3').textContent,
        violations: document.querySelectorAll('#violations li').length
      };
    })()`);
    out(`      rejection: ${JSON.stringify(rejection)}`);
    check('🔴 the mock rejected the BROKEN bytes with an itemized violation list',
      /rejected/.test(rejection.heading) && rejection.violations >= 3, rejection);
    await shot('rejection', wcS);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 7 — MECHANISM B (TM30_INSERT_MODE=inpage): same e2e, same receipt ═══════');
  {
    process.env.TM30_INSERT_MODE = 'inpage';
    const wcS = wcFor('Villa Suriyan 2');
    await wcS.loadURL(mockUrl + '/notify');
    await waitFor(() => wcS.executeJavaScript('!!document.querySelector(\'input[type="file"]\')'),
      { label: 'the upload form again' });

    const local = await insertViaButton(301);
    const res = local.insert || {};
    out(`      verdict: ${JSON.stringify(res)}`);
    check('insert reported ok in forced in-page mode', !!local.insert, local);
    check('🔴 mechanism B did the placement', res.mechanism === 'inpage', res);
    check('🔴 stage-2 soft accept through the in-page path too', res.verification === 'accepted', res);
    check('the soft success still names the row\'s file + byte size',
      res.filename === VALID_SHEET_NAME && res.size === validBuf.length, res);
    check('status line names the in-page fallback out loud',
      /inserted ✓ .*\(in-page fallback\)/.test(await statusline()), await statusline());
    check('🔴 the per-task dir was OVERWRITTEN in place — still exactly one file, no "(1)" copies',
      fs.readdirSync(taskDir(301)).length === 1 && fs.readdirSync(taskDir(301))[0] === VALID_SHEET_NAME,
      fs.readdirSync(taskDir(301)));

    await wcS.executeJavaScript('document.querySelector(\'form[action="/notify"] button[type="submit"]\').click(); true');
    await waitFor(() => wcS.executeJavaScript('!!document.getElementById("receipt-no")'),
      { label: 'the receipt page (in-page mode)' });
    check('the in-page-inserted bytes validated to a receipt too', true);
    delete process.env.TM30_INSERT_MODE;
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 8 — CONCURRENCY: a second insert on the same pane is REJECTED, not queued');
  {
    const wcS = wcFor('Villa Suriyan 2');
    await wcS.loadURL(mockUrl + '/notify');
    await waitFor(() => wcS.executeJavaScript('!!document.querySelector(\'input[type="file"]\')'),
      { label: 'the upload form again' });

    const req = { filing_id: 301, url: filesUrl + '/sheets/valid.xlsx', partition: PART('Villa Suriyan 2') };
    const pair = await R(
      `Promise.all([window.tm30Native.insertSheet(${JSON.stringify(req)}),` +
        ` window.tm30Native.insertSheet(${JSON.stringify(req)})])`
    );
    const oks = pair.filter((r) => r && r.ok === true);
    const busy = pair.filter((r) => r && r.ok === false && r.stage === 'busy');
    check('exactly one insert ran, the overlapping one came back {stage:busy}',
      oks.length === 1 && busy.length === 1, pair);
    check('…and the busy message says to wait', /already running/.test(busy[0] ? busy[0].error : ''), busy);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 9 — GUARDRAIL C: a page that clears its input yields the LOUD mismatch ══');
  {
    const wcS = wcFor('Villa Suriyan 2');
    await wcS.loadURL(filesUrl + '/hostile.html');
    await waitFor(() => wcS.executeJavaScript('!!document.querySelector(\'input[type="file"]\')'),
      { label: 'the hostile page' });

    const raw = await rawInsert({ filing_id: 301, url: filesUrl + '/sheets/valid.xlsx', partition: PART('Villa Suriyan 2') });
    out(`      raw verdict: ${JSON.stringify(raw)}`);
    check('🔴 verification FAILED — {ok:false, stage:verify}, never a false ✓',
      raw && raw.ok === false && raw.stage === 'verify', raw);
    check('the mismatch names what the input actually holds', /EMPTY|GONE/.test(raw.error || ''), raw);
    check('…and records that CDP was tried first and did not hold',
      typeof raw.fellBack === 'string' && /CDP/.test(raw.fellBack), raw.fellBack);

    // The same through the BUTTON: the renderer must shout do-NOT-submit at the manager.
    const local = await insertViaButton(301);
    check('row message carries the do-NOT-submit instruction',
      !!local.insertError && /do NOT submit/.test(local.insertError), local);
    check('status line shouts it too', /do NOT submit/.test(await statusline()), await statusline());
    await shot('mismatch-loud');
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 10 — NO INPUT / AMBIGUOUS INPUTS: loud refusals, never a guess ══════════');
  {
    const wcS = wcFor('Villa Suriyan 2');
    await wcS.loadURL(mockUrl + '/logout'); // lands on /login — a page with NO file input
    await waitFor(() => wcS.executeJavaScript('location.pathname === "/login"'), { label: 'the login page' });
    const noInput = await rawInsert({ filing_id: 301, url: filesUrl + '/sheets/valid.xlsx', partition: PART('Villa Suriyan 2') });
    check('a page with NO file input → {stage:find-input}, telling the manager to navigate',
      noInput && noInput.ok === false && noInput.stage === 'find-input' && /no file input/.test(noInput.error),
      noInput);

    await wcS.loadURL(filesUrl + '/twin.html');
    await waitFor(() => wcS.executeJavaScript('document.querySelectorAll(\'input[type="file"]\').length === 2'),
      { label: 'the twin-input page' });
    const twin = await rawInsert({ filing_id: 301, url: filesUrl + '/sheets/valid.xlsx', partition: PART('Villa Suriyan 2') });
    check('🔴 two visible file inputs → REFUSED, not guessed',
      twin && twin.ok === false && twin.stage === 'find-input' && /refusing to guess/.test(twin.error),
      twin);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 11 — STATIC AUDIT: the shipped wiring is the tested wiring ══════════════');
  {
    const mainSrc = fs.readFileSync(path.join(HELPER, 'main.js'), 'utf8');
    check('main.js registers the SAME production engine (registerInsertSheet from ./insert-sheet)',
      /require\('\.\/insert-sheet'\)/.test(mainSrc) && /registerInsertSheet\(\)/.test(mainSrc));
    const preloadSrc = fs.readFileSync(path.join(HELPER, 'preload.js'), 'utf8');
    check('preload exposes the one new verb on the narrow bridge',
      /insertSheet:/.test(preloadSrc) && /'tm30:insert-sheet'/.test(preloadSrc));
    check('…and preload picks the three row-derived fields explicitly (no pass-through)',
      /filing_id: req && req\.filing_id/.test(preloadSrc) &&
        /partition: req && req\.partition/.test(preloadSrc));
    const pkg = JSON.parse(fs.readFileSync(path.join(HELPER, 'package.json'), 'utf8'));
    check('electron-builder ships insert-sheet.js', pkg.build.files.indexOf('insert-sheet.js') >= 0, pkg.build.files);
    const engineSrc = fs.readFileSync(path.join(HELPER, 'insert-sheet.js'), 'utf8');
    check('🔴 the engine never clicks or navigates the portal (submit stays human)',
      // `.loadURL(` is navigation; `downloadURL(` (the file download) legitimately exists.
      !/\.click\s*\(/.test(engineSrc) && !/\.loadURL\s*\(/.test(engineSrc) && !/\.submit\s*\(/.test(engineSrc));
    check('🔴 the debugger detach lives in a finally — never left attached',
      /finally\s*\{\s*try\s*\{\s*dbg\.detach\(\)/.test(engineSrc));

    // T3-11: auto-insert is a WHEN decision layered on the SAME engine — no new portal writes.
    const appSrc = fs.readFileSync(path.join(HELPER, 'app.html'), 'utf8');
    check('🔴 T3-11 auto path calls the SAME insertSheet flow with { auto: true }',
      /insertSheet\(cand\.row, btn, \{ auto: true \}\)/.test(appSrc));
    check('🔴 T3-11 added NO portal click/submit to the engine (insert-sheet.js unchanged in scope)',
      !/\.click\s*\(/.test(engineSrc) && !/\.submit\s*\(/.test(engineSrc));
    check('T3-11 arms off the same onActiveVillaChange seam 4e/4g use',
      /mountAutoInsert/.test(appSrc) && /armAutoInsert/.test(appSrc));
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 12 — AUTO-INSERT (T3-11) · a single ready row fires WITHOUT ⇥ (Villa Anda) ═');
  // Villa Anda has EXACTLY ONE sheet_ready row (303) → unambiguous by rule (b). Sign it in and
  // the arming watcher places the sheet the instant the empty /notify form appears — no ⇥ click.
  {
    await R('delete window.tm30Shell.state.rowLocal[303]; window.tm30Shell.renderList(); true');
    await select('Villa Anda');
    await loginVilla('Villa Anda', ANDA);

    const local = await waitFor(
      async () => { const l = await rowLocal(303); return l && (l.insert || l.insertError) ? l : null; },
      { timeout: 40_000, label: 'auto-insert to fire on filing 303 with no ⇥ click' });
    out(`      auto verdict: ${JSON.stringify(local.insert || local.insertError)}`);
    check('🔴 the insert fired with NO ⇥ click — the watcher set rowLocal[303].insert', !!local.insert, local);
    const res = local.insert || {};
    check('…the consuming uploader gave the stage-2 "accepted" verdict', res.verification === 'accepted', res);
    check('…and it placed the single ready row\'s file', res.filename === VALID_SHEET_NAME, res);
    const box = await portalFilebox('Villa Anda');
    check('🔴 the mock portal consumed the auto-placed file (display box shows the name)',
      box === VALID_SHEET_NAME, box);

    const b = await banner();
    check('🔴 the auto-insert BANNER is visible and carries the filename',
      !b.hidden && b.text.indexOf(VALID_SHEET_NAME) >= 0, b);
    check('…and it reads as attached, pointing the human at Save',
      /Sheet attached/.test(b.text) && /Save/.test(b.text), b);
    check('the status line reflects it exactly like a manual insert',
      /inserted ✓ /.test(await statusline()), await statusline());
    await shot('auto-insert-single');
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 13 — AUTO-INSERT · the FOCUSED row wins when a villa has two ready rows ══');
  // Suriyan has TWO sheet_ready rows (301, 302). The T3-03 focus on 302 makes it unambiguous by
  // rule (a): auto-insert files the FOCUSED row and never guesses between the two.
  {
    await R('window.tm30Shell.state.focusFilingId = 302;' +
      ' delete window.tm30Shell.state.rowLocal[301]; delete window.tm30Shell.state.rowLocal[302];' +
      // Scenario 10 logged the mock out with a RAW nav (not freshLogin), so the Helper's session
      // cue for Suriyan can be stale — and whether scenario 4's session-open watcher caught the
      // fill before the page navigated is itself racy. Clear the cue so the shipped autofill
      // re-arms deterministically on the re-login below.
      " delete window.tm30Shell.state.villaSession['Villa Suriyan 2'];" +
      ' window.tm30Shell.renderList(); true');
    check('🔴 the resolver picks the FOCUSED row over the sibling (unit check)',
      (await R('(window.tm30Shell.resolveAutoInsertCandidate("Villa Suriyan 2") || {}).row ?' +
        ' window.tm30Shell.resolveAutoInsertCandidate("Villa Suriyan 2").row.filing_id : null')) === 302);
    await select('Villa Suriyan 2'); // re-arms auto-insert AND autofill for Suriyan (Anda was active)
    const wcS = wcFor('Villa Suriyan 2');
    await wcS.loadURL(mockUrl + '/logout'); // guarantee a logged-out start → the login form
    await waitFor(() => wcS.executeJavaScript('location.pathname === "/login"'),
      { label: 'Suriyan back on /login' });
    await loginVilla('Villa Suriyan 2', SURIYAN);

    const local = await waitFor(
      async () => { const l = await rowLocal(302); return l && l.insert ? l : null; },
      { timeout: 40_000, label: 'auto-insert to fire on the FOCUSED filing 302' });
    check('🔴 auto-insert filed the FOCUSED row (302), by its broken-sheet filename',
      !!local.insert && local.insert.filename === BROKEN_SHEET_NAME, local);
    const other = await rowLocal(301);
    check('…and the non-focused ready row (301) was left untouched', !other || !other.insert, other);
    const b = await banner();
    check('the banner names the focused row\'s file', !b.hidden && b.text.indexOf(BROKEN_SHEET_NAME) >= 0, b);
    await shot('auto-insert-focused');
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 14 — AUTO-INSERT · TWO ready rows, no focus ⇒ NO auto-insert, hint, manual ⇥ ═');
  // The fail-safe: ambiguous target ⇒ never guess. The status line hints, nothing is placed, and
  // the manual ⇥ path is fully intact.
  {
    await R('window.tm30Shell.state.focusFilingId = null;' +
      ' delete window.tm30Shell.state.rowLocal[301]; delete window.tm30Shell.state.rowLocal[302];' +
      ' window.tm30Shell.renderList(); true');
    const wcS = wcFor('Villa Suriyan 2');
    await wcS.loadURL(mockUrl + '/notify'); // fresh empty form re-arms the one-shot (did-navigate)
    await waitFor(() => wcS.executeJavaScript('!!document.querySelector(\'input[type="file"]\')'),
      { label: 'the fresh /notify' });

    await waitFor(async () => /select a task/.test(await statusline()),
      { label: 'the laconic ambiguity hint on the status line' });
    check('🔴 status line hints "select a task and press ⇥ insert"',
      /select a task and press ⇥ insert/.test(await statusline()), await statusline());
    const l301 = await rowLocal(301);
    const l302 = await rowLocal(302);
    check('🔴 NOTHING was auto-inserted for either ambiguous row',
      (!l301 || !l301.insert) && (!l302 || !l302.insert), { l301, l302 });
    check('the banner stayed hidden (no placement happened)', (await banner()).hidden);

    // The manual ⇥ path is untouched — the human disambiguates by pressing it.
    const manual = await insertViaButton(301);
    check('manual ⇥ still works on an ambiguous page (files 301 by hand)',
      !!manual.insert && manual.insert.filename === VALID_SHEET_NAME, manual);
    await shot('auto-insert-ambiguous');
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 15 — AUTO-INSERT · ONE-SHOT per page appearance; a reload re-arms it ═════');
  {
    await R('window.tm30Shell.state.focusFilingId = 301;' +
      ' delete window.tm30Shell.state.rowLocal[301]; window.tm30Shell.renderList(); true');
    const wcS = wcFor('Villa Suriyan 2');
    await wcS.loadURL(mockUrl + '/notify');
    await waitFor(() => wcS.executeJavaScript('!!document.querySelector(\'input[type="file"]\')'),
      { label: 'a fresh /notify to fire into' });

    await waitFor(async () => { const l = await rowLocal(301); return l && l.insert ? l : null; },
      { timeout: 40_000, label: 'the first auto-insert of the appearance' });
    check('auto-insert fired once on the fresh form (301)', !!(await rowLocal(301)).insert);

    // Same page still present (filename now echoed): the one-shot must NOT re-fire. Clear the
    // local result and confirm it stays cleared across several poll intervals.
    await R('delete window.tm30Shell.state.rowLocal[301]; window.tm30Shell.renderList(); true');
    await sleep(1600); // > 3 × AUTO_INSERT_POLL_MS
    const between = await rowLocal(301);
    check('🔴 ONE-SHOT: no re-fire while the same form stays present',
      !between || !between.insert, between);

    // A reload IS a new page appearance → re-arm → fire again.
    await wcS.loadURL(mockUrl + '/notify');
    await waitFor(() => wcS.executeJavaScript('!!document.querySelector(\'input[type="file"]\')'),
      { label: 'the reloaded /notify' });
    const second = await waitFor(
      async () => { const l = await rowLocal(301); return l && l.insert ? l : null; },
      { timeout: 40_000, label: 'the re-armed auto-insert after reload' });
    check('🔴 a page reload re-arms the one-shot and it fires again', !!second.insert, second);
    await shot('auto-insert-oneshot');
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 16 — AUTO-INSERT · a loud verify failure: no banner, no auto-retry ══════');
  // The hostile page clears its input on change and echoes nothing → guardrail C's loud mismatch.
  // Auto-insert must NOT paper over it with a banner, must NOT auto-retry, and manual ⇥ stays live.
  {
    await R('window.tm30Shell.state.focusFilingId = 301;' +
      ' delete window.tm30Shell.state.rowLocal[301]; window.tm30Shell.hideInsertBanner();' +
      ' window.tm30Shell.renderList(); true');
    const wcS = wcFor('Villa Suriyan 2');
    await wcS.loadURL(filesUrl + '/hostile.html');
    await waitFor(() => wcS.executeJavaScript('!!document.querySelector(\'input[type="file"]\')'),
      { label: 'the hostile page' });

    const local = await waitFor(
      async () => { const l = await rowLocal(301); return l && (l.insert || l.insertError) ? l : null; },
      { timeout: 40_000, label: 'auto-insert to fire and fail loudly on the hostile page' });
    check('🔴 auto-insert fired on the hostile page and FAILED verification (do NOT submit)',
      !!local.insertError && /do NOT submit/.test(local.insertError), local);
    check('🔴 NO banner on a failed auto-insert', (await banner()).hidden, await banner());
    check('the status line shouts do NOT submit', /do NOT submit/.test(await statusline()), await statusline());

    // No auto-retry: the loud failure is terminal for the automatic path. Manual ⇥ is the retry.
    const manual = await insertViaButton(301);
    check('🔴 manual ⇥ remains the live retry path (returns its own verdict)',
      !!(manual.insert || manual.insertError), manual);
    check('…and it too correctly refuses to claim success on the hostile page',
      !!manual.insertError && /do NOT submit/.test(manual.insertError), manual);
    await R('window.tm30Shell.state.focusFilingId = null; true'); // leave focus clean
    await shot('auto-insert-loud-fail');
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('══════════════════════════════════════════════════════════════════════════════');
  out(`  ${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} assertion(s) held, ${failed} failed`);
  out('');
  out(`  Empirical CDP answer (mechanism A on the mock portal): ${JSON.stringify(cdpEventsSeen)}`);
  out('  NOT covered here: the REAL portal\'s upload page (selector shape, dropzone or not,');
  out('  hidden input or not) — that is the pending live-probe item; the finder prefers the');
  out('  one visible input and tolerates one hidden-but-only input for exactly that unknown.');
  out('══════════════════════════════════════════════════════════════════════════════');

  mock.close();
  files.close();
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch { /* tmp — best effort */ }
  app.exit(failed === 0 ? 0 : 1);
}).catch((err) => {
  out('✗ the harness crashed: ' + (err && err.stack || err));
  app.exit(1);
});
