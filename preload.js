'use strict';

/**
 * A-WEB-4d — the ONLY native seam the worklist pane needs.
 * A-WEB-4g — added the third verb: `resetPortalSession`.
 * T3-08    — added the fourth verb: `insertSheet`. The bridge stays deliberately non-general —
 *            four named verbs, no pass-through.
 *
 * Q-5      — added the queue verbs: `fetchWorklist`, `markSubmitted`, `getQueueStatus` (ADR-0021,
 *            ADR-0023). Still named verbs, still no pass-through.
 *
 * `app.html` runs with `contextIsolation` on and no node integration, so it cannot reach
 * `shell` or `webContents.downloadURL` by itself. This preload exposes exactly seven verbs and
 * nothing else — it is deliberately not a general-purpose bridge.
 *
 * ── What this does NOT do ───────────────────────────────────────────────────────────────
 * · No `fetch` IN THE RENDERER, and no URL, base or token reachable from it. ADR-0021 inverted
 *   the transport — the worklist is now FETCHED rather than carried in the deep link — but the
 *   request is made by the MAIN process (`queue-client.js`), which holds the operator token and
 *   the backend address. What crosses this bridge is an OUTCOME: rows, or a `kind` naming how it
 *   failed. 🔴 The token never crosses. `getQueueStatus()` answers `paired`, never the secret.
 * · No portal access. The `<webview>` is not reachable from here (010 §8, Portal NO-GO).
 *
 * Attached ONLY to the v2 two-pane window. The v1 windows (`index.html`, `window.html`) get no
 * preload and are byte-untouched — backward compat is mandatory (013 §3.5).
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tm30Native', {
    /**
     * Downloads `row.sheet_download_url` into the OS Downloads directory.
     * @param {string} url
     * @returns {Promise<{ok:true,path:string,filename:string}|{ok:false,error:string}>}
     */
    downloadSheet: (url) => ipcRenderer.invoke('tm30:download-sheet', url),

    /**
     * Opens `row.folder_url` in the human's real browser — the escape hatch (005 §8.3.1).
     * @param {string} url
     * @returns {Promise<{ok:boolean,error?:string}>}
     */
    openExternal: (url) => ipcRenderer.invoke('tm30:open-external', url),

    /**
     * Whether an update is already downloaded and waiting to install on quit.
     * @returns {Promise<{downloaded: string|null}>}
     */
    updateState: () => ipcRenderer.invoke('tm30:update-state'),

    /**
     * Install the downloaded update and relaunch. Refused by main when nothing is staged.
     * @returns {Promise<{ok:boolean,error?:string}>}
     */
    quitAndInstall: () => ipcRenderer.invoke('tm30:quit-and-install'),

    /**
     * Fires when an update finishes downloading WHILE this window is open.
     *
     * 🔴 The callback is wrapped rather than handed the raw IPC event: `ipcRenderer.on` passes an
     * IpcRendererEvent whose `.sender` is the full ipcRenderer, and forwarding that into the
     * renderer would hand page script a channel to every main-process handler. Only the version
     * string crosses.
     * @param {(version: string|null) => void} fn
     */
    onUpdateDownloaded: (fn) =>
        ipcRenderer.on('tm30:update-downloaded', (_event, version) => fn(version)),

    /**
     * A-WEB-4g: clears ONE villa partition's storage, so the operator can restart that villa's
     * portal login (↻ fresh login) without restarting the app. The main-process handler refuses
     * anything not prefixed `persist:tm30-`, so this verb can never touch the window's own
     * session or any partition outside the Helper's per-villa scheme.
     * @param {string} partition
     * @returns {Promise<{ok:boolean,error?:string}>}
     */
    resetPortalSession: (partition) => ipcRenderer.invoke('tm30:reset-portal-session', partition),

    /**
     * T3-08: downloads the row's sheet to its PER-TASK path and places it into the villa's
     * portal file input programmatically (CDP primary, in-page fallback, read-back verified in
     * main) — no file picker, so a wrong-file upload is structurally impossible. Only
     * row-derived data crosses (the fields are picked explicitly, never passed through): main
     * re-derives the on-disk path from filing_id + url, and the partition is prefix-guarded
     * there exactly like `resetPortalSession`'s.
     * @param {{filing_id:number, url:string, partition:string}} req
     * @returns {Promise<{ok:true,filename:string,path:string,size:number,mechanism:'cdp'|'inpage',
     *   cdpEvents:{input:boolean,change:boolean}|null, dispatchedEvents:boolean, fellBack:string|null}
     *   |{ok:false,stage:string,error:string}>}
     */
    insertSheet: (req) => ipcRenderer.invoke('tm30:insert-sheet', {
        filing_id: req && req.filing_id,
        url: req && req.url,
        partition: req && req.partition,
    }),

    // ── Q-5 · the queue (contract C-8) ──────────────────────────────────────────────────────
    /**
     * AC-1 — the company queue, fetched by MAIN over HTTPS and handed here as an outcome.
     *
     * Takes NO arguments on purpose: the renderer does not choose an address, a page size or a
     * token, because it holds none of them. `main.js` builds the client from what the deep link
     * taught it, so a renderer bug can never point the fetch somewhere else.
     *
     * The success body is `Tm30Worklist` (`{items, total_due, total_overdue}`) passed through
     * UNTOUCHED — AC-16: a field this build has never heard of must arrive inert, not be dropped.
     * A failure names its `kind` (see `queue-client.js` `ErrorKind`), never a fabricated empty
     * queue, which is the lie AC-3 exists to forbid.
     * @returns {Promise<{ok:true,worklist:object}|{ok:false,kind:string,status:number,message?:string}>}
     */
    fetchWorklist: () => ipcRenderer.invoke('tm30:fetch-worklist'),

    /**
     * AC-11 / ADR-0023 — the one click. The Helper posts the transition itself.
     *
     * The actor is resolved SERVER-side from the token, so nothing identifying is sent from here
     * and nothing could be spoofed if it were. Fields are picked explicitly, exactly like
     * `insertSheet` above — the caller's object never crosses as itself.
     *
     * AC-11a: a refusal comes back as `kind:'refused'` with the server's `message`, which the row
     * shows verbatim. There is no local success anywhere in this path.
     * @param {number} filingId
     * @param {{receiptNo?: string}} [opts]
     * @returns {Promise<{ok:true,filing:object}|{ok:false,kind:string,status:number,message?:string}>}
     */
    markSubmitted: (filingId, opts) => ipcRenderer.invoke('tm30:mark-submitted', {
        filing_id: filingId,
        receipt_no: opts && opts.receiptNo,
    }),

    /**
     * ADR-0022 — can this window fetch at all?
     *
     * 🔴 `paired` is a BOOLEAN ABOUT a secret, never the secret. The token stays in main for the
     * whole of its life; the renderer learns only that one exists. `apiBase` is an address the
     * rows already reveal through their sheet URLs, so naming it costs nothing and lets the
     * window say WHERE it is disconnected from.
     * @returns {Promise<{paired: boolean, apiBase?: string}>}
     */
    getQueueStatus: () => ipcRenderer.invoke('tm30:queue-status'),
});
