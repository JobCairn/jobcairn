import type { SponsorshipFocus, TourId } from "@careeros/contract";
import type { Route } from "../router";
import { WHY_CHROME_SHORT } from "../chrome/state";

/**
 * Every guided tour, in the words people see. Plain Australian English, one or two short sentences per card.
 * Targets are CSS selectors, mostly `[data-tour="…"]` attributes on the real controls. A step whose control
 * isn't on screen (an empty list, a hidden section, a narrow window) is skipped quietly.
 */
export interface TourStep {
  id: string;
  /** The control to point at. The first match that is visible wins. */
  target: string;
  title: string;
  /** One or two sentences: what it does and why you'd use it. May depend on how much sponsorship matters. */
  body: string | ((focus: SponsorshipFocus) => string);
  /** Only shown to these people (by how much sponsorship matters to them). */
  only?: SponsorshipFocus[];
  /**
   * "Try it": a safe, local action only (focus a box, switch a tab). Never sends, applies or asks Claude.
   * `target` defaults to the step's own target.
   */
  tryIt?: { action: "focus" | "click"; target?: string };
  /**
   * Why this step's control may be missing on a normal visit (it only shows in some states, such as while Claude
   * runs or once a review step is reached). The anchor test skips optional steps; every other step's control must
   * be on screen with the example data.
   */
  optional?: string;
}

export interface TourDef {
  id: TourId; name: string;
  /** The welcome card a tour opens with when it starts by itself: a short hello before the step tips. */
  intro: { title: string; body: string };
  steps: TourStep[];
}

const t = (id: string) => `[data-tour="${id}"]`;
const tab = (list: string, id: string) => `[role="tablist"][aria-label="${list}"] [role="tab"][id$="-tab-${id}"]`;

export const TOURS: Record<TourId, TourDef> = {
  home: {
    id: "home", name: "Home",
    intro: { title: "Welcome to Home", body: "This is where your search comes together each day. Want a quick look around?" },
    steps: [
      { id: "today", target: t("home-today"), title: "Your day at a glance",
        body: "This line sums up what needs you today. Click a shortcut underneath to jump straight to it." },
      { id: "visa", target: t("home-visa"), title: "Your visa countdown", only: ["primary", "secondary"],
        body: "Days left on your visa, so you always know how much time your search has. Add the date in Settings if it's missing." },
      { id: "start", target: t("home-start"), title: "Your setup checklist",
        body: "A short checklist to get you set up, each step ticking itself off once it's done. Hide it here, and bring it back in Settings, Appearance." },
      { id: "next", target: t("home-next"), title: "Next up",
        body: (f) => f === "primary"
          ? "The jobs most worth your time right now, with roles that offer sponsorship first. Open one to read the ad."
          : "The jobs most worth your time right now, best match first. Open one to read the ad." },
      { id: "mix", target: t("home-mix"), title: "What the ads say about visas", only: ["primary", "secondary"],
        body: "How many ads offer sponsorship, welcome visa holders or want citizens only. Click a row to see those jobs." },
      { id: "claude", target: t("rail-status"), title: "Claude and Mail at a glance",
        body: "The dot on each icon shows whether Claude and Mail are ready, and a turning ring means Claude is busy. Point at one for details, or click it to see Claude's work or fix Mail." },
    ],
  },
  jobs: {
    id: "jobs", name: "Jobs",
    intro: { title: "This is Jobs", body: "Every role you've found lives here. Want a quick look around?" },
    steps: [
      { id: "find", target: "#main .screen-head .action", title: "Find more jobs",
        body: "Ask Claude to search the job sites for roles that suit you. New finds land in this list." },
      { id: "search", target: t("jobs-search"), title: "Search the list", tryIt: { action: "focus" },
        body: "Type a job title, company or suburb to narrow things down." },
      { id: "filters", target: t("jobs-filters"), title: "Quick filters",
        body: (f) => f === "primary"
          ? "Pick a chip, like Sponsorship or Work mode, to narrow the list. The numbers show how many jobs each choice leaves."
          : "Pick a chip, like Work mode or Salary, to narrow the list. The numbers show how many jobs each choice leaves." },
      { id: "hidden", target: t("jobs-hidden"), title: "Ads you can't apply for",
        body: "Ads that need work rights you don't have stay hidden so they don't clutter the list. Tick this to see them anyway." },
      { id: "table", target: "#main .table", title: "Your jobs",
        body: (f) => f === "primary"
          ? "One row per job, with how well you fit, how likely they are to sponsor, and where it's up to. Click a row to open it."
          : "One row per job, with how well you fit and where it's up to. Click a row to open it." },
      { id: "add", target: t("jobs-add"), title: "Add a job you found",
        body: "Paste a job link or the ad's text. Check what was read, then save it to your list." },
    ],
  },
  job: {
    id: "job", name: "this job",
    intro: { title: "A job up close", body: "Read the ad, see how you fit and get help from Claude, all on one page." },
    steps: [
      { id: "status", target: t("job-status"), title: "Keep track",
        body: "Move the job along as things happen, from Found to Applied to Offer. If it says You can't apply, the ad asks for work rights you don't have." },
      { id: "tabs", target: '[role="tablist"][aria-label="Job sections"]', title: "Everything in one place",
        tryIt: { action: "click", target: tab("Job sections", "score") },
        body: "The ad, its score, your files, a timeline, skill gaps and emails each have a tab. Under Files, click any file to read it right here." },
      { id: "ask", target: t("job-ask"), title: "Get Claude's help",
        body: "Claude can research the company or make a short video about the ad. While it works, a small status with a timer and Cancel sits in the button's place." },
      { id: "activity", target: tab("Job sections", "activity"), title: "What Claude did",
        body: "The Activity tab shows each run for this job, step by step, and the files it made." },
      { id: "mail", target: tab("Job sections", "mail"), title: "Emails about this job", tryIt: { action: "click" },
        body: "Emails with this company land under Mail, with replies grouped together. Write or reply from here, and nothing is sent until you approve it." },
      { id: "apply", target: t("job-apply"), title: "Ready to apply?",
        body: "This walks you through getting your resume and cover letter ready. Nothing is sent without your OK." },
    ],
  },
  apply: {
    id: "apply", name: "Apply",
    intro: { title: "Time to apply", body: "We'll get your resume and cover letter ready together. Nothing goes out without your OK." },
    steps: [
      { id: "steps", target: t("apply-steps"), title: "Four simple steps",
        body: "Prepare, review, hand off, then confirm. You can always go back to a step you've done." },
      { id: "prepare", target: t("apply-prepare"), title: "Tell Claude what you need",
        body: "Choose what to write and add a note if you like. Claude tailors your resume and cover letter to this job." },
      { id: "files", target: t("apply-files"), title: "Read before it goes", optional: "only from the Review step on",
        body: "Check each file before anything goes out. You can open the resume and tweak it yourself." },
      { id: "claims", target: t("apply-claims"), title: "Every claim traced", optional: "only from the Review step on",
        body: "Each claim in your resume should trace back to where it came from, so nothing made up slips through. If it says Unchecked, ask Claude to check them." },
      { id: "export", target: '#main [aria-label="Export"]', title: "Take a copy", optional: "only once the files exist",
        body: "Save your resume and cover letter as PDF or Word to attach anywhere." },
      { id: "next", target: t("apply-next"), title: "Move on when you're happy",
        body: "Next opens up once this step is done. Sending always waits for your approval." },
    ],
  },
  resume: {
    id: "resume", name: "the resume editor",
    intro: { title: "Your resume, your way", body: "Shape it for this job and watch the page update as you go." },
    steps: [
      { id: "tabs", target: '[role="tablist"][aria-label="Resume tools"]', title: "Your resume tools",
        body: "Edit the words, change the look, see Claude's ideas, go back to an older version or download it." },
      { id: "editor", target: "#main .rs-editor", title: "Edit right here",
        body: "Each part has its own fields, like dates and bullets. Click anything on the page to jump to it." },
      { id: "add-section", target: t("resume-add-section"), title: "Add what's missing",
        body: "Add a section like Projects, Certifications or Languages. Each comes with the right fields." },
      { id: "preview", target: t("resume-preview"), title: "See what they'll see",
        body: "The preview shows the real page. Most recruiters read one or two pages, so keep an eye on the page count." },
      { id: "save", target: t("resume-save"), title: "Saves as you go",
        body: "Changes save on their own a moment after you stop typing. Undo and Redo sit right beside it." },
      { id: "ai", target: tab("Resume tools", "ai"), title: "Ask for a rewrite", tryIt: { action: "click" },
        body: "Claude can suggest a sharper version. You decide whether to take it or keep your own." },
    ],
  },
  resumes: {
    id: "resumes", name: "Resumes",
    intro: { title: "All your resumes", body: "Your own resume, the ones tailored to jobs, and general versions. Want a quick look?" },
    steps: [
      { id: "new", target: t("resumes-new"), title: "Make a new resume",
        body: "Pick a job ad, or paste one you found anywhere. Or make a general version with a focus, like Backend-heavy." },
      { id: "view", target: t("resumes-view"), title: "Tiles or a list",
        body: "See your resumes as pages or as a list. We remember your choice." },
      { id: "base", target: t("resumes-base"), title: "Your own resume",
        body: "The resume you added in Settings. Claude reads it, with your work history, for every version." },
      { id: "tailored", target: t("resumes-tailored"), title: "Tailored to a job",
        body: "One resume per job. Open one to edit it, or use its ⋯ menu to copy, download or delete it." },
      { id: "general", target: t("resumes-general"), title: "General versions",
        body: "Resumes for applying anywhere, each with its own focus. Edit, download or copy them like any other." },
    ],
  },
  learn: {
    id: "learn", name: "Learn",
    intro: { title: "Brush up your skills", body: "Study guides and interview practice, built around the jobs you want." },
    steps: [
      { id: "start", target: t("learn-start"), title: "Learn something new",
        body: "Pick a skill and Claude writes you a study guide, pitched at your level." },
      { id: "suggested", target: t("learn-suggested"), title: "Skills the ads ask for",
        body: "These come from the jobs you've saved and the skills you haven't shown yet. The more ads that mention one, the higher it sits." },
      { id: "filter", target: t("learn-filter"), title: "Find what you need",
        body: "Switch between guides, videos and interview prep, or search by topic or job." },
      { id: "topics", target: t("learn-topics"), title: "Your topics",
        body: "Open a card to read or watch. It remembers where you're up to." },
      { id: "jobs", target: t("learn-jobs"), title: "Gaps from your jobs",
        body: "When a job is scored, any skills it wants that you haven't shown turn up here, ready to study." },
      { id: "history", target: t("learn-history"), title: "What you've finished",
        body: "Tick I've finished this on a guide and it lands here, so you can see how far you've come." },
    ],
  },
  inbox: {
    id: "inbox", name: "the drop box",
    intro: { title: "Your drop box", body: "Drop in any file and we'll help you put it in the right place." },
    steps: [
      { id: "drop", target: t("inbox-drop"), title: "Drop it in",
        body: "Drag in a resume, a reference or an offer letter, or click Choose file." },
      { id: "suggestion", target: t("inbox-suggestion"), title: "A suggested home",
        body: "The app reads each file on this computer and suggests where it belongs, with the reason. If it isn't sure, Ask Claude takes a look at that one file." },
      { id: "file", target: t("inbox-file"), title: "File it in one click",
        body: "Change the folder if the guess is wrong, then click File it, or Add job for a job ad. File all files the sure ones in one go." },
      { id: "remove", target: t("inbox-remove"), title: "Changed your mind?",
        body: "Remove sends a file to the Trash, so you can still get it back. Put back returns it to the folder you added it from." },
      { id: "folders", target: t("inbox-folders"), title: "Where things live",
        body: "Your folders at a glance. Locked ones stay private until you unlock them in Privacy." },
      { id: "history", target: t("inbox-history"), title: "Recently filed",
        body: "Every file you've filed, and where it went, in case you need it again." },
    ],
  },
  mail: {
    id: "mail", name: "Mail",
    intro: { title: "Your job mail", body: "Emails from the companies you're tracking, filed under each job. Want a quick look around?" },
    steps: [
      // Only on screen before Gmail is connected (the example has no Gmail); the other steps need a connection.
      { id: "connect", target: t("mail-connect"), title: "Connect Gmail first", optional: "only before Gmail is connected",
        body: "Mail works with your Gmail account and an app password. Settings walks you through it and tests it before saving." },
      { id: "sync", target: t("mail-sync"), title: "Always up to date",
        body: "Mail syncs on its own while the app is open. Click Sync now to check straight away." },
      { id: "filters", target: t("mail-filters"), title: "Find an email",
        body: "Search by subject or sender, or narrow it down to one company, job or unread mail." },
      { id: "list", target: t("mail-list"), title: "Only job mail",
        body: "Only emails about your job search are kept. Personal email is never saved." },
      { id: "viewer", target: t("mail-viewer"), title: "Read it safely",
        body: "Emails open here with pictures blocked until you choose to load them. Links always show where they really go." },
      { id: "sort", target: tab("Mail sections", "sort"), title: "Mail to sort", tryIt: { action: "click" },
        body: "Job alerts and new recruiters wait here, ready to file under the right job. Unfinished emails sit in Drafts, and nothing is sent until you approve it." },
    ],
  },
  settings: {
    id: "settings", name: "Settings",
    intro: { title: "Your settings", body: "A quick look at what you can change, including the one setting that matters most." },
    steps: [
      { id: "tabs", target: '[role="tablist"][aria-label="Settings sections"]', title: "All your settings",
        body: "Your details, what you're after, connections, voice and looks each have a tab. Pick light or dark under Appearance." },
      { id: "resume", target: t("settings-resume-fill"), title: "Fill from your resume",
        body: "Drop your resume here to fill in your name, email, phone, city and links. You check everything before it's saved." },
      { id: "rights", target: t("settings-rights"), title: "Your work rights",
        body: "This one matters: it decides which ads you can apply for and whether sponsorship details show up. Changes save as you make them, so there's no Save button." },
      { id: "connections", target: tab("Settings sections", "connections"), title: "Connected services", tryIt: { action: "click" },
        body: "Claude, email and Chrome each have a row with their status. Open a row to set it up." },
      { id: "chrome", target: "#settings-conn-chrome", title: "Why your own Chrome?", body: WHY_CHROME_SHORT },
      { id: "find", target: ".cmd-trigger", title: "Find any setting",
        body: "Press Cmd or Ctrl and K, then type a word like API key, Gmail or theme to jump straight there." },
    ],
  },
  applications: {
    id: "applications", name: "Applications",
    intro: { title: "Your applications", body: "Every application, from the first draft to the final answer. Want a quick look around?" },
    steps: [
      { id: "stages", target: '[role="tablist"][aria-label="Application stages"]', title: "One tab per stage",
        body: "To prepare, in progress, waiting for your OK, sent, interviews and closed. The numbers show how many are in each." },
      { id: "filter", target: t("apps-filter"), title: "Pick the best ones first", optional: "only on To prepare when jobs are waiting",
        body: "Sort by best match, fit or newest, or show only strong fits." },
      { id: "list", target: "#main .app-list", title: "One action per job",
        body: "Each row shows the fit, salary and where it came from. The button does the next thing, like Prepare or Continue." },
    ],
  },
  searches: {
    id: "searches", name: "Searches",
    intro: { title: "Every search Claude ran", body: "A record of where Claude looked, so nothing is searched twice." },
    steps: [
      { id: "head", target: "#main .screen-head", title: "Nothing searched twice",
        body: "Claude logs every search here and skips any it ran in the last week." },
      { id: "filters", target: "#main .filters", title: "Narrow it down",
        body: "Filter by site or words in the search to find one quickly." },
      { id: "table", target: "#main .table", title: "What each search found",
        body: "How many ads it found and kept. Click a row to see it in full." },
      { id: "gear", target: t("page-settings"), title: "Settings for this page",
        body: "The gear at the top of a page opens the settings that change it. Here, that's your search settings." },
    ],
  },
  videos: {
    id: "videos", name: "Videos",
    intro: { title: "All your videos", body: "Every video you've made, in one place. Want a quick look around?" },
    steps: [
      { id: "make", target: "#main .screen-head .btn--primary", title: "Make a video",
        body: "Start this week's recap here. Job and topic videos start from their own pages." },
      { id: "list", target: t("videos-list"), title: "Play, redo or delete",
        body: "Videos are grouped by topic, job, company and week. Open one to watch it or render it again." },
      { id: "gear", target: t("page-settings"), title: "Video settings",
        body: "The gear opens the video tools, caption style and default lengths." },
    ],
  },
  companies: {
    id: "companies", name: "Companies",
    intro: { title: "Every company in one place", body: "The companies you have jobs, mail or notes with, and how you're going with each." },
    steps: [
      { id: "filters", target: t("companies-filters"), title: "Find a company",
        body: "Search by name, or show only companies with open jobs or applications." },
      { id: "table", target: t("companies-table"), title: "Where you stand",
        body: (f) => (f === "off" ? "Open jobs, your best fit and your furthest application for each company. Click a heading to sort."
          : "Open jobs, your best fit, your furthest application and the sponsor score. Click a heading to sort.") },
      { id: "open", target: '[data-tour="companies-table"] tbody tr', title: "Open a company",
        body: "Click a row for its jobs, mail, research and timeline." },
    ],
  },
  recruiters: {
    id: "recruiters", name: "Recruiters",
    intro: { title: "Recruiters who hire in your field", body: "Agencies that place people in your roles, and how to reach them. Want a quick look around?" },
    steps: [
      { id: "head", target: "#main .screen-head", title: "Agencies in your field",
        body: "Recruitment agencies that hire for your roles, with only the contact details they publish themselves." },
      { id: "find", target: t("recruiters-find"), title: "Find recruiters",
        body: "Claude looks up agencies for your roles and cities on their own sites, and adds them here." },
      { id: "card", target: `${t("recruiters-grid")} .agency-card`, title: "One agency", optional: "only once there are agencies",
        body: "Its tags, what it's hiring for now, and buttons to email it, copy its number or open its pages." },
      { id: "email", target: `${t("recruiters-grid")} .agency-card__contact`, title: "Email them", optional: "only once there are agencies",
        body: (f) => (f === "primary"
          ? "Pick a job or a general enquiry, attach your tailored resume, and keep the sponsorship question if you need it. Nothing sends until you approve it."
          : "Pick a job or a general enquiry and attach your tailored resume. Nothing sends until you approve it.") },
      { id: "track", target: `${t("recruiters-grid")} .agency-card__track`, title: "Keep track", optional: "only once there are agencies",
        body: "Set the status, when you contacted them and when to follow up, and keep notes. A reply in your mail sets Replied for you." },
      { id: "bulk", target: `${t("recruiters-grid")} .agency-card__select`, title: "Several at once", optional: "only once there are agencies",
        body: "Tick agencies to email them (up to 20 at a time) or mark them contacted together." },
    ],
  },
  company: {
    id: "company", name: "Company",
    intro: { title: "One company, everything you know", body: "Jobs, mail, research and history with this company, on one page." },
    steps: [
      { id: "head", target: t("company-head"), title: "The company",
        body: "Its name, website and where its jobs are. Ask Claude to research it from here." },
      { id: "jobs", target: t("company-jobs"), title: "Your jobs here",
        body: "Every job you've saved with this company. Click one to open it." },
      { id: "sponsor", target: tab("Company sections", "sponsorship"), title: "Sponsorship", only: ["primary", "secondary"],
        body: "The sponsor score, why, and the evidence on file. Check again asks Claude for fresh evidence.", tryIt: { action: "click" } },
    ],
  },
  approvals: {
    id: "approvals", name: "Approvals",
    intro: { title: "Nothing happens without your OK", body: "Anything that acts for you waits here first." },
    steps: [
      { id: "head", target: "#main .screen-head", title: "Your safety net",
        body: "Sending, applying and status changes Claude suggests all wait here until you say yes." },
      { id: "pending", target: "#main .card--highlight", title: "Read, then decide", optional: "only when something is waiting",
        body: "Each card says exactly what will happen. Approve it, or decline with a note." },
      { id: "history", target: '#main [aria-label="History"]', title: "What you decided", optional: "only after a decision",
        body: "Every decision you've made, so you can check what went out and when." },
    ],
  },
  privacy: {
    id: "privacy", name: "Privacy",
    intro: { title: "You decide what Claude sees", body: "Some folders stay locked. Here's how that works." },
    steps: [
      { id: "head", target: "#main .screen-head", title: "Locked by default",
        body: "Your ID documents and employment papers are hidden from Claude unless you open them." },
      { id: "folders", target: t("privacy-folders"), title: "Your locked folders",
        body: "Open one for a short time when Claude needs it. It locks itself again afterwards." },
      { id: "activity", target: t("privacy-activity"), title: "Who looked, and when", optional: "only once something has been locked, opened or asked for",
        body: "Every time a locked folder was opened, and why." },
    ],
  },
};

/** Which tour belongs to the screen on show, if any. */
export function tourForRoute(r: Route): TourId | null {
  switch (r.screen) {
    case "home": case "jobs": case "job": case "apply": case "resume": case "learn": case "inbox": case "settings":
    case "applications": case "searches": case "companies": case "company": case "approvals": case "privacy": case "videos": case "mail": case "resumes":
    case "recruiters": return r.screen;
    // A general version opens in the same resume editor, so it shares that tour (steps it doesn't have are skipped).
    case "resume-variant": return "resume";
    default: return null;
  }
}

export function stepBody(s: TourStep, focus: SponsorshipFocus): string {
  return typeof s.body === "function" ? s.body(focus) : s.body;
}

/** The steps for this person, in order. Visibility on screen is checked separately. */
export function stepsFor(def: TourDef, focus: SponsorshipFocus): TourStep[] {
  return def.steps.filter((s) => !s.only || s.only.includes(focus));
}
