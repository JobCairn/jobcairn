# Candidate types: sponsorship only for people who need it

Ruling (product owner, 2026-10-10): CareerOS serves every kind of candidate. Citizens, permanent residents and people who prefer not to say never see visa sponsorship, and their job lists are never filtered by work-rights wording.

The single source is `packages/contract/src/candidate.ts`, driven by `profile.work_rights.status`:

| Status | `sponsorshipFocus` | What the UI does |
|--------|--------------------|------------------|
| needs_sponsorship | primary | Sponsors screen and columns, sponsor score, pinned "sponsorship offered" ads, sort by sponsor, 482 salary bands, Sponsorship mix card, "explicit sponsorship" tier in Next up |
| full_visa, limited_visa | secondary | Sponsor score shown as info in the job drawer and Job page. No pinning, no sponsor sort or tier, no 482 bands. Sponsors screen reachable but not in the sidebar. |
| citizen, pr, unknown | off | No sponsorship anywhere: no Sponsors nav item, column, score, card, pin, tier, bands or prompt text |

- Eligibility filtering stays with `isEligible`: citizens, PR and unknown are eligible for every ad.
- Job-search prompts use `jobSearchRightsRule(status)` instead of a fixed sponsorship sentence.
- Changing the status in Settings updates every screen with no data migration. Stored sponsor evidence is kept, only hidden.
- Copy never assumes a visa: "Work rights" not "Visa", and no "482" outside primary mode.
