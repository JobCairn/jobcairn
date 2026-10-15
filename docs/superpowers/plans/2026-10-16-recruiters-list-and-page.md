# Recruiters List and Page Implementation Plan

**Goal:** Replace the Recruiters card grid with a Companies-style table, and add a Job-style page for each agency.

**Architecture:** The list uses the shared brand `Table` with kept filters and a paged route. A new `recruiter` route
and screen read the existing `recruiters.list()` bridge call. Shared bits live in `recruiters/parts.tsx`. The
existing `RecruiterEmail` and `BulkEmail` flows are reused unchanged.

**Tech Stack:** React, `@careeros/brand`, Vitest and Testing Library.

**Spec:** `docs/specs/2026-10-16-recruiters-list-and-page.md`

## Global Constraints

- Fictional data only. In tests, build email addresses and phone numbers by concatenation.
- Brand tokens only. Button labels are at most two words, with longer text in `aria-label`.
- The renderer talks to the main process only through the bridge. The record format is unchanged, apart from the
  optional `sources` type.

## Tasks

### 1. Routes and navigation
Files: `packages/app-ui/src/router.ts`, `components/listPage.ts`, `nav/trail.ts`, `Shell.tsx`, `screens/registry.tsx`
- [x] Write route tests (`test/recruiters.test.tsx`, "Recruiters routes").
- [x] Make `recruiters` a paged list and add `recruiter/<slug>?tab=`, with its page key, Back fallback and sidebar
  highlight.

### 2. List
Files: `screens/Recruiters.tsx`, `recruiters/parts.tsx`, `recruiters/recruiters.css`. `recruiters/AgencyCard.tsx` is
removed.
- [x] Write tests for rows, filters (including Found on), sorting, star, the sponsorship filter, selection, bulk email
  and Mark contacted.
- [x] Build the table, filters, toolbar and selection.

### 3. Agency page
Files: `screens/Recruiter.tsx`
- [x] Write tests for the overview, tracking edits, contacts, people, jobs, timeline, the missing-agency message, the
  Email flows, and Back keeping the filters.
- [x] Build the header and the Overview, Contacts, Jobs and Timeline tabs.

### 4. Sources
Files: `packages/contract/src/recruiters.ts`
- [x] Add the optional `AgencySource` type to `sources`. Show it in the Found on column and filter, and in the page's
  Found on list.

### 5. Tours
Files: `packages/contract/src/tour.ts`, `tour/content.ts`, `test/tour.test.tsx`, `test/tour-anchors.test.tsx`
- [x] Re-point the recruiters tour at the table, and add the `recruiter` tour and its anchor route.
