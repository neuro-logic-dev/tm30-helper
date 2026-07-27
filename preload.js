'use strict';

/**
 * A-WEB-4d — the ONLY native seam the worklist pane needs.
 * A-WEB-4g — added the third verb: `resetPortalSession`.
 * T3-08    — added the fourth verb: `insertSheet`. The bridge stays deliberately non-general —
 *            four named verbs, no pass-through.
 *
 * `app.html` runs with `contextIsolation` on and no node integration, so it cannot reach
 * `shell` or `webContents.downloadURL` by itself. This preload exposes exactly four verbs and
 * nothing else — it is deliberately not a general-purpose bridge.
 *
 * ── What this does NOT do ───────────────────────────────────────────────────────────────
 * · No `fetch`, no data API. 014 §2.5: the Helper makes ZERO network calls of its own. The
 *   worklist is the deep-link payload. `downloadSheet` is a USER-INITIATED FILE DOWNLOAD of a
 *   URL the payload already carried — that is the 005 §8.3.1 "connect Excel to the portal"
 *   trick, and it is the one byte that ever crosses the wire.
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
});
