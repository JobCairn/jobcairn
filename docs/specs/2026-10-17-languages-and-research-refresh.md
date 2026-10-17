# Languages check, research refresh and link checks

Ideas 3, 10 and 11 from the ai-job-search comparison (MIT; ideas only, written again in our style).

## Goal

1. Ads that need a language the person doesn't speak are marked, the same way ads they can't apply for because of
   work rights are.
2. Company research older than 30 days says so, offers a refresh, and isn't reused as if it were current.
3. A pasted job link from an unknown host, or from an address that imitates a known board, gets a plain warning.

## 1. Languages

**Profile.** Settings › Profile gains a **Languages** section: a list of rows, each a language (free text, with
suggestions) and a level: **Basic**, **Conversational**, **Professional**, **Native or fluent**. Stored as
`profile.languages: [{ language, level }]` with levels `basic | conversational | professional | native`. The default
is an empty list. Nothing is assumed (not even English): an empty list means "unknown", and no ad is marked.

**Reading an ad** (`contract/src/languages.ts`, `detectLanguageNeeds`, pure). Only explicit requirement wording
counts, for a fixed list of common languages (English, Mandarin, Cantonese, Japanese, Korean, Vietnamese, Thai,
Indonesian, Malay, Tagalog, Hindi, Punjabi, Nepali, Tamil, Bengali, Urdu, Arabic, Persian, Hebrew, Turkish, German,
French, Spanish, Italian, Portuguese, Dutch, Swedish, Danish, Norwegian, Finnish, Polish, Russian, Ukrainian, Greek):

- "fluent in German", "fluency in Japanese", "native Korean speaker", "business-level Japanese", "conversational
  Spanish", "working knowledge of French", "Japanese (fluent)";
- "German required", "Mandarin is essential", "Japanese language skills are mandatory";
- "Japanese speaking Account Manager", "must speak Vietnamese", "bilingual in English and Mandarin".

The level asked for is the highest wording found: fluent, native, bilingual, mother tongue → native; professional,
business, proficient, advanced, excellent, C1/C2 → professional; conversational, intermediate, working knowledge,
B1/B2 → conversational; basic, A1/A2 → basic; a bare "German required" or "German speaking" states no level.

Not counted: sentences that call the language desirable, preferred, a plus, an advantage or a bonus; "Mandarin-
speaking customers" (a description of the clients, not the role); lower-case "polish" and other common words.
Aliases are folded together (Chinese and Putonghua → Mandarin, Bahasa Indonesia → Indonesian, Farsi → Persian,
Filipino → Tagalog), on both sides.

**The rule** (`checkLanguages`, pure):

| The ad | Your list | Result |
|---|---|---|
| Needs a language that isn't in your list | (list not empty) | **Blocker**: "Needs German, which isn't in your profile" |
| Asks a higher level than you declared | | **Warning**: "Asks for fluent German; your profile says Conversational" |
| Same or lower level, or no level stated | | Fine, nothing shown |
| Anything | Empty | Unknown, nothing marked in Jobs; the job page says to add your languages |

**Where it shows.** Jobs gets a **Language** column next to Work rights (hidden when no row has a result): a red tag
for a blocker, an amber one for a warning, the full sentence on hover and for screen readers. The Job page shows a
pill beside the work-rights pills ("Needs German"). A language blocker doesn't hide the ad (the reading is a
heuristic; the person decides), and it doesn't change the "Show ads I can't apply for" count.

**How.** Main reads each job's `jd.md` once and keeps the needs in memory keyed by file time and size, so a list is
cheap after the first read. Rows carry `lang?: { verdict, text, needs }`. The job record is unchanged.

**Claude.** The scoring rubric gets a Language row under Deal-breakers with the same rule (missing language: cap at
Nah or Definite No Go and name it; higher level: score and say so, quoting both). The score and tailor prompts tell
Claude to read the profile's Languages list and apply it.

## 2. Company research age

**Age.** `research.md`'s date is its "Researched: YYYY-MM-DD" line (or `researched_on:` front matter) when it has
one, else the file's modified time (`contract/src/research.ts`, `researchAge`). Research older than 30 days is
stale. Research company is told to start research.md with "Researched: <today>".

**Company page.** The Research tab and the header show "Researched N days ago" when stale, with **Refresh** (runs
Research company again). Fresh research shows "Researched today / N days ago" quietly in the Research tab.

**Claude.** Score, Tailor and Interview prep prompts get one line about the research: fresh research may be used
as background; stale research ("41 days old, older than 30 days") must not be reused as current: don't put its
facts in the score or the letter, and say in the summary to refresh it first. The career skill says the same:
research older than 30 days is re-researched before it's relied on (these runs have no web access, so the app's
Refresh does the re-research).

## 3. Pasted link host check

`classifyJobHost(url, company)` (in `job-link.ts`, pure):

- **board**: a known board or applicant system (`JOB_BOARDS`, exact host or dot-bounded subdomain);
- **company**: the host names the company ("careers.acme.com.au" for Acme Corp), or is the company's saved website;
- **lookalike**: not a known board, but a part of the host is a board's name or one letter off it
  ("seek-jobs.com.au", "linkedin.com.example.net", "lnkedin.com");
- **unknown**: anything else.

Add job's preview adds a warning (never a refusal) for the last two:

- "This link is on seek-jobs.com.au, which looks like SEEK but isn't SEEK's own address (seek.com.au). Fake job
  ads often use look-alike addresses, so check it before you apply or share any details."
- "This link is on example.net, which isn't a job board we know or Acme Corp's own site. Check the ad is real
  before you apply or share any details."

## Out of scope

- Hiding language-blocked ads or a "Show ads I can't apply for" change.
- Storing language needs on the job record or letting Claude override the detector.
- Per-fact source URLs in a research cache (the research already cites a URL for every fact).
- Fetching anything to check a host.
