# Recruiter email with Claude Implementation Plan

**Goal:** In the agency Email dialog, choose Use the template or Have Claude write it (with an optional note), and
for a general enquiry choose Attach one of your resumes, Tailor a resume for this agency, or No resume.

**Architecture:** Contract: two catalogue entries, `recruiter_email` (company target = the agency's company folder)
and `recruiter_job_email` (job target, app-set `agency` slug option), with `attached` and `sponsorship` options;
bridge methods `recruiters.suggestion` and `recruiters.attachVariant`. Services: main's request mapping checks the
agency (and that it lists the job) and makes its company folder; the suggestion reader shares mail-ai's guards;
attachVariant renders the version with `renderResume`; both actions never get auto mode. UI: RecruiterEmail gets two
radio groups and the Claude run; MockBridge mirrors the services.

**Tech Stack:** TypeScript, React, Vitest.

**Spec:** `docs/specs/2026-10-17-recruiter-email-claude.md`

## Global Constraints

- The To address is always the agency's published address; Claude writes only `{subject, body}`.
- Nothing is sent: the result opens in DraftEditor; sending stays Review and send and Approvals.
- The note goes through `validateRequest` / `requestSection` like every other note; options are always explicit.
- Button labels one or two words. Don't touch `recruiters.css` or `Contacts` in `screens/Recruiter.tsx`.
- Bulk email stays template-only.

## Tasks

### Task 1: contract
Files: `packages/contract/src/{actions,request,bridge,methods}.ts`, `packages/contract/test/recruiter-email.test.ts`.
- [x] Failing tests: both prompts read the agency record, write only recruiter.json, carry the fenced note and
      noteRule; the attached lines; sponsorship line only for people who need it, else "Don't mention visas";
      the agency option line; surfaces keep them out of generic lists.
- [x] Run and see them fail.
- [x] Implement; tests pass.

### Task 2: services
Files: `packages/services/src/{recruiters,mail-ai,claude/engine,claude/args}.ts`, `packages/services/test/recruiters.test.ts`.
- [x] Failing tests: recruiterEmailRequest refuses an unknown agency and a job the agency doesn't list, makes the
      company folder; recruiters.suggestion reads a fresh file and refuses a linked one; attachVariant writes the
      rendered version into emails/outgoing and refuses a bad version; runMode never auto for the new actions.
- [x] Run and see them fail.
- [x] Implement; tests pass.

### Task 3: UI
Files: `packages/app-ui/src/recruiters/RecruiterEmail.tsx`, `packages/app-ui/src/recruiters/recruiter-email.css`,
`packages/app-ui/src/mock/MockBridge.ts`, labels and activity maps, `packages/app-ui/test/recruiters.test.tsx`.
- [x] Failing tests: Claude path sends explicit options and the note, then opens the editor with Claude's text, the
      published To and the attachment; tailor path makes the version once, runs it, attaches it; No resume
      attaches nothing; no sponsorship key for someone who doesn't need it; a bad note keeps Write email off.
- [x] Run and see them fail.
- [x] Implement; tests pass; `npm run typecheck`.
- [x] Commit.
