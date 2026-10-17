import type { ResearchReport } from "@careeros/contract";

/**
 * Example research for the preview and tests (spec 2026-10-17-research-any-topic). Example data only: the numbers are
 * illustrative, not current figures, and the report says so. Nothing here is advice.
 */
export const EXPRESS_ENTRY_SLUG = "express-entry-in-canada";

const CANADA = "https://www.canada.ca/en/immigration-refugees-citizenship/services/immigrate-canada/express-entry";

export const EXPRESS_ENTRY_REPORT: ResearchReport = {
  schema: 1,
  title: "Express Entry in Canada for software engineers",
  as_of: "2026-10-10",
  summary:
    "Express Entry is Canada's online system for managing applications from skilled workers who want permanent residence. You make a profile, get a Comprehensive Ranking System (CRS) score, and the government invites the highest-ranked people in regular rounds. This is an example report for the preview: the figures are illustrative, not current.",
  changes_often: "Invitation rounds, score cut-offs and category draws change every few weeks. Check the official rounds page before you rely on any number here.",
  confidence: "medium",
  key_facts: [
    { label: "Programs", value: "3 federal programs", detail: "Federal Skilled Worker, Canadian Experience Class, Federal Skilled Trades.", sources: [1] },
    { label: "Score", value: "Up to 1,200 points", detail: "Comprehensive Ranking System, from age, education, language and experience.", sources: [2] },
    { label: "Profile valid", value: "12 months", detail: "Stays in the pool for up to a year unless invited.", sources: [1] },
    { label: "Language test", value: "Required", detail: "An approved English or French test, results under two years old.", sources: [3] },
  ],
  sections: [
    {
      heading: "Who it suits",
      paragraphs: ["Software engineers often apply through the Federal Skilled Worker program, or the Canadian Experience Class after a year of skilled work in Canada."],
      bullets: ["At least one year of continuous skilled work experience", "A language test at the required level", "An educational credential assessment for study done outside Canada"],
      sources: [1, 4],
    },
    {
      heading: "How invitations work",
      paragraphs: ["The government holds rounds of invitations. Some rounds are open to everyone in the pool; others target categories such as science, technology, engineering and maths occupations."],
      bullets: ["The cut-off score changes from round to round", "Category rounds can have lower cut-offs than general rounds"],
      sources: [2, 5],
    },
  ],
  steps: [
    { title: "Check you're eligible", detail: "Use the official tool to see which program fits your work, study and language results.", duration: "1 day", sources: [1] },
    { title: "Take a language test", detail: "Book an approved test and get your results.", duration: "2 to 6 weeks", sources: [3] },
    { title: "Get your education assessed", detail: "An educational credential assessment for degrees from outside Canada.", duration: "4 to 8 weeks", sources: [4] },
    { title: "Make your Express Entry profile", detail: "Enter your details online. Your CRS score is calculated and you join the pool.", duration: "1 to 2 days", sources: [1] },
    { title: "Wait for an invitation", detail: "If your score is at or above a round's cut-off, you're invited to apply.", duration: "Varies", sources: [5] },
    { title: "Apply for permanent residence", detail: "Send the full application with documents within the deadline in your invitation.", duration: "60 days to submit", sources: [1] },
  ],
  tables: [
    {
      title: "Programs compared",
      columns: ["Requirement", "Federal Skilled Worker", "Canadian Experience Class"],
      rows: [
        ["Work experience", "1 year continuous, anywhere", "1 year in Canada"],
        ["Language level", "Higher minimum", "Depends on job level"],
        ["Proof of funds", "Usually needed", "Not needed"],
        ["Education", "Required, assessed", "Not required"],
      ],
      note: "Example comparison for the preview. Check the program pages for the current rules.",
      sources: [1, 4],
    },
  ],
  charts: [
    {
      title: "Example: core points by language level",
      unit: "points",
      bars: [
        { label: "CLB 7", value: 68 },
        { label: "CLB 8", value: 92 },
        { label: "CLB 9", value: 116 },
        { label: "CLB 10", value: 136 },
      ],
      note: "Illustrative numbers for the preview, not the official grid.",
      sources: [2],
    },
  ],
  uncertain: [
    "How often category rounds for technology occupations will run next year.",
    "Whether provincial programs in your city have their own technology streams open now.",
  ],
  sources: [
    { id: 1, title: "Express Entry: how it works", url: `${CANADA}.html`, publisher: "Government of Canada", accessed: "2026-10-10", official: true },
    { id: 2, title: "Comprehensive Ranking System criteria", url: `${CANADA}/check-score/crs-criteria.html`, publisher: "Government of Canada", accessed: "2026-10-10", official: true },
    { id: 3, title: "Language test requirements", url: `${CANADA}/documents/language-requirements.html`, publisher: "Government of Canada", accessed: "2026-10-10", official: true },
    { id: 4, title: "Educational credential assessment", url: `${CANADA}/documents/education-assessed.html`, publisher: "Government of Canada", accessed: "2026-10-10", official: true },
    { id: 5, title: "Rounds of invitations", url: `${CANADA}/submit-profile/rounds-invitations.html`, publisher: "Government of Canada", accessed: "2026-10-10", official: true },
  ],
};

export const EXPRESS_ENTRY_MD = `# Express Entry in Canada for software engineers

As of 2026-10-10. Example report for the preview: the figures are illustrative, not current.

Express Entry is Canada's online system for managing applications from skilled workers who want permanent residence.

## Steps

1. Check you're eligible
2. Take a language test
3. Get your education assessed
4. Make your Express Entry profile
5. Wait for an invitation
6. Apply for permanent residence

## What we couldn't confirm

- How often category rounds for technology occupations will run next year.

## Sources

1. Express Entry: how it works, Government of Canada, read 2026-10-10
`;

/** A topic whose Claude run hasn't written anything yet, and one with only report.md (its data file failed). */
export const DEMO_TOPICS = [
  { slug: EXPRESS_ENTRY_SLUG, title: "Express Entry in Canada for software engineers", questions: "Which program suits a software engineer, and what score is usually needed?", depth: "thorough" as const, md: EXPRESS_ENTRY_MD, json: EXPRESS_ENTRY_REPORT, at: "2026-10-10T03:00:00.000Z", created_at: "2026-10-10T02:40:00.000Z" },
  { slug: "skilled-visa-482-vs-186", title: "Skilled visa 482 vs 186", questions: "", depth: "quick" as const, md: "# Skilled visa 482 vs 186\n\nAs of 2026-08-20. Example report for the preview.\n\n| | 482 | 186 |\n|---|---|---|\n| Length | Temporary | Permanent |\n", json: null, at: "2026-08-20T03:00:00.000Z", created_at: "2026-08-20T02:50:00.000Z" },
];
