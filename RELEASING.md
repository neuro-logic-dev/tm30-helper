# Releasing TM30 Helper

The Helper updates itself. That only works if a release is cut the way this file
describes — the update feed is a pair of generated files, not the list of assets on the
release page, and three things silently kill it.

## The three ways to break auto-update

1. **Publishing without `--publish always`.** `latest.yml` / `latest-mac.yml` are what
   `electron-updater` reads. Without them the app checks, finds nothing, and stays on the
   old version forever — no error the operator would ever see.
2. **Renaming an asset.** `latest.yml` records the exact filename and its sha512.
   `artifactName` in `package.json` already produces the stable `TM30-Helper.{exe,dmg,zip}`
   the install page links to; rename anything by hand and the updater 404s.
3. **Shipping an unsigned macOS build.** Squirrel.Mac refuses unsigned updates — that is
   the platform's rule, not a setting. An unsigned build installs fine and then never
   updates again.

## Before you build

Bump `version` in `package.json` and commit it. The version in the release must match the
version in the app, and the screen reads it from `app.getVersion()`.

## Windows

Build on Windows. No signing certificate is needed — `electron-updater` updates unsigned
NSIS builds, and the install page's PowerShell one-liner never sets Mark-of-the-Web, so
SmartScreen stays quiet.

```powershell
$env:GH_TOKEN = "<a token with repo scope>"
npm ci
npx electron-builder --win --publish always
```

Produces and uploads `TM30-Helper.exe` + `latest.yml`.

## macOS

Build on macOS. Signing and notarisation are **required** — see breakage #3.

```fish
# Developer ID Application certificate, in the keychain or as a .p12
set -x CSC_LINK /path/to/developer-id.p12
set -x CSC_KEY_PASSWORD <p12 password>

# Notarisation (an app-specific password, not the Apple ID password)
set -x APPLE_ID <apple id>
set -x APPLE_APP_SPECIFIC_PASSWORD <app-specific password>
set -x APPLE_TEAM_ID <team id>

set -x GH_TOKEN <a token with repo scope>

npm ci
npx electron-builder --mac --publish always
```

Produces and uploads `TM30-Helper.dmg` (first install), `TM30-Helper.zip` (what the
updater downloads — Squirrel.Mac cannot update from a dmg) and `latest-mac.yml`.

## What a correct release contains

```
TM30-Helper.exe      latest.yml
TM30-Helper.dmg      TM30-Helper.zip      latest-mac.yml
```

Both platforms have to be built and published under the **same release tag**, or one of
them gets an update feed pointing at a version whose artifact is missing.

## Verifying

Install the previous version, publish the new one, then launch the old app: within a few
seconds the console logs `update available`, then `update downloaded, installs on quit`.
Quit it and reopen — it is the new version. The check also repeats every 4 hours for
macOS, where the process outlives the window.

## The one release that has to be installed by hand

2.1.0 is the first version that can update itself. Everyone on 2.0.0 has to run the
install command from `/tm30-helper` once; from then on it is automatic.
