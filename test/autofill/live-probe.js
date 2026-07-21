'use strict';

/**
 * A-WEB-4e — LIVE PORTAL PROBE. **READ ONLY.**
 *
 * Answers the one question `harness.js` structurally cannot: do v1's selectors still describe the
 * real tm30.immigration.go.th login page?
 *
 * It loads the shipped `app.html` (so the webview goes to its own `src`), selects the
 * credentialled fixture villa — which starts the SHIPPED autofill poller — and then READS the
 * portal DOM: which inputs exist, their ids and names, forms, iframes, and whether the poller has
 * filled anything.
 *
 * 🔴 It does not click, type, submit, navigate, or interact with Turnstile in any way. There is no
 * human here to clear the challenge, so the poller CANNOT fill and MUST be observed still waiting.
 * That is the expected result and it is itself a check that the NO-GO line holds.
 *
 * ── What to look for, and the finding that made this file exist ─────────────────────────────
 * Run on 2026-07-21 this printed:
 *
 *     url    https://tm30.immigration.go.th/   title "Just a moment..."
 *     inputs exactly ONE — id="cf-chl-widget-8rh6t_response" name="cf-turnstile-response"
 *     #user  absent      #pass absent      forms: none      Ray ID: a1e868290e81f136
 *
 * i.e. the challenge is a Cloudflare INTERSTITIAL — a different document from the login page — and
 * the turnstile field you can see belongs to the interstitial. v1's poller requires
 * `#user && #pass && a non-empty token` in ONE document, so it is still unproven that the
 * post-challenge LOGIN page carries a turnstile input at all. If it does not, `some()` over an
 * empty NodeList is `false` and autofill would never fire.
 *
 * 🔴 TO CLOSE THAT: run this, then SOLVE THE CHALLENGE BY HAND in the window (pass `--show`), and
 * read the second probe it prints for the page that appears. That is the 20-second check.
 *
 * Usage:  node_modules/.bin/electron test/autofill/live-probe.js [--show]
 * Needs:  network access to tm30.immigration.go.th.
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const HELPER = path.resolve(__dirname, '..', '..');
const BUILD = path.resolve(__dirname, '..', '.build'); // gitignored
const { b64url } = require('./fixture.js');

const SHOW = process.argv.indexOf('--show') >= 0;
const out = (s) => process.stdout.write(s + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read-only inventory of the page. Nothing here mutates the DOM. */
const PROBE = `(function () {
  function meta(el) {
    return { tag: el.tagName, type: el.type || null, id: el.id || null,
             name: el.getAttribute('name'), value_len: (el.value || '').length };
  }
  return {
    url: location.href,
    v1_selectors: {
      '#user': !!document.getElementById('user'),
      '#pass': !!document.getElementById('pass'),
      'input[name=cf-turnstile-response]': document.querySelectorAll('input[name="cf-turnstile-response"]').length
    },
    all_inputs: Array.prototype.map.call(document.querySelectorAll('input'), meta),
    forms: Array.prototype.map.call(document.querySelectorAll('form'), function (f) {
      return { id: f.id || null, action: f.getAttribute('action') };
    }),
    iframes: Array.prototype.map.call(document.querySelectorAll('iframe'), function (f) {
      return (f.getAttribute('src') || '').slice(0, 70);
    }),
    helper_state: { pollerLive: !!window.__tm30Autofill, filledFlag: window.__tm30Filled || null },
    body_text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 260)
  };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: SHOW,
    webPreferences: { webviewTag: true, preload: path.join(HELPER, 'preload.js') },
  });

  let portalWc = null;
  win.webContents.on('did-attach-webview', (_e, wc) => { portalWc = wc; });
  win.webContents.on('console-message', (_e, _l, m) => {
    if (m.indexOf('[tm30-helper]') === 0) out('   helper │ ' + m.replace('[tm30-helper] ', ''));
  });

  await win.loadFile(path.join(HELPER, 'app.html'), { query: { d: b64url } });
  out('▸ app.html loaded — the webview is navigating to its own src (the live portal)');

  await sleep(12000); // the real portal + Turnstile need a moment
  if (!portalWc) {
    out('✗ no webview attached');
    app.exit(1);
    return;
  }

  out(`▸ portal URL   : ${portalWc.getURL()}`);
  out(`▸ portal title : ${portalWc.getTitle()}`);

  await win.webContents.executeJavaScript("window.tm30Shell.setActiveVilla('Villa Suriyan 2')");
  await sleep(3000);

  async function report(label) {
    out('');
    out(`════ ${label} ══════════════════════════════════════════`);
    try {
      out(JSON.stringify(await portalWc.executeJavaScript(PROBE), null, 2));
    } catch (e) {
      out(`✗ probe failed: ${e && e.message}`);
    }
    const status = await win.webContents.executeJavaScript(
      "document.getElementById('statusline').textContent.replace(/\\s+/g,' ').trim()"
    );
    out(`▸ Helper status line: "${status}"`);
  }

  await report('PROBE 1 — as loaded (nobody has solved anything)');
  out('  ^ expected: still "waiting for captcha…". A fill here would mean the NO-GO was breached.');

  if (SHOW) {
    out('');
    out('────────────────────────────────────────────────────────────────────────────');
    out('  🔴 SOLVE THE CLOUDFLARE CHALLENGE BY HAND NOW, in the window that just opened.');
    out('     Probing again in 90 seconds. Do NOT log in — we only need the login PAGE.');
    out('────────────────────────────────────────────────────────────────────────────');
    await sleep(90000);
    await report('PROBE 2 — after the human cleared the challenge');
    out('  ^ THE ANSWER: does this page have #user + #pass AND a cf-turnstile-response input?');
    out('    If the token count here is 0, v1\'s AND-condition can never be satisfied and the');
    out('    autofill needs a fix. Record the result on the buildAutofillScript comment.');
  } else {
    out('');
    out('▸ Re-run with --show to solve the challenge by hand and probe the real login page.');
  }

  try {
    fs.mkdirSync(BUILD, { recursive: true });
    const png = path.join(BUILD, 'live-portal.png');
    fs.writeFileSync(png, (await portalWc.capturePage()).toPNG());
    out(`▸ screenshot: ${png}`);
  } catch (e) {
    out(`▸ screenshot skipped: ${e && e.message}`);
  }

  app.exit(0);
});
