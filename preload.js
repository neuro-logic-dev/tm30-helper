'use strict';

/**
 * A-WEB-4d — the ONLY native seam the worklist pane needs.
 *
 * `app.html` runs with `contextIsolation` on and no node integration, so it cannot reach
 * `shell` or `webContents.downloadURL` by itself. This preload exposes exactly two verbs and
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
});
