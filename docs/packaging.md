# Packaging the desktop app

The app's name, bundle id and icon come from `packages/brand/identity.json` and the brand's app icon.
Nothing in the packaging scripts hard-codes the product name.

## Development: the Dock name

macOS shows the running bundle's `CFBundleName` in the Dock, the app switcher and the menu bar. Under a bare
`electron .` that is node_modules' stock `Electron.app`, so it says "Electron".

`npm run start` and `npm run dev` (in `packages/app-electron`) launch through `scripts/dev-app.mjs`. On macOS it
keeps a copy of `Electron.app` in `packages/app-electron/.dev-app/<name>.app` (gitignored) with:

- `CFBundleName` = identity `shortName`, `CFBundleDisplayName` = identity `name`
- `CFBundleIdentifier` = identity `appId` + `.dev` (so a dev run never shares a bundle id with an installed app)
- our app icon as `<internalId>.icns` (built from `packages/brand/assets/app-icon-512.png` and `-1024.png`)
- an ad-hoc re-signature (editing Info.plist breaks Electron's own ad-hoc signature)

`CFBundleExecutable` stays `Electron`, so `app.isPackaged` is still false in development. The copy is remade
only when the Electron version, the identity or the icon changes. `node scripts/dev-app.mjs --prepare-only` makes
the copy without launching it. Other systems launch Electron as before.

## Installers

```
npm run package:mac              # repo root or packages/app-electron: this Mac's architecture, unsigned
npm run package:mac:all -w @careeros/app-electron   # arm64 + x64 (downloads the other Electron build)
npm run package:win -w @careeros/app-electron       # configured; build on Windows or in CI
npm run package:linux -w @careeros/app-electron     # configured; build on Linux or in CI
```

Output: `packages/app-electron/dist-release/` (gitignored): `<name>-<version>-<arch>.dmg`, `-mac.zip`, a
`.blockmap` beside each, `latest-mac.yml` (the update feed), `SHA256SUMS.txt` and the unpacked
`mac-<arch>/<name>.app`. The package script ends by listing the files to attach to the GitHub release.

`scripts/package.mjs` builds the app (`scripts/build.mjs`), stages only what ships in `.package/app` (the
esbuild bundles, schemas and a dependency-free `package.json`), then runs electron-builder with the config from
`scripts/builder-config.mjs`.

What ends up in `Contents/Resources` (`resources/` on Windows and Linux):

| Path | From | Looked up by |
|------|------|--------------|
| `app.asar` | `dist/` (main, preload, renderer, export worker, icons) and `schemas/` | Electron |
| `app.asar.unpacked/dist/mcp.mjs`, `app.asar.unpacked/schemas/` | same | `claude-host.ts` (`mcpLaunch`): run by Electron as Node for Claude Code, so it must be a real file |
| `careeros-plugin/` | `plugin/` | `bundledPluginDir` (claude-host.ts); also `CAREEROS_PLUGIN_ROOT` for the narrator script |
| `careeros-example/` | `samples/alex-example` (no `.index`, backups or `settings/.env`) | `sampleDirFor` (onboarding-host.ts), "Explore with an example" |
| `guides/` | `docs/assets/marketing/guides` (the guide videos, made with `scripts/marketing/`) | `guidesDir` (guide-media.ts) |
| `licenses/` | `licenses` | `licensesDir` (licenses.ts): third-party licence texts, including the Supertonic model's OpenRAIL-M |
| `careeros-setup/` (`run.mjs`, `lib.mjs`) and `careeros-setup/components/` | `scripts/setup`, `setup/components` | `setupRunnerDir`, `setupComponentsDir` (setup-host.ts): the Setup cards and the Videos tools card install tools with this runner, run by Electron as Node (`ELECTRON_RUN_AS_NODE`) with `--components` |
| `node_modules/` | ajv, ajv-formats and their dependencies; the four @fontsource font packages | `require()` calls esbuild can't inline (core loads ajv through `createRequire`) and the PDF export's font files. Found by scanning the built bundles (`runtimeRequires`) |

`test/packaging.test.ts` checks that each runtime lookup matches what the config ships.

## Signing and notarisation (off until set up)

No secrets are needed for a local build: it is ad-hoc signed and not notarised. That is fine on your own Mac, but
on any other Mac Gatekeeper blocks it ("JobCairn" Not Opened: Apple could not verify it is free of malware) and the
user has to allow it in System Settings > Privacy & Security. The config is ready for a Developer ID: set the
variables below and the same `npm run package:mac:all` signs, notarises and staples. With none of them set, the
build is exactly as before.

### What the config does once an identity is set

`scripts/builder-config.mjs` treats a build as signed when `CAREEROS_MAC_IDENTITY`, `CSC_NAME` or `CSC_LINK` is
set. Then, and only then:

- **Hardened runtime on**, with `signing/entitlements.mac.plist` for the app and its helpers. It grants only
  `com.apple.security.cs.allow-jit` (V8, including Electron-as-Node for the MCP server). Left out on purpose:
  `allow-unsigned-executable-memory` (not needed since Electron 20), `disable-library-validation` (no third-party
  native code is loaded), `device.audio-input` and `camera` (the app never records; the renderer's permission
  handler grants fullscreen only) and `network.client` (an App Sandbox key, meaningless for a non-sandboxed
  Developer ID app). If a feature ever records the microphone, add `com.apple.security.device.audio-input` and an
  `NSMicrophoneUsageDescription`, or macOS denies it silently.
- **Notarisation** through notarytool, when one credential group is complete (`notarizeMode`). A half-set group
  stops the signed build with the missing names rather than skipping notarisation. electron-builder staples the
  ticket to the app; `scripts/package.mjs` then signs (`dmg.sign`), notarises and staples each dmg too.
- **Ad-hoc stays ad-hoc.** Hardened runtime with an ad-hoc signature would need `disable-library-validation` to
  launch, so the unsigned build keeps hardened runtime, entitlements and notarisation off.

| Variable | Effect |
|----------|--------|
| `CAREEROS_MAC_IDENTITY` or `CSC_NAME` | Name of a "Developer ID Application" certificate in the login keychain, e.g. `Developer ID Application: Example Labs (TEAMID1234)`. |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | Alternative (CI): a .p12 file path or base64 and its password. |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | Notarise with an App Store Connect API key. `APPLE_API_KEY` is the path to the `.p8` file. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarise with an Apple ID and an app-specific password. |
| `APPLE_KEYCHAIN_PROFILE` (+ optional `APPLE_KEYCHAIN`) | Notarise with credentials saved by `xcrun notarytool store-credentials` (recommended: no secret in the environment). |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Sign the Windows installer. |

### Helper binaries and native code

Notarisation rejects any Mach-O file in the bundle that isn't signed with the hardened runtime. Inventory
(checked 2026-10-11 on a packaged build):

| Item | Where | Notarisation |
|------|-------|--------------|
| Electron, its helpers and frameworks | `Contents/MacOS`, `Contents/Frameworks` | signed by electron-builder |
| `dist/mcp.mjs` | `app.asar.unpacked` | a script, run by our own signed binary as Node |
| `narrate.py` and the plugin's other scripts | `careeros-plugin/` | scripts, not Mach-O |
| setup runner and component files | `careeros-setup/` | Node scripts and JSON, run by our own signed binary as Node |
| licence texts | `licenses/` | text |
| ajv and the font packages | `Resources/node_modules` | plain JavaScript and font files |
| Python + Supertonic, ffmpeg, Chrome, HyperFrames, whisper model | `~/.careeros/venv`, Homebrew, the user's system | not in the app: installed by setup, never notarised by us, and not bound by the app's entitlements |

`npm run release:verify` fails if a Mach-O file ever appears outside `MacOS/` and `Frameworks/` (for example a
`.node` module in `node_modules`). List such a file in the mac `binaries` option so electron-builder signs it.

### Checksums

Every package run writes `dist-release/SHA256SUMS.txt` (an electron-builder `afterAllArtifactBuild` hook) for the
dmgs and zips, in `shasum -a 256 -c` format. Publish it next to the dmgs: the website asks users to check it. A
host-only build lists one architecture; `package:mac:all` lists arm64 and x64.

### In-app updates

The installed mac app updates itself from the public GitHub releases (`JobCairn/jobcairn`) with electron-updater
(`packages/app-electron/src/updates.ts`). It checks 10 seconds after launch and every 6 hours (unless the person turns
"Check for updates automatically" off in About), downloads the new zip in the background, and shows a dot on the
version in the sidebar. "Restart to update" in About installs it; otherwise it installs on the next quit. Development
runs, end-to-end runs and Windows and Linux builds never check.

How it fits together:

- `builder-config.mjs` sets `publish: { provider: "github", owner: "JobCairn", repo: "jobcairn" }`. electron-builder
  then writes `Resources/app-update.yml` into the app (where to look) and `latest-mac.yml` into `dist-release/`
  (each zip's name, size and sha512). `package.mjs` builds with `publish: "never"`, so nothing is ever uploaded.
- Squirrel.Mac installs from the **zip**, never the dmg. The zip holds the signed, notarised and stapled app, and the
  update must be signed by the same Developer ID as the installed app, so updates only work between signed builds.
- The updater reads the **latest published release** (not drafts, not pre-releases) and downloads
  `latest-mac.yml` from it. A release without that file shows the person "The newest release isn't ready for
  automatic updates yet" with a link to download it by hand.
- `latest-mac.yml` also lists the dmgs, but `package.mjs` staples the dmgs after the feed is written, so those dmg
  hashes are stale. That is harmless: the mac updater only ever uses the zip entries, and `release:verify` checks
  only those.

**Release checklist** (after `npm run package:mac:all` and `npm run release:verify -- --require-signed`):

1. Bump `version` in `packages/app-electron/package.json` before building. The feed and the zips carry it, and the
   app only updates to a higher version.
2. Create the draft release for the new version's tag as before (the updater follows whatever release GitHub
   marks as latest, so the tag's form doesn't matter).
3. Attach every file `release:verify` (or the package script) lists from `dist-release/`:
   - `JobCairn-<version>-arm64.dmg` and `JobCairn-<version>-x64.dmg`, for new downloads
   - `JobCairn-<version>-arm64-mac.zip` and `JobCairn-<version>-mac.zip` (x64), for in-app updates
   - every `.blockmap` (smaller, partial downloads for the next update)
   - `latest-mac.yml`
   - `SHA256SUMS.txt`
4. Write the release notes in the release body: the app shows them under "What's new" once the update is ready.
5. Publish the release as a normal (latest) release, not a pre-release. Installed apps see it within 6 hours, or at
   once with "Check for updates".

Never rename the files: `latest-mac.yml` names the zips exactly as electron-builder wrote them.

### Checking a build

```
npm run release:verify                        # every app in dist-release
npm run release:verify -- --require-signed    # for a public release: an ad-hoc build fails
```

It checks SHA256SUMS.txt, checks that `latest-mac.yml` lists each zip with its real sha512 and size, scans for unsigned binaries and runs `codesign --verify --deep --strict`. For a Developer
ID build it also runs `spctl -a -vv` (must say `source=Notarized Developer ID`) and `xcrun stapler validate` on
each app and each dmg. On an ad-hoc build those two are skipped with a note. Needs the Xcode Command Line Tools.

### Owner setup, step by step

The owner is already an Apple Developer Program member (another app is on the App Store), so no enrolment is
needed. An "Apple Development" or App Store distribution certificate can't sign a download: Gatekeeper outside the
App Store wants a **Developer ID Application** certificate.

1. **Create the "Developer ID Application" certificate.** In Xcode: Settings > Accounts > the team > Manage
   Certificates > + > Developer ID Application. This needs the **Account Holder** role. Or create it at
   https://developer.apple.com/account/resources/certificates with a certificate signing request from Keychain
   Access. It lands in the login keychain; `security find-identity -v -p codesigning` lists it as
   `Developer ID Application: <team name> (<TEAMID>)`.
2. **Create an App Store Connect API key** for notarytool: App Store Connect > Users and Access > Integrations >
   Team Keys, with the **Developer** role. Note the Key ID and Issuer ID and download the `.p8` (only once). Keep it
   outside the repo, e.g. `~/.private_keys/AuthKey_<KEYID>.p8`, `chmod 600`.
3. **Save it as a notarytool keychain profile**, so builds need no secret in the environment:
   ```
   xcrun notarytool store-credentials jobcairn-notary --key ~/.private_keys/AuthKey_<KEYID>.p8 --key-id <KEYID> --issuer <ISSUER-ID>
   ```
4. **Build:**
   ```
   export CAREEROS_MAC_IDENTITY="Developer ID Application: <team name> (<TEAMID>)"
   export APPLE_KEYCHAIN_PROFILE=jobcairn-notary
   npm run package:mac:all -w @careeros/app-electron      # or package:mac for this Mac's architecture only
   npm run release:verify -- --require-signed
   ```
   electron-builder signs the app with the hardened runtime, notarises and staples it. Then `package.mjs` signs,
   notarises and staples each dmg, and writes SHA256SUMS.txt last (stapling changes the dmg). Each notarisation
   uploads to Apple and usually takes a few minutes. If one is rejected, read why with
   `xcrun notarytool log <submission-id> --keychain-profile jobcairn-notary`.
5. **First signed build: launch it before publishing.** Hardened runtime can't be tested with an ad-hoc
   signature. Open the signed app with a throwaway home (`HOME=$(mktemp -d) open -n <app>` or run its binary),
   check the window opens, then on a clean Mac check the MCP server starts for Claude Code, reading aloud works and
   a PDF export works. A crash at launch means a missing entitlement.

Never commit certificates, `.p12`, `.p8`, passwords or `.env` files (all gitignored). Keep them in the Keychain or
in environment variables set for the build shell only.

### What changes for users once signed

- Unsigned (today): macOS shows that JobCairn was "Not Opened" because Apple could not check it for malware. The
  user has to go to System Settings > Privacy & Security and choose Open Anyway.
- Signed and notarised: the only prompt is the usual one for any download, "JobCairn is an app downloaded from the
  Internet. Are you sure you want to open it?". One click on Open. The developer named in macOS dialogs and in the
  certificate is the team's name, the same one shown as the developer on the owner's App Store listing.

If Electron fuses are ever added, keep `RunAsNode` on: the MCP server and the setup runner (tool installs) run as
`ELECTRON_RUN_AS_NODE`. The runner starts `/bin/bash`, `brew` and `curl` as ordinary child processes with no stdin,
so nothing can stop to ask for a password; they are separate signed programs and need no entitlement from the app.
