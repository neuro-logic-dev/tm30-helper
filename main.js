const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const { autoUpdater } = require('electron-updater');

const { parseDeepLink, DeepLinkKind, PROTOCOL, compareVersions } = require('./deeplink');
const { registerInsertSheet } = require('./insert-sheet');
const { createQueueClient, ErrorKind } = require('./queue-client');

// ---------- Single instance ----------
// Повторный запуск (в т.ч. по deep link на Win/Linux) пробрасывается
// в уже работающий процесс через событие 'second-instance'.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// ---------- Регистрация протокола tm30:// ----------
if (process.defaultApp) {
  // dev-запуск через `electron .` — регистрируем бинарь electron + путь к проекту
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// ---------- Разбор deep link ----------
// Формат: tm30://open?d=<base64url(JSON)>
//   v1: {name, login, pass}          — legacy, поведение не менялось
//   v2: {v:2, worklist:[...]}        — MO-TM30-014 §7.3
//   v3: {v:3, rows:[...], villas, *_base} — ADR-0015, the compact shape. Normalised to the
//       SAME rows by deeplink.js, so nothing below this line can tell the two apart.
// Сам парсер живёт в ./deeplink.js — без зависимости от electron, чтобы его
// можно было прогонять тестом вместе с эмиттером (test/roundtrip.test.mjs).

function findDeepLinkInArgv(argv) {
  return argv.find(a => typeof a === 'string' && a.startsWith(PROTOCOL + '://')) || null;
}

// ---------- Окна ----------
function toBase64Url(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function openAccountWindow(acc) {
  const win = new BrowserWindow({
    width: 1240,
    height: 880,
    title: acc.name,
    webPreferences: { webviewTag: true },
  });
  win.loadFile('window.html', { query: { d: toBase64Url(acc) } });
  win.focus();
}

/**
 * Every standalone window currently open. Tracked because the update verdict arrives AFTER the
 * window does (see `broadcastUpdateNotice`), so main has to be able to find it again.
 */
const standaloneWindows = new Set();

function openStandaloneWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'TM30 Helper',
    webPreferences: { webviewTag: true },
  });
  // Версия уезжает в query, а не вшита в разметку: приложение меняет версию само
  // (на Windows — автообновлением, на macOS — переустановкой поверх), и жёстко
  // прописанная строка на экране начинает врать.
  win.loadFile('index.html', { query: { v: app.getVersion() } });

  // ADR-0001 / spec C-1. `index.html` is a v1 window and deliberately has NO preload (013 §3.5),
  // so it cannot reach `shell` the way `app.html` does. The install-page link is therefore a
  // plain `<a target="_blank">`, and this is the seam that hands it to the real browser and
  // refuses the in-window navigation. The renderer gains no verb it could call with anything
  // else — the only URL it can produce here is the one main gave it.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  standaloneWindows.add(win);
  win.on('closed', () => standaloneWindows.delete(win));
  // The other half of the race: the check may already have answered before this window loaded.
  win.webContents.on('did-finish-load', () => pushUpdateNotice(win));
}

/**
 * ADR-0001 / spec C-2 — why this is pushed rather than passed in the query.
 *
 * `app.whenReady()` starts the version check (up to 3 s) and opens the window on the very next
 * line. At a Dock launch the window is therefore painted while `latestKnownVersion` is still
 * null, so a query parameter would be empty every single time and the operator would never be
 * told. The verdict has to arrive after the window does.
 *
 * Main → renderer, one way. `index.html` has no preload and no `ipcRenderer`: it receives three
 * strings and has no channel to answer on.
 */
function pushUpdateNotice(win) {
  if (!latestKnownVersion || !win || win.isDestroyed()) return;
  const notice = JSON.stringify({
    next: latestKnownVersion,
    cur: app.getVersion(),
    install: installPageUrl,
  });
  win.webContents
    .executeJavaScript(`window.showUpdateNotice && window.showUpdateNotice(${notice})`)
    .catch(() => {
      /* the window went away mid-flight — nothing to tell anyone */
    });
}

function broadcastUpdateNotice() {
  for (const win of standaloneWindows) pushUpdateNotice(win);
}

/**
 * A-WEB-4c: v2 → ОДНО окно с ДВУМЯ панелями (`app.html`): слева worklist, справа
 * `<webview>` портала (014 §2.4, §3; макет H1). Заменило собой 4b-заглушку
 * `worklist.html`, которая только доказывала, что провод работает.
 *
 * 🔴 Это окно ТОЛЬКО для v2. v1 (`openAccountWindow` / `openStandaloneWindow`)
 * не тронут — обратная совместимость обязательна (013 §3.5).
 *
 * Механизм ЗАГРУЗКИ окна прежний и намеренно нулевой по зависимостям: bootstrap-payload
 * v2/v3-ссылки уезжает в query как base64url — ни preload, ни IPC, ни сети. Это утверждение
 * про ОТКРЫТИЕ окна, а не про приложение: после ADR-0021 v4-ссылка строк не несёт вовсе, и
 * worklist приходит по HTTPS через `queue-client.js` уже после того, как окно открылось.
 */
/**
 * MO-TM30-HELPER-VERSIONING §5 Layer 1 — "is there a newer release", asked once at startup.
 *
 * 🔴 WHY THIS EXISTS AT ALL, given the Helper auto-updates. It auto-updates on WINDOWS.
 * `build.mac.identity` is null, `build.mac.target` is dmg-only (electron-updater cannot update
 * from a dmg — it needs a zip), and no `latest-mac.yml` is published. So on macOS nothing
 * updates itself and, until now, nothing noticed: an operator could sit on an old build
 * indefinitely with no signal anywhere. That is the gap this closes.
 *
 * NON-BLOCKING by design (§5's table): a newer release existing is not a reason to stop someone
 * filing. The hard block is Layer 2, which fires only when a LINK says it needs more.
 *
 * The only outbound request this app makes to a THIRD PARTY, and the only one still issued
 * inline in this file. After ADR-0021 the Helper's full network surface is four calls: this
 * release check, the version report, the worklist fetch and the `submitted` write — the last
 * three all go to OUR backend through `queue-client.js`, which is the single place a token and
 * a URL meet. (`checkForNewerRelease` stays out of that module deliberately: no token, no error
 * kinds, no caller that reacts — see the header of `queue-client.js`.)
 *
 * On a short timeout, failing silently in every direction: a version check that can take the
 * Helper down is worse than no version check.
 */
const RELEASES_API = 'https://api.github.com/repos/neuro-logic-dev/tm30-helper/releases/latest';
const UPDATE_CHECK_TIMEOUT_MS = 3000;

/** The newest published version, or null while unknown / unreachable. Read when a window opens. */
let latestKnownVersion = null;

/**
 * Set once `electron-updater` has an update ON DISK, ready to install on quit. Windows only in
 * practice: macOS has no feed (unsigned, dmg-only), which is why the mac path is still the
 * install page rather than a button.
 */
let downloadedUpdateVersion = null;

async function checkForNewerRelease() {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
    });
    if (!res.ok) return;
    const data = await res.json();
    const tag = typeof data?.tag_name === 'string' ? data.tag_name.replace(/^v/, '') : null;
    // Only remember it if it is BOTH parseable and actually newer — so the renderer never has to
    // re-derive the comparison, and a malformed tag is indistinguishable from no answer.
    if (compareVersions(app.getVersion(), tag) === -1) {
      latestKnownVersion = tag;
      console.log(`[tm30-helper] a newer release exists: ${tag} (running ${app.getVersion()})`);
    }
  } catch (e) {
    console.log('[tm30-helper] update check skipped:', (e && e.message) || e);
  }
}

/**
 * ADR-0001 — where the install page lives, remembered across launches.
 *
 * The origin is NEVER hardcoded: it is the origin of the web app that sent us, taken from a
 * worklist row's `return_url`, so an operator on a staging deployment is sent to the staging
 * install page. That derivation needs a worklist — and the standalone window (Dock launch) has
 * none. So the last origin a deep link taught us is written to disk and reused there.
 *
 * `{userData}` already holds per-filing sheets ({userData}/tm30-sheets/), so this adds no new
 * storage location. Never having seen an origin is a SUPPORTED state, not an error: the notice
 * then shows without its button, exactly as `refusedForVersion` already degrades.
 */
const STATE_FILENAME = 'tm30-state.json';

/** The install page URL, or null while unknown. */
let installPageUrl = null;

/**
 * ADR-0001 (version report) — WHERE to report this Helper's version, and who to say it is.
 *
 * Both are taught to us by a deep link and then remembered, for exactly the reason the install
 * page above is: a Dock / Start-menu launch has no link and no worklist, and that is precisely
 * the launch the dashboard needs to hear about. Null until some link has taught us is a
 * SUPPORTED state, not an error — a Helper that has never been opened from the web reports
 * nothing at all, silently (AC-14).
 */
let reportUrl = null;
let reportToken = null;

/**
 * ADR-0021 — WHERE THE QUEUE LIVES. The backend base a v4 pointer names outright, and that a
 * v2/v3 link betrays through the sheet URLs it already carries (see {@link deriveApiBase}).
 *
 * Remembered for the same reason the two above are, and it matters more: from 2.5.0 the rows do
 * not travel in the link at all, so a Dock launch with no memo is a Helper that knows of no
 * queue whatsoever. Null until some link has taught us stays a SUPPORTED state — the Helper is
 * then exactly the offline shell it was before ADR-0021.
 *
 * 🔴 The FETCH that uses it now lives in this file too: `tm30:fetch-worklist` below hands this
 * base and the token to `queue-client.js`. This declaration is still only the memo half.
 */
let apiBase = null;

function stateFilePath() {
  return path.join(app.getPath('userData'), STATE_FILENAME);
}

/**
 * The whole memo, read TOLERANTLY.
 *
 * A file written by 2.3.4 (only `install_url`) and a file written by some future build (keys
 * this one has never heard of) both load, and both are just an object. Missing, unreadable,
 * hand-edited into nonsense, or not an object at all ⇒ `{}`. Never an error, never a dialog:
 * every caller below treats "we do not know" as a normal state.
 */
function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 🔴 A UNION write, never a replace.
 *
 * Until this file held one key, `rememberInstallPage` could rewrite the whole object and be
 * right. With three facts and three independent writers, that same code silently drops
 * `installation_id` the first time a new install page arrives — and a regenerated installation
 * forks one machine into two rows on the backend. Unknown keys survive for the mirror-image
 * reason: a memo written by a NEWER build must not be destroyed by an older one.
 *
 * Failing to write costs a button and a report on a LATER launch, and nothing in this session.
 */
function writeState(patch) {
  const merged = { ...readState(), ...patch };
  try {
    fs.writeFileSync(stateFilePath(), JSON.stringify(merged) + '\n', 'utf8');
  } catch (e) {
    console.log(`[tm30-helper] could not write ${STATE_FILENAME}:`, (e && e.message) || e);
  }
  return merged;
}

/** `https://app.example.com/tm30/...` → `https://app.example.com/tm30-helper`, or null. */
function deriveInstallPage(worklist) {
  try {
    const withReturn = (worklist || []).find((r) => r && r.return_url);
    if (!withReturn) return null;
    return new URL(withReturn.return_url).origin + '/tm30-helper';
  } catch {
    /* an unusable return_url costs the button, not the warning */
    return null;
  }
}

/**
 * ADR-0021 / AC-14 — the backend base this link teaches us, or null.
 *
 * Two sources, in this order and no third:
 *
 *  1. **The result says so.** A v4 pointer's whole payload is an address and a token; a future
 *     shape that states `api_base` outright is read the same way.
 *  2. **A row's `sheet_download_url` gives it away.** That is what makes a v2/v3 link BOOTSTRAP
 *     material rather than merely a snapshot (AC-14): the deployment that BUILT the sheet URL is
 *     the one asked to answer for the queue. It is byte-for-byte the emitter's own rule
 *     (`resolveApiBase`, `mo-reservation-fe/src/lib/tm30.ts`), which is also how v3's `api_base`
 *     header is computed in the first place — so an origin derived here equals the header a v3
 *     payload carries, and nothing is lost by reading the rows instead of the header.
 *
 * 🔴 No origin is hardcoded, exactly as in {@link deriveInstallPage}: the Helper is told where
 * its backend is by the web app that launched it, so a staging operator fetches from staging.
 *
 * A v2/v3 link whose rows carry no sheet URL yet (nothing generated) teaches nothing, and that
 * is a supported state — it is the link that comes WITH work attached that we need this from.
 */
function deriveApiBase(result) {
  if (!result) return null;
  if (isHttpUrl(result.api_base)) return String(result.api_base).replace(/\/+$/, '');
  for (const row of result.worklist || []) {
    if (!row || !row.sheet_download_url) continue;
    try {
      return new URL(row.sheet_download_url).origin;
    } catch {
      /* one malformed URL is not a reason to give up on the next row */
    }
  }
  return null;
}

function loadInstallPage() {
  /* first launch, or a hand-edited file — either way `readState` says `{}` and no origin yet */
  const { install_url: url } = readState();
  if (isHttpUrl(url)) installPageUrl = url;
}

/** Called for every v2 link, refused or not: a refused link still teaches us where to send them. */
function rememberInstallPage(worklist) {
  const url = deriveInstallPage(worklist);
  if (!url || url === installPageUrl) return;
  installPageUrl = url;
  writeState({ install_url: url });
}

/**
 * The bootstrap material as of the last link that carried it.
 *
 * Every URL goes through the SAME `isHttpUrl` gate on the way OUT of the file as on the way in:
 * `tm30-state.json` sits in a writable directory and these are addresses we are about to POST
 * to and fetch from.
 *
 * 🔴 Read FACT BY FACT since ADR-0021, where it used to insist on the report PAIR. The pair rule
 * said "a token with nowhere to go is just silence", and that was true while the token had one
 * job. It now has two: a v4 pointer carries the same operator token with NO `report_url` beside
 * it, so a paired read would throw away the one credential the queue fetch runs on — and a
 * Helper that has been paired would look, on its next Dock launch, exactly like one that never
 * was. Nothing becomes louder: `reportVersion` still requires BOTH before it says a word, which
 * is where that rule belonged all along.
 */
function loadReportDetails() {
  const state = readState();
  if (isHttpUrl(state.report_url)) reportUrl = state.report_url;
  if (typeof state.report_token === 'string' && state.report_token) {
    reportToken = state.report_token;
  }
  if (isHttpUrl(state.api_base)) apiBase = state.api_base;
}

/**
 * AC-12 / AC-7 — a link that carries bootstrap material teaches it to disk, so that every FUTURE
 * launch can report, and (from Q-5) fetch, without a link. Called before the Layer-2 gate for
 * the same reason `rememberInstallPage` is: an operator whose link was just refused for being
 * too old is exactly the operator whose version the dashboard most needs to have heard.
 *
 * Junk cannot get in — and cannot cost anything either: bad details leave the Helper as silent
 * as it was before the link arrived, and the filing opens regardless.
 *
 * 🔴 THREE FACTS, WRITTEN INDEPENDENTLY, ONE TOKEN (ADR-0021).
 *
 * `report_token` holds the SAME opaque per-operator string a v4 pointer calls `token`. It is
 * stored ONCE, under the name it has had since ADR-0001, precisely because it is one secret: two
 * fields would be two things to rotate, and the day they disagree is the day nobody can say
 * which one the backend accepted. (The NAME now reads narrower than the job — see the report's
 * proposal; renaming it here would break Q-5 and Q-7, which is why it stays.)
 *
 * `report_url` still refuses to be written without a token beside it (an address with nobody to
 * name is silence, and `reportVersion` would never use it). The token no longer refuses to be
 * written without the URL: a v4 pointer carries no `report_url` at all, and refusing there would
 * mean a pointer link paired the Helper with nothing.
 */
function rememberReportDetails(result) {
  if (!result) return;
  const patch = {};

  // One token, under either of the two names the wire gives it — v2/v3 `report_token`, v4
  // `token`. `report_token` wins when a payload somehow carries both: it is the older contract.
  const token =
    typeof result.report_token === 'string' && result.report_token !== ''
      ? result.report_token
      : typeof result.token === 'string' && result.token !== ''
        ? result.token
        : '';

  const url = result.report_url;
  if (isHttpUrl(url) && token && url !== reportUrl) {
    reportUrl = url;
    patch.report_url = url;
  }
  if (token && token !== reportToken) {
    reportToken = token;
    patch.report_token = token;
  }

  const base = deriveApiBase(result);
  if (base && base !== apiBase) {
    apiBase = base;
    patch.api_base = base;
  }

  if (Object.keys(patch).length === 0) return; // already known — nothing to write
  writeState(patch);
}

/**
 * This installation's identity: generated ONCE, on first need, and then never again.
 *
 * It is half of the backend's key (operator + installation), so a regenerated id forks one
 * machine into two rows and makes "the latest observation" ambiguous — which is why it is read
 * back from disk on every call rather than cached in a variable that a future edit could reset.
 *
 * Deliberately random and deliberately meaningless: it says "the same install as last time" and
 * nothing whatsoever about the machine (AC-15). Nothing is derived from hostname, user or path.
 */
function ensureInstallationId() {
  const existing = readState().installation_id;
  if (typeof existing === 'string' && existing !== '') return existing;
  const id = randomUUID();
  writeState({ installation_id: id });
  return id;
}

/**
 * ADR-0001 — THE VERSION REPORT. `{version, platform}` and the token, to the address on disk.
 *
 * 🔴 The POST itself no longer lives here. This used to be an inline `fetch` under a note saying
 * it was shaped like `checkForNewerRelease()` and would stay duplicated "until the third
 * occurrence"; ADR-0021 brought the third and the fourth (worklist read, submitted write), so the
 * transport moved to `queue-client.js` — one timeout, one abort, one `catch` that cannot rethrow,
 * one place where a token meets a URL. `checkForNewerRelease()` stays where it is: it answers to
 * GitHub's release feed, not to our contract.
 *
 * WHAT STAYED HERE, because it is genuinely this file's: WHERE the details came from, and
 * WHETHER this launch already reported. The "already sent" guard is per LAUNCH and keyed on what
 * was actually sent, so the whenReady report and a deep link carrying the SAME details produce
 * one POST rather than two, while a link carrying NEW details (the bootstrap case, and a rotated
 * token) still reports at once. A failed attempt is never re-attempted with the same details:
 * that would be a retry. The client is built per call and holds nothing between them.
 *
 * WHAT IT MUST NEVER DO: block. Not the window, not a deep link, not a filing.
 *
 * The token is never logged. Nothing about a filing, a guest, a villa, an account, a path or a
 * machine is sent — the four fields below are the entire contract.
 */

/** `url|token` of the report already sent this launch, or null. */
let reportedThisLaunch = null;

/**
 * WHERE to post the version report — the address on disk, or the one `api_base` implies.
 *
 * 🔴 ORCHESTRATOR DECISION (Tier-2, 2026-08-14), and the reason it exists: contract C-1 gives a
 * v4 pointer no `report_url` at all. Without this, an operator whose queue is always big enough
 * to emit v4 would silently stop reporting a Helper version — the dashboard would show a fleet
 * frozen at whatever it last heard, with nothing anywhere saying why. A silent degradation is the
 * one failure mode this project does not accept (Q-4 report §7.2 raised it).
 *
 * The composed shape is the backend's own (`tm30-helper-report.service.ts`:80 builds it as
 * `${API_PUBLIC_URL}/tm30/helper-report`), and it is the SAME rebuild-from-a-base move v3 rows
 * already make for sheet and return URLs. No origin is hardcoded: `apiBase` is whatever the web
 * app that launched us named, so a staging operator still reports to staging.
 *
 * A stored `report_url` always wins — it was stated outright rather than inferred.
 */
function resolveReportUrl() {
  if (isHttpUrl(reportUrl)) return reportUrl;
  if (isHttpUrl(apiBase)) return `${apiBase}/tm30/helper-report`;
  return null;
}

async function reportVersion() {
  const url = resolveReportUrl();
  // Both or neither, unchanged: an address with nobody to name is silence (AC-14).
  if (!url || !reportToken) return; // nobody ever told us where — stay silent
  const attempt = `${url}|${reportToken}`;
  if (attempt === reportedThisLaunch) return;
  reportedThisLaunch = attempt;

  await createQueueClient({ token: reportToken }).reportVersion({
    reportUrl: url,
    installationId: ensureInstallationId(),
    version: app.getVersion(),
    platform: process.platform,
  });
}

/**
 * ADR-0021 / ADR-0022 — can this Helper fetch its queue?
 *
 * BOTH facts or neither: a token with no address has nowhere to go, and an address with no token
 * would be refused. The pair is what "paired" means, and it is the single condition the Dock
 * launch routes on, so the window can never open in fetch mode and then discover it cannot fetch.
 */
function isPaired() {
  return Boolean(reportToken) && isHttpUrl(apiBase);
}

/** The client for the queue routes, built per call and holding nothing between them (Q-3). */
function queueClient() {
  return createQueueClient({ apiBase, token: reportToken });
}

/**
 * AC-4 — THE DISCARD. A 401/403 means this token is not good here any more, so it stops existing:
 * in memory, and in the memo that would otherwise re-supply it on the next launch.
 *
 * 🔴 Only main ever does this. The renderer is told `unauthorized` and paints state 5; it never
 * manages a credential it cannot see. `reportedThisLaunch` is cleared with it so a re-pair in the
 * same session reports again rather than being mistaken for a repeat.
 *
 * `undefined` in the patch REMOVES the key: `writeState` union-merges and `JSON.stringify` drops
 * undefined values, so the memo loses the credential rather than keeping an empty spelling of it
 * that `loadReportDetails` would then have to know to distrust.
 */
function discardReportToken() {
  if (!reportToken) return;
  console.log('[tm30-helper] queue access refused — discarding the stored token (AC-4)');
  reportToken = null;
  reportedThisLaunch = null;
  writeState({ report_token: undefined });
}

/**
 * MO-TM30-HELPER-VERSIONING §5 Layer 2 — the per-link floor. BLOCKING.
 *
 * Needs no network, which is the point: it answers "can this Helper honour THIS link" from the
 * link itself. Opening the worklist anyway would show a queue built by a payload this build only
 * half understands — the silent-degradation failure that spec was written about.
 *
 * The install page is derived from the link's own `return_url` — the web app that sent us — so
 * an operator on a staging deployment is sent to the staging install page, and no origin is
 * hardcoded here. No derivable origin ⇒ the dialog still opens, just without the button.
 *
 * @returns true when the link was refused and nothing further should happen.
 */
function refusedForVersion(result, url) {
  const floor = result.min_helper_version;
  if (!floor) return false;
  if (compareVersions(app.getVersion(), floor) !== -1) return false;

  const installUrl = deriveInstallPage(result.worklist);

  console.error(
    `[tm30-helper] REFUSED: link needs >= ${floor}, this is ${app.getVersion()}\n  url: ${url}`
  );

  const buttons = installUrl ? ['Open install page', 'Quit'] : ['Quit'];
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: 'TM30 Helper — update required',
    message: `TM30 Helper ${app.getVersion()} is out of date.`,
    detail:
      `This filing queue needs version ${floor} or newer. Update the Helper and open it again ` +
      `from the web app — nothing has been opened, and no filing has been changed.`,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
  });

  if (installUrl && choice === 0) shell.openExternal(installUrl);
  return true;
}

function openWorklistWindow(worklist, focusFilingId) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080, // левая панель 360px + панель портала, ниже неё макет ломается
    title: 'TM30 Helper',
    // A-WEB-4d: preload — ТОЛЬКО для v2-окна. Даёт `app.html` ровно два глагола
    // (скачать лист / открыть папку). v1-окна остаются без preload — 013 §3.5.
    webPreferences: { webviewTag: true, preload: path.join(__dirname, 'preload.js') },
  });
  // T3-03: focus_filing_id уезжает в НОВОЕ окно тем же query-механизмом. Каждая v2-ссылка
  // открывает СВОЁ окно, так что фокус по построению существует только на initial boot —
  // ни один уже открытый webview никогда не перенавигируется этим полем.
  win.loadFile('app.html', {
    query: {
      d: toBase64Url({
        v: 2,
        worklist,
        ...(Number.isFinite(focusFilingId) ? { focus_filing_id: focusFilingId } : {}),
      }),
      // T3-07: portal-base override for the internal MOCK-portal e2e (test/mock-portal/).
      // Unset ⇒ the param is absent ⇒ app.html falls back to the real portal URL, byte-identical.
      ...(process.env.TM30_PORTAL_BASE_URL ? { portal: process.env.TM30_PORTAL_BASE_URL } : {}),
      /*
        ADR-0022 state 5 — WHERE "Open MO" GOES when access is revoked.
        The revoked window has to name the one action that fixes it, and by then the fetch has no
        token and the rows have no `return_url` to derive an origin from. So the address travels
        the same zero-dep query mechanism `upd`/`portal` already use, from the memo main has held
        since ADR-0001. Unknown ⇒ the param is absent ⇒ the button says so instead of lying.
        🔴 Deliberately NOT a preload verb: C-8 is frozen at three, and this is a fact the window
        needs at BIRTH, not a question it asks later.
      */
      ...(installPageUrl ? { install: installPageUrl } : {}),
      // Layer 1's verdict, already compared in the main process — the renderer only paints it.
      ...(latestKnownVersion ? { upd: latestKnownVersion, cur: app.getVersion() } : {}),
    },
  });
  win.focus();
}

/**
 * 🔴 Громкий отказ (MO-TM30-014 §7.9).
 *
 * Раньше любой неразобранный payload превращался в `null` и молча открывал chooser —
 * сломанная ссылка выглядела как рабочая. Теперь битая ссылка показывает НАТИВНОЕ окно
 * ошибки и НИКОГДА не деградирует до chooser'а. «Нет учётки» и «битая ссылка» — разные
 * состояния, и выглядят они по-разному: первое открывает окно worklist'а, второе — вот это.
 */
/**
 * 🔴 ADR-0022 — WHERE A LAUNCH WITH NO PAYLOAD GOES. The one branch this whole feature turns on.
 *
 * The habitual launch is the Dock or the Start menu, and until now it landed on the standalone
 * portal window — which by policy (013 §3.5) has NO preload, so it structurally cannot show a
 * queue or a "Mark submitted". That is why production measured 0 of 13 filings ever reaching
 * `submitted`: the feature existed and was simply unreachable from the path operators use.
 *
 * With ADR-0021 the rows no longer arrive in the link, so the historical reason the queue window
 * needed one ("it needs a payload") is gone: a PAIRED Helper opens the queue window and fetches.
 *
 * The unpaired case still opens the standalone window, unchanged and still preload-less — 013
 * §3.5 is superseded only in the sense that this window is no longer the Dock destination. It is
 * granted no IPC channel here or anywhere (AC-2).
 *
 * Called from all three payload-less entry points, because they are one situation wearing three
 * shapes and routing two of them would leave AC-1 unmet on the platform it matters most: a
 * `tm30://open` with no payload (CHOOSER), a cold start with no link at all (macOS Dock, Windows
 * Start menu), and a re-activation with every window closed (macOS Dock again).
 */
function openLaunchWindow() {
  if (isPaired()) {
    console.log('[tm30-helper] launch: paired — opening the queue window in fetch mode');
    // No rows to hand over: the window boots empty and asks for them itself (ADR-0021).
    openWorklistWindow([]);
    return;
  }
  console.log('[tm30-helper] launch: not paired — opening the standalone portal window');
  openStandaloneWindow();
}

function reportBrokenLink(reason, url) {
  console.error('[tm30-helper] BROKEN DEEP LINK:', reason, '\n  url:', url);
  dialog.showErrorBox(
    'TM30 Helper — broken link',
    `This tm30:// link could not be read:\n\n${reason}\n\n` +
      'Nothing was opened. Go back to the web app and try again — if it keeps failing, ' +
      'the link is likely too long or was cut off in transit.'
  );
}

function handleDeepLink(url) {
  const result = parseDeepLink(url);
  if (!result) return; // не наша ссылка

  switch (result.kind) {
    case DeepLinkKind.V1:
      console.log('[tm30-helper] deep link v1: account="' + result.account.name + '"');
      openAccountWindow(result.account);
      return;

    case DeepLinkKind.V2: {
      const withCreds = result.worklist.filter((r) => r.account).length;
      console.log(
        `[tm30-helper] deep link v${result.payload_version}: ${result.worklist.length} filing(s), ` +
          `${withCreds} with credentials, ${result.worklist.length - withCreds} manual-login` +
          (result.focus_filing_id !== undefined ? `, focus filing #${result.focus_filing_id}` : '')
      );
      // BEFORE the gate: a link we are about to refuse still tells us where the install page is,
      // and that is precisely the operator who will need it from a Dock launch afterwards.
      rememberInstallPage(result.worklist);
      // AC-12, and BEFORE the gate for the same reason: a Helper too old for this link is the
      // one whose version the dashboard is trying to warn about. Never awaited — the report is
      // incapable of delaying the gate, the window or the filing behind it.
      rememberReportDetails(result);
      void reportVersion();
      // Layer 2 gate — BEFORE the window. A refused link opens nothing at all.
      if (refusedForVersion(result, url)) return;
      openWorklistWindow(result.worklist, result.focus_filing_id);
      return;
    }

    /**
     * ADR-0021 — THE POINTER. No rows arrived; what arrived is where to get them and what to
     * present when asking. Q-4 taught this case to REMEMBER; Q-5 gives it the window that acts
     * on what was remembered.
     *
     * The order is the v2 case's, for the v2 case's reasons: remember BEFORE the floor gate, so a
     * link this build is too old for still leaves the Helper paired — that operator is precisely
     * the one who will next launch from the Dock and need a queue there.
     *
     * The gate lets v4 through from 2.5.0 on, which is what `package.json` now says (Q-7). While
     * this branch sat at 2.4.0 the gate refused every v4 link and only the pairing landed — the
     * intended pre-release state, now closed. `test/roundtrip.test.mjs` (h4) keeps it closed:
     * shipping below `TM30_MIN_HELPER_VERSION_V4` while this case exists is a red test.
     */
    case DeepLinkKind.V4:
      console.log(
        `[tm30-helper] deep link v4: pointer to ${result.api_base}` +
          (result.focus_filing_id !== undefined ? `, focus filing #${result.focus_filing_id}` : '')
      );
      rememberReportDetails(result);
      void reportVersion();
      if (refusedForVersion(result, url)) return;
      // No rows in a pointer, by construction — the window fetches them. The focus rides along
      // and is resolved against the FETCHED queue, since there is no payload to resolve it in.
      openWorklistWindow([], result.focus_filing_id);
      return;

    case DeepLinkKind.CHOOSER:
      console.log('[tm30-helper] deep link: chooser (no payload)');
      openLaunchWindow();
      return;

    case DeepLinkKind.ERROR:
    default:
      reportBrokenLink(result.reason, url);
  }
}

// ---------- A-WEB-4d: скачивание листа + открытие папки ----------
// Скачивание файла, инициированное ЧЕЛОВЕКОМ (005 §8.3.1: «лист скачивается локально, дальше
// человек грузит его в портал руками»). Раньше здесь стояло «единственное сетевое действие
// хелпера, никаких data-fetch'ей» — после ADR-0021 это неправда: хелпер проверяет релизы на
// GitHub, репортит свою версию, тянет worklist и пишет `submitted`. Три последних идут в наш
// бэкенд через `queue-client.js`. Верно лишь то, что ЭТА загрузка по-прежнему запускается
// человеком и ничего не тянет фоном.

const DOWNLOAD_TIMEOUT_MS = 120_000;

function isHttpUrl(raw) {
  try {
    const u = new URL(String(raw));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** `~/Downloads/name.xlsx` → `~/Downloads/name (1).xlsx`, чтобы не затирать прошлый лист. */
function uniqueDownloadPath(dir, rawName) {
  const safe = path.basename(String(rawName || '')).replace(/[/\\]/g, '_') || 'tm30-sheet.xlsx';
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length) || 'tm30-sheet';

  let candidate = path.join(dir, safe);
  for (let n = 1; fs.existsSync(candidate); n += 1) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
  }
  return candidate;
}

/**
 * Скачивает `sheet_download_url` в системную папку загрузок и возвращает РЕАЛЬНЫЙ путь —
 * рендерер печатает его в строку статуса (`sheet downloaded ✓`), поэтому путь должен быть
 * тем, что лежит на диске, а не тем, что мы надеялись получить.
 *
 * ⚠️ `will-download` висит на сессии, а не на конкретном запросе. Загрузка идёт через сессию
 * ОКНА (`event.sender` — это app.html, его сессия — дефолтная), и с A-WEB-4g это уже НЕ та
 * сессия, где живут webview портала: у каждой виллы своя партиция `persist:tm30-v-…`, так что
 * загрузки, начатые человеком в портале, сюда физически не приезжают. Слушатель всё равно
 * ставится ТОЛЬКО на время нашей загрузки и снимается в `finish()` — параллельные скачивания
 * листов из самого окна не должны перехватывать друг друга.
 */
ipcMain.handle('tm30:download-sheet', (event, rawUrl) => {
  if (!isHttpUrl(rawUrl)) return Promise.resolve({ ok: false, error: 'not an http(s) url' });

  const wc = event.sender;
  return new Promise((resolve) => {
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wc.session.removeListener('will-download', onWillDownload);
      resolve(result);
    };

    const onWillDownload = (_e, item) => {
      const target = uniqueDownloadPath(app.getPath('downloads'), item.getFilename());
      item.setSavePath(target);
      item.once('done', (_ev, state) => {
        finish(
          state === 'completed'
            ? { ok: true, path: target, filename: path.basename(target) }
            : { ok: false, error: state } // 'cancelled' | 'interrupted'
        );
      });
    };

    const timer = setTimeout(() => finish({ ok: false, error: 'timed out' }), DOWNLOAD_TIMEOUT_MS);

    wc.session.on('will-download', onWillDownload);
    wc.downloadURL(String(rawUrl));
  });
});

/**
 * A-WEB-4g: ↻ fresh login — сброс портальной сессии ОДНОЙ виллы.
 *
 * 🔴 Префикс `persist:tm30-` — единственная граница этого глагола, и она проверяется ЗДЕСЬ,
 * в main, а не в renderer'е: renderer не должен уметь попросить очистку чужой партиции
 * (в т.ч. дефолтной сессии, где живёт само окно и его загрузки листов). Всё, что не наше, —
 * `{ok:false}` и НИЧЕГО не очищено.
 *
 * `session.fromPartition` создаёт партицию, если её ещё нет — очистка пустой партиции
 * корректна и честно возвращает ok. Сети здесь нет вообще: стирается локальное хранилище,
 * ни одного байта наружу. (Сетевые вызовы у хелпера есть — они в `queue-client.js` и в
 * `checkForNewerRelease`, ADR-0021; этот глагол к ним отношения не имеет.)
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

/**
 * T3-08: ⇥ insert — скачивание листа в per-task каталог ({userData}/tm30-sheets/{filing_id}/)
 * + программная подстановка файла в input[type=file] портальной webview (CDP primary, in-page
 * fallback, read-back verification). Весь движок живёт в ./insert-sheet.js, чтобы insert-харнесс
 * (который, как и autofill-харнесс, бутается САМ вместо main.js) регистрировал ТОТ ЖЕ
 * production-обработчик, а не дрейфующую копию.
 */
registerInsertSheet();

/** 📁 — отдаём ссылку настоящему браузеру человека. Открыть браузер ≠ сетевой вызов хелпера. */
/**
 * Whether a downloaded update is sitting on disk, so a freshly opened window can render the
 * "restart now" affordance for an update that finished downloading BEFORE it existed.
 */
ipcMain.handle('tm30:update-state', async () => ({ downloaded: downloadedUpdateVersion }));

/**
 * Install the already-downloaded update and relaunch.
 *
 * 🔴 Refuses when nothing has been downloaded. `quitAndInstall` with no staged update quits the
 * app and installs nothing — the operator's window closes and they are still on the old build,
 * with no explanation. Not a theoretical ordering: the renderer can only ever have learned about
 * an update from us, but the guard costs one line and the failure it prevents is silent.
 */
ipcMain.handle('tm30:quit-and-install', async () => {
  if (!downloadedUpdateVersion) return { ok: false, error: 'no update has been downloaded' };
  console.log('[tm30-helper] installing', downloadedUpdateVersion, 'at the operator\'s request');
  // setImmediate: let this IPC call return before the app starts tearing itself down, or the
  // renderer's promise rejects and the click looks like it failed.
  setImmediate(() => autoUpdater.quitAndInstall());
  return { ok: true };
});

ipcMain.handle('tm30:open-external', async (_event, rawUrl) => {
  if (!isHttpUrl(rawUrl)) return { ok: false, error: 'not an http(s) url' };
  try {
    await shell.openExternal(String(rawUrl));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// ---------- Q-5: the queue (ADR-0021, ADR-0022, ADR-0023) ----------
/**
 * 🔴 THE THREE QUEUE HANDLERS, AND THE ONE RULE THEY ALL KEEP.
 *
 * The token lives here and dies here. It is read from the module state, handed to the client, and
 * what goes back to the renderer is an OUTCOME — rows, a filing, or a `kind`. Nothing in the three
 * returns below can carry it, which is why `getQueueStatus` answers a boolean and not a string.
 *
 * They are also deliberately thin. Every decision that could be got wrong twice — the URL shapes,
 * the timeout, the 401-vs-400 classification, the "never throw" contract — lives in
 * `queue-client.js` (Q-3, frozen). What is genuinely this file's is WHOSE token and WHICH base,
 * plus AC-4's discard, which is a change to main's own state and belongs nowhere else.
 */

/**
 * AC-1 / AC-3 / AC-4 — fetch the queue, and pay AC-4's price on the spot.
 *
 * Deliberately takes no arguments: see the preload's note. The `booking_id` filter the route
 * accepts is NOT wired to the deep link's `focus_filing_id` — those are different id spaces, and
 * narrowing the queue to one booking would answer a question nobody asked while hiding the rest
 * of the operator's work. The focus is a HIGHLIGHT, resolved renderer-side against the full queue.
 */
ipcMain.handle('tm30:fetch-worklist', async () => {
  const res = await queueClient().fetchWorklist();
  /*
    🔴 AC-4 — DISCARD AND STOP, decided here rather than in the renderer, which has no credential
    to drop and no file to write. Q-3's integration note is the trap this guards: a MISSING token
    or base comes back `refused`/`status:0`, NOT `unauthorized` — there is nothing to discard in
    that case, and treating it as a revocation would delete a perfectly good token for being
    unaccompanied. Only a real 401/403 gets here.
  */
  if (!res.ok && res.kind === ErrorKind.UNAUTHORIZED) discardReportToken();
  return res;
});

/**
 * AC-11 / AC-11a / ADR-0023 — the Helper posts the transition itself.
 *
 * `user_id` is not sent and could not be honoured if it were: the route derives the actor from
 * the token server-side, which is the whole reason this attestation is allowed to leave the
 * Helper at all. The refusal path returns the server's own words untouched (`message`) — the row
 * shows them verbatim rather than the Helper's guess at what they meant.
 */
ipcMain.handle('tm30:mark-submitted', async (_event, req) => {
  const res = await queueClient().markSubmitted(req && req.filing_id, {
    receiptNo: req && req.receipt_no,
  });
  // A revoked token is revoked whichever route discovered it — same discard, same reason (AC-4).
  if (!res.ok && res.kind === ErrorKind.UNAUTHORIZED) discardReportToken();
  return res;
});

/**
 * ADR-0022 — what the window is allowed to assume about itself.
 *
 * 🔴 `paired` is computed, never stored: it is `token && api_base`, the same condition
 * `openLaunchWindow` routes on, asked once here so the window and the router can never disagree
 * about whether a fetch is possible. Asked AGAIN after a 401, it answers false — which is how the
 * renderer learns the discard happened without ever being told what was discarded.
 */
ipcMain.handle('tm30:queue-status', async () => ({
  paired: isPaired(),
  ...(isHttpUrl(apiBase) ? { apiBase } : {}),
}));

// ---------- Автообновление ----------
/**
 * На Windows помощник обновляет себя сам, молча. Ничего не спрашиваем и ничего не
 * показываем: человек открывает его, чтобы подать TM30, а не чтобы обслуживать
 * приложение.
 *
 * 🔴 На macOS этот механизм НЕ РАБОТАЕТ и работать не будет — ADR-0001: подписи нет,
 * mac-фид не публикуется, самозамену мы делать отказались. Там роль обновления играет
 * Layer 1 выше: полоска «есть версия новее» + ссылка на страницу установки, в окне
 * worklist'а и в standalone-окне. Всё, что ниже, — про Windows.
 *
 * Как это ложится на жизненный цикл: на Windows приложение выходит, как только
 * закрыто последнее окно (см. `window-all-closed` ниже), то есть живёт от одной
 * задачи до другой. Проверка на старте + установка при выходе означают, что
 * обновление приезжает буквально к следующему открытию — окна для «забыл
 * обновиться» почти не остаётся. На macOS процесс живёт дольше, поэтому там
 * дополнительно работает периодическая проверка.
 *
 * 🔴 Обязательные условия, без которых механизм молча мёртв:
 *   • релиз собран с `--publish always`, чтобы рядом с артефактами лежали
 *     `latest.yml` / `latest-mac.yml` — апдейтер читает их, а не список файлов;
 *   • имена артефактов стабильные (`artifactName` в package.json): переименование
 *     файла руками расходится с именем внутри latest.yml и даёт 404;
 *   • macOS обновляется ТОЛЬКО из подписанного и нотаризованного билда — это
 *     требование Squirrel.Mac, а не настройка. Неподписанная сборка ставится
 *     руками и обновляться не будет.
 */
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function initAutoUpdate() {
  // Запуск через `electron .` не имеет фида обновлений — апдейтер там только шумит.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    console.log('[tm30-helper] update available:', info && info.version);
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[tm30-helper] update downloaded, installs on quit:', info && info.version);
    /*
      The update is already ON DISK and will install whenever the operator next quits. The strip
      exists to offer them "now" instead of "eventually" — a Helper left open for a week would
      otherwise keep running the old build while carrying the new one.
      Pushed to every open window: `app.html` decides whether to show anything.
    */
    downloadedUpdateVersion = (info && info.version) || null;
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('tm30:update-downloaded', downloadedUpdateVersion);
    }
  });
  // Сеть недоступна, релиз ещё не опубликован, GitHub прилёг — это не повод мешать
  // человеку работать. Ошибка идёт в лог, приложение продолжает как ни в чём не бывало.
  autoUpdater.on('error', (err) => {
    console.error('[tm30-helper] update check failed:', (err && err.message) || err);
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

// deep link может прилететь до app.whenReady()
let pendingLink = null;

// macOS: ссылки приходят сюда (и при запуске, и в работающее приложение)
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (app.isReady()) handleDeepLink(url);
  else pendingLink = url;
});

// Windows/Linux: ссылка в argv второго инстанса
app.on('second-instance', (_event, argv) => {
  const url = findDeepLinkInArgv(argv);
  if (url) handleDeepLink(url);
});

app.whenReady().then(() => {
  initAutoUpdate();
  loadInstallPage();
  loadReportDetails();
  // Layer 1 — fire and forget. Never awaited: a slow or unreachable GitHub must not delay the
  // window an operator is waiting for. Its answer is read when a v2 window opens, and pushed
  // into any standalone window that is already up — which, at a Dock launch, is all of them.
  void checkForNewerRelease().then(broadcastUpdateNotice);
  // AC-11 — EVERY launch, Dock included, and on the same terms: started here, never awaited,
  // and the very next line opens the window whatever it is doing. A launch that was never
  // taught an address reports nothing and says nothing about it.
  void reportVersion();

  const url = pendingLink || findDeepLinkInArgv(process.argv);
  if (url) {
    handleDeepLink(url);
  } else {
    // ADR-0022 — THE Dock / Start-menu launch: no link, no argv, just the app icon. This is the
    // path production measured 0/13 on, and the one AC-1 is written about.
    openLaunchWindow();
  }
  pendingLink = null;
});

// Хелпер живёт в фоне и ждёт следующие deep links, даже когда все окна закрыты
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  // macOS: the Dock icon again, with every window closed. Same situation as a cold launch, so it
  // takes the same branch — routing this one to the portal would put the queue one launch out of
  // reach for exactly the operator who just asked for it.
  if (BrowserWindow.getAllWindows().length === 0) openLaunchWindow();
});

/**
 * 🔴 TEST SEAM — inert in production. `main.js` is the Electron ENTRYPOINT: nothing requires it,
 * so this object is never constructed by anything the operator runs.
 *
 * It exists so `test/version-report.test.mjs` can drive the REAL memo and the REAL report rather
 * than a re-typed copy of them. That is the same rule `deeplink.js` was extracted under, applied
 * to code that genuinely cannot leave `main.js`: the memo needs `app.getPath('userData')` and
 * the report needs `app.getVersion()`. A mirrored copy of a file format is exactly the drift
 * `roundtrip.test.mjs` was written to catch — the thing under test must be the thing that ships.
 *
 * `__resetForTest` clears the per-launch module state (a test process is many "launches").
 */
module.exports = {
  readState,
  writeState,
  loadInstallPage,
  loadReportDetails,
  rememberInstallPage,
  rememberReportDetails,
  ensureInstallationId,
  reportVersion,
  handleDeepLink,
  // Q-5 — the routing decision and the credential drop, so a test drives the REAL ones.
  isPaired,
  resolveReportUrl,
  discardReportToken,
  openLaunchWindow,
  __resetForTest() {
    installPageUrl = null;
    reportUrl = null;
    reportToken = null;
    apiBase = null;
    reportedThisLaunch = null;
  },
};
