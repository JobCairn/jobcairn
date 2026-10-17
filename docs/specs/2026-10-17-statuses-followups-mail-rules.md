# Statuses, follow-up limits and mail rules

Ideas 6, 7 and 8 from the review of another job-search tool (MIT licensed: ideas only, written our own way).

## Goal

- Close applications that never got a reply, and say when you pulled out, so they stop inflating the pipeline and
  keeping follow-ups alive.
- Stop nagging: at most two follow-ups, and a follow-up never adds a claim the application didn't make.
- Let synced mail move a job only when it is safe (an acknowledgement), and never decide an outcome for you.

## 1. Status vocabulary

Two new **final** statuses, beside Rejected and Skipped:

- **No response**: you applied and never heard back.
- **Withdrawn**: you pulled out of an application.

Order (menus, sorting): Found, Saved, Applying, Applied, Interview, Offer, Rejected, No response, Withdrawn, Skipped.

`FINAL_STATUSES` in `contract/constants.ts` (Rejected, No response, Withdrawn, Skipped) replaces the copies of the
"closed" list across contract, core, services and the UI. No response and Withdrawn count as sent applications
(the funnel's Applied stage, Resumes' sent list, the apply flow's done step). Applications › Closed holds all four.
Each has its own word, tone and icon in the table and pills.

**Legacy import:** Withdrawn used to fold into Skipped. It now imports as Withdrawn; Closed still maps to Skipped.
Existing workspaces need no migration: the schema enum only grows.

### Quiet applications (stale sweep)

An application in **Applied** with no activity (no timeline event, synced email included) for 60 days is "quiet".
On Applications and Jobs one banner offers them all:

> 5 applications have had no reply for 60 days. Mark them No response?

**Review** opens the list with a checkbox per job (all ticked). **Mark No response** sets the ticked ones to No
response with the note "No reply for 60 days". **Not now** hides the banner for this session. Nothing changes
without that click. Drafts never count: only Applied jobs are offered.

## 2. Follow-ups

- **Count:** a follow-up is a sent email on the job whose subject reads as a follow-up ("Following up: …",
  "Follow-up", "Checking in"), or a "Followed up" timeline event. `followUpsSent(timeline)` counts them.
- **Limit:** `MAX_FOLLOW_UPS = 2`. After one, the next follow-up is due `FOLLOW_UP_DAYS` after it. After two there
  is no follow-up date at all, so Home, Applications and the calendar stop offering one. The job's Outreach card
  says why: "You've followed up twice. A third rarely helps; wait for their reply or mark it No response." Asking
  Claude for a follow-up draft then fails with the same reason.
- **Grounding:** Claude's follow-up draft (draft_email, purpose Follow-up) may only use claims already in the resume
  and cover letter sent for this job (`application/resume.md`, `application/cover-letter.md`); 60 to 120 words;
  subject starts "Following up:" so it is counted. The career skill carries the same rule. A draft opened from the
  follow-up (or thank-you) template starts Write with Claude on that purpose.
- **Thank-you prompt:** once an interview is logged (status Interview, or an interview time that has passed), the
  job page shows a prompt to send a thank-you note (the existing `thankYouTemplate`). It goes away once a
  thank-you email is sent or the job moves on.

## 3. Mail rules

Pure functions in `packages/mail/src/signals.ts`:

- `mailSignal(subject, text)` reads the subject and the **first lines** of the body (never the footer) for:
  acknowledgement ("we've received your application", "thank you for applying"), interview invitation, rejection
  and offer. Opposite outcomes in one email are "mixed".
- `statusAdvice(status, signal)`:
  - acknowledgement on an **Applying** job: **move** to Applied, timeline note "Moved to Applied: the employer
    acknowledged your application (email of <date>)". The follow-up clock starts from the email's date.
  - interview, rejection or offer: at most a **suggestion** (returned, never applied); outcomes like accepted,
    declined, rejected or offer are never set from email.
  - a signal that conflicts with a final status (an interview invitation for a Rejected job, a rejection on an
    Offer), or mixed signals: **check**.
- **ATS senders:** a message from a known ATS domain (greenhouse.io, lever.co, myworkday.com and the rest, the new
  `ats` list in `data/job-senders.json`) whose subject names one active job's title matches that job, even when
  the sender is a no-reply address.
  Rule 6 only adds matches, so filed mail needs no re-check (`RECHECK_VERSION` stays 1).
- **Conflicts go to Mail to sort:** when the email's signals conflict with the matched job's status (or with each
  other), sync files the email in Mail to sort instead of the job, with `custom.needs_check` (company, job, reason)
  on its sidecar. Mail to sort shows "Needs a check: <reason>" and suggests that company.
- **An acknowledgement isn't a reply:** its "Email received" event carries `signal: "acknowledged"`, and
  `followUpOn` skips it, so the follow-up still comes due (whether sync or you set Applied).
- **Suggestions:** `syncMail` returns them as `suggestions` (company, job, status, note, email ref). Sync never
  applies them.

The look-back on match-key changes in `sync.ts` is unchanged.

## Out of scope

- Turning mail suggestions into approval cards (status_change approvals). The suggestion is computed, tested and
  returned by sync; showing it is a later step.
- A conflict when the subject names a different known company than the one matched: an agency's mail often names its
  client, so this needs its own design.
- Offer declined as its own status.
- Reading a job's date applied back from the acknowledgement into a separate field: the status event carries it.
