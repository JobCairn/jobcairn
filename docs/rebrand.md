# Renaming the product

The product is **JobCairn** (short name "Cairn", domain jobcairn.com). It was called CareerOS
until 2026-10-11. The display name lives in one place: `packages/brand/identity.json`
(`name`, `shortName`, `tagline`, `domain`). Code reads it from there
(`@careeros/brand/identity` in the UI and Electron, `@careeros/brand/identity.json` in core,
services, mail, video and contract). Tests assert against `identity.name` too, so changing the
name doesn't break them.

`tests/identity.test.ts` enforces this. It scans every `packages/*/src` folder, plus
`packages/app-ui/index.html`, `packages/brand/guide` and `packages/core/schemas`, and fails on
any line that spells out the current name or a former one (`FORMER_NAMES`). Comment lines,
the fictional fixture path and the internal ids listed below are allowed.

## Renaming: the steps

1. Edit `name` and `shortName` in `packages/brand/identity.json`. Everything built from
   code follows, including:
   - the window title, the menus, the About panel and the sidebar
   - the Dock name: the dev launcher's `.dev-app/<name>.app`, plus `CFBundleName` and
     `CFBundleDisplayName`
   - electron-builder's `productName` and the DMG title
   - onboarding, the tour, dialogs, notifications and error messages
   - the email and scheduler descriptions
   - the Claude prompts
   - the default workspace folder (`~/<name>`, `~/<name> Example`, `~/<name> <person>`)
2. Add the old name to `FORMER_NAMES` in `tests/identity.test.ts` so stragglers fail.
3. Regenerate the assets:
   - Run `npm run icons:svg -w @careeros/brand`. The wordmark's text and width and the
     aria-labels follow `identity.name`.
   - Run `npm run visual:update -w @careeros/brand` (Docker) to refresh the brand guide
     baselines in `docs/assets/brand-snapshots/`.
   - Regenerate the video golden files (`packages/video/test/golden/*.html` carry the
     "Made by <name>" comment).
   - Update the services Claude args snapshot (`npx vitest run -u packages/services/test/claude/args.test.ts`).
     Check that the diff shows only name changes.
4. Rename the static files that can't import identity. Edit them by hand:
   - `Setup <name>.command` (use `git mv`). The app's messages already say
     `Setup <name>.command`, so the file has to match.
   - `setup.sh`, `scripts/setup/run.mjs`, `setup/components/*.json`. `workspace.json` creates
     `~/<name>`. Make its check accept the old folder as well as the new one, or re-running
     setup gives an existing user a second workspace.
   - `README.md`, `CLAUDE.md`, `NOTICE.md`, `docs/**`
   - `plugin/` text: the `plugin.json` description and author, the skills' prose, and the
     video template comments
   - `.claude-plugin/marketplace.json`: `owner.name` and the descriptions only
   - `samples/alex-example/CLAUDE.md`
   - `.gitignore`: add `<NewName>/` and keep the old names, so an old local folder never gets
     committed
5. Run `npm run typecheck` and `npx vitest run`.

The CareerOS → JobCairn rename did steps 1 to 4, except the brand visual baselines (they need
Docker). Two things were left alone on purpose:
- Code comments under `packages/*/src` still say "CareerOS" in places. They aren't shown to
  anyone, and leaving them kept the diff small while other lanes edit the same files.
- The dated design records in `docs/specs/` and `docs/superpowers/plans/` describe the
  product as it was then.

**Existing installs:** "Get started" now suggests `~/JobCairn`. A person whose workspace is
already in `~/CareerOS` keeps it: the app reopens known workspaces from its list in userData,
and setup's check accepts either folder.

The app icon and the mark are drawings with no text, so they don't need new art. Only the
wordmark has the name in it, and it's generated from identity in step 3.

## Internal ids that stay as they are

These look like the name but are fixed identifiers. Changing any of them orphans the
person's data, secrets or schedules, or breaks installs. They don't follow `identity.name`.

| Id | Where | What breaks if it changes |
|----|-------|---------------------------|
| `internalId` `careeros` | `identity.json` → Electron `app.setName`, userData folder `~/Library/Application Support/careeros` | Settings, the workspace list and every saved secret disappear. |
| Keychain entry `careeros Safe Storage` | Electron safeStorage, named after `internalId` | Every encrypted secret (Gmail app password, API keys) can't be decrypted. |
| `appId` `com.careeros.desktop` (dev: `.dev`) | `identity.json` → bundle id, electron-builder `appId` | macOS treats it as a new app: new Keychain prompts, permissions and login items. |
| launchd label `com.careeros.desktop.mailsync[.<workspaceId>]` | `packages/mail/src/scheduler/index.ts` (`<appId>.mailsync`) | The existing background sync keeps running under the old label, so two syncs run at once. |
| Windows task `CareerOS Mail Sync [<id>]` | `TASK_NAME` in `packages/mail/src/scheduler/text.ts` (allow-listed in the identity test) | The same: the old scheduled task is orphaned. |
| systemd unit `careeros-mailsync[-<id>]` | `SYSTEMD_UNIT` in the same file | The same. |
| `.careeros/` folder in each workspace, and `workspace.json` | core | Existing workspaces stop being recognised. |
| `careeros-file:` URL scheme | Electron protocol | Saved links and open previews break. |
| npm scope `@careeros/*` | every `package.json`, imports | None for users. It's a large mechanical change across the code. |
| `careeros` CLI binary and plugin name (`plugin/.claude-plugin/plugin.json` `name`, marketplace `name`) | core CLI, `services/src/claude/plugin.ts` checks `name === "careeros"` | Claude runs can't find the bundled plugin. Prompts tell Claude to run `careeros request access`. |
| MCP server name `careeros` | `services/src/claude/args.ts` `mcpServers`, `mcp/server.ts` `serverInfo` | Tool names (`mcp__careeros__*`) change, and allow-lists in run args must change with them. |
| Browser helper session `careeros` | `services/src/chrome/helper.ts` `SESSION` | The signed-in helper session is lost. |
| Env vars `CAREEROS_*` (`WORKSPACE`, `DEV_URL`, `USER_DATA`, `PLUGIN_ROOT`, `HOME_OVERRIDE`, `BROWSER_*`, `E2E_*`) | Electron, services, tests | Dev scripts and the MCP launch break. |
| localStorage keys `careeros.*` (`careeros.theme`, `careeros.notify`, `careeros.applications.stage`, seen and activity keys) | app-ui | Theme, notification choice and "seen" state reset once. |
| `~/.careeros/venv` (voice Python) | `plugin/skills/voice`, video tools check | Narration can't find its Python until setup runs again. |
| Fixture root `/fictional/alex-example/CareerOS` | `app-ui/src/mock`, tests | Nothing. It's fictional test data, allow-listed in the identity test. |
| Email marker `<!-- <name>: a copy of an email from outside ... -->` | `packages/mail/src/store.ts` | Nothing reads it back. It follows `identity.name`, so old saved emails keep the old name in the marker. That's harmless. |

## A later migration (if the owner wants the ids renamed before the first public release)

The cheapest time to do this is before any outside user installs the app. After that, every
step needs migration code. Plan:

1. **Pick the new ids once:** `internalId`, `appId`, CLI, plugin and MCP name, env var
   prefix, URL scheme, and folder name.
2. **userData and Keychain:** on first launch under the new `internalId`:
   - If the old userData folder exists and the new one doesn't, copy it across.
   - Read each secret with the old safeStorage key (this needs a one-off helper started with
     the old app name) and re-save it under the new one.
   - Keep the old folder until the copy is verified.
3. **Schedules:** at start-up, look for the old launchd label, Windows task and systemd
   unit. Remove each one and install the new one with the same interval and workspace.
4. **Workspace folder:** accept both `.careeros/` and the new name when reading, and write
   only the new one. Rename on open, after a backup.
5. **Plugin, MCP and CLI:**
   - Rename them together.
   - Update `plugin.ts`, the `mcpServers` key, the tool allow-lists and the prompts that
     mention `careeros request access`.
   - Ship the CLI under both names for one release.
6. **Env vars and the URL scheme:** read both prefixes for one release, then drop the old one.
7. **localStorage:** read the old key when the new one is missing, then write the new one.
8. **npm scope:** one mechanical commit (`@careeros/*` → new scope) once the lanes are merged,
   with no other changes in it.
9. Add tests for each migration, using a fixture made by the old version.

Until then, the ids above stay, and only the display name follows `identity.json`.
