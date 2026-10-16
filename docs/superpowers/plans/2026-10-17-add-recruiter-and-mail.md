# Add recruiter, import and recruiter mail Implementation Plan

**Goal:** Add recruiter (one or a list) with Claude checking each on its own site, mail matched to agencies (website,
published addresses, linked addresses and domains), Link recruiter in Mail to sort, and an Emails tab per agency.

**Architecture:** Core: `email_match`, `needs_check` on the agency schema; `mergeAgency` takes them and "Added by you"
sources; `agencyByDomain`, `ensureAgencyCompany`. Contract: `parseAgencyLine(s)`, `addRecruiterArgs`,
`agencyAddresses` with `email_match`, `agencyThreads`, the `check_recruiters` action. Mail: `companyIndex` folds in
agencies (no subject matching for agency-only entries), sync makes the company folder before filing, free-mail domains
never match from `email_match`. Services: recruiter handlers (add, import, unlink, emails), `mail.triage.linkAgency`,
recruiter_add merges by domain and clears `needs_check`, check_recruiters context and tools. UI: AddRecruiterDialog,
Link recruiter in Mail to sort, Linked addresses, Emails tab, timeline links.

**Tech Stack:** TypeScript, React, Vitest.

**Spec:** `docs/specs/2026-10-17-add-recruiter-and-mail.md`

## Global Constraints

- Personal mail stays out: nothing new is downloaded for mail that matches no company or agency and isn't job-related.
- A free-mail or job-board domain is never linked or matched as a whole domain (enforced in services and mail).
- Every record write goes through the store; fictional data only; emails in tests built by concatenation.
- Button labels one or two words. Don't touch `recruiters.css` or the column constants in `Recruiters.tsx`.

## Tasks

### Task 1: agency record
Files: `packages/core/schemas/agency.schema.json`, `packages/core/src/{types,recruiters}.ts`, core tests.
- [x] Failing tests: mergeAgency keeps email_match and needs_check, an "Added by you" source with no url;
      agencyByDomain finds an agency by its website's domain; ensureAgencyCompany makes the company folder once.
- [x] Implement; tests pass.

### Task 2: contract
Files: `packages/contract/src/{recruiters,actions,request,bridge}.ts`, contract tests.
- [x] Failing tests: parseAgencyLines (header, bare hosts, bad lines), addRecruiterArgs (site, board link needs a name,
      name and email), agencyAddresses with email_match, agencyThreads (grouping, order, latest received),
      check_recruiters prompt carries the published-contact rules.
- [x] Implement; tests pass.

### Task 3: mail matching
Files: `packages/mail/src/{match,sync}.ts`, mail tests.
- [x] Failing tests: agency website, contact email and linked address match; linked free-mail domain never matches;
      agency-only entries never match by subject; sync files an agency's mail and makes its company folder.
- [x] Implement; tests pass.

### Task 4: services
Files: `packages/services/src/{recruiters,mail-read,dispatch}.ts`, `claude/{context,args}.ts`, `claude/mcp/tools.ts`,
services tests.
- [x] Failing tests: add (site, board, name+email, dedupe by domain), importList, unlink, emails, linkAgency (address,
      domain, free-mail refused, other waiting mail re-filed), recruiter_add merges by domain and clears needs_check,
      check_recruiters context and tools.
- [x] Implement; tests pass.

### Task 5: UI
Files: `packages/app-ui/src/recruiters/AddRecruiter.tsx`, `recruiters/emails.css`, `screens/{Recruiters,Recruiter,Mail}.tsx`,
mock bridge, `packages/app-ui/test/recruiters.test.tsx`, `mail-screen.test.tsx`.
- [x] Failing dom tests: Add recruiter saves and starts Check recruiters; list import reports skipped lines; Contacts
      shows linked addresses with Remove; Emails tab shows threads and Reply; Link recruiter offers domain only when
      not free mail.
- [x] Implement; tests pass; `npm run typecheck`; commit.
