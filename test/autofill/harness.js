'use strict';

/**
 * A-WEB-4e — THE CREDENTIAL-AUTOFILL HARNESS.
 *
 * Runs the REAL, SHIPPED `app.html` + `preload.js` in a real Electron window with a real v2
 * deep-link payload, then points the portal `<webview>` at a fake portal that reproduces the real
 * one's TIMING (challenge → login form → token). Everything under assertion is production code:
 * the `onActiveVillaChange` subscription, the injected script, the poller, the status-line
 * transitions, `villaSession`, and the locked/unlocked render.
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

const { app, BrowserWindow } = require('electron');
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

  let portalWc = null;
  win.webContents.on('did-attach-webview', (_e, wc) => {
    portalWc = wc;
    wc.on('console-message', (_ev, _lvl, m) => {
      if (m.indexOf('[fake-portal]') === 0) out('   portal │ ' + m.replace('[fake-portal] ', ''));
    });
    /**
     * TEST-ONLY: swap the live portal for the fake one. This is the harness navigating the
     * webview from the MAIN process — `app.html` itself never navigates it (see the "what 4e
     * deliberately does NOT do" note at the end of the 4e section).
     */
    wc.loadURL(portalUrl);
  });
  win.webContents.on('console-message', (_e, _l, m) => {
    if (m.indexOf('[tm30-helper]') === 0) out('   helper │ ' + m.replace('[tm30-helper] ', ''));
  });

  await win.loadFile(path.join(HELPER, 'app.html'), { query: { d: b64url } });
  await sleep(1200);

  const R = (js) => win.webContents.executeJavaScript(js);
  const fields = () =>
    portalWc.executeJavaScript('window.__harnessFields ? window.__harnessFields() : null');
  const select = (villa) => R(`window.tm30Shell.setActiveVilla(${JSON.stringify(villa)})`);

  /** Forget every session and deselect, so each scenario starts from a cold Helper. */
  const RESET =
    'window.tm30Shell.state.villaSession = Object.create(null);' +
    'window.tm30Shell.setActiveVilla(null);' +
    'window.tm30Shell.renderList();';
  async function coldStart() {
    await R(RESET);
    await portalWc.loadURL(portalUrl); // restarts the fake portal's clock at t=0
    await sleep(250);
  }

  // ── snapshot of everything 4e drives ───────────────────────────────────────────────────
  const SNAP = `(function () {
    var S = window.tm30Shell;
    return {
      status: document.getElementById('statusline').textContent.replace(/\\s+/g, ' ').trim(),
      groups: Array.prototype.map.call(document.querySelectorAll('.vgroup'), function (g) {
        return {
          villa: g.getAttribute('data-villa'),
          cls: g.className,
          pill: g.querySelector('.vg-pill').textContent,
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
    out(`      session: [${s.sessions.join(', ')}]   pending: ${s.pending.villa || '—'}`);
  }

  const rowsOf = (s, villa) => s.rows.filter((r) => r.villa === villa);
  const groupOf = (s, villa) => s.groups.filter((g) => g.villa === villa)[0];

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 1 — BOOT: locked by construction, nothing injected ══════════════════════');
  {
    const s = await R(SNAP);
    show('boot', s);
    check('no villa selected → no autofill pending', s.pending.villa === null, s.pending);
    check('no sessions exist yet', s.sessions.length === 0, s.sessions);
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
    await sleep(400); // t≈0.4s — form has NOT mounted yet
    let s = await R(SNAP);
    let f = await fields();
    show('t≈0.4s — login form does not exist yet', s);
    out(`      portal : ${JSON.stringify(f)}`);
    check('status reads "waiting for captcha…"', /waiting for captcha…/.test(s.status), s.status);
    check('fields do not exist yet, so nothing was typed', !f.userExists && !f.passExists);
    check('the poller is alive, waiting', f.pollerLive === true);

    await sleep(1800); // t≈2.2s — fields exist, but the human has NOT solved the challenge
    s = await R(SNAP);
    f = await fields();
    show('t≈2.2s — fields exist, challenge NOT cleared', s);
    out(`      portal : ${JSON.stringify(f)}`);
    check('🔴 fields exist but the token is empty → still NOTHING typed',
      f.userExists && f.passExists && f.user === '' && f.pass === '', f);
    check('status still reads "waiting for captcha…"', /waiting for captcha…/.test(s.status), s.status);
    check('villa is still locked', groupOf(s, 'Villa Suriyan 2').locked === true);

    await sleep(2500); // t≈4.7s — the "human" cleared it at t=3.5s
    s = await R(SNAP);
    f = await fields();
    show('t≈4.7s — human cleared the challenge', s);
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
    await portalWc.loadURL(portalUrl); // ← destroys the injected poller
    out('   ↻ webview navigated — the injected poller is gone');
    await sleep(600);
    check('poller was re-injected after the navigation', (await fields()).pollerLive === true);
    await sleep(4000);
    const f = await fields();
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
    await sleep(4200); // past the moment the challenge clears
    const f = await fields();
    const s = await R(SNAP);
    show('after switching to the cred-less villa', s);
    out(`      portal : ${JSON.stringify(f)}`);
    check('🔴 challenge cleared, yet NOTHING was typed', f.token !== '' && f.user === '' && f.pass === '', f);
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
    await sleep(4200);
    const f = await fields();
    const s = await R(SNAP);
    show('after the cred→cred switch', s);
    out(`      portal : ${JSON.stringify(f)}`);
    check('typed villa B\'s login', f.user === ANDA.login, f.user);
    check('typed villa B\'s password', f.pass === ANDA.pass, f.pass);
    check('🔴 did NOT type villa A\'s password', f.pass !== SURIYAN.pass);
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
    const f = await fields();
    const s = await R(SNAP);
    show('cred-less villa, 4.2s after selecting', s);
    out(`      portal : ${JSON.stringify(f)}`);
    check('🔴 nothing was injected', f.user === '' && f.pass === '' && f.pollerLive === false, f);
    check('the portal pane is still up for MANUAL login', f.userExists && f.passExists);
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
  out('════ 9 — STALE-FLAG: one villa\'s fill must not open another\'s session ════════');
  out('   (A fills → the portal SPA-routes off the login page → B is selected. No navigation,');
  out('    so window.__tm30Filled survives — the exact state the per-selection token guards.)');
  await coldStart();
  await select('Villa Suriyan 2');
  await sleep(4500); // A genuinely fills; __tm30Filled is now set
  {
    const before = await R(SNAP);
    check('precondition: villa A filled and holds the flag',
      before.sessions.indexOf('Villa Suriyan 2') >= 0 && (await fields()).filledFlag !== null);

    await portalWc.executeJavaScript('window.__harnessRemoveForm()'); // SPA nav — flag SURVIVES
    await select('Villa Anda'); // B: nothing can be typed, the form is gone
    await sleep(2500);

    const f = await fields();
    const s = await R(SNAP);
    show('villa B selected after A filled, with no login form present', s);
    out(`      portal : ${JSON.stringify(f)}`);
    check('the login form really is gone', f.userExists === false && f.passExists === false);
    check('🔴 villa B did NOT inherit villa A\'s fill as a session',
      s.sessions.indexOf('Villa Anda') < 0, s.sessions);
    check('villa B is still locked', groupOf(s, 'Villa Anda').locked === true);
    check('villa B still reads "waiting for captcha…"', /waiting for captcha…/.test(s.status), s.status);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  out('');
  out('════ 10 — PORTAL NO-GO STATIC AUDIT of the shipped app.html ══════════════════');
  {
    const src = fs.readFileSync(path.join(HELPER, 'app.html'), 'utf8');
    const BANNED = [
      ['click()', /\.click\s*\(/],
      ['submit()', /\.submit\s*\(/],
      ['form submit', /submit\s*\(\s*\)/],
      ['loadURL', /loadURL/],
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
      const code = hits.filter(([, l]) => !/^\s*(\/\/|\*|\/\*|.*│)/.test(l));
      check(`no ${label} in code (${hits.length - code.length} mention(s) in comments)`, code.length === 0,
        code.map(([n, l]) => `app.html:${n} ${l.trim().slice(0, 80)}`));
    });
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
