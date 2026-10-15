# CareerOS app (sub-project 3c): Claude chat and voice

- Status: draft for review
- Date: 2026-10-08
- Builds on: `docs/specs/2026-10-08-app-shell-design.md` (3a: bridge, services, SecretStore,
  approvals, allow-once, Electron shell), `docs/specs/2026-10-08-mail-design.md` (3b) and the
  CareerOS plugin skills (`career`, `voice`, `video-explainer`, `video-slides`, `video-captions`)
- Plan it extends: `docs/superpowers/plans/2026-10-08-app-shell.md` (Tasks 14, 26, 29, 32, 34)
- Later part: sub-project 5 (video generation) uses the runs, tools and voice engines defined here

## 1. Goal

The candidate talks to Claude from inside CareerOS, about their real jobs, scores and files,
and runs Claude Actions (find jobs, score, tailor, interview prep, learning video, research)
from any screen. They choose how Claude connects. Claude can read and propose, never write or
send on its own. Videos and read-aloud use a voice the candidate picked and heard first.

Success:
- In Settings the candidate picks one of three connection modes, sees what each one costs and
  means, and a status light turns green.
- On the Acme Corp job, Cmd/Ctrl+K "Ask Claude: what am I missing for this role?" answers with
  the job's real gaps, citing files, in a side panel, while streaming.
- "Tailor resume" runs in-app (modes 2 and 3) with steps, a Cancel button and (mode 2) a live
  token and cost figure, and ends with one approval card listing the files it wants to save.
- Claude asks for the visa expiry; an allow-once card appears; after Allow it continues; the
  fact is not kept in the saved chat.
- Settings shows every local voice on this laptop with a Preview button. Premium voices stay
  off until the candidate adds their own key.

## 2. Decisions (owner, 2026-10-08)

| Topic | Decision |
|-------|----------|
| Modes | (1) Claude desktop app with the CareerOS plugin, default, hand-off as in 3a. (2) In-app chat with the candidate's own Anthropic API key: Messages API, streaming, tool use over the 3a bridge. (3) "Use my Claude Code login (experimental)": opt-in, runs the local Claude Code CLI headless (`claude -p`, stream-json) in the workspace, with a terms notice. Off by default. |
| Writes | Every write Claude wants goes through 3a approvals. Locked folders only through allow-once. |
| Actions | Find jobs, score, tailor, interview prep, learning video, research. Run in-app in modes 2 and 3 with progress and cancel; token and cost display in mode 2. Mode 1 hands off. |
| Chat UI | Side panel on every screen plus a full Chat screen. History stored locally in `.careeros/chats`. Context chips (current job, email, topic). Cmd/Ctrl+K "Ask Claude". |
| Models | `claude-sonnet-5` default, `claude-opus-5-5` option, `claude-haiku-4-5-20251001` for cheap classification. Kept in a data file so new models need no code. |
| Inbox | Claude classification of dropped files (3a inbox) and of unmatched mail (3b) in modes 2 and 3, as an upgrade of the rules. Rules still run first. |
| Voice | Picker with preview for video narration and optional read-aloud. Local free voices by default: Supertonic 3 (shipped), macOS `say`, Windows SAPI, Linux `espeak-ng` and Piper when installed. Premium voices (ElevenLabs) only with the candidate's own key, off until added. The app and `plugin/skills/voice` support the same engine list. |
| One tool registry | The same CareerOS tools serve mode 2 (in-process) and mode 3 (a local stdio MCP server, `careeros mcp`). One place for path checks, locks and approvals. |

## 3. Architecture

```
packages/tools/        new: tool registry (JSON Schema in, result out) over @careeros/core
                       and services; read tools, propose tools, request_access, start_video
packages/claude/       new: providers and runs
  src/modes/desktop.ts   mode 1: build prompt, copy, open Claude desktop (3a openDesktop, extended)
  src/modes/api.ts       mode 2: @anthropic-ai/sdk Messages API, streaming, tool loop, caching
  src/modes/cli.ts       mode 3: spawn `claude -p --output-format stream-json`, parse events
  src/actions/*.json     Claude Actions as data: id, label, screens, prompt template, tools,
                         model, budget, output check
  src/models.json        model ids, labels, context size, price per MTok (dated)
  src/runs.ts            run lifecycle: queued, running, waiting (approval or access), done,
                         failed, cancelled; one event stream per run
  src/chats.ts           .careeros/chats storage, redaction, export
  src/classify.ts        inbox and mail classification (Haiku), with rule fallback
packages/voice/        new: engines (supertonic, macos_say, windows_sapi, espeak_ng, piper,
                       elevenlabs), voice discovery, preview, synth to WAV, read-aloud
packages/core/         `careeros mcp` (stdio MCP server built from packages/tools), schemas
                       chat.schema.json and action-run.schema.json, new approval actions
plugin/skills/voice/   narrate.py gains windows_sapi, espeak_ng, piper and elevenlabs engines
```

### 3.1 Interfaces extended

| 3a interface | 3c change |
|--------------|-----------|
| `Transport` (Task 14) | Adds `onEvent(cb: (e: RunEvent) => void): () => void` for streaming. `RunEvent` = `{ run, kind: "text" \| "tool" \| "approval" \| "access" \| "usage" \| "status" \| "audio", ... }`. Text deltas are batched every 50 ms. |
| `CareerosBridge` | `claude.status()`, `claude.setMode(mode)`, `claude.testKey()`, `claude.models()`, `claude.cliCheck()`, `claude.acceptCliNotice(version)`; `chat.list()`, `chat.get(id)`, `chat.create(context)`, `chat.send(id, text, context)`, `chat.cancel(runId)`, `chat.rename(id, title)`, `chat.delete(id)`, `chat.export(id)`; `actions.list(screen)`, `actions.run(actionId, target)`, `actions.cancel(runId)`, `actions.runs()`; `voice.list()`, `voice.preview(engine, voice, lang)`, `voice.speak(text, opts)`, `voice.stop()`; `inbox.classify(names)`. `claude.openDesktop()` stays and now takes an optional action prompt. |
| `SECRET_NAMES` | Already has `anthropic_api_key`. Adds `elevenlabs_api_key`. |
| `APPROVAL_ACTIONS` | Adds `file_write` (one or more files with full content, diff for overwrites), `job_create` (new job and company records from a search), `sponsor_update` (evidence lines), `search_log` (lines to append). Same once-only state machine and card UI. |
| `CHANGE_AREAS` | Adds `chat`. |
| Services `Host` (Task 29) | `net.fetch` limited to `api.anthropic.com` (mode 2), `api.elevenlabs.io` (premium voice), and the hosts 3b allows. `ShellHost` gains `spawn(cmd, args, opts)` with process-tree kill, `detectClaudeDesktop()`, `detectClaudeCli()`, `clipboardWrite(text)`. |
| Approvals executor (Task 32) | Executes the new actions through `@careeros/core` store functions only. `file_write` refuses locked folders, `.careeros/`, `settings/.env`, `.claude/` and anything outside the workspace. |
| Electron (Task 34) | New IPC push channel `careeros:event`. CSP adds `media-src blob:` for read-aloud and previews. The renderer still has no network (`connect-src 'none'`); all calls run in main. |

### 3.2 Mode 1: Claude desktop app (default)

Same as 3a, generalised. Each Claude Action builds a prompt (extending 3a's
`buildApplyPrompt`), copies it to the clipboard, opens the desktop app, and shows "Paste this
in Claude. Results appear here when Claude saves them." The watcher picks up files Claude
writes. Proposals Claude makes through the CLI (`careeros approval propose`, `careeros mail
draft`) show up in Approvals. No chat panel content in this mode: the panel shows the action
buttons and a "Switch mode" link.

### 3.3 Mode 2: in-app chat with the candidate's API key

- Key stored in `SecretStore`. "Test key" calls the models list endpoint and shows the result.
- Messages API with streaming and tool use. The system prompt is short: CareerOS rules (no
  fabrication, plain writing, never submit, never send), the workspace `CLAUDE.md`, and the
  context chips. Skill text is not preloaded: a `load_skill(name, ref?)` tool reads the
  bundled plugin skill or one reference file on demand, the same progressive loading Claude
  Code uses. System prompt and tool definitions use prompt caching.
- Tool loop runs in main. Tool results are wrapped as untrusted data when they contain job
  ads, emails or web pages. Long tool results are trimmed with a pointer to the file.
- Research and find jobs use Anthropic's server-side web search and web fetch tools. A
  Settings switch turns them off. Their extra cost is shown.
- Find jobs in mode 2 reads public ATS boards (Greenhouse, Lever, Ashby, Workable,
  SmartRecruiters JSON endpoints) through a `fetch_ats_board` tool and web search. Browsing
  job sites in the candidate's Chrome stays in modes 1 and 3.
- Usage: input, output and cache tokens from each response, priced from `models.json`
  (labelled "estimate"). Shown live per run, per chat, and per month in Settings. A monthly
  soft cap (see open questions) pauses runs with "Continue anyway" or "Stop".

### 3.4 Mode 3: "Use my Claude Code login (experimental)"

- Off by default. Turning it on shows a notice the candidate must accept, stored with the
  date and notice version in user data (asked again if the text changes). The notice says, in
  plain words:
  - Anthropic's Consumer Terms (Section 3, item 7, effective 8 October 2025) forbid accessing
    the Services "through automated or non-human means, whether through a bot, script, or
    otherwise", except via an API key or where Anthropic explicitly permits it.
    Link: https://www.anthropic.com/legal/consumer-terms. CareerOS checks the current text
    at release time.
  - This mode starts Anthropic's own Claude Code program on this laptop. CareerOS never reads,
    copies or stores the Claude Code login.
  - It may stop working or be blocked at any time. Modes 1 and 2 are the supported ones.
- Run: `claude -p <prompt> --output-format stream-json --verbose --model <id>` with the
  workspace as the working directory, so the generated `.claude/settings.json` (locked-folder
  denies) applies. `--mcp-config` points at a file in user data that starts `careeros mcp`,
  with `--strict-mcp-config`. `--allowedTools` is set per action: the `careeros` MCP tools,
  `Read`, `Glob`, `Grep`, and for find jobs only `Bash(agent-browser:*)`. `Write`, `Edit` and
  all other `Bash` are not allowed, so writes go through the MCP propose tools and approvals.
  Follow-ups in a chat reuse the CLI session with `--resume <session_id>`. Exact flags are
  checked against the pinned Claude Code version by `claude.cliCheck()`.
- Usage shows "Uses your Claude plan limits" plus token counts when the stream reports them.
  No dollar figure.
- Cancel kills the process tree (`taskkill /T` on Windows, process group on macOS and Linux).

### 3.5 Tools (one registry, both modes)

| Tool | Kind | Notes |
|------|------|-------|
| `workspace_summary`, `get_profile` | read | Profile without locked-folder facts. |
| `list_jobs(query)`, `get_job(slug, id)` | read | Same view logic as 3a (`applyJobQuery`). |
| `read_file(rel)`, `list_files(dir)`, `search_text(q)` | read | 3a path checks. Refuses locked folders without a grant, `settings/.env`, `.careeros/` internals, `.claude/`. 200 KB cap. |
| `list_sponsors`, `search_log`, `mail_thread(slug, id)` | read | Mail is wrapped as untrusted. |
| `load_skill(name, ref?)` | read | Bundled plugin skills only. |
| `fetch_ats_board(provider, board)` | network | Fixed hosts per provider, https, size cap. Mode 2 only. |
| `request_access(folder, why, minutes)` | access | Creates a 3a access request; the run waits until Allow, Deny or timeout. |
| `propose_files`, `propose_status`, `propose_job`, `propose_sponsor`, `propose_search_log`, `propose_email` | propose | Each creates one approval. A run batches its file writes into one card. `propose_email` uses 3b drafts. |
| `list_video_types()`, `start_video(type, subject)` | flow | Any type in sub-project 5's video-type registry (lesson, JD walkthrough, company briefing, interview prep, pitch, application summary, weekly recap, and any added later). Opens the Make video flow with the request filled in; the candidate starts it. "Make me a pitch video for the Acme Corp job" in chat works this way. |

### 3.6 Claude Actions

Actions are data files (`packages/claude/src/actions/<id>.json`, schema-validated), so new
ones need no code. Each has: label, screens it appears on, target (job, company, topic, none),
prompt template, tools allowed, model, budget (max turns and tokens), and an output check
(for example "tailor must propose `application/resume.md`"). Built-in: the five career actions
from the 3a addendum catalogue run in-app (`find_jobs`, `score_job`, `tailor_application`,
`interview_prep`, `research_company`, which saves cited notes to `companies/<slug>/research/`);
the video action ids open the Make video flow (sub-project 5). Runs appear in a
Runs drawer with steps, elapsed time, tokens and cost (mode 2), and Cancel. Cancelled runs
leave no files: proposals not yet approved are withdrawn.

### 3.7 Chat storage

- `.careeros/chats/<id>.jsonl` (one event per line: user text, assistant text, tool call and a
  short result summary, approval links, usage) and `.careeros/chats/index.json` (title, mode,
  model, context, updated). New record kinds with schemas.
- Content read from a locked folder under a grant is kept in memory for the run only. The
  saved transcript stores "[locked content, not saved]" and the folder name.
- Delete removes the file. Export writes Markdown to a folder the candidate picks.
- The generated `.claude/settings.json` denies Claude Code `Read(./.careeros/chats/**)` so
  desktop and CLI sessions do not pull old chats into context.

### 3.8 Classification

Rules first (3a `suggestInboxTarget`, 3b job-sender rules). If a rule is not confident and
the mode is 2 or 3, Haiku gets the file name, type and size (dropped files) or sender, subject
and the first 500 characters (unmatched mail) and returns a target from a fixed list. File
contents are sent only if the candidate turns on "Let Claude read inbox files", off by
default, and never for images. The candidate still confirms every move.

### 3.9 Voice

| Engine | OS | Status | Voices |
|--------|----|--------|--------|
| `supertonic` | all | Default, shipped by the installer | F1 to F5, M1 to M5 (default F4, suggested M3), expression tags |
| `macos_say` | macOS | Built in | System voices from `say -v ?` |
| `windows_sapi` | Windows | Built in | Installed SAPI voices via PowerShell `System.Speech` |
| `espeak_ng` | Linux (any) | If installed | `espeak-ng --voices` |
| `piper` | Linux, macOS, Windows | If installed with voice models | Model files found in the CareerOS voices folder |
| `elevenlabs` | all | Off until the candidate adds a key | Voices listed from their account |

- One engine list, two callers. `packages/voice` calls `plugin/skills/voice/scripts/narrate.py`
  for synthesis, so the app and desktop-mode Claude produce the same audio. narrate.py gains
  the four new engines and keeps its exit codes. The `engine` enum in the integrations schema
  grows to match.
- ElevenLabs needs the key from `SecretStore`, which only the app can read. The app passes it
  to narrate.py through an environment variable for that one process. In desktop mode,
  narrate.py with `elevenlabs` exits 3 with "Open CareerOS to use a premium voice".
  `docs/dependencies.md` changes the key's home from workspace `.env` to the OS keychain.
- Settings > Voice: engine, voice list with Preview (a fixed sample sentence, cached in
  `settings/voice-previews/`), language, natural expressions on or off, and a voice per video
  type (guide, interview, slides). Read-aloud: off by default; when on, a speaker button on
  chat replies and guides, and an optional "read replies aloud" switch.
- Read-aloud audio is generated in main and sent to the renderer as bytes, played from a
  `blob:` URL, and not saved. Markdown is turned into speakable text (no code blocks, links
  read as their text).

## 4. Screens

| Screen or part | What it does |
|----------------|--------------|
| Settings > Claude | Three mode cards with plain pros and cons. Mode 1: desktop app found or not, plugin installed or not, "Open Claude". Mode 2: masked key field, Test key, model choice, web tools switch, monthly cap, usage this month. Mode 3: the notice and an "I understand" checkbox, CLI found and version, "Check again". Status light per mode. |
| Settings > Voice | As in 3.9. Premium section greyed out with "Add your ElevenLabs key to use these". |
| Chat side panel | Toggle from the top bar on every screen. Context chips at the top (current job, open email, Learn topic), removable. Streaming reply with safe Markdown (3a component). Tool steps as one-line rows ("Read job · Acme Corp · AI Engineer"). Proposals as inline cards linking to Approvals. Access requests as inline Allow and Deny. Stop button. Model picker and token and cost meter (mode 2). |
| Chat screen | Conversation list (search, rename, delete, export) and a wide chat view. |
| Command bar (Cmd/Ctrl+K) | "Ask Claude: ..." opens the panel with the text and current context. Also lists the Claude Actions for the current screen. |
| Claude Actions | Buttons on Job (score, tailor, interview prep, make video), Company (research), Jobs (find jobs), Learn (learning video). Runs drawer shows active and recent runs. |
| Inbox and Mail to sort | Suggestions marked "Suggested by Claude" or "Suggested by rule". |
| Approvals | New cards for `file_write` (file list, preview, diff on overwrite), `job_create`, `sponsor_update`, `search_log`. |
| Connection footer | Mode, model, and status (3a placeholder filled). |

## 5. Security and privacy

| Threat | Mitigation |
|--------|-----------|
| API key leak | `SecretStore` only. Requests built in main. The key never reaches the renderer, logs, chats or child processes (except the ElevenLabs key passed by env to one narrate.py call). |
| Prompt injection from job ads, emails, web pages | Claude has no write, send or delete tools, only propose tools. Every proposal shows exactly what will change. Untrusted content is wrapped and labelled. Network tools have fixed hosts (ATS) or are Anthropic server tools. No tool can reach the candidate's other files. |
| Locked facts leaking | Tools refuse locked folders without a grant. Grants are 3a allow-once, time-boxed, logged. Locked content is not stored in chats. Mode 3 also runs under the generated deny rules. |
| Data sent to Anthropic | Mode 2 sends what the tools read. Settings explains this. Classification sends metadata only unless the candidate opts in. Mode 1 and 3 follow the candidate's own Claude account settings. |
| Runaway cost or loops | Per-action budgets (turns and tokens), monthly soft cap, Cancel everywhere, at most two runs at once. |
| Mode 3 terms risk | Off by default, notice with the clause and link, consent recorded, never touches the login token, clearly labelled experimental. |
| Child process abuse | `claude` and `narrate.py` are found at known paths, run with fixed arguments, no shell, the workspace as working directory, a clean environment, and a kill on cancel or app quit. |
| Malicious model output in the UI | Replies render through 3a's safe Markdown (no raw HTML, links through `links.open`, remote images replaced). |
| Chat history exposure | Stored in the workspace only, deletable, denied to Claude Code reads, excluded from any export unless the candidate picks it. |

## 6. Cross-platform notes

- The Claude desktop app exists for macOS and Windows. On Windows the app is found in the
  usual per-user install folder and started directly. On Linux, or when it is not installed,
  mode 1 falls back to "copy prompt" and Settings suggests mode 2 or 3.
- Claude Code CLI: found on `PATH` and in the installer's known locations, `.cmd` shim
  handled on Windows. The installer (sub-project 4) owns installing and updating it.
- Voices: `say` only on macOS, SAPI only on Windows, `espeak-ng` mostly on Linux. Supertonic
  runs everywhere through the CareerOS Python venv. Engines not present are hidden, not shown
  as errors.
- Audio: synthesis always produces 44.1 kHz mono WAV through ffmpeg so playback and video are
  the same on every OS.
- Process trees are killed per OS. Paths with spaces and non-ASCII names are tested.

## 7. Testing

- `packages/tools`: each tool against the sample workspace (Alex Example); locked refusal;
  path tricks reuse 3a's Review Focus 1 cases; proposals create the right approval records.
- Mode 2: a fake Messages API (recorded streaming fixtures, no network) covers text deltas,
  tool loops, server tool blocks, usage math, budget stop, cancel mid-stream, and the 401 and
  429 paths.
- Mode 3: a fake `claude` script that prints recorded stream-json covers parsing, resume,
  cancel and a missing or old CLI. One manual check per Claude Code release, documented.
- `careeros mcp`: MCP protocol tests over stdio with the same tool cases.
- Actions: every action file validates against its schema; prompts snapshot-tested.
- Chats: redaction of locked content, export, delete.
- Voice: engine discovery with fake binaries per OS, narrate.py engine tests where the engine
  exists (CI runs `espeak-ng` on Linux, `say` on macOS), WAV format check, preview cache.
- Components and e2e: chat panel streaming, access request inline, proposal to approval,
  Cmd/Ctrl+K, Settings mode switching with the mode 3 notice, voice preview.
- Security: the renderer never receives a key (asserted on every IPC reply), the renderer CSP
  blocks network, mode 3 never passes `Write`, `Edit` or open `Bash` in `--allowedTools`.

## 8. Out of scope

- Speech input or dictation.
- Claude writing files directly without approval, in any mode.
- Cloud sync of chats, shared chats, multiple workspaces in one chat.
- Browsing job sites in the candidate's Chrome from mode 2.
- Using the Claude Code login for anything other than starting the official CLI.
- Video rendering itself (sub-project 5). 3c only triggers it.
- Installing Claude Code, the desktop app or voices (sub-project 4).

## 9. Risks

- Mode 3 can break with any Claude Code release, or be disallowed. It is opt-in and
  isolated behind the same tool registry, so switching it off loses nothing.
- Model ids and prices change. They live in `models.json` with a date; a stale price shows
  "estimate may be out of date" after 90 days.
- Prompt injection can never be fully prevented. The design limits its blast radius to
  proposals the candidate sees in full.
- Desktop mode cannot stream into the app. The candidate sees results only when files land.
- Local voice quality varies a lot (espeak-ng sounds robotic). Supertonic stays the default
  and the picker plays a preview before any choice.

## 10. Open questions

1. **Monthly spending cap default (mode 2).** Recommended default: a soft cap of 20 US dollars
   a month, editable, with "Continue anyway" when reached.
2. **Mode 3 legal read.** Should we get a legal opinion before shipping mode 3 to paying
   candidates? Recommended default: ship it to the founder only (feature flag) until
   reviewed; candidates see modes 1 and 2.

**Resolution (2026-10-08):** the recommended default for each open question above is adopted so the build can proceed. The owner can change any of them later.
