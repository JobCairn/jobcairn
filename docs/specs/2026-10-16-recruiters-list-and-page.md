# Recruiters: a list like Companies and a page like the Job view

## Goal

The Recruiters screen showed every agency as a large two-column card with everything inline. It was hard to scan.
Make it read like the rest of the app: a sortable table like Companies, and a detail page like the Job and Company
pages.

## Behaviour

**List (`#/recruiters`, `?p=` page kept in the address).** It uses the shared `Table` (`id="recruiters"`), the same as
Companies. Each row shows:

- a tick box, named for screen readers only ("Select Acme Recruiting")
- a star
- the agency: its mark, name, website host and founding year
- its cities
- up to three tags, then "+N"
- what it's hiring for, on one truncated line
- Found on: the first source's board mark and name, then "+N"
- status, as a pill
- follow-up date

You can sort by star, agency, cities, Found on, status and follow-up. With no heading clicked, favourites come first,
then names A to Z.

Filters are Search, Tag, City, Found on (shown only when some agency records a source) and "Ads open to visa holders"
(only for people who need sponsorship). They're kept for the session (`useKept`), so Back from an agency returns to
the same filtered list.

The toolbar shows the count, Clear filters and Select all. With rows ticked it adds a "Selected recruiters" toolbar:
Email selected (BulkEmail, up to 20 at a time), Mark contacted and Clear. Find recruiters stays in the header.
Clicking a row opens the agency.

**Agency page (`#/recruiter/<slug>?tab=`).** It has a Back link and a page name, the same as Company. The header shows
the mark, name, website link and the facts line (cities, founding year, open jobs). Its actions are star, Status,
Open website and Email, which opens RecruiterEmail.

The page has four tabs:

- **Overview:** what it's hiring for, the team-page note with its source, then specialties, tags, cities, founding
  year, jobs saved from it, and sponsorship evidence (sponsorship focus only). Below that, Found on lists each source
  linked to its page, with its date. Beside it, a Your tracking card holds the contacted date, follow-up date (set
  five business days after contact) and notes.
- **Contacts:** emails, each with its source page and date, Copy and Email. Email opens RecruiterEmail addressed to
  that address. Phones, each with Copy, because phone links are blocked. Named people with their title, specialties
  and source. Links to the website, the about/team page, each city's contact page and the LinkedIn company page, each
  with Open and Copy.
- **Jobs:** the jobs saved from this agency. Each row opens its job.
- **Timeline:** `activity`, the existing timeline, including emails drafted and replies.

**Tours.** The `recruiters` tour points at the header, Find recruiters, the filters, the table, a row and the tick
box. A new `recruiter` tour covers the header, Email, Found on, Your tracking and the Contacts tab.

## Data

The agency record format doesn't change. The page reads `recruiters.list()` and finds the agency by slug. Changes save
through `recruiters.update`.

`AgencyRecordView` gains an optional `sources?: { name, url, found_at }[]`. Another branch is adding this field to
the stored record, and older records have none.

## Out of scope

- A `recruiters.get` bridge call.
- Status or favourite filters.
- Editing the agency's published details.
