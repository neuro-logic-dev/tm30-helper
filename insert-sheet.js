'use strict';

/**
 * T3-08 — ⇥ INSERT SHEET INTO PORTAL: the main-process engine.
 *
 * Eliminates the one remaining human file choice in the submission flow. Until now the manager
 * downloaded the sheet to ~/Downloads and then PICKED IT BY HAND in the portal's file dialog —
 * and "name (1).xlsx" next to "name.xlsx" is exactly how the wrong villa's guests get filed.
 * This verb derives the file from the ROW (filing_id → sheet_download_url), downloads it to a
 * path only that filing owns, and places it into the portal page's file input programmatically.
 * No picker ever opens; there is no step where a human can choose the wrong file.
 *
 * ── The three mechanisms (user-approved ADR, STRICT) ────────────────────────────────────────
 *   A · PRIMARY  — CDP `DOM.setFileInputFiles` via `webContents.debugger`. Chromium's own
 *                  automation path: real File objects, no bytes shipped into the page.
 *                  Attach → act → detach, scoped to the one insert, never left attached.
 *   B · FALLBACK — in-page File + DataTransfer synthesis via `executeJavaScript`, used when the
 *                  debugger attach throws (e.g. DevTools already attached) or A fails the
 *                  read-back. Ships the bytes as base64, so it refuses files > 10 MB (ours are
 *                  KB-sized) rather than pushing a huge string into the page.
 *   C · GUARDRAIL— ALWAYS after A or B, in TWO stages. STAGE 1 (strongest): read `input.files[0]`
 *                  back and compare name + byte size against the file on disk — a byte-exact
 *                  match is a hard "verified ✓". STAGE 2 (consuming uploaders): the real portal
 *                  reads the File into framework state on `change` and CLEARS the input, so
 *                  stage 1 finds it EMPTY through no fault of ours; when the expected filename is
 *                  then visible on the page (the uploader's own display box), that is a SOFT
 *                  success — "accepted by the page, input consumed", NOT a mismatch. Only an
 *                  EMPTY input with the filename NOWHERE on the page is the LOUD do-NOT-submit
 *                  failure — never a silent "probably".
 *
 * ── What this deliberately does NOT do ──────────────────────────────────────────────────────
 *   · click the portal's submit — submission stays a human decision, in the portal pane
 *     (010 §8 Portal NO-GO: the ONE DOM write here is the file input; no navigation, no submit).
 *   · touch ~/Downloads — the plain ⬇ xlsx button keeps its dedup path untouched; the insert
 *     flow owns {userData}/tm30-sheets/{filing_id}/ and overwrites stale copies there.
 *   · trust the renderer with paths — only row-derived data crosses the bridge (filing_id, the
 *     payload's sheet url, the villa partition); the on-disk path is re-derived HERE.
 *
 * Lives in its own module (not main.js) for the same reason deeplink.js does: the insert
 * harness boots Electron WITH ITSELF as the main script, so it registers THIS handler — the
 * production one — instead of replicating it (the drift the autofill harness has to
 * static-assert away).
 */

const { app, ipcMain, session, webContents } = require('electron');
const path = require('path');
const fs = require('fs');

const DOWNLOAD_TIMEOUT_MS = 120_000;
/** B ships base64 into the page — refuse anything bigger than this instead (contract cap). */
const INPAGE_MAX_BYTES = 10 * 1024 * 1024;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** The marker PREP stamps on the ONE unambiguous file input; every script targets it. */
const TARGET_SELECTOR = 'input[type="file"][data-tm30-insert]';

function isHttpUrl(raw) {
  try {
    const u = new URL(String(raw));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const errMsg = (e) => String((e && e.message) || e);

/**
 * Find the target file input and prepare the page for ONE insert:
 *   · unstamp any marker a previous insert left behind (idempotent re-runs);
 *   · pick the ONE unambiguous input[type=file]: exactly one visible wins; zero visible but
 *     exactly one in total also wins (custom-styled uploaders hide the input behind a label —
 *     hidden-but-only is still unambiguous). Anything else is a refusal, never a guess.
 *   · stamp it + start recording input/change events on it, so the caller can tell whether
 *     CDP itself fired them (the empirical check contract 3 demands).
 */
const PREP_SCRIPT = `
  (function () {
    var old = document.querySelectorAll('[data-tm30-insert]');
    for (var i = 0; i < old.length; i += 1) old[i].removeAttribute('data-tm30-insert');

    var all = document.querySelectorAll('input[type="file"]');
    var visible = [];
    for (var j = 0; j < all.length; j += 1) {
      if (all[j].getClientRects().length > 0 || all[j].offsetParent !== null) visible.push(all[j]);
    }

    var target = null;
    if (visible.length === 1) target = visible[0];
    else if (visible.length === 0 && all.length === 1) target = all[0];
    if (!target) return { marked: false, total: all.length, visible: visible.length };

    target.setAttribute('data-tm30-insert', '1');
    window.__tm30InsertEvents = [];
    if (!target.__tm30InsertRecorder) {
      target.__tm30InsertRecorder = true;
      ['input', 'change'].forEach(function (t) {
        target.addEventListener(t, function () {
          if (window.__tm30InsertEvents) window.__tm30InsertEvents.push(t);
        });
      });
    }
    return { marked: true, total: all.length, visible: visible.length };
  })()
`;

/** Guardrail C's read: what the input ACTUALLY holds now, plus the events observed so far. */
const READBACK_SCRIPT = `
  (function () {
    var t = document.querySelector('${TARGET_SELECTOR}');
    if (!t) return { found: false, count: 0, name: null, size: null, events: [] };
    var f = t.files && t.files[0];
    return {
      found: true,
      count: t.files ? t.files.length : 0,
      name: f ? f.name : null,
      size: f ? f.size : null,
      events: window.__tm30InsertEvents || []
    };
  })()
`;

/** Fired only when the page did NOT observe input/change from CDP itself (contract 3). */
const DISPATCH_SCRIPT = `
  (function () {
    var t = document.querySelector('${TARGET_SELECTOR}');
    if (!t) return false;
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()
`;

/** Mechanism B: synthesize the File in the page. Dispatches input+change itself. */
function buildInpageScript(base64, filename) {
  return `
    (function () {
      var t = document.querySelector('${TARGET_SELECTOR}');
      if (!t) return false;
      var bin = atob(${JSON.stringify(base64)});
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      var file = new File([bytes], ${JSON.stringify(filename)}, { type: ${JSON.stringify(XLSX_MIME)} });
      var dt = new DataTransfer();
      dt.items.add(file);
      t.files = dt.files;
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `;
}

/**
 * Guardrail C, stage 2: the input came back EMPTY after placement — did a CONSUMING uploader
 * take the File and echo its name onto the page? The filename is unique enough (villa + dates)
 * that a plain `innerText` scan is a safe, cheap positive signal.
 */
function buildConsumedScript(filename) {
  return `
    (function () {
      try {
        var txt = (document.body && document.body.innerText) || '';
        return txt.indexOf(${JSON.stringify(filename)}) >= 0;
      } catch (e) { return false; }
    })()
  `;
}

/**
 * The webview webContents that IS this villa's portal pane, resolved through its partition —
 * `session.fromPartition` memoizes, so session identity means "runs in this villa's cookie
 * jar" (the same mapping the autofill harness uses). `hostWebContents === sender` pins it to a
 * pane embedded in the CALLING window: one renderer can never insert into another window's
 * portal. The partition prefix was already guarded by the handler before this runs.
 */
function findVillaWebview(sender, partition) {
  const target = session.fromPartition(partition);
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed() || wc.getType() !== 'webview') continue;
    if (wc.session !== target || wc.hostWebContents !== sender) continue;
    return wc;
  }
  return null;
}

/**
 * Download the row's sheet to ITS OWN directory: {userData}/tm30-sheets/{filing_id}/{name}.
 * The dir is emptied first, so it only ever holds the LAST downloaded copy — stale sheets are
 * overwritten, never deduped into "name (1).xlsx" (the exact ambiguity this feature removes).
 * ~/Downloads and the plain ⬇ button are untouched.
 *
 * Same session-scoped `will-download` mechanics as `tm30:download-sheet` in main.js, with one
 * addition: the listener only claims items whose URL chain starts at OUR url, so an insert
 * cannot hijack a plain download the operator started in the same window a moment earlier.
 */
function downloadToTaskDir(sender, rawUrl, filingId) {
  const dir = path.join(app.getPath('userData'), 'tm30-sheets', String(filingId));
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  } catch (err) {
    return Promise.resolve({ ok: false, error: 'could not prepare the task directory — ' + errMsg(err) });
  }

  return new Promise((resolve) => {
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sender.session.removeListener('will-download', onWillDownload);
      resolve(result);
    };

    const onWillDownload = (_e, item) => {
      const chain = item.getURLChain();
      const origin = (chain && chain[0]) || item.getURL();
      if (origin !== String(rawUrl)) return; // someone else's download — not ours to claim

      const safe = path.basename(String(item.getFilename() || '')).replace(/[/\\]/g, '_') ||
        'tm30-sheet-' + filingId + '.xlsx';
      const target = path.join(dir, safe);
      item.setSavePath(target);
      item.once('done', (_ev, state) => {
        finish(
          state === 'completed'
            ? { ok: true, path: target, filename: safe }
            : { ok: false, error: state } // 'cancelled' | 'interrupted'
        );
      });
    };

    const timer = setTimeout(() => finish({ ok: false, error: 'timed out' }), DOWNLOAD_TIMEOUT_MS);

    sender.session.on('will-download', onWillDownload);
    sender.downloadURL(String(rawUrl));
  });
}

/**
 * Mechanism A. Attach → DOM.getDocument → DOM.querySelector(marker) → DOM.setFileInputFiles →
 * detach — the detach is in `finally`, so the debugger is NEVER left attached (constraint),
 * whatever throws in between. Throws to signal "fall back to B".
 */
async function insertViaCdp(wc, filePath) {
  const dbg = wc.debugger;
  dbg.attach('1.3'); // throws if something (e.g. DevTools) already holds the debugger
  try {
    const { root } = await dbg.sendCommand('DOM.getDocument');
    const { nodeId } = await dbg.sendCommand('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: TARGET_SELECTOR,
    });
    if (!nodeId) throw new Error('the marked file input was not resolvable over CDP');
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: [filePath] });
  } finally {
    try { dbg.detach(); } catch { /* already detached */ }
  }
}

/**
 * The post-placement settle + two-stage verify. Read back, and if the file IS in but the page
 * never observed input/change (the empirical CDP question), dispatch them and read back AGAIN —
 * the page may legitimately react to the events (that second read is what catches a page that
 * clears the input on change, instead of reporting a false ✓). Then classify:
 *
 *   'verified' — stage 1: the input STILL holds the file, byte-exact. The strongest signal.
 *   'accepted' — stage 2: the input is EMPTY but the expected filename is visible on the page —
 *                a consuming uploader took the File into its own state. A SOFT success.
 *   'failed'   — the input is empty (or gone) AND the filename is nowhere: the LOUD mismatch.
 */
async function settleAndVerify(wc, expect) {
  let v = await wc.executeJavaScript(READBACK_SCRIPT);
  const placedNow = () =>
    v && v.found && v.count === 1 && v.name === expect.name && v.size === expect.size;
  const observed = {
    input: !!v && v.events.indexOf('input') >= 0,
    change: !!v && v.events.indexOf('change') >= 0,
  };

  let dispatched = false;
  if (placedNow() && (!observed.input || !observed.change)) {
    await wc.executeJavaScript(DISPATCH_SCRIPT);
    dispatched = true;
    v = await wc.executeJavaScript(READBACK_SCRIPT);
  }

  let verdict = 'failed';
  if (placedNow()) {
    verdict = 'verified';
  } else if (v && v.found && v.count === 0) {
    // The input was CLEARED — the sign of a consuming uploader. Confirm the page actually took
    // OUR file (its name is on the page), never accept an empty input on faith.
    let onPage = false;
    try {
      onPage = await wc.executeJavaScript(buildConsumedScript(expect.name));
    } catch { onPage = false; }
    if (onPage) verdict = 'accepted';
  }
  return { verdict, observed, dispatched, snapshot: v };
}

/** One line of honest read-back state for the loud mismatch message. */
function describeSnapshot(v) {
  if (!v || !v.found) return 'the marked file input is GONE from the page';
  if (v.count === 0) return 'the file input is EMPTY';
  return `the file input holds "${v.name}" (${v.size} bytes)`;
}

/** In-flight inserts, keyed by target webContents id — one insert per portal pane at a time. */
const inflight = new Set();

async function handleInsertSheet(event, req) {
  const fail = (stage, error, extra) => ({ ok: false, stage, error, ...extra });

  // ── request validation: ONLY row-derived data, every field re-checked here ──────────────
  const filingId = req && req.filing_id;
  const rawUrl = req && req.url;
  const partition = req && req.partition;
  if (!Number.isFinite(filingId)) return fail('request', 'filing_id is not a number');
  if (!isHttpUrl(rawUrl)) return fail('request', 'sheet url is not an http(s) url');
  if (typeof partition !== 'string' || !partition.startsWith('persist:tm30-v-')) {
    return fail('request', 'not a tm30 villa partition');
  }

  const target = findVillaWebview(event.sender, partition);
  if (!target) {
    return fail('target', "this villa's portal pane is not open — select the villa first");
  }

  // Concurrent inserts on the same pane are REJECTED, not queued: the second click was almost
  // certainly an impatient double-click, and queueing it would re-run a flow that already ran.
  if (inflight.has(target.id)) {
    return fail('busy', 'an insert is already running in this portal pane — wait for it to finish');
  }
  inflight.add(target.id);
  try {
    return await runInsert(event.sender, target, filingId, String(rawUrl));
  } catch (err) {
    return fail('internal', errMsg(err));
  } finally {
    inflight.delete(target.id);
  }
}

async function runInsert(sender, target, filingId, rawUrl) {
  const fail = (stage, error, extra) => ({ ok: false, stage, error, ...extra });

  // 1 · the per-task download — the file's identity comes from the ROW, nothing else.
  const dl = await downloadToTaskDir(sender, rawUrl, filingId);
  if (!dl.ok) return fail('download', 'sheet download failed — ' + dl.error);
  const expect = { name: dl.filename, size: fs.statSync(dl.path).size };

  // 2 · find + mark the ONE unambiguous file input; anything else fails loudly, never guesses.
  let prep;
  try {
    prep = await target.executeJavaScript(PREP_SCRIPT);
  } catch (err) {
    return fail('find-input', 'could not inspect the portal page — ' + errMsg(err));
  }
  if (!prep || prep.marked !== true) {
    if (!prep || prep.total === 0) {
      return fail('find-input',
        'no file input on this portal page — open the upload page in the portal first');
    }
    return fail('find-input',
      `${prep.total} file inputs on this portal page (${prep.visible} visible) — refusing to guess which one`);
  }

  // 3 · mechanism A (unless the test toggle forces B), falling back honestly.
  const forcedInpage = process.env.TM30_INSERT_MODE === 'inpage';
  let fellBack = null; // why A was abandoned, when it was
  let cdpEvents = null; // did CDP itself fire input/change? (the empirical answer)
  let cdpDispatched = false;

  if (!forcedInpage) {
    let placedByCdp = false;
    try {
      await insertViaCdp(target, dl.path);
      placedByCdp = true;
    } catch (err) {
      fellBack = 'CDP attach/act failed — ' + errMsg(err);
    }
    if (placedByCdp) {
      const settled = await settleAndVerify(target, expect);
      cdpEvents = settled.observed;
      cdpDispatched = settled.dispatched;
      // Only a 'failed' verdict (BOTH stages missed) drops through to mechanism B; 'verified'
      // and the 'accepted' soft success both return ok here.
      if (settled.verdict !== 'failed') {
        return {
          ok: true, filename: expect.name, path: dl.path, size: expect.size,
          mechanism: 'cdp', verification: settled.verdict,
          cdpEvents, dispatchedEvents: cdpDispatched, fellBack: null,
        };
      }
      fellBack = 'CDP placed the file but the read-back did not hold — ' +
        describeSnapshot(settled.snapshot);
    }
  }

  // 4 · mechanism B — the fallback (or the forced test mode).
  if (expect.size > INPAGE_MAX_BYTES) {
    return fail('mechanism',
      `the sheet is ${expect.size} bytes — over the 10 MB in-page cap, and the CDP path ` +
      (forcedInpage ? 'is disabled by TM30_INSERT_MODE=inpage' : 'failed: ' + fellBack),
      { fellBack });
  }
  let applied;
  try {
    const base64 = fs.readFileSync(dl.path).toString('base64');
    applied = await target.executeJavaScript(buildInpageScript(base64, expect.name));
  } catch (err) {
    return fail('mechanism', 'in-page synthesis failed — ' + errMsg(err), { fellBack });
  }
  if (applied !== true) {
    return fail('mechanism', 'in-page synthesis could not find the marked file input', { fellBack });
  }

  const settled = await settleAndVerify(target, expect);
  if (settled.verdict !== 'failed') {
    return {
      ok: true, filename: expect.name, path: dl.path, size: expect.size,
      mechanism: 'inpage', verification: settled.verdict,
      cdpEvents, dispatchedEvents: true, fellBack,
    };
  }

  // 5 · guardrail C failed both ways — the one message that must never be softened.
  return fail('verify',
    `read-back mismatch: expected "${expect.name}" (${expect.size} bytes) but ` +
    describeSnapshot(settled.snapshot) +
    (fellBack ? ` (CDP first: ${fellBack})` : ''),
    { fellBack });
}

/** Registered by main.js AND by the insert harness — both run this exact production handler. */
function registerInsertSheet() {
  ipcMain.handle('tm30:insert-sheet', handleInsertSheet);
}

module.exports = { registerInsertSheet };
