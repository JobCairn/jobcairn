# Claude Code engine (amends 3c, §3.4 "Mode 3")

Date: 2026-10-10. Status: building (lane H), fix rounds 1 and 2 applied. Amends `2026-10-08-claude-chat-voice-design.md`.

## 1. Decision

The owner ruled (2026-10-10) that CareerOS never asks the candidate to paste a prompt into the
Claude app. The app starts the candidate's own Claude Code CLI, headless, with the CareerOS
plugin loaded for that run, and that does all generation: resume and cover letter, research, scoring,
interview prep, learning guides and videos. "Copy prompt instead" stays as a fallback only.

What changes from §3.4:

| §3.4 said | Now |
|-----------|-----|
| Mode 3 is experimental and off by default | It is the default engine. Settings > Claude and onboarding set it up. |
| Writes go only through MCP propose tools | Each run may write only its own output files (from `actionPaths`), enforced by `--allowedTools` plus `--permission-mode dontAsk`. Record changes go through the typed `careeros mcp` server (§4.2); there is no shell. The app checks the result and flags anything written elsewhere. Approvals still gate every outward action (apply, send, status). |
| Installing Claude Code is sub-project 4 | The app finds the CLI and explains how to install it. Nothing is installed into Claude Code: the bundled plugin is passed per run with `--plugin-dir` (owner decision a, fix round 1). |

The consent notice (`CLAUDE_NOTICE`, version 3 since fix round 2) says what really happens: Claude
Code runs under the candidate's own account and what it reads goes to Anthropic under that
account's terms; CareerOS never touches the login; each run gets only what its job needs (most runs
read the workspace and write their own result files; job search and company research use the web
and can't read the candidate's files), with no command line, only a few CareerOS record tools; a run
can ask to open a locked folder and it opens only if the candidate allows it; runs ignore the
candidate's own Claude Code settings, hooks, add-ons and connected tools and change nothing in their
setup, though Claude Code may still read their own CLAUDE.md notes; runs count against plan limits
and the app shows Claude Code's cost estimate. The candidate ticks "I understand". The date and
notice version are saved in `settings/integrations.json` under `claude_code`; a new notice version
asks again. The product owner confirmed the consumer terms allow this use (fix round 2), so
`CLAUDE_EXPERIMENTAL` is `false` and no Experimental tag is shown.

## 2. Detect

- **Find the CLI.** `PATH` first, then known places: `~/.claude/local/claude`, `~/.local/bin/claude`,
  `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, the npm global bin (`$npm_config_prefix/bin`,
  `%APPDATA%\npm\claude.cmd` on Windows). On Windows only `claude.cmd` / `claude.exe` count. The first
  regular, executable file wins. The path never reaches the renderer.
- **Version.** `claude --version` (10 s timeout) prints `2.1.280 (Claude Code)`. Minimum pinned:
  `2.1.280`, the version the run flags were tested against (`--restricted`, `--permission-prompts`,
  `--plugin-dir`, `--strict-mcp-config`, `auth status --json`). Older shows "Claude Code is too old"
  with `claude update`.
- **Signed in.** `claude auth status --json` (15 s). Read only the logged-in flag; the output is
  never stored or logged. Exit code non-zero or `loggedIn: false` means signed out. A failed run
  whose error reads like an auth error ("not logged in", "/login", "authentication_error",
  "invalid api key") also marks the state signed out.
- **Plugin.** Only the bundled folder is checked: `<pluginDir>/.claude-plugin/plugin.json` must exist
  and name `careeros`. No `claude plugin …` command is ever run. A missing folder means a broken
  install ("Reinstall CareerOS").

Every command goes through one `ProcessRunner` (the video lane's pattern, copied into
`services/src/claude/process.ts` until the video package merges): an argument array, `shell: false`,
a clean environment (PATH, HOME, temp and locale, plus `CLAUDE_CONFIG_DIR`, `HTTP(S)_PROXY`,
`NO_PROXY` and `NODE_EXTRA_CA_CERTS` so Claude Code finds its config and works behind a company
proxy; no API keys), a timeout, and on cancel or
timeout the whole process tree is killed (process group on macOS/Linux, `taskkill /T` on Windows).

## 3. Plugin: bundled, loaded per run

Owner decision a (fix round 1): no global install and no change to the candidate's `~/.claude`.
Every run passes `--plugin-dir <bundled plugin>` (development: `<repo>/plugin`; packaged:
`resources/careeros-plugin`). The old marketplace add / install / update path is removed. Settings >
Claude has three steps: Claude Code found, signed in, test run. (An opt-in global install is not built.)

## 4. Run

`runAction({ actionId, target, request })` in main (services), IPC `claude.run(action, target, request)`.
The renderer sends only lane G's composer choices, `request = { options?, note? }`; it never sends prompt
text. Main checks them with `validateRequest` (per-action option allowlist, note rules) and rebuilds the
prompt with `buildActionPrompt(id, target, info, choices)`, so the rules always come last. Permissions
come only from the action and target, computed in main. A fixed `--append-system-prompt` (no user text)
says the run is non-interactive and names the folder.

```
claude -p --output-format stream-json --verbose            (prompt on stdin)
  --restricted --strict-mcp-config --permission-prompts none
  --permission-mode dontAsk --no-session-persistence
  --plugin-dir <bundled plugin>
  --mcp-config '{"mcpServers":{"careeros":{"type":"stdio","command":<app runtime>,
                 "args":[<mcp.mjs>,"--tools",<this action's tools>[,"--job",<company>/<job>]],
                 "env":{"ELECTRON_RUN_AS_NODE":"1","CAREEROS_WORKSPACE":<root>}}}}'
  --append-system-prompt <fixed text: non-interactive, the folder, careeros command -> tool map>
  --settings '{"disableAllHooks":true,"permissions":{"blockReadsOutsideWorkingDirectories":true,
              "defaultMode":"dontAsk","allow":[...],"deny":[...]}}'
  --tools        workspace runs: Read,Glob,Grep[,Edit,Write]    web runs: Edit,Write,WebSearch,WebFetch
  --allowedTools workspace runs: Read(./**) Edit(./<each output file>) mcp__careeros__<tool>...
                 web runs:       Edit(./<each output file>) mcp__careeros__<tool>... WebSearch WebFetch
  --disallowedTools <claudeSettings deny rules for the current lock state>
                    Edit(./me/**) Edit(./settings/**) Edit(./.careeros/**) Edit(./.claude/**) ...
                    Read(./.backup/**) Read(./.index/**)
                    [web runs: Read(./**) Grep Glob]
```

### 4.1 Isolation from the candidate's own setup (R2)

- `--restricted` removes Bash, PowerShell, REPL and the other code-running tools (and WebFetch unless
  `--tools` names it), ignores user, project and local settings files, confines file tools to the
  working folder and refuses `bypassPermissions`. `--setting-sources` is not needed with it.
- `--strict-mcp-config` loads only our server. `--plugin-dir` loads only our plugin for this run;
  plugins enabled in the candidate's settings are not loaded because those settings are ignored.
- `--settings` adds `disableAllHooks: true` and `blockReadsOutsideWorkingDirectories: true` on top of
  the exact allow/deny rules. Managed (admin) settings still apply, as Claude Code intends.
- `--permission-prompts none` plus `--permission-mode dontAsk`: anything not allowed is refused,
  nothing waits on a prompt.
- Because project settings are ignored, the workspace's generated `.claude/settings.json` is not
  what protects a run; the same deny rules are passed in `--settings` and `--disallowedTools`.
- Not covered by these flags (parked, fix round 2): CLAUDE.md memory files (user-level and the
  workspace's) and auto-memory may still be read by Claude Code; possibly also `~/.claude/skills`,
  agents and commands. `--bare` would skip them but also refuses OAuth sign-in, so it is not used.
  The notice says so ("Claude Code may still read your own CLAUDE.md notes"). Listed in §8.
- The setup test runs in a fresh empty temp folder (removed after), with `--tools ""`, no MCP and
  no plugin.

### 4.2 The `careeros mcp` server (R1)

`services/src/claude/mcp/` (entry `main.ts`, bundled to `dist/mcp.mjs` and started with the app's
own runtime as Node). Newline-delimited JSON-RPC 2.0 over stdio: `initialize`, `tools/list`,
`tools/call`, `ping`. It is pinned to one workspace (`CAREEROS_WORKSPACE`) and serves only the tools
named in `--tools`, and job_event and score_record only to the run's own job (`--job`, from the action's target). Start
arguments are parsed strictly (`mcp/argv.ts`): known tool names only, a well-formed job, nothing else.

| Tool | Does | Actions |
|------|------|---------|
| `search_check` | Did this search run in the last 7 days? | find_jobs |
| `search_add` | Log a search | find_jobs |
| `job_new` | Add a job; the ad comes as `jd_text` (at most 200 KB, control characters dropped), saved as its jd.md | find_jobs |
| `job_event` | Add a timeline event to the run's own job | score_job |
| `score_record` | Save the run's own job's structured score (fit, interview odds, tier, must-haves with status and evidence, what would change it, summary). Writes `score.json` beside `score.md`, sets the record's fit and career scores, and logs "Scored". Text is put in plain words (no paths) | score_job |
| `request_access` | Ask for a locked folder (identity / employment) | all |

Every argument goes through a contract validator (unknown keys refused). **No tool takes a file path**
(fix round 2, F1): the earlier `jd_file` let a run copy any readable workspace file (for example
`me/history`, settings, or a locked file while a grant was open) into a job folder, so it is gone; the
tests assert no schema has a path-like property. There is no init, import, migrate, index or
workspace-choosing tool. Per-run caps: 50 job_new, 100 search_add, 5 job_event, 3 request_access, 2 score_record
(F10). Errors reach Claude with absolute paths removed (workspace words like `me/identity` stay
readable). The CLI keeps `--jd-file` and `job attach` for people, guarded by `workspaceSourceFile`
(realpath inside the workspace, not locked, not app internals, not a link, one hardlink); core's
`attachFile` refuses locked folders. Parked (F6): the check and the read are separate steps; open
once with `O_NOFOLLOW` and compare the fd's dev/ino. Only another local process could race it. The action texts (lane G) still say "run `careeros …`"; the
fixed system text maps each command to its tool.

### 4.3 Two kinds of run: workspace runs and web runs (R3, fix round 2 F2)

The danger is a run that can both read the candidate's files and reach the internet: a job ad or
company page could tell Claude to read a tailored resume, a recruiter email or interview notes and
put them in a WebFetch URL or a search query. So no run gets both.

- **Web runs** (`find_jobs`, `research_company`): `WebSearch` and `WebFetch` (both read whole ads or
  pages), but no `Read`, `Grep` or `Glob` in `--tools`, and `Read(./**)`, `Grep` and `Glob` denied.
  They write only their own output files (`knowledge/job-searches/<date>.md`, `companies/<slug>/research.md`)
  and call their MCP tools, none of which takes a path. Main builds the context they need and puts
  it in front of the request, fenced as data and capped at 8,000 characters (`claude/context.ts`):
  for find_jobs the target roles, skills and keywords, seniority, job types, locations, minimum
  salary, work-rights status (as words, never the visa subclass or dates), industries and companies
  to skip, search sources, and the last 30 days of search log lines (30 at most); for
  research_company the company name, website and aliases. Never contact details, locked folders,
  resumes, emails or interview notes. Because Claude Code's Write tool may refuse to replace a file
  it hasn't read, main moves an existing output (a research_company re-run) to `<name>.previous.md`
  in the same folder before the run, keeps it there on success and puts it back if the run fails or
  is cancelled.
- **Workspace runs** (every other action): read the workspace, with the locked folders denied for the
  current lock state and app backups and index (`.backup/**`, `.index/**`) denied always; no web tool
  at all, so nothing they read can leave the computer except through Claude itself.

### 4.4 Other rules

- `Edit(path)` covers every file-writing tool (Write included), as core's `claudeSettings` notes.
- Career actions may write only their exact output and extra files (`research_company`'s folder is the
  whole company folder, so a folder glob would also open that company's job folders). Video actions
  write many files, so they get `Edit(./<video folder>/**)`.
- Glob and Grep are available but not on the allow list: inside the workspace they need no
  permission, outside it they would prompt, so they are refused.
- Timeout 20 minutes (45 for videos). At most two runs at once; one run per action and target. The
  key is reserved synchronously before any await (a pending-start map), so a double click or two
  windows get the same run (R5).
- **Progress.** stream-json lines become plain steps: `Read …/jd.md` is "Reading the job ad",
  `Write …/resume.md` is "Writing your resume", `claims.json` is "Checking claims", `WebSearch` is
  "Searching the web", `Skill` is "Using the career skill". Raw JSON and absolute paths never reach
  the UI; text goes through `scrubMessage` (paths, URL-encoded paths, ANSI/OSC codes, invisible
  characters, and API tokens such as `sk-ant-…`, `ghp_…`, `github_pat_…`, `xox…`). The `result` line
  gives cost, duration and turns. A result line longer than the runner's 64 KB line cap arrives cut
  off; it still counts (success if it says so) with the text that arrived and no cost.
- **Cost (owner decision b).** Claude Code's `total_cost_usd` estimate is shown in the finished run's
  details ("Cost estimate: $0.18") and as a monthly total in Settings > Claude, never on the action
  buttons. Totals live in `.careeros/runs/costs.json` (`{"YYYY-MM": {usd, runs}}`, local months, 24
  kept) because run records are pruned to 50. On a subscription plan this is an estimate, not a bill.
- **Run records.** `.careeros/runs/<id>.json`: action, target, status, timestamps, steps, summary,
  files, stray files, error, cost. Runs still "running" when the app starts are marked "stopped when
  CareerOS closed". The last 50 are kept.
- **Verify.** On success every expected output must exist as a regular file inside the action folder
  (the same `probeFor` checks as the hand-off). Files the stream says were written, plus any file
  under the workspace changed or deleted since the run started, that sit outside the run's files are
  listed as "changed outside this run's folder" and the run gets a warning. A link the run made or
  re-pointed is always reported ("a shortcut link"), even in its own folder. Missing outputs fail the run.
- **Known limits (parked).** The before/after scan stops at 20,000 entries, so a larger workspace is
  only partly checked. If Electron itself crashes, a running `claude` (in its own process group) is not
  killed; its record shows "Stopped when CareerOS closed" on the next start, but the process may
  finish its work. A future fix: a pid file per run, swept at start.

## 5. UI

- `<ClaudeSetup>` (onboarding step and Settings > Claude): notice and "I understand"; then three steps: Claude Code found and its version (or install steps, a link, "Check
  again"); signed in (or "Open Terminal to sign in", which opens Terminal running `claude`; on Windows
  `cmd /d /s /c "start "" "<path>""` with the path quoted once and refused if it holds cmd syntax);
  "Run a test". Settings also shows this month's cost estimate.
- `<ClaudeRunPanel>`: the action named with its subject ("Researching Acme Corp…"), steps, elapsed
  time, Cancel; on success the result named, file chips with Show and the cost estimate; on failure
  a plain reason, Retry and "Copy prompt instead".
- `useClaudeRun(action, target)`: start, status, cancel, last run.
- Sidebar footer: "Claude is working…" while runs are active.
- `ActionButton` starts a run instead of the clipboard hand-off when the engine is ready, and shows
  `<ClaudeRunPanel>` in place of the paste banner.

## 6. Video carry: `cliWriter`

The video package's `ScriptWriter` (`packages/video/src/writer.ts`, feat/video) has `mode:
"desktop" | "api" | "cli"`. A `cliWriter` built on this engine:

```ts
export function cliWriter(engine: ClaudeRunner): ScriptWriter {
  return { mode: "cli", async write(req) {
    const prompt = buildWriterPrompt(req);            // video lane's prompt, with wrapUntrusted sources
    const run = await engine.runCustom({
      key: `video--${req.folder}`, prompt, cwd: req.root,
      writeFolder: req.folder,                         // Edit(./<folder>/**) only
      expect: WRITER_FILES.map((f) => `${req.folder}/${f}`),
      web: false, signal: req.signal, onStep: (s) => req.onStatus?.(s.label),
    });
    if (run.status !== "succeeded") throw new VideoError(run.error || "Claude couldn't write the script.");
    return { lockedFacts: [] };                       // grants still come from careeros request access
  } };
}
```

`runCustom` is the same runner as `runAction` with an explicit folder and expected files instead of
an action id. The pipeline then narrates and renders as today; Claude never runs ffmpeg or Python.

## 7. Tests

A fake `claude` (a Node script, plus the in-memory `fakeRunner`) prints recorded stream-json and
covers: parsing, cancel, timeout, missing CLI, old version, signed out, bundled plugin missing; the
fake throws if the engine ever runs a `plugin` or `mcp` subcommand. Snapshot tests of the argument
list for every action: no `Edit`/`Write` outside the output files, no Bash or other code tool at all,
isolation flags present, MCP tools per action, no locked folders, web tools only where needed. The
MCP server is tested over JSON-RPC (tool lists, validation, no path argument in any schema, jd_text
cap and control characters, job_event pinned to the run's job, caps, unknown tools refused, start
arguments) and the bundled `mcp.mjs` was smoke-tested over stdio. Web and workspace runs' argument
lists are tested separately, and a find_jobs run's prompt is checked for the context and for the
absence of contact and visa details. The `claude` process env never carries `ELECTRON_RUN_AS_NODE`,
`CAREEROS_WORKSPACE` or `NODE_OPTIONS`.
A `Promise.all` double start yields one run. Output verification flags stray
files. Prompt injection in a job title stays quoted (`promptText` / `quoted`).

## 8. Open points for the product owner

- Decided (fix round 2): the consumer terms allow running Claude Code this way; no Experimental tag.
- Decided: `--plugin-dir` per run, no global install (a); cost in run details and a monthly total (b).
- Parked: CLAUDE.md memory files may still be read by runs (see §4.1); the notice says so. Not `--bare`
  (breaks OAuth). `--safe-mode` might skip them but its help says it also disables MCP servers; check
  on a real run before relying on it.
- The flag behaviour was read from `claude --help` on 2.1.280; one manual run per release is needed,
  including: `blockReadsOutsideWorkingDirectories` is honoured; the MCP tools appear as
  `mcp__careeros__<tool>`; case-variant reads (`ME/IDENTITY/x`) are refused on case-insensitive disks;
  Grep/Glob from `.` don't return names or content under denied folders; `--restricted` doesn't load
  `~/.claude/skills`, agents or commands; the plugin's skills still work (`Skill` isn't in `--tools`,
  and its references sit outside the working folder); links inside the workspace that point outside
  are refused; a web run's Write can replace an existing output it hasn't read.
- Packaging (parked, F11): the MCP server runs as Node through Electron's RunAsNode fuse, which must
  stay on (revisit with a small helper binary if the fuses are hardened). The `--mcp-config` and
  `--settings` JSON (with the workspace path) are visible in `ps` to local users; accept, or pass them
  as files in a 0600 temp folder.
- Packaging carry: ship `plugin/` as `resources/careeros-plugin`, and `asarUnpack` `dist/mcp.mjs`
  (and the schemas it loads) so the app runtime can start it as Node.
