'use strict';

/**
 * A-WEB-4f — THE MARK-SUBMITTED HAND-BACK HARNESS.
 *
 * Two things are under test, and they are different kinds of thing:
 *
 *  ── PART A · THE SEAM (static, both ends, no mirroring) ────────────────────────────────────
 *  The web app EMITS `return_url` (`src/lib/tm30.ts`) and the web app READS it back
 *  (`reservation-url.ts` → `manageBookingDialog.tsx` → `Tm30Tab.tsx`). 013 §5: those two halves
 *  were built in different tickets, which is precisely how the v2 deep link shipped broken. So
 *  the emitted URL is produced by the COMPILED emitter and fed to the COMPILED URL parser, and
 *  the two consumers that the parser hands off to are asserted against their real source.
 *
 *  ── PART B · THE HAND-BACK (runtime, the real app) ─────────────────────────────────────────
 *  This harness requires the REAL `main.js` and hands it the fixture deep link in argv, so the
 *  window under test is opened by production code, with the production preload, running the
 *  shipped `app.html`. The ONLY thing replaced is `shell.openExternal`, which is recorded rather
 *  than performed — otherwise every run would fling three browser tabs at the operator. The IPC
 *  handler, its `isHttpUrl` guard, and the whole renderer path are the real ones.
 *
 *  ⚠️ NOT COVERED, AND NOT COVERABLE HERE: the live click-through. Once the URL leaves for the
 *  browser, finishing the loop needs a running web app + backend + a signed-in manager pressing
 *  Confirm, and endpoint #9 writing the row. That is an INTEGRATION item. What this proves is
 *  that the Helper opens the right URL and that the web reads the params it carries.
 *
 * Usage:  test/run-handback.sh
 * Exit:   0 = every assertion held, 1 = something regressed.
 */

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const HELPER = path.resolve(__dirname, '..', '..'); // desktop/tm30-helper
const WEB = path.resolve(HELPER, '..', '..'); // mo-reservation-fe
const { RETURN_URL, BOOKING_ID, ORIGIN } = require('./fixture.js');

const out = (s) => process.stdout.write(s + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (p) => fs.readFileSync(p, 'utf8');

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

// ── the ONE stub: record the hand-back instead of launching a browser ────────────────────────
const opened = [];
shell.openExternal = async (url) => {
  opened.push(String(url));
  out(`   🌐 shell.openExternal(${JSON.stringify(String(url))})`);
};

/**
 * `main.js` opens with `app.requestSingleInstanceLock()` and QUITS silently when it loses — so a
 * Helper the operator already has open would turn this suite into a green no-op. Take the lock
 * first (a second request from the same process succeeds) and fail loudly if it is not ours.
 */
if (!app.requestSingleInstanceLock()) {
  out('✗ another TM30 Helper instance is running — close it and rerun.');
  process.exit(1);
}

/** A hang is a failure, not a suite that never finishes. */
const HARNESS_TIMEOUT_MS = 60_000;
setTimeout(() => {
  out('✗ the harness timed out — nothing finished it.');
  app.exit(1);
}, HARNESS_TIMEOUT_MS).unref();

/**
 * `main.js` calls `win.loadFile('app.html')` — a path relative to the APP ROOT, which Electron
 * takes from the entry script's directory (here: `test/handback/`). Pointing it back at the
 * Helper is what lets the shipped `main.js` run verbatim instead of being re-typed here.
 */
app.setAppPath(HELPER);

// 🔴 The real main process. It reads the deep link out of OUR argv and opens the real window.
require(path.join(HELPER, 'main.js'));

app.whenReady().then(async () => {
  // ═════════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ A — THE return_url SEAM: what the emitter WRITES vs what the web READS ══');
  {
    out(`   emitted: ${RETURN_URL}`);
    const u = new URL(RETURN_URL);
    const q = u.searchParams;

    check('emitter targets the booking route', u.pathname === `/reservation/reservations/${BOOKING_ID}`, u.pathname);
    check('emitter keeps the origin it was given', u.origin === ORIGIN, u.origin);
    check('emitter writes action=manage_booking', q.get('action') === 'manage_booking', q.get('action'));
    check('emitter writes tab=tm30', q.get('tab') === 'tm30', q.get('tab'));
    check('emitter writes confirm=submitted', q.get('confirm') === 'submitted', q.get('confirm'));
    check('emitted URL is http(s) — the only thing shell will accept', /^https?:$/.test(u.protocol), u.protocol);

    // ── the READ half, run for real against the compiled web parser ──
    const parser = require(path.join(__dirname, '..', '.build', 'reservation-url.js'));
    const parsed = parser.parseReservationPathname(u.pathname, u.search);
    out(`   parsed : ${JSON.stringify(parsed)}`);
    check('web parser recovers the booking id', parsed && parsed.bookingId === BOOKING_ID, parsed);
    check('web parser accepts the action (it is in VALID_DIALOG_ACTIONS)',
      parsed && parsed.action === 'manage_booking', parsed);
    check('🔴 web parser recovers tab=tm30 → the dialog lands on the TM30 tab',
      parsed && parsed.tab === 'tm30', parsed);

    // ── the two consumers the parser hands off to, asserted against their real source ──
    const dialog = read(path.join(WEB, 'src/components/booking/manageBookingDialog.tsx'));
    const tab = read(path.join(WEB, 'src/features/tm30/Tm30Tab.tsx'));
    const page = read(path.join(WEB, 'src/app/reservation/reservations/page.tsx'));

    check('manageBookingDialog selects the tm30 tab from the parsed `tab`',
      /parseInitialReservationState\(\)\?\.tab/.test(dialog) &&
        /initialManageTab === 'tm30' \? 'tm30'/.test(dialog));
    check('🔴 Tm30Tab opens the confirm panel on exactly `confirm === \'submitted\'`',
      /get\('confirm'\) === 'submitted'/.test(tab));
    check('Tm30Tab — and only the web — calls endpoint #9 (markSubmitted with user_id)',
      /markSubmitted\(\{[\s\S]{0,200}user_id/.test(tab));
    check('reservations/page.tsx strips only `action`, KEEPING tab+confirm for the read above',
      /kept\.delete\('action'\)/.test(page) && !/kept\.delete\('(tab|confirm)'\)/.test(page));
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ B — THE HELPER, RUNNING: real main.js, real preload, shipped app.html ═══');

  // The window main.js opened for our deep link.
  let win = null;
  for (let i = 0; i < 100 && !win; i += 1) {
    const candidate =
      BrowserWindow.getAllWindows().find((w) => /app\.html/.test(w.webContents.getURL())) || null;
    // The URL is set even when the load FAILED, so ask the document, not the address.
    if (candidate) {
      const alive = await candidate.webContents
        .executeJavaScript('typeof window.tm30Shell === "object" && !!window.tm30Shell')
        .catch(() => false);
      if (alive) win = candidate;
    }
    if (!win) await sleep(100);
  }
  if (!win) {
    out('   ✗ the real main.js never opened a working app.html for the fixture deep link');
    app.exit(1);
    return;
  }
  win.webContents.on('console-message', (_e, _l, m) => {
    if (m.indexOf('[tm30-helper]') === 0) out('   helper │ ' + m.replace('[tm30-helper] ', ''));
  });
  await sleep(1200);
  const R = (js) => win.webContents.executeJavaScript(js);

  check('🔴 the window was opened by the REAL main.js from the deep link in argv', true);
  check('the real preload is attached (tm30Native.openExternal exists)',
    (await R('typeof window.tm30Native.openExternal')) === 'function');

  /** One row's rendered truth, straight off the DOM. */
  const ROW = (id) => R(`(function () {
    var r = document.querySelector('.row[data-filing-id="${id}"]');
    var b = r.querySelector('.act-status');
    var m = r.querySelector('.rowmsg');
    return {
      rowClass: r.className,
      btn: b.textContent, disabled: b.disabled, primary: b.classList.contains('primary'),
      title: b.title, msg: m ? m.textContent : null
    };
  })()`);
  const show = (label, s) => {
    out('');
    out(`   ── ${label} ${'─'.repeat(Math.max(0, 56 - label.length))}`);
    out(`      button : "${s.btn}" ${s.disabled ? 'DISABLED' : 'enabled'}${s.primary ? ' /primary' : ''}`);
    out(`      row    : ${s.rowClass}`);
    if (s.msg) out(`      msg    : ${s.msg}`);
    if (s.disabled && s.title) out(`      why    : ${s.title}`);
  };

  // ── B1 · the happy hand-back ──────────────────────────────────────────────────────────────
  out('');
  out('──── B1 — row 201 (real emitter return_url): click ✓ Mark as submitted ───────');
  {
    let s = await ROW(201);
    show('before the click', s);
    check('button reads "✓ Mark as submitted" and is live', /Mark as submitted/.test(s.btn) && !s.disabled, s);

    await R('document.querySelector(\'.row[data-filing-id="201"] .act-status\').click()');
    await sleep(500); // renderer → preload → ipcMain → shell → back

    check('🔴 shell.openExternal was invoked exactly once', opened.length === 1, opened);
    check('🔴 …with the EMITTER\'S return_url, byte for byte', opened[0] === RETURN_URL, opened[0]);

    s = await ROW(201);
    show('after the click', s);
    check('the row flipped to the optimistic submitted state (s-await)', /s-await/.test(s.rowClass), s.rowClass);
    check('🔴 the row SAYS the Helper cannot see whether it was recorded',
      /cannot see whether it was recorded/.test(s.msg || ''), s.msg);
    check('🔴 it does NOT claim "✓ Submitted" — the server\'s word, which never arrived',
      !/✓ Submitted/.test(s.btn), s.btn);
    check('the confirm can be reopened (browser tab closed too early)',
      /Reopen web confirm/.test(s.btn) && !s.disabled, s);

    const note = await R("document.getElementById('statusline').textContent.replace(/\\s+/g,' ').trim()");
    out(`      status : ${note}`);
    check('status line reports the browser hand-off, not a confirmation',
      /opened the web confirm in your browser/.test(note) && !/recorded|submitted ✓/.test(note), note);

    await R('document.querySelector(\'.row[data-filing-id="201"] .act-status\').click()');
    await sleep(400);
    check('reopening hands back the SAME url again', opened.length === 2 && opened[1] === RETURN_URL, opened);
  }

  // ── B2 · no return_url at all ─────────────────────────────────────────────────────────────
  out('');
  out('──── B2 — row 202 (arrived with NO return_url): refuse, and say why ─────────');
  {
    const s = await ROW(202);
    show('a row an older link produced', s);
    check('button is DISABLED — no broken URL is offered', s.disabled === true, s);
    check('it is not left looking clickable (no .primary)', s.primary === false, s);
    check('the tooltip explains and points at the fix', /without a usable return link/.test(s.title), s.title);
    check('🔴 the row states it too — loud, not silent (014 §7.9)',
      /No usable return link on this row/.test(s.msg || ''), s.msg);

    // Even called directly, past the disabled button, it must not fire.
    const before = opened.length;
    await R('window.tm30Shell.markSubmitted(window.tm30Shell.state.worklist[1])');
    await sleep(300);
    check('🔴 forced past the button, still nothing was opened', opened.length === before, opened);
    check('and the row did NOT flip to submitted', !/s-await/.test((await ROW(202)).rowClass));
  }

  // ── B3 · a return_url that is a string but not a place ────────────────────────────────────
  out('');
  out('──── B3 — row 203 (return_url = "javascript:alert(1)"): same refusal ────────');
  {
    const s = await ROW(203);
    show('a non-http(s) return_url', s);
    check('canHandBack rejects it', (await R('window.tm30Shell.canHandBack(window.tm30Shell.state.worklist[2])')) === false);
    check('button is DISABLED', s.disabled === true, s);

    const before = opened.length;
    await R('window.tm30Shell.markSubmitted(window.tm30Shell.state.worklist[2])');
    await sleep(300);
    check('🔴 nothing was handed to the browser', opened.length === before, opened);
    const after = await ROW(203);
    check('the refusal is stated on the row, not swallowed',
      /no usable return link/.test(after.msg || ''), after.msg);
    check('and it still did NOT flip to submitted', !/s-await/.test(after.rowClass), after.rowClass);
  }

  // ── B4 · the constraints this ticket must not break ───────────────────────────────────────
  out('');
  out('──── B4 — the standing constraints ─────────────────────────────────────────');
  {
    const src = read(path.join(HELPER, 'app.html'));
    const mainSrc = read(path.join(HELPER, 'main.js'));

    check('🔴 the Helper made ZERO network calls of its own (014 §2.5): no fetch/XHR in app.html',
      !/^(?!\s*(\/\/|\*|\/\*)).*\b(fetch|XMLHttpRequest)\s*\(/m.test(
        src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|.*│)/.test(l)).join('\n')
      ));
    check('the hand-back reuses `tm30Native.openExternal` — no new IPC verb was added',
      /tm30Native\.openExternal\(row\.return_url\)/.test(src));
    check('main.js still owns exactly one open-external handler, backed by shell.openExternal',
      (mainSrc.match(/ipcMain\.handle\('tm30:open-external'/g) || []).length === 1 &&
        /shell\.openExternal\(String\(rawUrl\)\)/.test(mainSrc));
    check('main.js keeps its own http(s) guard on that handler',
      /tm30:open-external[\s\S]{0,120}isHttpUrl\(rawUrl\)/.test(mainSrc));
    check('🔴 the hand-back never touches the portal webview',
      !/portal[\s\S]{0,40}return_url|return_url[\s\S]{0,40}portal/.test(src));
    check('no TODO(4f) marker survives', !/TODO\(4f\)/.test(src));
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('══════════════════════════════════════════════════════════════════════════════');
  out(`  ${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} assertion(s) held, ${failed} failed`);
  out('');
  out('  NOT covered here: the live click-through. The Helper hands the URL to the browser and');
  out('  goes blind by design — the manager pressing Confirm, endpoint #9 writing `submitted_by`');
  out('  and `receipt_no`, and the status coming back on the next worklist all need a running');
  out('  web app + backend. That round trip is an INTEGRATION item, not a Helper unit.');
  out('══════════════════════════════════════════════════════════════════════════════');

  app.exit(failed === 0 ? 0 : 1);
});
