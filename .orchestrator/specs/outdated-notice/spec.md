# SPEC — "your build is out of date", everywhere the operator can be

Feature: `outdated-notice` · Branch: `feat/macos-self-update` · Drafted 2026-08-10
Governed by: `../../decisions/0001-no-apple-signing-no-self-replacement.md` (**Strict**)

## Problem

macOS never updates itself and — per ADR-0001 — never will. The only thing that closes the gap is
the operator being told, and being able to act. Today they are told in exactly one place: the v2
worklist window, and only when they arrived there by deep link (F12). An operator who launches the
Helper from the Dock sees `Version 2.3.1` and no hint that 2.4.0 exists (F13).

## Scope

**IN**
- `main.js` — remember the install-page origin; feed the update verdict to the standalone window;
  route outbound links from that window.
- `index.html` — render the notice and an "Open install page" action.
- Honesty pass: `index.html`'s "the app updates itself" comment (F15), `README.md` / `RELEASING.md`
  if they repeat the claim, `mo-reservation-fe/.../page.tsx` §Updating, and
  `HANDOFF-macos-self-update.md` (superseded by ADR-0001).

**OUT**
- `window.html` — the v1 account window. Left byte-untouched: `main.js:75` states v1 windows get no
  preload and backward compatibility is mandatory (013 §3.5). See Open question O-1.
- Anything touching signing, notarisation, `latest-mac.yml`, or self-replacement (ADR-0001, Strict).
- Changing the *action*: it stays "Open install page". The user chose this over carrying the
  install command inside the Helper.

## Behaviour

1. When a newer release is known, **every window the operator can be looking at** carries the same
   strip: `Update available: <new> — you are running <cur>.` with `[Open install page] [Not now]`.
2. The install page URL keeps its current derivation — the origin of a worklist row's `return_url`,
   never a hardcoded origin (F16, `refusedForVersion`). The standalone window has no worklist, so
   the **last origin seen from a deep link is persisted** to `{userData}/tm30-state.json` and reused.
   Consistent with existing practice: `{userData}/tm30-sheets/` is already written per filing.
3. **No origin has ever been seen** ⇒ the notice still shows, without the button. This is exactly
   how `refusedForVersion` already degrades — the warning is worth more than the button.
4. `Not now` dismisses for that window only. No persisted "don't ask again": ADR-0001 makes the
   notice the *only* thing standing between an operator and a stale build.

## Two constraints the handoff did not anticipate

**C-1 — `index.html` has no preload, so it cannot call `openExternal`.**
The v2 strip reaches the browser through `window.tm30Native.openExternal`. `index.html` is a v1
window and deliberately has no preload (`main.js:75`). Rather than granting it one — which would
breach the documented invariant — the link is a plain `<a target="_blank">` and `main.js` attaches
`webContents.setWindowOpenHandler` to send it to `shell.openExternal` and deny the navigation. No
new capability reaches the renderer; the standard Electron seam does the work.

**C-2 — the standalone window opens before the version check has answered.**
`app.whenReady()` fires `void checkForNewerRelease()` (up to 3 s, `main.js:98`) and then calls
`openStandaloneWindow()` on the next line. At Dock launch the window is therefore painted while
`latestKnownVersion` is still `null`, so a query parameter alone would never show the strip. The
verdict must be pushed after it resolves: when the check completes, main calls
`webContents.executeJavaScript('window.showUpdateNotice(...)')` on any open standalone window.
Main → renderer only; the renderer gains nothing it could call back with.

## Acceptance criteria

| # | Criterion | How it is proved |
|---|---|---|
| A1 | Dock-launched Helper on release N, with N+1 published, shows the strip | Run an installed build with a stubbed `RELEASES_API`; the standalone window shows the strip within the check timeout |
| A2 | The strip appears even though the window opened first (C-2) | Same run — the window is visibly up before the strip arrives |
| A3 | "Open install page" opens the real browser, not an in-app navigation | `shell.openExternal` called; the standalone window does not navigate away |
| A4 | With no persisted origin, the notice shows with no button and no error | Delete `{userData}/tm30-state.json`, relaunch |
| A5 | The persisted origin is written on a v2 deep link and survives a restart | Open a v2 link, quit, relaunch from the Dock, press the button |
| A6 | Up-to-date build shows nothing new | Stub the API to return the running version |
| A7 | `window.html` is byte-identical | `git diff --stat` names no `window.html` |
| A8 | Existing suites stay green | `./test/run.sh` (33) and `node --test test/*.test.mjs` (39) |
| A9 | No document claims macOS updates itself | grep the honesty pass targets |

## Open questions for the user

- **O-1** — leave `window.html` alone? An operator working a v1 account window would not be told.
  Recommendation: leave it. It is a documented backward-compat surface, v1 links are legacy, and
  the operator reaches it *from* the dashboard, which already flags staleness.
- **O-2** — the drift test the user picked (exact command text asserted in both repos) is **moot**
  under the chosen mechanism: the Helper never carries the install command, so there is nothing to
  drift. Nothing will be built for it unless the user wants it for another reason.
