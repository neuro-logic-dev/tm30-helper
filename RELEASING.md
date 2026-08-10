# Releasing TM30 Helper

**CI cuts the release. Nothing is built on anyone's laptop.**

```bash
gh workflow run release.yml -f version=2.2.0    # or -f bump=patch|minor|major
gh workflow run release.yml -f dry_run=true     # build + test, no commit, no tag, no release
```

Actions → release → Run workflow does the same. `.github/workflows/release.yml` then runs
`plan → gate → build (macOS ∥ Windows) → publish`: it settles the version, runs the suites,
builds both installers, commits the bump, tags it, and creates ONE release with everything
attached. `README.md` describes the job graph; this file is about what a release must
CONTAIN, and how it silently fails to.

## The three ways to break auto-update

1. **Publishing without the feed.** `latest.yml` is what `electron-updater` reads — not the
   asset list on the release page. Without it the app checks, finds nothing, and stays on the
   old version forever, with no error the operator would ever see. The `publish` job attaches
   it as a release asset and then reads it back off the live release.
2. **Renaming an asset.** `latest.yml` records the exact filename and its sha512.
   `artifactName` in `package.json` produces the stable `TM30-Helper.{exe,dmg}` the install
   page links to; rename anything by hand and the updater 404s. The Windows job asserts that
   the feed names `TM30-Helper.exe` and the version being released.
3. **Shipping an unsigned macOS build.** Squirrel.Mac refuses unsigned updates — the
   platform's rule, not a setting. An unsigned build installs fine and then never updates.

## What a release contains today, and why it is asymmetric

```
Windows   TM30-Helper.exe   TM30-Helper.exe.blockmap   latest.yml     ← updates itself
macOS     TM30-Helper.dmg                                            ← installed by hand
```

Windows needs no certificate: `electron-updater` updates unsigned NSIS builds, and the
install page's PowerShell one-liner never sets Mark-of-the-Web, so SmartScreen stays quiet.

macOS needs an **Apple Developer ID Application certificate and notarisation** before it can
update itself — see breakage #3. This project does not have one (2026-08-07: the only
identity on the build machine is an *Apple Development* certificate, which `spctl` rejects,
and the repository has no signing secrets). So **no `latest-mac.yml` is published at all**.
That is the deliberate choice: a mac feed we cannot honour would make every Helper on macOS
download an update it then fails to install, on every check, forever. With no feed the check
404s, `main.js` logs it and moves on, and mac operators reinstall from the download page.

## Turning macOS auto-update on, when the certificate exists

> **This is a recipe, not a plan.** 2026-08-10, ADR-0001: the decision is that macOS stays
> unsigned and installed by hand, and that the Helper never replaces itself while running. What
> closes the gap instead is the "a newer release exists" strip — now shown in the standalone
> window too, not only in a worklist opened from a deep link. Do not start any of the steps below
> without a new ADR superseding 0001.

1. Apple Developer Program membership → **Developer ID Application** certificate, exported
   as `.p12`.
2. Repository secrets: `CSC_LINK` (base64 of the .p12), `CSC_KEY_PASSWORD`, `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD` (an app-specific password, not the Apple ID password),
   `APPLE_TEAM_ID`.
3. `package.json` → `build.mac`: drop `"identity": null`, add `"hardenedRuntime": true` and
   `"notarize": true`, and add the `zip` target back — Squirrel.Mac updates from a zip, never
   from a dmg. The dmg stays for first install.
4. `.github/workflows/release.yml` → the matrix entry for macOS: add
   `dist/TM30-Helper.zip` and `dist/latest-mac.yml` to `paths`, add both to the
   `gh release create` asset list and to the final link check.
5. Assert the result rather than trusting it — `spctl -a -vv` on the built `.app` must say
   **accepted**, and `xcrun stapler validate` must find a ticket. Without those two, the build
   is the silent-death case #3 and must fail the job, not ship.

## Before you press the button

Bump nothing by hand — `plan` does it and `publish` commits it. Do run the two suites CI
cannot (both compile sources out of the private `mo-reservation-fe`):

```bash
./test/run.sh            # emitter ↔ parser seam
./test/run-handback.sh   # the hand-back round trip
```

## Verifying an update actually lands

Install the previous version on Windows, publish the new one, then launch the old app: within
a few seconds the console logs `update available`, then `update downloaded, installs on quit`.
Quit and reopen — it is the new version.
