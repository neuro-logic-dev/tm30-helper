'use strict';

/**
 * MO-TM30-PORTAL-DATE — LIVE PROBE of the IMPORT FORM. **READ ONLY.**
 *
 * `live-probe.js` answers a different question: are v1's LOGIN selectors still real. It reads the
 * page as loaded and again 90s later, which on a successful login is a race — by the time a human
 * has cleared Turnstile, logged in and navigated, its window has closed.
 *
 * This one waits for YOU. It prints a countdown, you drive the pane to
 * `Inform Accommodation > Import Excel` at your own pace, and it dumps that form's inputs when you
 * press Enter in this terminal.
 *
 * 🔴 It does not click, type, submit or navigate. Every selector it prints is read with
 * `querySelectorAll` and nothing else. The one thing it needs from you is that the import page is
 * ON SCREEN when you press Enter.
 *
 * What it is looking for: the `วันที่เข้าพัก / Check-in Date` input — its id, name, Angular
 * `formControlName`, placeholder and the text of whatever labels it — because the page is an
 * Angular route (`/tm30/#/external/ifa/import`) and may well have no stable ids at all, in which
 * case the fill has to anchor on the label instead.
 *
 * Usage:  ELECTRON_DISABLE_SANDBOX=1 node_modules/.bin/electron test/autofill/import-form-probe.js --show
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');

const HELPER = path.resolve(__dirname, '..', '..');
const { b64url } = require('./fixture.js');

const SHOW = process.argv.indexOf('--show') >= 0;
const out = (s) => process.stdout.write(s + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Read-only inventory, richer than the login probe's: an Angular form is described by its
 * `formControlName` and its label text far more reliably than by an id it may not have.
 */
const PROBE = `(function () {
  function labelsFor(el) {
    var texts = [];
    if (el.id) {
      var l = document.querySelector('label[for="' + el.id + '"]');
      if (l) texts.push(l.innerText.trim());
    }
    var lab = el.closest('label');
    if (lab) texts.push(lab.innerText.trim());
    // Angular Material and this portal both put the caption in an ancestor container rather
    // than a <label for>, so walk up a few levels and keep the shortest sensible caption.
    var p = el.parentElement, hops = 0;
    while (p && hops < 4) {
      var t = (p.innerText || '').replace(/\\s+/g, ' ').trim();
      if (t && t.length < 120) texts.push(t);
      p = p.parentElement; hops++;
    }
    return texts.slice(0, 4);
  }
  function meta(el) {
    var attrs = {};
    Array.prototype.forEach.call(el.attributes, function (a) {
      if (/^(id|name|type|placeholder|formcontrolname|aria-label|ng-reflect-name|readonly|disabled|class)$/i.test(a.name)) {
        attrs[a.name] = a.value.slice(0, 80);
      }
    });
    return {
      attrs: attrs,
      value: (el.value || '').slice(0, 40),
      visible: !!(el.offsetWidth || el.offsetHeight),
      labels: labelsFor(el)
    };
  }
  var inputs = Array.prototype.map.call(document.querySelectorAll('input, select, textarea'), meta);
  return {
    url: location.href,
    title: document.title,
    input_count: inputs.length,
    inputs: inputs,
    // The two dates, found the way the fill would have to find them if there are no ids.
    date_like: inputs.filter(function (i) {
      var hay = (JSON.stringify(i.attrs) + ' ' + i.labels.join(' ')).toLowerCase();
      return hay.indexOf('date') >= 0 || hay.indexOf('วันที่') >= 0;
    }),
    file_inputs: Array.prototype.map.call(document.querySelectorAll('input[type=file]'), function (f) {
      return { id: f.id || null, name: f.getAttribute('name'), files: f.files ? f.files.length : -1 };
    }),
    forms: Array.prototype.map.call(document.querySelectorAll('form'), function (f) {
      return { id: f.id || null, action: f.getAttribute('action') };
    })
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
  await sleep(8000);
  if (!portalWc) { out('✗ no webview attached'); app.exit(1); return; }

  await win.webContents.executeJavaScript("window.tm30Shell.setActiveVilla('Villa Suriyan 2')");

  out('');
  out('────────────────────────────────────────────────────────────────────────');
  out('  In the window: clear Turnstile, log in, open  Inform Accommodation >');
  out('  Import Excel  — then come back here and press ENTER.');
  out('  Nothing is clicked or typed by this probe. Take as long as you need.');
  out('────────────────────────────────────────────────────────────────────────');

  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', resolve);
  });

  out('');
  out(`▸ portal URL   : ${portalWc.getURL()}`);
  out(`▸ portal title : ${portalWc.getTitle()}`);
  out('');
  out('════ IMPORT FORM INVENTORY ═════════════════════════════════════════════');
  try {
    out(JSON.stringify(await portalWc.executeJavaScript(PROBE), null, 2));
  } catch (e) {
    out(`✗ probe failed: ${e && e.message}`);
  }
  app.exit(0);
});
