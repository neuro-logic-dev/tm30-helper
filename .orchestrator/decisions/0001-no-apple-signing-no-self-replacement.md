# ADR-0001 — macOS stays unsigned and manually installed; no self-replacing updater

- **Date:** 2026-08-10
- **Status:** Accepted
- **Decided by:** the user (Tier 1)
- **Supersedes:** the framing of `HANDOFF-macos-self-update.md` §2 (Options C and D)
- **AI Guidance Level:** **Strict** — no session may reopen signing, notarisation, `latest-mac.yml`,
  or an in-app self-replacing installer without a new ADR.

## Context

`HANDOFF-macos-self-update.md` posed a binary: sign + notarise + ship a zip (Option C), or write a
detached self-replacing shell script (Option D). Evidence gathered on a Mac before deciding:

- No Developer ID Application certificate exists on this machine — `security find-identity -v`
  returns exactly one identity, `Apple Development: Andrei Kochkalda (63542KPNTU)`, which is a
  *development* certificate and cannot sign for distribution or notarisation.
- `gh secret list` on `neuro-logic-dev/tm30-helper` is **empty** — none of `CSC_LINK`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` exist.
- `xcrun notarytool history` → `Error: Must provide credentials.`
- The handoff's claim that a "Restart & update now" button is "already there and already wired" is
  **false**. No `#updinstall`, no `armUpdateInstall`, no `tm30:quit-and-install`, no
  `quitAndInstall`/`updateState`/`onUpdateDownloaded` in `preload.js`. Windows updates entirely
  silently through `autoInstallOnAppQuit`. Option D therefore requires the whole renderer↔preload↔
  main update seam built from scratch *in addition to* the dangerous script — strictly more work
  than the handoff implied, not less.

## Decision

**Neither C nor D.** The Apple Developer Program is not to be involved, and the app will not replace
itself while running. The release cycle stays exactly as it is: macOS installs and updates by
running the install command, which is already idempotent
(`releases/latest/download/TM30-Helper.dmg`).

What is in scope instead:

1. The Helper must **tell the operator, wherever they are, that their build is out of date.**
2. Getting to the current build must take the **fewest steps that are safe** — without the app
   destroying itself.
3. The documentation must be **honest**: no claim anywhere that macOS updates itself.

## Consequences

- `build.mac.identity` stays `null`; `build.mac.target` stays `dmg`-only; `release.yml`'s
  "latest-mac.yml is deliberately NOT published" guard stays and stays correct.
- The `xattr -dr com.apple.quarantine` step in the install command is permanent, not a workaround
  to be removed later.
- Browser-downloading the `.dmg` is **not** an acceptable "fewer steps" path: `page.tsx` documents
  that `curl` avoids the quarantine flag while a browser download sets it, and on current macOS an
  unsigned quarantined app costs the operator a System Settings → Privacy & Security detour. The
  Terminal command is the shorter path, not the longer one.
- `index.html`'s comment "the app updates itself" and the retired
  `MO-TM30-HELPER-VERSIONING.md`'s "macOS is signed and notarised" are both false and must be
  struck.
- `HANDOFF-macos-self-update.md` is now superseded and should not be followed as written.
