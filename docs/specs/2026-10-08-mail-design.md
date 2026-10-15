# CareerOS app (sub-project 3b): mail

- Status: draft for review
- Date: 2026-10-08
- Builds on: `docs/specs/2026-10-08-app-shell-design.md` (3a: bridge, services, SecretStore,
  approvals, Electron shell) and `docs/specs/2026-10-08-workspace-design.md` (sub-project 1)
- Plan it extends: `docs/superpowers/plans/2026-10-08-app-shell.md` (Tasks 14, 26, 29, 32, 34)
- Later parts: 3c Claude chat and voice (uses mail as a tool and for inbox classification)

## 1. Goal

The candidate connects their Gmail once, from Settings, and from then on every email about a
job lands on that job's timeline without them doing anything. They read recruiter mail safely
inside the app, and they send replies and email applications only after seeing the exact
message and pressing Approve. No terminal, no plaintext password anywhere, nothing leaves the
laptop except the mail itself.

Success:
- A non-technical candidate finishes the setup wizard in under 5 minutes, guided by links to
  each Google page, and sees "Connected" after a test.
- A recruiter email from `talent@example.org` shows up on the Acme Corp job's Mail tab within
  one sync interval, with a timeline event, while the app is open or (if turned on) closed.
- A job-board alert that matches no company appears in "Mail to sort". A personal email is
  never written to disk.
- A tracking pixel in a recruiter email does not load until the candidate clicks "Load images".
- Claude drafts a follow-up; the app shows From, To, Cc, Subject, attachments and the full
  body with signature; nothing is sent until Approve; the sent copy is in the job folder.
- The Apply hand-off can send an email application with the tailored resume attached, through
  the same approval.

## 2. Decisions (owner, 2026-10-08)

| Topic | Decision |
|-------|----------|
| Provider | Gmail only in 3b, with an App Password. IMAP `imap.gmail.com:993` (implicit TLS), SMTP `smtp.gmail.com:465` (implicit TLS). No STARTTLS, no plain ports. |
| Other providers | Outlook and generic IMAP are a later extension point. 3b defines a `MailProvider` interface and ships one implementation. |
| Secret | The App Password lives only in 3a's `SecretStore` (`gmail_app_password`). Never shown back, never in the workspace, never in logs. Linux without a secret service: refuse to save (3a rule). |
| Setup | A wizard in Settings > Connections > Email with step-by-step links: 2-Step Verification, the App Passwords page, enabling IMAP. A Test connection button checks IMAP login, the Sent folder and SMTP auth (no message sent). |
| Sync | Read-only. A scheduled sync while the app runs (default every 15 minutes, plus a "Sync now" button). Optional background sync through the OS scheduler (launchd, Task Scheduler, systemd user timer) with an on/off toggle, off by default. |
| Matching | Recruiter email, company website domain, `email_match` list, company name in the subject. Unmatched job-related mail goes to "Mail to sort". Personal mail is ignored and never stored. |
| Views | Mail tab on the Job screen (the 3a placeholder) and a global Mail screen. |
| Viewer | Sanitized HTML, no scripts, remote images blocked by default with "Load images" per message, links through 3a's safe link dialog, attachments saved into the job folder only on click. |
| Sending | Every send is an `email_send` approval (the action 3a reserved and refused). Only Approve sends. The sent copy is saved and logged. Email applications from Apply use the same path. |
| Library choice | `imapflow` (IMAP), `nodemailer` (SMTP and MIME build), `mailparser` (MIME parse), `sanitize-html` (HTML clean). All run in the main process. Exact pins, licences checked and listed in `docs/dependencies.md` at pin time. No native modules. |

## 3. Architecture

```
packages/mail/                 new, shell-neutral Node package (no electron import)
  src/provider.ts              MailProvider interface; GmailProvider (imapflow + nodemailer)
  src/sync.ts                  incremental read-only sync, UID high-water marks, caps
  src/match.ts                 match a message to company and job; job-related rules
  src/store.ts                 write .eml + .json sidecar + .md text through @careeros/core
  src/sanitize.ts              HTML -> safe HTML (allow list), CSS url() stripped
  src/draft.ts                 draft file format, address checks, MIME build, content hash
  src/scheduler/               launchd plist, Task Scheduler XML, systemd unit + timer text
packages/core/                 schema email.schema.json, layout, index table, CLI draft cmd
packages/contract/             mail.* methods, types, validators, "mail" change area
packages/services/src/mail.ts  handlers, sync timer, email_send executor
packages/app-ui/               Mail screen, Job Mail tab, viewer, setup wizard, draft editor
packages/app-electron/         careeros-mail: protocol, background-sync entry, scheduler host
```

### 3.1 Workspace layout and records (core changes)

- Messages for a job: `companies/<slug>/jobs/<id>/emails/<YYYY-MM-DD>-<subject-slug>-<h6>.{eml,json,md}`.
  `.eml` is the raw message (the viewer and attachments read it, so mail works offline).
  `.json` is the sidecar record (new kind `email`, schema `email.schema.json`): `message_id`,
  `in_reply_to`, `thread_key`, `direction` (in or out), `from`, `to[]`, `cc[]`, `subject`,
  `date`, `uid`, `mailbox`, `matched_by` (recruiter, domain, email_match, subject, user),
  `attachments[]` of `{ part, name, size, type, saved_as }`, `images_allowed` (bool),
  `auth` (`pass`, `fail` or `none` from `Authentication-Results`), `custom`.
  `.md` is a plain-text copy (headers plus text body) so Claude can read the thread cheaply.
- Company mail with no clear job: `companies/<slug>/emails/` (new folder). The Mail tab of
  every job at that company shows it, with "Move to job".
- Drafts: `companies/<slug>/jobs/<id>/emails/drafts/<draft-id>.md`. Format kept from the
  legacy helper the owner already uses: header lines `To:`, `Cc:`, `Subject:`, `Attach:` (one
  per file, workspace-relative), `In-Reply-To:`, a blank line, then a plain-text body.
- Sort list: `.careeros/mail-triage/<id>.{eml,json}`. Ignore list and sync state:
  `.careeros/mail-state.json` (account address, `UIDVALIDITY` and last UID per mailbox, last
  run, counts). No secret is ever in it.
- Settings: `settings/integrations.json` > `mail`: `provider`, `address`, `display_name`,
  `signature` (plain text), `sync_minutes`, `first_sync_days` (default 30), `background`
  (on/off, minutes), `send_limit_per_hour` (default 10). Fields carry `x-ui` so 3a's
  schema-driven forms render them.
- `company.json` gains optional `email_match[]` (addresses, domains or words) and
  `recruiter.email`. Migration 2 adds the defaults.
- Index: new `emails` table (job, company, direction, date, subject, from) so the Home
  "replies" KPI and the Mail screen read from SQLite. `refreshIndex` (3a Task 4) learns the
  new paths.
- Timeline: core `addEvent` writes "Email received" or "Email sent" with the subject. 3a's
  `isReply` already counts "Email received".
- CLI: `careeros mail draft --job SLUG/ID --to ... --subject ... --body-file F [--attach P]`
  writes a draft and proposes `email_send`. Claude (desktop mode) uses this; it cannot send.

### 3.2 Sync

1. Open `INBOX` and the folder with the `\Sent` special-use flag (Gmail's name changes with
   the account language) using `EXAMINE`, so the mailbox is read-only. Fetch with
   `BODY.PEEK[]`, so no message is marked read.
2. First run fetches the last `first_sync_days`. Later runs fetch UIDs above the high-water
   mark. A changed `UIDVALIDITY` triggers a bounded re-scan by date, deduplicated by
   `Message-ID`.
3. Fetch headers first. Run the matcher on headers. Download the full body only for matched
   or job-related messages. Personal mail is skipped after the header check and only the UID
   mark moves.
4. Caps: 25 MB per message (larger ones are stored as headers plus "too large, open in
   Gmail"), 500 messages per run, 60 seconds of network per run. A run that hits a cap
   resumes next time.
5. A lock file in user data stops two syncs at once (app timer, background job, Sync now).

Matching order (first hit wins): recruiter email on a job or company; address in
`email_match`; sender domain equals the company `website` domain (with subdomains); a domain
or word in `email_match`; company name or alias in the subject (whole words). Then the job:
one job at that company, or the job whose title words appear in the subject, or the most
recent job in Applying, Applied or Interview; otherwise the company folder.

Job-related but unmatched: sender domain in a shipped data list of job boards and ATS senders
(`packages/mail/data/job-senders.json`, editable, data not code), or subject and first lines
matching job words (application, interview, role, position, recruiter, offer). Everything else
is personal and ignored. 3c replaces this rule with a Claude classifier in modes 2 and 3.

### 3.3 Sending

1. A draft comes from Claude (CLI or 3c tool) or from the candidate (draft editor). Creating
   a draft never sends.
2. "Review and send" proposes an `email_send` approval. Payload: draft path, account address,
   and `sha256` of the fully built MIME message (headers, body with signature, attachments).
3. The Approvals card and the draft screen show the full preview: From, To, Cc, Subject,
   each attachment (name, size, path), and the exact body with signature, rendered as the
   recipient will see it. A "You are attaching a file from a locked folder" banner appears
   when that applies.
4. On Approve, services rebuild the MIME and compare the hash. Any change since the proposal
   (draft edited, attachment replaced, signature changed) fails the approval with "The draft
   changed. Review it again." Any edit means a new preview and a new Approve.
5. SMTP send. Gmail files its own copy in Sent. The app writes the exact sent `.eml`, sidecar
   and `.md` into the job's `emails/`, adds "Email sent" to the timeline and the activity log,
   and moves the draft to `emails/drafts/sent/`.
6. Limits: one approval sends one message. `send_limit_per_hour` (default 10) blocks runaway
   loops. No bulk send, no BCC in 3b.

Apply hand-off (3a Task 21): when `apply_via` is an email address, the hand-off step offers
"Email application". It builds a draft addressed to `apply_via`, attaches the files from
`application/` that the candidate ticked, and proposes `email_send`. After the send, Apply
moves to confirm and the candidate marks it applied (3a rule: the app never marks for them).

### 3.4 Interfaces extended

| 3a interface | 3b change |
|--------------|-----------|
| `CareerosBridge` (Task 14) | New `mail` namespace: `status()`, `testConnection(address, displayName)`, `saveAccount(address, displayName)`, `disconnect()`, `syncNow()`, `list(query)`, `get(ref)`, `loadImages(ref)`, `saveAttachment(ref, part)`, `move(ref, target)`, `triage.list()`, `triage.assign(id, target, addMatch)`, `triage.createCompany(id, name, jobTitle)`, `triage.ignore(id, scope)`, `drafts.list(slug, id)`, `drafts.save(slug, id, draft)`, `drafts.propose(slug, id, draftId)`, `background.status()`, `background.set(on, minutes)`. Every argument has a validator in `METHODS`; refs are workspace-relative paths checked like `files.readText`. |
| `CHANGE_AREAS` | Add `mail`. |
| `APPROVAL_ACTIONS` | `email_send` stops being refused; it gets an executor. `ApprovalView` gains an `email` preview block. |
| `SECRET_NAMES` | Already has `gmail_app_password`. `secrets.set` for it now runs the test first and saves only on success. |
| Services (Task 29, 32, 33) | `mailHandlers`, a sync timer started on workspace open and stopped on close, `email_send` in the approval executor (same once-only state machine), `MUTATION_AREAS` entries. |
| `Host` (Task 29) | New `scheduler: BackgroundScheduler { status(); install(opts); remove() }` and `net: { allowedHosts }` so only `imap.gmail.com` and `smtp.gmail.com` are reachable from mail code. |
| Electron (Task 34) | `careeros-mail:` protocol for message bodies and images; `--background-sync` entry point; scheduler implementations per OS; `powerMonitor` resume triggers a sync. |

### 3.5 Background sync

The OS scheduler runs the CareerOS app binary itself with `--background-sync --workspace <path>`.
This is required because `safeStorage` can only decrypt inside the app that encrypted. The
process opens no window, takes the single-instance lock, syncs, writes a log line to
`userData/logs/mail-sync-<workspace_id>.log` (counts and errors only, no addresses or subjects) and exits.
If the app is already running, the second instance passes "sync now" to it and exits.

Everything is per workspace (people sharing a computer each have their own workspace): the Gmail
password is in that workspace's secrets (`ws.<workspace_id>.gmail_app_password`), the sync state
and send journal live in the workspace, and the sync lock (`userData/mail-sync-<workspace_id>.lock`),
the log and the OS schedule are named after its `workspace_id`. Switching workspace stops the old
workspace's running sync and closes its Gmail session.

| OS | Mechanism | File the toggle writes |
|----|-----------|------------------------|
| macOS | launchd user agent, `StartInterval` | `~/Library/LaunchAgents/<app-id>.mailsync.<workspace_id>.plist` |
| Windows | Task Scheduler, current user, "run only when logged on" | task `CareerOS Mail Sync <workspace_id>` created from XML with `schtasks` |
| Linux | systemd user service plus timer | `~/.config/systemd/user/careeros-mailsync-<workspace_id>.{service,timer}` |

Turning the toggle off removes the file or task. Settings shows the state the OS reports, not
what we think we wrote. Uninstall (sub-project 4) removes it too.

### 3.6 Carried over from 3a

3a Task 32 listed a Claude Code `SessionStart` hook that expires allow-once grants when the app
crashed with a grant open. 3b adds it to the generated `.claude/settings.json`, calling
`careeros privacy expire`. Mail drafts by Claude need it most, since they can cite locked files.

## 4. Screens

| Screen | What it does |
|--------|--------------|
| Settings > Connections > Email | Wizard. Step 1 turn on 2-Step Verification (link). Step 2 create an App Password named "CareerOS" (link, a picture of the page, "copy the 16 letters"). Step 3 check IMAP is on (link). Step 4 enter address and display name, paste the password into a masked field, press Test connection. Results per check (IMAP login, Sent folder found, SMTP login) in plain words, with the fix for each failure. Save happens only after a passing test. After that: "Connected as alex@example.com", Replace password, Disconnect, sync interval, first-sync window, signature editor with preview, background sync toggle with interval and OS status. The password is never shown again. |
| Mail (global) | Three tabs. **All job mail**: newest first, filters for company, job, direction, unread-by-me, has attachment. **Mail to sort**: each message with a suggested company, buttons Assign, New company and job, Ignore sender, Ignore domain. Assigning offers "Always match this sender" (adds to `email_match`). **Drafts**: every draft with its job and status (draft, waiting for approval, sent, failed). Header shows last sync, next sync, Sync now, and errors. |
| Job > Mail tab | The thread view for this job and its company mail, grouped by thread, with Reply (opens a draft with `In-Reply-To`), New email, and Move to job. |
| Message viewer | Header block with the real sender address (display name and address both shown), a warning when the display name claims a different domain or `auth` is `fail`, the sanitized body in a sandboxed frame, a bar "Images are blocked to protect your privacy. Load images", attachment chips (Save to job folder, then Reveal). Links open through `links.open` (3a dialog shows the full address). |
| Draft editor | To, Cc, Subject, body (plain text), attachments picked from the job folder, live preview with signature. Buttons Save draft, Ask Claude to improve (3c), Review and send (creates the approval). |
| Approvals | `email_send` cards show the same full preview and the hash-checked note "This exact message will be sent". |
| Home | "Replies" KPI and "next up" items for unread replies and drafts waiting. Connection footer shows mail status. |
| Apply | "Email application" option in hand-off when `apply_via` is an email address. |

## 5. Security and privacy

| Threat | Mitigation |
|--------|-----------|
| App Password stolen from disk or logs | `SecretStore` only (safeStorage). Never in workspace, settings, sync state, logs, crash reports or IPC replies. The renderer can only set or remove it. The test runs in main. Log lines are redacted by a shared redactor with a unit test. |
| Downgrade or interception | Implicit TLS on 993 and 465 only. Certificate validation always on; no "ignore certificate" option. Hosts pinned to the two Gmail names in `net.allowedHosts`. |
| Malicious HTML (scripts, forms, CSS exfiltration, frames) | `sanitize-html` allow list in main: no `script`, `iframe`, `object`, `form`, `input`, `style` with `url()`, `@import`, event attributes, `javascript:` or `data:` links. The result is shown in an iframe with `sandbox=""` (no scripts, no same-origin, no forms, no popups) and a CSP of `default-src 'none'; img-src careeros-mail: data:; style-src 'unsafe-inline'`. A corpus of known XSS vectors runs in tests. |
| Tracking pixels and remote content | Remote images never load by default. "Load images" (per message, remembered in the sidecar) makes main fetch them over https only, without cookies or referrer, with a size cap, and serve them from `careeros-mail:`. Inline `cid:` images come from the local `.eml` and show by default. |
| Phishing links | Links never navigate the app. `links.open` shows the real URL and allows https only. Displayed link text that differs from the target domain gets a warning in the dialog. |
| Spoofed recruiter | Show the real address next to the display name. Flag `Authentication-Results` DMARC or SPF fail. Matching on domain ignores display names. |
| Malicious attachments | Never opened or saved automatically. Save writes into the job folder with a slugged name (no path parts, no leading dots, length cap). Executable and script types (`.exe`, `.bat`, `.js`, `.app`, `.dmg`, `.sh`, `.ps1` and similar) are saved with a warning and never opened by the app. Reveal only shows the folder. |
| Prompt injection through email text | Emails are data. When Claude reads them (3c, or desktop mode reading `.md`), the content is marked untrusted. Claude cannot send; it can only draft, and the candidate approves the exact message. |
| Sending more than intended | Hash-checked approval, one message per approval, hourly cap, recipients shown in full, no BCC, header injection blocked (no CR or LF in any header field, addresses parsed and re-serialised). |
| Locked documents emailed by mistake | Attachments from `me/identity` or `me/employment` need an active allow-once grant and show a red banner in the preview. |
| Personal mail stored | Personal mail is never written. Only headers are fetched to decide. The ignore list stores senders and domains only. |
| Workspace on a cloud-synced folder | Emails become workspace files. Settings shows a one-time notice if the workspace path is inside a known sync folder (iCloud Drive, OneDrive, Dropbox, Google Drive). |
| Background job abuse | The scheduled command is the signed app binary with fixed arguments. It reads mail only and never sends. The task is per-user, never admin. |

## 6. Cross-platform notes

- Keychain access: macOS Keychain may prompt once for the background process; the wizard
  explains this. Windows DPAPI works for the logged-in user, which is why the task runs only
  when logged on. Linux needs a running Secret Service (GNOME Keyring or KWallet) and a session
  D-Bus; the systemd user unit imports `DBUS_SESSION_BUS_ADDRESS`. If the keyring is locked or
  missing, background sync logs "keychain locked" and skips; the app-open sync still works.
- Scheduler files are written with the right line endings and quoting per OS. Paths with
  spaces and non-ASCII characters are tested on all three.
- Gmail's Sent folder name varies by language; always find it by `\Sent`.
- Time: dates are stored in UTC ISO and shown in local time.
- File names: slugged ASCII, 80 characters max, to stay under Windows `MAX_PATH` in deep job
  folders.
- Sleep and wake: `powerMonitor` resume triggers a sync; missed intervals are not replayed.

## 7. Testing

- Unit (vitest): matcher rules on fictional messages (`talent@example.org`, Acme Corp,
  Example Labs, Acme Recruiting); job-related rules; draft parse and MIME build; header
  injection; hash check; slugging of attachment names; redactor.
- Sanitizer: an XSS and CSS-exfiltration corpus must come out inert; snapshot of safe output.
- Sync: a `FakeMailProvider` with fixture `.eml` files (all fictional, emails built by
  concatenation) covers first sync, incremental, `UIDVALIDITY` change, caps and resume,
  read-only (no flag changes requested), personal mail never written.
- SMTP: nodemailer's stream transport in tests captures the exact bytes; no network.
- Scheduler: golden text for plist, XML and systemd files; install and remove against a fake
  OS runner.
- Services: `email_send` approve runs once (double Approve, two windows), fails on a changed
  draft, refuses locked attachments without a grant, respects the hourly cap.
- Components (RTL, MockBridge): wizard happy path and each failure message, viewer with images
  blocked then loaded, Mail to sort assign, draft to approval.
- End-to-end (Playwright for Electron): setup with the fake provider, sync, open message,
  load images, save attachment, draft and approve a send captured by the fake.
- Security: the viewer frame cannot run script or reach the network; the renderer never
  receives the password (asserted on every IPC reply in e2e).

## 8. Out of scope

- Outlook, iCloud, generic IMAP and OAuth sign-in (the `MailProvider` interface is the hook).
- Sending without approval, scheduled sends, bulk mail, BCC, mail merge.
- Changing anything in Gmail: no labels, flags, archive, delete or mark-as-read.
- Rich-text (HTML) composing. Drafts are plain text in 3b.
- Calendar invites (`.ics` is saved as an attachment only).
- Claude classification of mail and Claude-written drafts inside the app (3c). Desktop-mode
  Claude can already draft through the CLI.

## 9. Risks

- Google may limit App Passwords for some accounts (Advanced Protection, some work or school
  accounts). The wizard detects the failure and says so plainly; OAuth is the later path.
- `imapflow`, `nodemailer` and `mailparser` are maintained by small teams. Pin exact versions,
  run osv-scanner, keep the provider interface thin so a swap is cheap.
- HTML sanitising is a moving target. Defence in depth: allow list, sandboxed frame, strict
  CSP, no remote loads.
- Background sync behaviour differs by OS and power settings. The app-open sync is the
  baseline; background sync is a convenience.
- Raw `.eml` files grow the workspace. The Mail screen shows space used and offers "remove
  raw copies older than N months" (keeps `.json` and `.md`).

## 10. Open questions

1. **Accounts where App Passwords are blocked.** Do we want a fallback in 3b? Recommended
   default: no. Show a clear "not available for this account" step and keep email manual
   until the OAuth provider ships.
2. **Mail to sort retention.** How long do ignored or unsorted messages stay in
   `.careeros/mail-triage/`? Recommended default: 30 days, then deleted, with a count shown.

**Resolution (2026-10-08):** the recommended default for each open question above is adopted so the build can proceed. The owner can change any of them later.
