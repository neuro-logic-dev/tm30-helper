'use strict';

/**
 * A-WEB-4e — THE CREDENTIAL-AUTOFILL HARNESS.
 * A-WEB-4g — extended for the PER-VILLA WEBVIEW POOL: each villa now gets its own <webview>
 *            on its own `persist:tm30-v-…` partition, so the harness maps every attached
 *            webContents back to its villa THROUGH ITS PARTITION, points each pool webview at
 *            the fake portal, and asserts the pool isolation + ↻ fresh-login scenarios.
 *
 * Runs the REAL, SHIPPED `app.html` + `preload.js` in a real Electron window with a real v2
 * deep-link payload, then points the portal `<webview>`s at a fake portal that reproduces the
 * real one's TIMING (challenge → login form → token). Everything under assertion is production
 * code: the `onActiveVillaChange` subscription, the injected script, the poller, the status-line
 * transitions, `villaSession`, the locked/unlocked render, the pool switch and the fresh-login
 * reset (renderer → preload → ipcMain → `session.fromPartition(...).clearStorageData()`).
 *
 * ── Why a fake portal, and what that costs ──────────────────────────────────────────────────
 * The live portal's Cloudflare challenge can only be cleared by a HUMAN (010 §8 — and clearing it
 * from a script is the exact thing the Portal NO-GO forbids). So a live end-to-end autofill is not
 * automatable, by design, and never will be. This harness therefore proves the WIRING and the
 * TIMING; it does NOT prove v1's selectors still match the real login page. That single remaining
 * question is written up as the ⚠️ INTEGRATION ITEM on `buildAutofillScript` in `app.html`, and
 * `live-probe.js` next to this file is the read-only tool for answering it.
 *
 * Usage:  test/run-autofill.sh          (or: node_modules/.bin/electron test/autofill/harness.js)
 * Exit:   0 = every assertion held, 1 = something regressed.
 */

const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

const HELPER = path.resolve(__dirname, '..', '..'); // desktop/tm30-helper
const { b64url, SURIYAN, ANDA } = require('./fixture.js');
const PAGE = fs.readFileSync(path.join(__dirname, 'fake-portal.html'), 'utf8');

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

/**
 * 4g TEST-ONLY: this harness boots Electron WITH ITSELF as the main script (that is what lets
 * it stand in a fake portal), so the REAL `main.js` never runs here and its
 * `tm30:reset-portal-session` handler is not registered. The handler below is main.js's,
 * REPLICATED VERBATIM so the renderer→preload→ipcMain→clearStorageData path under ↻ fresh
 * login runs for real — and scenario 13 statically asserts that main.js still registers the
 * same channel with the same `persist:tm30-` guard and `clearStorageData()` body, so this
 * copy cannot drift from the shipped one silently. (`run-handback.sh` boots the real main.js,
 * where the real registration happens.)
 */
ipcMain.handle('tm30:reset-portal-session', async (_event, partition) => {
  if (typeof partition !== 'string' || !partition.startsWith('persist:tm30-')) {
    return { ok: false, error: 'not a tm30 partition' };
  }
  try {
    await session.fromPartition(partition).clearStorageData();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/** A hang is a failure, not a suite that never finishes (mirrors the handback harness). */
const HARNESS_TIMEOUT_MS = 180_000;
setTimeout(() => {
  out('✗ the harness timed out — nothing finished it.');
  app.exit(1);
}, HARNESS_TIMEOUT_MS).unref();

app.whenReady().then(async () => {
  // ── the fake portal ────────────────────────────────────────────────────────────────────
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const portalUrl = `http://127.0.0.1:${server.address().port}/`;
  out(`▸ fake portal at ${portalUrl}`);

  // Same options as main.js `openWorklistWindow` — same preload, same webviewTag.
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { webviewTag: true, preload: path.join(HELPER, 'preload.js') },
  });

  /**
   * 4g: the pool creates ONE webview per villa, lazily, so several webContents attach over a
   * run. Every one of them is collected here and immediately pointed at the fake portal.
   * TEST-ONLY: this is the harness navigating from the MAIN process — `app.html` itself never
   * navigates on selection (see the "what 4e deliberately does NOT do" note in its 4e section;
   * the one in-app navigation is ↻ fresh login, asserted below).
   */
  const attached = new Set();
  win.webContents.on('did-attach-webview', (_e, wc) => {
    attached.add(wc);
    wc.on('console-message', (_ev, _lvl, m) => {
      if (m.indexOf('[fake-portal]') === 0) out('   portal │ ' + m.replace('[fake-portal] ', ''));
    });
    wc.loadURL(portalUrl).catch(() => {}); // racing the src load — toFakePortal re-parks later
  });
  win.webContents.on('console-message', (_e, _l, m) => {
    if (m.indexOf('[tm30-helper]') === 0) out('   helper │ ' + m.replace('[tm30-helper] ', ''));
  });

  /**
   * Map an attached webContents back to its villa THROUGH ITS PARTITION:
   * `session.fromPartition` memoizes, so identity with the villa's expected partition session
   * is exactly "this webContents runs in villa X's cookie jar". No ids, no ordering guesses.
   */
  const wcFor = (villa) => {
    const target = session.fromPartition(PART(villa));
    for (const wc of attached) if (!wc.isDestroyed() && wc.session === target) return wc;
    return null;
  };

  await win.loadFile(path.join(HELPER, 'app.html'), { query: { d: b64url } });
  await sleep(1200);

  const R = (js) => win.webContents.executeJavaScript(js);

  /**
   * Park a webContents on the fake portal, tolerating aborts. On a networked machine a pool
   * webview really reaches the LIVE portal (its `src`, and the ↻ fresh-login reload), and the
   * live Cloudflare challenge issues redirects of its own — those abort a same-moment
   * `loadURL(portalUrl)` with ERR_ABORTED. Retry until the fake portal actually holds.
   */
  async function toFakePortal(wc) {
    for (let i = 0; i < 6; i += 1) {
      try {
        await wc.loadURL(portalUrl);
        return;
      } catch (e) {
        await sleep(200);
        if (wc.getURL().indexOf(portalUrl) === 0 && !wc.isLoading()) return;
      }
    }
    throw new Error('could not park a webview on the fake portal');
  }

  const fields = (villa) => {
    const wc = wcFor(villa);
    return wc
      ? wc.executeJavaScript('window.__harnessFields ? window.__harnessFields() : null')
      : Promise.resolve(null);
  };
  const select = (villa) => R(`window.tm30Shell.setActiveVilla(${JSON.stringify(villa)})`);

  /** Forget every session and deselect, so each scenario starts from a cold Helper. */
  const RESET =
    'window.tm30Shell.state.villaSession = Object.create(null);' +
    'window.tm30Shell.setActiveVilla(null);' +
    'window.tm30Shell.renderList();';
  async function coldStart() {
    await R(RESET);
    // 4g: every pool webview goes back to the fake portal's t=0 — one clock per villa now.
    for (const wc of attached) if (!wc.isDestroyed()) await toFakePortal(wc);
    await sleep(250);
  }

  // ── snapshot of everything 4e/4g drive ─────────────────────────────────────────────────
  const SNAP = `(function () {
    var S = window.tm30Shell;
    return {
      status: document.getElementById('statusline').textContent.replace(/\\s+/g, ' ').trim(),
      groups: Array.prototype.map.call(document.querySelectorAll('.vgroup'), function (g) {
        return {
          villa: g.getAttribute('data-villa'),
          cls: g.className,
          pill: g.querySelector('.vg-pill').textContent,
          fresh: !!g.querySelector('.vg-fresh'),
          locked: S.isLocked(g.getAttribute('data-villa'))
        };
      }),
      rows: Array.prototype.map.call(document.querySelectorAll('.row'), function (r) {
        var mk = r.querySelector('.act-status');
        var sh = r.querySelector('.act-sheet');
        var fo = r.querySelector('.act-folder');
        return {
          villa: r.getAttribute('data-villa'),
          id: r.getAttribute('data-filing-id'),
          markPrimary: mk.classList.contains('primary'),
          markDisabled: mk.disabled,
          sheetDisabled: sh.disabled,
          folderDisabled: fo.disabled
        };
      }),
      pool: Array.prototype.map.call(document.querySelectorAll('webview[data-villa]'), function (w) {
        return {
          villa: w.getAttribute('data-villa'),
          partition: w.getAttribute('partition'),
          hidden: w.classList.contains('hidden')
        };
      }),
      activePortal: S.portal ? S.portal.getAttribute('data-villa') : null,
      sessions: Object.keys(S.state.villaSession),
      pending: { villa: S.autofill.villa, login: S.autofill.login, token: S.autofill.token }
    };
  })()`;

  function show(label, s) {
    out('');
    out(`   ── ${label} ${'─'.repeat(Math.max(0, 58 - label.length))}`);
    out(`      status : ${s.status}`);
    s.groups.forEach((g) =>
      out(`      group  : ${g.villa.padEnd(16)} pill="${g.pill}" locked=${g.locked} class="${g.cls}"`)
    );
    s.rows.forEach((r) =>
      out(
        `      row ${r.id}: ${r.villa.padEnd(16)} mark=${r.markPrimary ? 'primary' : 'DIMMED '}` +
          `${r.markDisabled ? '/disabled' : '/enabled '} · sheet=${r.sheetDisabled ? 'DISABLED' : 'enabled'}` +
          ` · folder=${r.folderDisabled ? 'DISABLED' : 'enabled'}`
      )
    );
    s.pool.forEach((p) =>
      out(`      webview: ${p.villa.padEnd(16)} ${p.hidden ? 'hidden ' : 'VISIBLE'} ${p.partition}`)
    );
    out(`      session: [${s.sessions.join(', ')}]   pending: ${s.pending.villa || '—'}` +
        `   active portal: ${s.activePortal || '—'}`);
  }

  const rowsOf = (s, villa) => s.rows.filter((r) => r.villa === villa);
  const groupOf = (s, villa) => s.groups.filter((g) => g.villa === villa)[0];
  const poolOf = (s, villa) => s.pool.filter((p) => p.villa === villa)[0];

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 1 — BOOT: locked by construction, nothing injected, EMPTY pool ══════════');
  {
    const s = await R(SNAP);
    show('boot', s);
    check('no villa selected → no autofill pending', s.pending.villa === null, s.pending);
    check('no sessions exist yet', s.sessions.length === 0, s.sessions);
    check('4g: the pool is LAZY — no webview exists before the first selection',
      s.pool.length === 0, s.pool);
    check('4g: tm30Shell.portal is null before the first selection', s.activePortal === null);
    check('4g: every group carries the ↻ fresh-login control (creds or not)',
      s.groups.every((g) => g.fresh), s.groups);
    check('credentialled villa renders LOCKED', groupOf(s, 'Villa Suriyan 2').locked === true);
    check('cred-less villa is NOT locked (it is manual login)',
      groupOf(s, 'Villa Baan Ork').locked === false &&
        groupOf(s, 'Villa Baan Ork').pill === 'manual login');
    check('locked villa: mark-submitted is DIMMED but still ENABLED',
      rowsOf(s, 'Villa Suriyan 2').every((r) => !r.markPrimary && !r.markDisabled));
    check('🔴 locked villa: ⬇ xlsx stays ENABLED (Drive-side, not portal-gated)',
      rowsOf(s, 'Villa Suriyan 2').every((r) => !r.sheetDisabled));
    check('🔴 locked villa: 📁 folder stays ENABLED (Drive-side, not portal-gated)',
      rowsOf(s, 'Villa Suriyan 2').every((r) => !r.folderDisabled));
    check('cred-less villa: mark-submitted is NOT dimmed (never gated on a session it cannot get)',
      rowsOf(s, 'Villa Baan Ork').every((r) => r.markPrimary));
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 2 — THE INJECTED SCRIPT, VERBATIM ═══════════════════════════════════════');
  {
    const script = await R(
      `window.tm30Shell.buildAutofillScript(${JSON.stringify(SURIYAN.login)},` +
        `${JSON.stringify(SURIYAN.pass)},'tm30-fill-DEMO')`
    );
    out(script.replace(/^/gm, '   │'));
    check('injects v1\'s #user selector', script.indexOf('getElementById("user")') >= 0);
    check('injects v1\'s #pass selector', script.indexOf('getElementById("pass")') >= 0);
    check('polls v1\'s cf-turnstile-response selector',
      script.indexOf('input[name="cf-turnstile-response"]') >= 0);
    check('uses v1\'s native-value-setter workaround',
      script.indexOf('getOwnPropertyDescriptor(HTMLInputElement.prototype') >= 0);
    check('🔴 contains NO click / submit / navigation',
      !/\.click\s*\(|\.submit\s*\(|location\s*=|loadURL/.test(script));
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 3 — HAPPY PATH: waiting for captcha… → credentials filled ✓ ═════════════');
  await coldStart();
  await select('Villa Suriyan 2');
  {
    await sleep(600); // the villa's webview was just CREATED (4g) — fake portal at t≈0.4s
    let s = await R(SNAP);
    let f = await fields('Villa Suriyan 2');
    show('t≈0.4s — login form does not exist yet', s);
    out(`      portal : ${JSON.stringify(f)}`);
    check('4g: the villa got its OWN webview, on its OWN persist: partition',
      poolOf(s, 'Villa Suriyan 2') &&
        poolOf(s, 'Villa Suriyan 2').partition === PART('Villa Suriyan 2'), s.pool);
    check('4g: tm30Shell.portal resolves to the ACTIVE villa\'s webview',
      s.activePortal === 'Villa Suriyan 2', s.activePortal);
    check('status reads "waiting for captcha…"', /waiting for captcha…/.test(s.status), s.status);
    check('fields do not exist yet, so nothing was typed', !f.userExists && !f.passExists);
    check('the poller is alive, waiting', f.pollerLive === true);

    await sleep(1800); // t≈2.2s — fields exist, but the human has NOT solved the challenge
    s = await R(SNAP);
    f = await fields('Villa Suriyan 2');
    show('t≈2.2s — fields exist, challenge NOT cleared', s);
    out(`      portal : ${JSON.stringify(f)}`);
    check('🔴 fields exist but the token is empty → still NOTHING typed',
      f.userExists && f.passExists && f.user === '' && f.pass === '', f);
    check('status still reads "waiting for captcha…"', /waiting for captcha…/.test(s.status), s.status);
    check('villa is still locked', groupOf(s, 'Villa Suriyan 2').locked === true);

    await sleep(3000); // t≈5.2s — the "human" cleared it at t=3.5s
    s = await R(SNAP);
    f = await fields('Villa Suriyan 2');
    show('t≈5.2s — human cleared the challenge', s);
    out(`      portal : ${JSON.stringify(f)}`);
    check('login was typed into #user', f.user === SURIYAN.login, f.user);
    check('password was typed into #pass', f.pass === SURIYAN.pass, f.pass);
    check('the poller stopped after filling', f.pollerLive === false);
    check('status reads "credentials filled ✓"', /credentials filled ✓/.test(s.status), s.status);
    check('villaSession written, keyed by VILLA (AMB-1)',
      s.sessions.length === 1 && s.sessions[0] === 'Villa Suriyan 2', s.sessions);
    check('group unlocked: pill → 🔓 session open',
      groupOf(s, 'Villa Suriyan 2').pill === '🔓 session open' &&
        groupOf(s, 'Villa Suriyan 2').locked === false);
    check('🔴 ONE solve unlocked BOTH filings in the group (014 §7.2)',
      rowsOf(s, 'Villa Suriyan 2').length === 2 &&
        rowsOf(s, 'Villa Suriyan 2').every((r) => r.markPrimary));
    check('the OTHER credentialled villa stayed locked (per-villa, not global)',
      groupOf(s, 'Villa Anda').locked === true);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 4 — NAVIGATION MID-WAIT: dom-ready must re-inject the poller ════════════');
  out('   (the human bounces off a failed login back to the form)');
  await coldStart();
  await select('Villa Suriyan 2');
  {
    await sleep(1000);
    await toFakePortal(wcFor('Villa Suriyan 2')); // ← destroys the injected poller
    out('   ↻ webview navigated — the injected poller is gone');
    await sleep(600);
    check('poller was re-injected after the navigation',
      (await fields('Villa Suriyan 2')).pollerLive === true);
    await sleep(4000);
    const f = await fields('Villa Suriyan 2');
    const s = await R(SNAP);
    out(`      portal : ${JSON.stringify(f)}`);
    check('the fill still landed on the new page', f.user === SURIYAN.login && f.pass === SURIYAN.pass, f);
    check('session opened despite the navigation', s.sessions.indexOf('Villa Suriyan 2') >= 0);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 5 — SWITCH MID-WAIT → cred-less: the pending password must not leak ═════');
  await coldStart();
  await select('Villa Suriyan 2');
  await sleep(800);
  await select('Villa Baan Ork'); // superseded BEFORE the token clears
  {
    await sleep(4200); // past the moment villa A's own challenge clears
    const fA = await fields('Villa Suriyan 2');
    const fB = await fields('Villa Baan Ork');
    const s = await R(SNAP);
    show('after switching to the cred-less villa', s);
    out(`      portal A: ${JSON.stringify(fA)}`);
    out(`      portal B: ${JSON.stringify(fB)}`);
    check('🔴 A\'s challenge cleared, yet NOTHING was typed in A\'s page (poller torn down)',
      fA.token !== '' && fA.user === '' && fA.pass === '' && fA.pollerLive === false, fA);
    check('🔴 nothing was ever injected into the cred-less villa\'s OWN page',
      fB && fB.user === '' && fB.pass === '' && fB.pollerLive === false, fB);
    check('no session was opened for either villa', s.sessions.length === 0, s.sessions);
    check('nothing is pending', s.pending.villa === null, s.pending);
    check('status shows the cred-less state', /no credentials — log in manually/.test(s.status), s.status);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 6 — SWITCH MID-WAIT → other creds: B\'s password, never A\'s ═════════════');
  await coldStart();
  await select('Villa Suriyan 2');
  await sleep(800);
  await select('Villa Anda');
  {
    await sleep(5200); // villa B's OWN page: form ≈+1.5s, challenge ≈+3.5s after creation
    const fA = await fields('Villa Suriyan 2');
    const fB = await fields('Villa Anda');
    const s = await R(SNAP);
    show('after the cred→cred switch', s);
    out(`      portal A: ${JSON.stringify(fA)}`);
    out(`      portal B: ${JSON.stringify(fB)}`);
    check('typed villa B\'s login into B\'s OWN page', fB.user === ANDA.login, fB.user);
    check('typed villa B\'s password', fB.pass === ANDA.pass, fB.pass);
    check('🔴 did NOT type villa A\'s password anywhere', fB.pass !== SURIYAN.pass && fA.pass !== SURIYAN.pass);
    check('🔴 4g: A\'s superseded poller was torn down in A\'s page — nothing typed there',
      fA.user === '' && fA.pass === '' && fA.pollerLive === false, fA);
    check('session belongs to B only', s.sessions.length === 1 && s.sessions[0] === 'Villa Anda', s.sessions);
    check('villa A is still locked', groupOf(s, 'Villa Suriyan 2').locked === true);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 7 — CRED-LESS VILLA: inert, and never an error ══════════════════════════');
  await coldStart();
  await select('Villa Baan Ork');
  {
    await sleep(4200);
    const f = await fields('Villa Baan Ork');
    const s = await R(SNAP);
    show('cred-less villa, 4.2s after selecting', s);
    out(`      portal : ${JSON.stringify(f)}`);
    check('🔴 nothing was injected', f.user === '' && f.pass === '' && f.pollerLive === false, f);
    check('the portal pane is still up for MANUAL login', f.userExists && f.passExists);
    check('4g: the cred-less villa still got its own webview + partition',
      poolOf(s, 'Villa Baan Ork') &&
        poolOf(s, 'Villa Baan Ork').partition === PART('Villa Baan Ork'), s.pool);
    check('pill reads "manual login", not an error', groupOf(s, 'Villa Baan Ork').pill === 'manual login');
    check('group class is no-acct (never "locked")',
      /no-acct/.test(groupOf(s, 'Villa Baan Ork').cls) && !/\blocked\b/.test(groupOf(s, 'Villa Baan Ork').cls));
    check('its ⬇ xlsx and 📁 folder work',
      rowsOf(s, 'Villa Baan Ork').every((r) => !r.sheetDisabled && !r.folderDisabled));
    check('no session, no captcha-wait status',
      s.sessions.length === 0 && !/waiting for captcha/.test(s.status), s.status);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 8 — RESELECT: an open session must not re-wait for a captcha ════════════');
  await coldStart();
  await select('Villa Suriyan 2');
  await sleep(4500); // fill lands
  await select('Villa Baan Ork');
  await sleep(400);
  await select('Villa Suriyan 2'); // back again
  {
    await sleep(600);
    const s = await R(SNAP);
    show('reselected a villa that already has a session', s);
    check('status goes straight back to "credentials filled ✓"',
      /credentials filled ✓/.test(s.status), s.status);
    check('no new autofill was started', s.pending.villa === null, s.pending);
    check('the session survived the round trip', s.sessions.indexOf('Villa Suriyan 2') >= 0);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 9 — POOL ISOLATION: one webview per villa, no reload on switch ══════════');
  out('   (log in A → select B: B shows B\'s OWN fresh document, never A\'s logged-in page;');
  out('    switch back: A\'s in-page state survived, byte for byte — the pool never reloads.)');
  await coldStart();
  await select('Villa Suriyan 2');
  await sleep(4800); // A fills, session opens
  {
    // Plant an in-page marker in A. A reload — the thing a switch must NEVER do — wipes it.
    await wcFor('Villa Suriyan 2').executeJavaScript('window.__harnessMarker = "A-alive"; true');

    await select('Villa Anda');
    await sleep(600);
    let s = await R(SNAP);
    show('villa B selected while A holds a session', s);
    check('B is the ACTIVE portal now', s.activePortal === 'Villa Anda', s.activePortal);
    check('🔴 exactly the active webview is visible, the rest are display:none',
      s.pool.length >= 2 && s.pool.every((p) => p.hidden === (p.villa !== 'Villa Anda')), s.pool);
    check('🔴 every pool webview carries its own persist:tm30-v-<enc(villa)> partition, all distinct',
      s.pool.every((p) => p.partition === PART(p.villa)) &&
        new Set(s.pool.map((p) => p.partition)).size === s.pool.length, s.pool);
    check('🔴 B\'s webview is B\'s OWN document — A\'s marker is not in it',
      (await wcFor('Villa Anda').executeJavaScript('window.__harnessMarker || null')) === null);

    await sleep(2000); // B's own challenge cleared during A's wait → B fills fast
    const fB = await fields('Villa Anda');
    s = await R(SNAP);
    out(`      portal B: ${JSON.stringify(fB)}`);
    check('B autofilled with B\'s OWN credentials in B\'s OWN page',
      fB.user === ANDA.login && fB.pass === ANDA.pass, fB);
    check('both villas hold sessions now — isolation, not replacement',
      s.sessions.indexOf('Villa Suriyan 2') >= 0 && s.sessions.indexOf('Villa Anda') >= 0,
      s.sessions);

    await select('Villa Suriyan 2'); // back to A
    await sleep(400);
    const fA = await fields('Villa Suriyan 2');
    const marker = await wcFor('Villa Suriyan 2').executeJavaScript('window.__harnessMarker || null');
    s = await R(SNAP);
    show('back on villa A', s);
    check('🔴 A\'s in-page marker SURVIVED the round trip — the switch did not reload',
      marker === 'A-alive', marker);
    check('A\'s filled fields survived too', fA.user === SURIYAN.login && fA.pass === SURIYAN.pass, fA);
    check('A is the active portal again and its pill still reads 🔓',
      s.activePortal === 'Villa Suriyan 2' && groupOf(s, 'Villa Suriyan 2').pill === '🔓 session open');
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 10 — STALE-FLAG: a stale __tm30Filled must never open a session ═════════');
  out('   (A fills → the portal SPA-routes off the login page, so the flag SURVIVES in A\'s');
  out('    page. 4g: villa B now has its own document and cannot even see it — and a');
  out('    RE-selection of A with a new token must not read it either. The token +');
  out('    `__tm30Filled = null` pair is still the mutation-tested guard for that window.)');
  await coldStart();
  await select('Villa Suriyan 2');
  await sleep(4800); // A genuinely fills; A's page now holds __tm30Filled = tm30-fill-N
  {
    const before = await R(SNAP);
    check('precondition: villa A filled and holds the flag',
      before.sessions.indexOf('Villa Suriyan 2') >= 0 &&
        (await fields('Villa Suriyan 2')).filledFlag !== null);

    await wcFor('Villa Suriyan 2').executeJavaScript('window.__harnessRemoveForm()'); // SPA — flag SURVIVES
    await toFakePortal(wcFor('Villa Anda')); // B's OWN clock back to t=0 (challenge unsolved)
    await select('Villa Anda');
    await sleep(2500); // before B's own challenge clears at t≈3.5s

    let s = await R(SNAP);
    show('villa B selected after A filled', s);
    check('🔴 villa B did NOT inherit villa A\'s fill as a session',
      s.sessions.indexOf('Villa Anda') < 0, s.sessions);
    check('villa B is still locked', groupOf(s, 'Villa Anda').locked === true);
    check('villa B still reads "waiting for captcha…"', /waiting for captcha…/.test(s.status), s.status);

    // The same-villa half: clear A's session STATE only — no navigation, no teardown, so the
    // stale flag stays behind in A's page — then reselect A, which arms a NEW token.
    await R('delete window.tm30Shell.state.villaSession["Villa Suriyan 2"];' +
            'window.tm30Shell.renderList();');
    await select('Villa Suriyan 2');
    await sleep(2000);

    const f = await fields('Villa Suriyan 2');
    s = await R(SNAP);
    show('villa A reselected with its stale flag still in the page', s);
    out(`      portal A: ${JSON.stringify(f)}`);
    check('the login form really is gone in A\'s page', f.userExists === false && f.passExists === false);
    check('🔴 A\'s STALE flag did not reopen A\'s session under the new token',
      s.sessions.indexOf('Villa Suriyan 2') < 0, s.sessions);
    check('villa A honestly reads "waiting for captcha…" again',
      /waiting for captcha…/.test(s.status), s.status);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 11 — ↻ FRESH LOGIN (creds): reset → portal root → autofill re-arms ══════');
  await coldStart();
  await select('Villa Suriyan 2');
  await sleep(4800); // session opens, fields filled
  {
    const wcA = wcFor('Villa Suriyan 2');
    // A cookie in A's partition — the native clearStorageData must take it out.
    await wcA.executeJavaScript('document.cookie = "tm30_harness=1"; true');
    // Watch where the fresh login sends A's webview.
    const navs = [];
    const onNav = (_e, url) => navs.push(url);
    wcA.on('did-start-navigation', onNav);

    const s0 = await R(SNAP);
    check('precondition: session open, pill 🔓',
      s0.sessions.indexOf('Villa Suriyan 2') >= 0 &&
        groupOf(s0, 'Villa Suriyan 2').pill === '🔓 session open');

    await R('document.querySelector(\'.vgroup[data-villa="Villa Suriyan 2"] .vg-fresh\').click(); true');
    await sleep(900); // IPC round-trip + loadURL initiated

    let s = await R(SNAP);
    show('right after ↻ fresh login', s);
    check('villaSession entry is gone — this villa\'s ONLY', s.sessions.indexOf('Villa Suriyan 2') < 0, s.sessions);
    check('pill is back to 🔒 log in', groupOf(s, 'Villa Suriyan 2').pill === '🔒 log in');
    check('status reads "waiting for captcha…" again — autofill re-armed as on first selection',
      /waiting for captcha…/.test(s.status) && s.pending.villa === 'Villa Suriyan 2', s);
    check('🔴 the webview was sent to the PORTAL ROOT — the one allowed navigation',
      navs.some((u) => String(u).indexOf('https://tm30.immigration.go.th') === 0), navs);
    check('no failure was rendered', !/fresh login (failed|unavailable)/.test(s.status), s.status);
    wcA.removeListener('did-start-navigation', onNav);

    // Stand in for the portal root arriving: the fake portal again, fresh clock.
    await toFakePortal(wcA);
    check('🔴 the partition\'s cookies were ACTUALLY cleared by the native reset',
      String(await wcA.executeJavaScript('document.cookie')).indexOf('tm30_harness') < 0);

    await sleep(4800); // form mounts, "human" clears the challenge, autofill lands again
    const f = await fields('Villa Suriyan 2');
    s = await R(SNAP);
    show('after the (fake) challenge cleared post-reset', s);
    out(`      portal : ${JSON.stringify(f)}`);
    check('autofill landed AGAIN after the reset', f.user === SURIYAN.login && f.pass === SURIYAN.pass, f);
    check('the session re-opened', s.sessions.indexOf('Villa Suriyan 2') >= 0, s.sessions);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 12 — ↻ FRESH LOGIN (cred-less): partition cleared, still never an error ═');
  await coldStart();
  await select('Villa Baan Ork');
  await sleep(500);
  {
    const wcB = wcFor('Villa Baan Ork');
    const navs = [];
    const onNav = (_e, url) => navs.push(url);
    wcB.on('did-start-navigation', onNav);

    await R('document.querySelector(\'.vgroup[data-villa="Villa Baan Ork"] .vg-fresh\').click(); true');
    await sleep(900);

    const s = await R(SNAP);
    show('cred-less villa after ↻ fresh login', s);
    check('pill STAYS "manual login"', groupOf(s, 'Villa Baan Ork').pill === 'manual login');
    check('nothing pending — no autofill exists to re-arm', s.pending.villa === null, s.pending);
    check('the webview went back to the portal root for a manual login',
      navs.some((u) => String(u).indexOf('https://tm30.immigration.go.th') === 0), navs);
    check('🔴 no error rendered — cred-less stays a NORMAL state (014 §7.9)',
      /no credentials — log in manually/.test(s.status) &&
        !/fresh login (failed|unavailable)/.test(s.status), s.status);
    wcB.removeListener('did-start-navigation', onNav);

    await toFakePortal(wcB); // the login page "arrives"
    await sleep(2000);
    const f = await fields('Villa Baan Ork');
    check('the fresh login page is up for manual typing, nothing injected',
      f.userExists && f.user === '' && f.pollerLive === false, f);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 13 — THE RESET IPC GUARD: only persist:tm30- partitions are clearable ═══');
  {
    const bad = await R('window.tm30Native.resetPortalSession("persist:definitely-not-ours")');
    check('🔴 a non-tm30 partition is refused with {ok:false}',
      bad && bad.ok === false && /not a tm30 partition/.test(bad.error || ''), bad);
    const noPersist = await R('window.tm30Native.resetPortalSession("tm30-v-Villa%20X")');
    check('a partition without the persist: prefix is refused too',
      noPersist && noPersist.ok === false, noPersist);
    const nonString = await R('window.tm30Native.resetPortalSession(null)');
    check('a non-string partition is refused', nonString && nonString.ok === false, nonString);
    const good = await R(`window.tm30Native.resetPortalSession(${JSON.stringify(PART('Villa Anda'))})`);
    check('a real per-villa partition clears with {ok:true}', good && good.ok === true, good);

    // The handler exercised above is the harness's verbatim COPY (see its comment up top —
    // this harness boots itself, not main.js). Pin the SHIPPED registration so the copy
    // cannot drift from it silently.
    const mainSrc = fs.readFileSync(path.join(HELPER, 'main.js'), 'utf8');
    check('main.js registers the real tm30:reset-portal-session handler',
      mainSrc.indexOf("ipcMain.handle('tm30:reset-portal-session'") >= 0);
    check('…with the same persist:tm30- prefix guard and clearStorageData body',
      mainSrc.indexOf("startsWith('persist:tm30-')") >= 0 &&
        mainSrc.indexOf("{ ok: false, error: 'not a tm30 partition' }") >= 0 &&
        /clearStorageData\(\)/.test(mainSrc));
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 14 — PORTAL NO-GO STATIC AUDIT of the shipped app.html ══════════════════');
  {
    const src = fs.readFileSync(path.join(HELPER, 'app.html'), 'utf8');
    const isComment = (l) => /^\s*(\/\/|\*|\/\*|.*│)/.test(l);
    const BANNED = [
      ['click()', /\.click\s*\(/],
      ['submit()', /\.submit\s*\(/],
      ['form submit', /submit\s*\(\s*\)/],
      ['webview .src assignment', /\.src\s*=/],
      ['fetch()', /\bfetch\s*\(/],
      ['XMLHttpRequest', /XMLHttpRequest/],
    ];
    BANNED.forEach(([label, re]) => {
      const hits = src
        .split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => re.test(line));
      // A hit inside a comment is fine — the NO-GO warning box names the things it forbids, and
      // a bare count cannot tell you that. Only non-comment lines count as violations.
      const code = hits.filter(([, l]) => !isComment(l));
      check(`no ${label} in code (${hits.length - code.length} mention(s) in comments)`, code.length === 0,
        code.map(([n, l]) => `app.html:${n} ${l.trim().slice(0, 80)}`));
    });
    /**
     * 4g: `loadURL` graduated from BANNED to RATIONED. The ↻ fresh-login reset is the one
     * human-click-initiated navigation the Portal NO-GO carve-out allows (010 §8; it goes only
     * to TM30_URL), so the audit now pins it to EXACTLY ONE code call site instead of zero —
     * a second one appearing anywhere is a regression, same as before.
     */
    {
      const hits = src
        .split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => /loadURL/.test(line));
      const code = hits.filter(([, l]) => !isComment(l));
      check(
        `loadURL appears in CODE exactly once — the ↻ fresh-login carve-out ` +
          `(${hits.length - code.length} mention(s) in comments)`,
        code.length === 1,
        code.map(([n, l]) => `app.html:${n} ${l.trim().slice(0, 80)}`));
      check('…and that one call site targets TM30_URL and nothing else',
        code.length === 1 && /loadURL\(TM30_URL\)/.test(code[0][1]), code.map(([, l]) => l.trim()));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('══════════════════════════════════════════════════════════════════════════════');
  out(`  ${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} assertion(s) held, ${failed} failed`);
  out('');
  out('  NOT covered here, and not coverable: a real autofill against the live portal.');
  out('  The challenge needs a human (010 §8), so this proves the WIRING and the TIMING.');
  out('  Whether v1\'s selectors match the real LOGIN page is open — run live-probe.js and');
  out('  see the ⚠️ INTEGRATION ITEM on buildAutofillScript in app.html.');
  out('══════════════════════════════════════════════════════════════════════════════');

  server.close();
  app.exit(failed === 0 ? 0 : 1);
});
