# Recruiters: Add recruiter, import a list, and recruiter mail

Owner, 2026-10-17: "Add recruiter, like Add job" (paste a site, a job ad link or a name and email; Claude fills in the
rest), import several at once, and "Mail should link messages to agencies, because recruiters write from other
addresses". Then: an Emails tab on the agency page showing the conversation as threads.

## Goal

A person can add agencies they already know, one at a time or as a list, and their mail with recruiters lands on the
right agency, including mail from an address the agency doesn't publish.

## Behaviour

### Add recruiter

- The Recruiters header has **Add recruiter** next to Find recruiters (also on the empty state).
- The dialog has two tabs. **One agency**: one box takes an agency website, a job ad link from the agency, or a name
  with any details and an email; an optional Name field is required when the link is on a job board (a board is never
  taken as the agency's website). **A list**: paste lines or choose a CSV file, one agency per line:
  `name, website, email` (website and email optional; a header row starting with "name" is skipped; at most 200
  lines). Each line is checked and lines that can't be used are listed with the reason.
- Saving writes the record straight away (no Claude needed) with a source: `Added by you` with the pasted page, or the
  board's name (`SEEK`, `LinkedIn`...) with the ad's address. A pasted email is kept as a contact labelled
  `Added by you` (it isn't a published-page find, so it has no source page). Saved agencies are marked
  `needs_check`.
- **Duplicates.** An agency whose website domain (www. stripped, job boards and free mail never count) or slug matches
  an existing agency merges into it instead of making a second one. The same rule applies when Claude saves through
  recruiter_add, so Claude's "Acme Recruiting Pty Ltd" merges into the stub "acmerecruiting.example.com" was saved as.
- **Claude fills in the rest.** After saving, the app starts **Check recruiters** (`check_recruiters`, a web run like
  Find recruiters with the same published-contact rules, the same read-only rule and the same LinkedIn fetch block).
  Its context lists the agencies marked `needs_check` (name, website, the page and email given). Claude checks each on
  its own site and saves it with recruiter_add, which clears `needs_check`. One run checks every agency waiting; the
  page shows "Not checked yet" and a Check button while any wait. A record saved with no name is named after its
  slug until Claude saves its real name.

### Recruiter mail

- **Matching.** Mail sync's company index folds in every agency (same slug as its company folder): its website domain,
  every contact and person email (exact address only, never their domain), and its own `email_match` list
  (addresses exactly; domains with subdomains). Agencies never match by name in the subject, so a job alert naming a
  large agency isn't filed there. When an agency matches and has no company folder yet, sync makes one
  (`type: recruiter`), exactly like the Email button already does.
- **Free mail.** A whole free-mail domain (gmail, outlook, hotmail, yahoo, icloud and the rest of the mail module's
  list, plus country variants) or a job board's domain can never be linked or match as a domain: only the exact
  address. Services refuse it, not just the UI.
- **Linking a sender.** In Mail › Mail to sort, each message has **Recruiter** ("This is from a recruiter…"). It
  picks an agency and either the sender's exact address or, unless free mail, its whole domain. The value goes into
  the agency's `email_match`, the message (and every other waiting message that now matches) is filed under the
  agency, and new mail follows.
- **Contacts tab** lists "Linked email addresses" with Remove. Removing stops future matching; filed mail stays.
- **Privacy.** Unchanged: mail that matches nothing and isn't job-related is still skipped on headers alone; nothing is
  downloaded for it.

### Emails tab

- The agency page gets **Emails** (with a count): every message filed under the agency, plus any filed elsewhere whose
  counterpart is one of the agency's addresses or domains, plus drafts to it not sent yet. Messages are grouped by
  thread (oldest to newest within a thread, newest thread first). Each shows You → them or them → You, the address,
  date, subject and a short preview. Clicking opens it in the message viewer. The latest received message has Reply,
  which opens the agency email composer answering that message.
- **Timeline** keeps events; email events (sent, received) link to the Emails tab.

## Data

- `recruiters/<slug>/agency.json`: `email_match: string[]` (max 50, default []) and `needs_check: boolean` (default
  false). A source may have an empty url only when its name is `Added by you`.
- Bridge: `recruiters.add(input)`, `recruiters.importList(text)`, `recruiters.importFile(path)`,
  `recruiters.unlink(slug, value)`, `recruiters.emails(slug)`, `mail.triage.linkAgency(id, slug, scope)`.
  `TriageItem.free_mail` says whether the domain choice is offered.

## Out of scope

- Moving filed mail back when a link is removed.
- Claude reading pasted ad text (Add job's preview); the link and the agency's own site are enough.
- Matching agencies by name in subjects.
