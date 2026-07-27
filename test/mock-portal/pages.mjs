'use strict';

/**
 * T3-07 — the mock portal's page templates. Pure string builders, no I/O.
 *
 * Loosely the real portal's SHAPE (login form → menu/upload page → result page), zero visual
 * fidelity — the only load-bearing parts are the ones the shipped Helper autofill targets:
 *
 *   · `#user` / `#pass` — the login inputs, by id (v1's production selectors)
 *   · `input[name="cf-turnstile-response"]` — the fake-Turnstile idiom shared with
 *     `test/autofill/fake-portal.html`: the hidden token input EXISTS from t=0 but is EMPTY;
 *     a non-empty value ⇒ "the human cleared the challenge". Here the human is real, so the
 *     challenge is a BUTTON instead of the harness's 3.5s timer — clicking it sets the token,
 *     which is the moment the shipped poller types the credentials.
 *   · the login form mounts LATE (t≈1.2s), reproducing the real portal's ordering
 *     (challenge renders before the form) — the reason the autofill is a poller.
 */

export function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const STYLE = `
  body { font: 14px system-ui; margin: 0; background: #f4f5f7; color: #223; }
  header { background: #1f3a6d; color: #fff; padding: 12px 24px; font-size: 15px; }
  header small { opacity: .75; margin-left: 8px; }
  main { max-width: 760px; margin: 28px auto; padding: 0 16px; }
  .box { background: #fff; border: 1px solid #ccd; border-radius: 8px; padding: 20px 22px; }
  label { display: block; margin: 10px 0 3px; font-size: 12px; color: #556; }
  input[type=text], input[type=password] { width: 100%; box-sizing: border-box; padding: 7px 9px; font: inherit; border: 1px solid #bbc; border-radius: 5px; }
  button { margin-top: 14px; padding: 8px 18px; font: inherit; border: 1px solid #1f3a6d; border-radius: 5px; background: #27509b; color: #fff; cursor: pointer; }
  button.ghost { background: #eef2fa; color: #1f3a6d; }
  #turnstile { margin: 14px 0; padding: 12px; background: #eef; border-radius: 6px; font-size: 12px; }
  .error { margin: 12px 0; padding: 10px 12px; background: #fdecea; border: 1px solid #e5b4ae; border-radius: 6px; color: #8a2620; }
  .ok { color: #1c7a3d; }
  table { border-collapse: collapse; width: 100%; margin-top: 14px; font-size: 13px; }
  th, td { border: 1px solid #dde; padding: 5px 8px; text-align: left; }
  th { background: #f0f3f9; }
  ul.violations li { margin: 6px 0; color: #8a2620; }
  .receipt-no { font: 20px ui-monospace, Menlo, monospace; background: #eef7ee; border: 1px dashed #7bab7b; padding: 10px 14px; border-radius: 6px; display: inline-block; margin: 10px 0; }
`;

function page(title, body) {
    return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body>
<header>Immigration Bureau — Section 38 (TM30) <small>MOCK PORTAL — internal testbed, not the real service</small></header>
<main>${body}</main>
</body>
</html>`;
}

/** GET /login — the SAME ids the shipped autofill targets + the fake-Turnstile idiom. */
export function loginPage({ error = null } = {}) {
    return page('TM30 mock — sign in', `
  <div class="box">
    <h3 style="margin-top:0">Sign in</h3>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}

    <div id="turnstile">
      ⧗ Cloudflare challenge (fake) — <button type="button" class="ghost" id="solve" style="margin-top:0">✓ I am human</button>
      <span id="solved-mark"></span>
    </div>

    <form method="POST" action="/login" id="loginform">
      <input type="hidden" name="cf-turnstile-response" value="" />
      <div id="formslot"><!-- #user/#pass mount at t≈1.2s — the real portal's ordering --></div>
      <button type="submit" id="signin">Sign in</button>
    </form>
  </div>

  <script>
    // Same idiom as test/autofill/fake-portal.html: the token input exists from t=0, EMPTY;
    // the login form mounts late; a non-empty token ⇒ the human cleared the challenge.
    console.log('[mock-portal] t=0 login page up — #user/#pass do NOT exist yet, token EMPTY');
    setTimeout(function () {
      document.getElementById('formslot').innerHTML =
        '<label for="user">Username</label><input type="text" id="user" name="user" autocomplete="off">' +
        '<label for="pass">Password</label><input type="password" id="pass" name="pass" autocomplete="off">';
      console.log('[mock-portal] t=1200 login form mounted (#user, #pass now exist)');
    }, 1200);
    document.getElementById('solve').addEventListener('click', function () {
      document.querySelector('input[name="cf-turnstile-response"]').value =
        'MOCK.turnstile.token.' + Math.random().toString(36).slice(2);
      document.getElementById('solved-mark').textContent = ' — challenge cleared ✓';
      console.log('[mock-portal] HUMAN cleared the challenge — token now non-empty');
    });
  </script>`);
}

/** GET /notify — the accommodation-notify upload page (behind the session cookie). */
export function notifyPage({ user = '' } = {}) {
    return page('TM30 mock — Inform Accommodation', `
  <div class="box">
    <h3 style="margin-top:0">แจ้งที่พัก / Inform Accommodation — import Excel</h3>
    <p>Signed in as <b>${escapeHtml(user)}</b> · <a href="/logout">sign out</a></p>
    <p>Upload the TM30 sheet (<code>.xlsx</code>, worksheet «แบบแจ้งที่พัก Inform Accom», 9 columns).</p>
    <form method="POST" action="/notify" enctype="multipart/form-data">
      <input type="file" name="sheet" id="sheet" accept=".xlsx" required />
      <button type="submit">Upload &amp; validate</button>
    </form>
  </div>`);
}

/** ACCEPT → receipt with a generated number + the parsed-guest summary table. */
export function receiptPage({ receiptNo, filename, guests }) {
    const rows = guests.map((g) => `
      <tr>
        <td>${g.row}</td><td>${escapeHtml(g.firstName)}</td><td>${escapeHtml(g.lastName)}</td>
        <td>${escapeHtml(g.gender)}</td><td>${escapeHtml(g.passport)}</td><td>${escapeHtml(g.nationality)}</td>
        <td>${escapeHtml(g.birthDate)}</td><td>${escapeHtml(g.checkoutDate)}</td><td>${escapeHtml(g.phone)}</td>
      </tr>`).join('');
    return page('TM30 mock — receipt', `
  <div class="box">
    <h3 class="ok" style="margin-top:0">✓ Notification accepted</h3>
    <p>File <b>${escapeHtml(filename)}</b> passed validation. Receipt number:</p>
    <div class="receipt-no" id="receipt-no">${escapeHtml(receiptNo)}</div>
    <table>
      <tr><th>xlsx row</th><th>First Name</th><th>Last Name</th><th>Gender</th><th>Passport</th>
          <th>Nat.</th><th>Birth Date</th><th>Check-out</th><th>Phone</th></tr>
      ${rows}
    </table>
    <p><a href="/notify">Upload another sheet</a></p>
  </div>`);
}

/** REJECT → EVERY violation, row-numbered — the mistake-prevention testbed. */
export function rejectPage({ filename, violations }) {
    const items = violations.map((v) => `<li class="violation">${escapeHtml(v.message)}</li>`).join('');
    return page('TM30 mock — rejected', `
  <div class="box">
    <h3 style="margin-top:0;color:#8a2620">✗ Notification rejected — ${violations.length} violation(s)</h3>
    <p>File <b>${escapeHtml(filename)}</b> did not pass validation. Nothing was filed. Fix every item and re-upload:</p>
    <ul class="violations" id="violations">${items}</ul>
    <p><a href="/notify">Back to upload</a></p>
  </div>`);
}
