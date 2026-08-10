> # ⛔ SUPERSEDED — 2026-08-10, by `.orchestrator/decisions/0001-no-apple-signing-no-self-replacement.md`
>
> The decision was **neither** Option C nor Option D. macOS stays unsigned and installed by hand;
> the Helper will not replace itself while running. What shipped instead: the "a newer release
> exists" notice now also appears in the standalone (Dock-launched) window, which is where an
> operator was previously told nothing at all.
>
> Kept for its reasoning and its evidence table. **Three of its factual claims are wrong** — see
> the "Handoff corrections" table in `.orchestrator/STATE.md` before acting on anything below:
> there is no v2.3.2, there is no "Restart & update now" button on any platform, and none of the
> `tm30:update-state` / `tm30:quit-and-install` / `#updinstall` symbols §5 maps exist in this repo.

# HANDOFF — macOS self-update for the TM30 Helper

Branch: `feat/macos-self-update` · Base: `main` @ 2.3.2 · Written 2026-08-10
**Run this session ON A MAC.** Nothing here can be verified on Linux or Windows, which is why it
was split out instead of being written blind.

---

## 1. Why this exists

The Helper auto-updates **on Windows only**. Three independent things block macOS, all verified
in the shipped configuration rather than assumed:

| what | where | value |
|---|---|---|
| the app is unsigned | `package.json` → `build.mac.identity` | **`null`** |
| the target cannot be updated from | `build.mac.target` | **`dmg` only** — `electron-updater` needs a `zip` |
| no update feed is published for mac | release v2.3.2 assets | `latest.yml` (Windows), `.exe`, `.exe.blockmap`, `.dmg` — **no `latest-mac.yml`** |

So a macOS operator installs once and stays there forever unless a human tells them to re-run the
install command. `MO-TM30-HELPER-VERSIONING.md` was retired on 2026-08-03 with the note *"the
Helper updates itself… macOS is signed and notarised"* — **that premise is false in the shipped
config**, and this handoff is the correction.

What already shipped in 2.3.1–2.3.2 and is NOT your job:
- **Layer 1** — a startup check against the public releases API that shows an amber strip when a
  newer release exists. Works on macOS. Tells the operator; cannot act for them.
- **Layer 2** — a per-link `min_helper_version` floor that refuses a link this build cannot honour.
- **The Windows "Restart & update now" button** — `autoUpdater.quitAndInstall()`, gated on an
  update actually being downloaded.

On macOS the strip's only action is "Open install page". Your job is to give it a real one.

---

## 2. The decision to make FIRST, before writing any code

There are two ways to close this, and they are not equal. **Read both, pick one, and say which
you picked and why in the PR.**

### Option C — do it properly: sign, notarise, ship a zip

Add `zip` alongside `dmg` in `build.mac.target`, set a real `build.mac.identity`, and notarise.
`electron-builder` then emits `latest-mac.yml`, the release workflow attaches it, and
`electron-updater` works on macOS exactly as it already does on Windows — including the
"Restart & update now" button that is already built and wired.

- Needs: an Apple Developer account (`MO-TM30-HELPER-VERSIONING.md` claims the team holds one —
  **verify that before starting**), a Developer ID Application certificate in the CI keychain,
  and `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` as repository secrets.
- Removes the problem class. No new runtime code, no self-replacing script, and Gatekeeper stops
  being something the install page has to work around with `xattr -dr com.apple.quarantine`.
- Cost is entirely in credentials and CI, not in application code.

### Option D — the self-replacing script

A button that spawns a detached shell script which waits for the app to exit, downloads the DMG,
swaps `/Applications/TM30 Helper.app` and relaunches — the install page's command, run from
inside the app.

- Needs no certificate and no CI change.
- **The app replaces itself while running.** The script must outlive its parent, and every failure
  mode leaves an operator with no application: the volume did not detach, the app had not exited
  when `rm -rf` ran, `/Applications` is not writable, the download was truncated.
- It is a workaround for the absence of C, and it will still be a workaround after it works.

**Recommendation: C.** Take D only if the Apple Developer account turns out not to exist or cannot
be used, and if you take it, treat §4's safety rules as mandatory rather than advisory.

---

## 3. If you take Option C

1. `build.mac.target` → `[{ "target": "dmg", "arch": ["universal"] }, { "target": "zip", "arch": ["universal"] }]`.
   The **dmg stays**: the install page downloads it by exact filename
   (`releases/latest/download/TM30-Helper.dmg`, hardcoded in
   `mo-reservation-fe/src/app/tm30-helper/page.tsx`), and the release workflow asserts that name.
   Removing it breaks every existing install command in the wild.
2. `build.mac.identity` → the Developer ID. Add notarisation (`build.afterSign` hook or
   `electron-builder`'s `notarize` block).
3. `.github/workflows/release.yml`: the macOS matrix entry's `paths` must gain
   `dist/TM30-Helper.zip` and `dist/latest-mac.yml`, or the feed is built and thrown away. There
   is already a "Verify the macOS artifact" step that asserts filenames — extend it, do not
   bypass it; that step exists because a rename slip is invisible until an operator's download
   404s.
4. Secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
   `APPLE_TEAM_ID`.
5. The install page's `xattr -dr com.apple.quarantine` can stay — harmless on a signed app, and
   removing it is a separate change with its own testing.

**Verification that actually proves it** (a green build does not):
- Install the PREVIOUS release on a real Mac from the `.dmg`.
- Publish the new one.
- Launch the old build, leave it open, and watch `~/Library/Logs/TM30 Helper/` for
  `update-downloaded`.
- Click **Restart & update now** — the button is already there and already gated on the download.
- Confirm the app relaunches and its own window prints the new version (`index.html` renders it).
- `spctl -a -vv "/Applications/TM30 Helper.app"` → `accepted`, and `source=Notarized Developer ID`.

---

## 4. If you take Option D

Rules, each of which exists because of a way this goes wrong:

- **The script must survive its parent.** `spawn` with `detached: true`, `stdio: 'ignore'`, then
  `unref()`. Write it to `app.getPath('temp')` and `chmod 0700`.
- **Wait for the app to actually exit**, do not `sleep` and hope: poll `pgrep -f "TM30 Helper"`
  until it is gone, with a bounded timeout, and abort the swap if it never goes. Deleting a
  running app's bundle is what corrupts the install.
- **Download and verify BEFORE destroying anything.** Fetch to a temp path, check the size and
  that `hdiutil attach` succeeds, and only then touch `/Applications`. The existing install
  command's `&&` chain does this by construction — keep that property.
- **Never leave the operator with nothing.** If the swap fails after the old bundle is gone,
  relaunch is impossible and the failure is invisible. Move the old bundle aside rather than
  deleting it, and restore it on any failure.
- **Log to a file the operator can be asked for.** A detached script's stderr goes nowhere;
  redirect it into `app.getPath('logs')`.
- The button lives in the same strip as the Windows one (`#updinstall` in `app.html`), so branch
  on `process.platform` in the main process and expose one verb — do not add a second button.

**Verification: on a real Mac, from a real previous release, at least twice** — once on the happy
path, once with the network cut mid-download, and confirm the app still starts afterwards.

---

## 5. Where everything is

| what | where |
|---|---|
| the strip, its markup and `renderUpdateBar` / `armUpdateInstall` | `app.html` (search `updbar`) |
| Layer 1 (`checkForNewerRelease`) and Layer 2 (`refusedForVersion`) | `main.js` |
| `update-downloaded` handling, `tm30:update-state`, `tm30:quit-and-install` | `main.js` |
| the renderer bridge | `preload.js` (`updateState`, `quitAndInstall`, `onUpdateDownloaded`) |
| release pipeline | `.github/workflows/release.yml` (run it with `-f version=x.y.z`) |
| the install page the strip links to | `mo-reservation-fe/src/app/tm30-helper/page.tsx` |
| the retired spec, kept for its reasoning | `Backlog/specs/MO-TM30-HELPER-VERSIONING.md` |

Tests: `./test/run.sh` (emitter↔parser seam, 33), `node --test test/*.test.mjs` (39).
`test/worklist-render.test.mjs` lifts pure functions out of `app.html` **by name** — if you rename
one, that test fails loudly rather than silently covering nothing. Keep it that way.

**Do not** run `npm start` expecting the updater: `initAutoUpdate` returns early when
`app.isPackaged` is false. Any update work has to be tested against an installed build.

---

## 6. Definition of done

- A macOS operator on release N ends up on release N+1 **without being told to do anything**, or —
  under Option D — by pressing one button.
- The failure path leaves a working application in every case you can force.
- `mo-reservation-fe/src/app/tm30-helper/page.tsx` §Updating is corrected: it currently states
  plainly that macOS does **not** update itself. If it now does, that paragraph is wrong and
  must change in the same release, or the page lies in the other direction.
- The stale claim in `MO-TM30-HELPER-VERSIONING.md` ("macOS is signed and notarised") is either
  made true or struck.
