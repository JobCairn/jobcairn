# Recruiter email: Claude writes it, and a resume tailored for the agency

## Goal

The agency **Email** dialog (Recruiter page, `RecruiterEmail.tsx`) fills a fixed template today, and a general
enquiry can only attach one of your own resumes. Let the person choose how the email is written and, for a general
enquiry, ask Claude for a resume aimed at that agency.

## Behaviour

The dialog keeps its layout: the note about recruiters, **What it's about** (a live job or General enquiry), the
resume part, the sponsorship checkbox, then **Write email** and **Cancel**.

**How to write it** (radio group, two choices):

- **Use the template** (default): the current template (`recruiterEmailDraft`), instant.
- **Have Claude write it**: Claude drafts the email from your profile, your evidence (me/history, me/resumes), the
  agency's record (specialties, cities, what it's hiring for, its named recruiters, where it was found) and, about a
  job, the job ad. An optional box **Anything to add or ask?** (for example "mention I'm available from November, ask
  about contract roles") goes to Claude as your note, with the same checks and fencing as every other note
  (`noteProblems`, `requestSection`, `noteRule`). Help text: "Claude uses your profile, your resume and what's saved
  about this agency." While Claude works the dialog shows "Claude is writing…" with the time and Stop. When it's
  done the usual draft editor opens with Claude's subject and body. Without Claude set up, the choice says so and
  offers **Claude setup**.

Either way the To address is the agency's published address (`a.email`), never anything Claude writes; the app adds
the signature; nothing is sent without Review and send and an approval.

**Resume, about a job:** unchanged (tailored application resume attached, or Tailor first, or attach one of yours).

**Resume, general enquiry** (radio group, three choices):

- **Attach one of your resumes** (default when you have one): as today.
- **Tailor a resume for this agency**: Claude writes a general resume version (`tailor_resume_variant`, Resumes
  screen) named "For <agency>", focused on the agency's specialties. If that version already exists it is reused,
  not made again. While Claude writes it the dialog shows progress; once ready, **Attach resume** renders it to PDF
  (Word when PDF isn't available) into the agency's `emails/outgoing` folder and attaches it. Write email waits
  until it's attached.
- **No resume**: nothing attached; the template and Claude both offer to send it instead.

**Sponsorship:** the checkbox stays, shown only to people who need sponsorship. It goes to Claude as an option
(off unless the dialog sends it on); otherwise Claude is told not to mention visas or sponsorship.

## Data and actions

- `recruiter_email` (general enquiry): target `company` = the agency's company folder (same slug, made by
  `recruiters.mailbox`). Writes `companies/<agency>/emails/suggested/recruiter.json` (`{subject, body}`). Reads
  `recruiters/<agency>/agency.json`.
- `recruiter_job_email` (about a job): target `job`. Writes `<job>/emails/suggested/recruiter.json`. A required
  app-set slug option `agency` names the agency; main checks the agency exists and lists that job.
- Both: `surface: "recruiters"`, options `attached` (toggle) and `sponsorship` (toggle, sponsorship audience
  "prioritise"); never auto mode (they read text from public pages, like draft_email reads mail).
- New bridge methods: `recruiters.suggestion(slug, id)` reads Claude's file with the same guards as
  `mail.drafts.assist`; `recruiters.attachVariant(slug, variant)` renders a general version into the agency's
  `emails/outgoing`.

## Edge cases

- A suggestion older than the run is ignored ("Claude didn't write a draft. Try again.").
- A note that fails `noteProblems` shows why and Write email stays off.
- An agency with no saved job only has General enquiry, as today.
- An agency name with characters a version name can't hold is cleaned (`topicLabel`).

## Out of scope

- **Email selected** (bulk) stays template-only: twenty Claude runs at once is too slow and costly.
- Claude never picks the recipient or adds contact details.
