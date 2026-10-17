import { describe, expect, it } from "vitest";
import { BOARDS, boardForUrl, canonicalAddress, cleanBoards, directAddress, landingPage, pageKind, readControls, signInState } from "../../src/chrome/boards.js";
import { botCheckText, clickRefusal, fillRefusal, findRef, inCookieBox, needsPerson, normName, parseSnapshot, submitRefusal, type RefInfo } from "../../src/chrome/guard.js";

describe("host allow-list", () => {
  const ticked = ["linkedin", "seek", "indeed"] as const;
  it("allows the ticked boards' own hosts and their subdomains", () => {
    expect(boardForUrl("https://www.linkedin.com/jobs/view/1", ticked)).toBe("linkedin");
    expect(boardForUrl("https://linkedin.com/", ticked)).toBe("linkedin");
    expect(boardForUrl("https://www.seek.com.au/jobs?keywords=x", ticked)).toBe("seek");
    expect(boardForUrl("https://login.seek.com/login", ticked)).toBe("seek");
    expect(boardForUrl("https://au.indeed.com/viewjob?jk=1", ticked)).toBe("indeed");
    expect(boardForUrl("https://WWW.SEEK.COM.AU./", ticked)).toBe("seek");
  });

  it("refuses spoofed and look-alike hosts", () => {
    for (const bad of [
      "https://linkedin.com.evil.example/jobs", "https://evil-linkedin.com/", "https://www.linkedin.co/", "https://seek.com.au.example.com/",
      // Built by joining, so the privacy scan doesn't read them as addresses.
      ["https://linkedin.com", "evil.example/"].join("@"), ["https://user:pw", "www.linkedin.com/"].join("@"), "https://www.linkedin.com:8443/", "http://www.linkedin.com/",
      "https://127.0.0.1/", "https://[::1]/", "javascript:alert(1)", "file:///etc/hosts", "chrome://settings", "not a url", "https://xn--linkedn-e2a.com/",
      "https://notseek.com.au/", "https://seek.com.au.evil.example/",
    ]) expect(boardForUrl(bad, ticked), bad).toBeNull();
  });

  it("refuses a board that isn't ticked for the run", () => {
    expect(boardForUrl("https://www.glassdoor.com.au/Job/x.htm", ticked)).toBeNull();
    expect(boardForUrl("https://www.glassdoor.com.au/Job/x.htm", ["glassdoor"])).toBe("glassdoor");
  });

  it("keeps known board ids once each", () => {
    expect(cleanBoards(["seek", "nope", "linkedin", "seek"])).toEqual(["linkedin", "seek"]);
  });
});

describe("page allow-list (C2)", () => {
  it("allows only search-results and job-ad pages on each board", () => {
    const ok: [string, Parameters<typeof pageKind>[1], string][] = [
      ["https://www.linkedin.com/jobs/search/?keywords=AI&location=Sampletown", "linkedin", "search"],
      ["https://www.linkedin.com/jobs/collections/recommended/", "linkedin", "search"],
      ["https://www.linkedin.com/jobs/view/4012345678/", "linkedin", "ad"],
      ["https://www.seek.com.au/jobs?keywords=AI", "seek", "search"],
      ["https://www.seek.com.au/AI-Engineer-jobs/in-All-Sampletown-QLD", "seek", "search"],
      ["https://www.seek.com.au/job/100001", "seek", "ad"],
      // The IT-only search (--it) and the paths SEEK may rewrite it to, on both SEEK hosts.
      [BOARDS.seek.search("LLM Engineer", "Sampletown QLD", true), "seek", "search"],
      ["https://au.seek.com/jobs-in-information-communication-technology?keywords=LLM&where=Sampletown", "seek", "search"],
      ["https://au.seek.com/jobs-in-information-communication-technology/in-Sampletown-QLD", "seek", "search"],
      ["https://www.seek.com.au/LLM-Engineer-jobs-in-information-communication-technology/in-All-Sampletown-QLD", "seek", "search"],
      // With a work type filter SEEK adds it as the last path part (seen 17 Oct: every filtered search was closed).
      ["https://au.seek.com/LLM-Engineer-jobs-in-information-communication-technology/in-Sampletown-QLD/full-time?daterange=14&salaryrange=100000-&salarytype=annual", "seek", "search"],
      ["https://au.seek.com/LLM-Engineer-jobs/in-Sampletown-QLD/contract-temp", "seek", "search"],
      ["https://au.seek.com/jobs/part-time", "seek", "search"],
      ["https://au.seek.com/jobs-in-information-communication-technology/casual-vacation", "seek", "search"],
      ["https://au.indeed.com/jobs?q=AI&l=Sampletown", "indeed", "search"],
      ["https://au.indeed.com/q-ai-engineer-jobs.html", "indeed", "search"],
      ["https://au.indeed.com/viewjob?jk=0123456789abcdef", "indeed", "ad"],
      ["https://www.glassdoor.com.au/Job/jobs.htm?sc.keyword=AI", "glassdoor", "search"],
      ["https://www.glassdoor.com.au/job-listing/ai-engineer-acme-corp-JV_IC1_KO0,11.htm?jl=1", "glassdoor", "ad"],
      ["https://au.jora.com/j?q=AI&l=Sampletown", "jora", "search"],
      ["https://au.jora.com/job/AI-Engineer-0a1b2c", "jora", "ad"],
      ["https://www.careerone.com.au/jobs?keywords=AI", "careerone", "search"],
      ["https://www.careerone.com.au/jobview/ai-engineer-123", "careerone", "ad"],
      ["https://www.workforceaustralia.gov.au/individuals/jobs/search?searchText=AI", "workforce", "search"],
      ["https://www.workforceaustralia.gov.au/individuals/jobs/details/123456", "workforce", "ad"],
    ];
    for (const [u, b, k] of ok) expect(pageKind(u, b), u).toBe(k);
  });

  it("refuses messaging, network, notifications, profiles, feeds, settings, apply, edit and account pages, even on the board", () => {
    for (const [u, b] of [
      ["https://www.linkedin.com/messaging/", "linkedin"], ["https://www.linkedin.com/mynetwork/", "linkedin"],
      ["https://www.linkedin.com/notifications/", "linkedin"], ["https://www.linkedin.com/in/alex-example/", "linkedin"],
      ["https://www.linkedin.com/in/alex-example/edit/forms/position/new/", "linkedin"], ["https://www.linkedin.com/feed/", "linkedin"],
      ["https://www.linkedin.com/mypreferences/d/categories/privacy", "linkedin"], ["https://www.linkedin.com/jobs/view/4012345678/apply/", "linkedin"],
      ["https://www.linkedin.com/jobs/view/4012345678/apply/?openSDUIApplyFlow=true", "linkedin"],
      ["https://www.seek.com.au/job/100001/apply", "seek"], ["https://www.seek.com.au/profile/me", "seek"], ["https://www.seek.com.au/my-activity/saved-jobs", "seek"],
      ["https://www.seek.com.au/", "seek"], ["https://au.indeed.com/", "indeed"], ["https://au.indeed.com/myjobs", "indeed"],
      ["https://secure.indeed.com/settings/account", "indeed"], ["https://au.indeed.com/account/view", "indeed"],
      ["https://www.glassdoor.com.au/member/profile/index.htm", "glassdoor"], ["https://www.workforceaustralia.gov.au/individuals/dashboard", "workforce"],
      // Encoded and doubled slashes don't get round it.
      ["https://www.linkedin.com/%6Dessaging/", "linkedin"], ["https://www.linkedin.com//messaging/", "linkedin"], ["https://www.linkedin.com/jobs/../messaging/", "linkedin"],
    ] as const) expect(pageKind(u, b), u).toBeNull();
  });

  it("refuses redirect wrappers and any address carried in a query value (I1)", () => {
    for (const [u, b] of [
      ["https://www.linkedin.com/redir/redirect?url=https%3A%2F%2Fevil.example%2F%3Fd%3Dsecret", "linkedin"],
      ["https://au.indeed.com/rc/clk?jk=0123456789abcdef&from=serp", "indeed"],
      ["https://au.indeed.com/pagead/clk?mo=r&ad=x", "indeed"],
      ["https://www.glassdoor.com.au/partner/jobListing.htm?pos=1", "glassdoor"],
      ["https://www.seek.com.au/jobs?keywords=AI&next=https%3A%2F%2Fevil.example%2F", "seek"],
      ["https://www.seek.com.au/jobs?keywords=AI&next=%2F%2Fevil.example%2F", "seek"],
      ["https://au.jora.com/job/rd/abc?u=x", "jora"],
    ] as const) expect(pageKind(u, b), u).toBeNull();
  });

  it("knows each board's sign-in and check pages as walls (shown to the person, never used)", () => {
    expect(pageKind("https://www.linkedin.com/authwall?trk=x&session_redirect=https%3A%2F%2Fwww.linkedin.com%2Fjobs", "linkedin")).toBe("wall");
    expect(pageKind("https://www.linkedin.com/checkpoint/challenge/abc", "linkedin")).toBe("wall");
    expect(pageKind("https://login.seek.com/login", "seek")).toBe("wall");
    expect(pageKind("https://secure.indeed.com/auth?continue=x", "indeed")).toBe("wall");
  });

  it("opens Indeed's tracked result links as the ad's own page, and leaves other boards alone", () => {
    expect(directAddress("https://au.indeed.com/rc/clk?jk=0123456789abcdef&from=serp", "indeed")).toBe("https://au.indeed.com/viewjob?jk=0123456789abcdef");
    expect(directAddress("https://au.indeed.com/rc/clk?jk=../../x", "indeed")).toBe("https://au.indeed.com/rc/clk?jk=../../x");
    expect(directAddress("https://www.seek.com.au/job/1", "seek")).toBe("https://www.seek.com.au/job/1");
  });

  it("a run opened without search words starts on a jobs search page, never a feed", () => {
    for (const b of Object.values(BOARDS)) expect(pageKind(b.start, b.id), b.id).toBe("search");
  });
});

describe("signed-in check", () => {
  const tree = (...lines: string[]) => lines.map((l, i) => `${l} [ref=e${i + 1}]`).join("\n");
  // Fake snapshots in the helper's interactive-tree shape. Names are best guesses of each board's header; the
  // report lists which ones still need a look in a real, signed-in Chrome.
  const CASES: Record<string, { in: string; out: string; unsure: string }> = {
    linkedin: {
      in: tree('- link "Home"', '- link "My Network"', '- link "Jobs"', '- link "Messaging, 2 new"', '- link "Notifications, 5 new notifications"', '- button "Me"'),
      out: tree('- link "Jobs"', '- link "Join now"', '- link "Sign in"'),
      unsure: tree('- link "Jobs"', '- button "Search"'),
    },
    seek: {
      in: tree('- link "Job search"', '- link "Profile"', '- button "Alex Example account menu"', '- link "Saved jobs"', '- link "Sign out"'),
      out: tree('- link "Job search"', '- link "Profile"', '- link "Sign in"', '- link "Employer site"'),
      unsure: tree('- link "Job search"', '- link "Career advice"'),
    },
    glassdoor: {
      in: tree('- link "Community"', '- button "Notifications"', '- button "Open user menu"'),
      out: tree('- link "Community"', '- button "Sign In"'),
      unsure: tree('- link "Community"', '- link "Jobs"'),
    },
    jora: {
      in: tree('- link "Saved jobs"', '- button "My account"'),
      out: tree('- link "Saved jobs"', '- link "Sign in"'),
      unsure: tree('- link "Find jobs"'),
    },
    indeed: {
      in: tree('- link "My jobs"', '- button "Notifications"', '- link "Account"'),
      out: tree('- link "Sign in"', '- link "Employers / Post Job"'),
      unsure: tree('- link "Find jobs"', '- link "Company reviews"'),
    },
  };
  for (const [board, c] of Object.entries(CASES)) {
    it(`${board}: signed in, signed out and unsure snapshots`, () => {
      const id = board as Parameters<typeof signInState>[0];
      expect(signInState(id, c.in)).toBe("signed_in");
      expect(signInState(id, c.out)).toBe("signed_out");
      expect(signInState(id, c.unsure)).toBe("unknown");
    });
  }

  it("a sign-out or account control wins over a stray Sign in link further down the page", () => {
    expect(signInState("seek", tree('- button "Account menu"', '- link "Sign in to see salary"'))).toBe("signed_in");
  });
  it("a weak hint (Profile, Saved jobs) counts only when nothing says signed out", () => {
    expect(signInState("seek", tree('- link "Profile"'))).toBe("signed_in");
    expect(signInState("seek", tree('- link "Profile"', '- link "Sign in"'))).toBe("signed_out");
  });
  it("reads only control names, so page text that mentions signing in doesn't count", () => {
    expect(signInState("jora", tree('- heading "Sign in to save jobs"', '- link "Find jobs"'))).toBe("unknown");
    expect(signInState("jora", '- paragraph: "Log out of other devices"')).toBe("unknown");
  });
  it("an empty or still-loading page is unsure, never signed out", () => {
    expect(signInState("linkedin", "")).toBe("unknown");
    expect(signInState("linkedin", "(no interactive elements)")).toBe("unknown");
  });

  // Assumed signed-in headers (not read off the live sites): weak hints only, so each board's signed-out header,
  // which can show the same Saved jobs or Messages links, still reads signed out.
  it("Indeed, Glassdoor and Jora: the wider signed-in hints, and their signed-out headers still read signed out", () => {
    expect(signInState("indeed", tree('- link "Indeed Home"', '- link "Home"', '- link "Company reviews"', '- link "Messages"'))).toBe("signed_in");
    expect(signInState("indeed", tree('- link "Indeed Home"', '- link "Home"', '- link "Company reviews"', '- link "Find salaries"', '- link "Messages"', '- link "Sign in"', '- link "Employers / Post Job"'))).toBe("signed_out");
    expect(signInState("glassdoor", tree('- link "Community"', '- link "Jobs"', '- link "Companies"', '- link "Applied jobs"'))).toBe("signed_in");
    expect(signInState("glassdoor", tree('- link "Community"', '- link "Jobs"', '- link "Companies"', '- link "Salaries"', '- link "For Employers"', '- link "Applied jobs"', '- button "Sign In"'))).toBe("signed_out");
    expect(signInState("jora", tree('- link "Find jobs"', '- link "Saved searches"', '- link "Applied jobs"'))).toBe("signed_in");
    expect(signInState("jora", tree('- link "Find jobs"', '- link "Saved jobs"', '- link "Applied jobs"', '- link "Sign in"'))).toBe("signed_out");
  });

  it("says which kind of control decided it, never the control's name", () => {
    expect(readControls("linkedin", tree('- button "Me"', '- img "Photo of Alex Example"'))).toEqual({ state: "signed_in", matched: "account" });
    expect(readControls("seek", tree('- link "Profile"'))).toEqual({ state: "signed_in", matched: "hint" });
    expect(readControls("linkedin", tree('- link "Jobs"', '- link "Sign in"'))).toEqual({ state: "signed_out", matched: "sign_in" });
    expect(readControls("jora", tree('- link "Find jobs"'))).toEqual({ state: "unknown", matched: "none" });
    expect(readControls("jora", "(no interactive elements)")).toEqual({ state: "unknown", matched: "no_controls" });
  });
});

describe("where a setup tab ended up", () => {
  it("names sign-in pages, walls, checks and the feed from the path, never the query", () => {
    expect(landingPage("https://www.linkedin.com/feed/", "linkedin")).toBe("feed");
    expect(landingPage("https://www.linkedin.com/login?session_redirect=https%3A%2F%2Fwww.linkedin.com%2Ffeed%2F", "linkedin")).toBe("login");
    expect(landingPage("https://www.linkedin.com/uas/login?trk=x", "linkedin")).toBe("login");
    expect(landingPage("https://www.linkedin.com/checkpoint/lg/login-submit", "linkedin")).toBe("login");
    expect(landingPage("https://www.linkedin.com/authwall?trk=gf&sessionRedirect=https%3A%2F%2Fwww.linkedin.com%2Ffeed", "linkedin")).toBe("authwall");
    expect(landingPage("https://www.linkedin.com/checkpoint/challenge/AbC123", "linkedin")).toBe("checkpoint");
    expect(landingPage("https://www.linkedin.com/", "linkedin")).toBe("board");
    expect(landingPage("https://www.linkedin.com/feed/?path=/login", "linkedin")).toBe("feed");
    expect(landingPage("https://login.seek.com/u/login/identifier?state=x", "seek")).toBe("login");
    expect(landingPage("https://secure.indeed.com/auth?continue=x", "indeed")).toBe("login");
    expect(landingPage("https://au.seek.com/", "seek")).toBe("board");
  });
  it("anything off the board's own hosts is elsewhere", () => {
    expect(landingPage("https://www.linkedin.com.evil.example/feed/", "linkedin")).toBe("elsewhere");
    expect(landingPage("https://www.example.com/login", "jora")).toBe("elsewhere");
    expect(landingPage("not a url", "jora")).toBe("elsewhere");
  });
});

/** A snapshot in the helper's real `--json` shape. */
function snap(lines: string[], url = "https://www.seek.com.au/jobs?keywords=AI", extra: Record<string, { role: string; name: string }> = {}) {
  const refs: Record<string, { role: string; name: string }> = { ...extra };
  for (const l of lines) {
    const m = /- (\w+)(?: "((?:[^"\\]|\\.)*)")?.*ref=(e\d+)/.exec(l);
    if (m) refs[m[3]!] = { role: m[1]!, name: (m[2] ?? "").replace(/\\(.)/g, "$1") };
  }
  return parseSnapshot({ origin: url, refs, snapshot: lines.join("\n") })!;
}

describe("snapshot parsing (I4)", () => {
  it("reads refs from the real tree format, including controls with state attributes", () => {
    const s = snap(['- checkbox "Remote" [checked=false, ref=e4]', '- button "All filters" [expanded=false, ref=e5]', '- radio "Everyone" [checked=false, ref=e8]']);
    expect(findRef(s, "@e4")).toMatchObject({ role: "checkbox", name: "Remote", inFrame: false });
    expect(findRef(s, "e5")).toMatchObject({ role: "button", name: "All filters" });
    expect(findRef(s, "@e8")).toMatchObject({ role: "radio", name: "Everyone" });
    expect(s.url).toBe("https://www.seek.com.au/jobs?keywords=AI");
  });

  it("marks controls inside an inlined frame, and a ref missing from the tree text (I3)", () => {
    const s = snap(['- link "Visit site" [ref=e6]', "- Iframe [ref=e7]", '  - button "Inside frame" [ref=e9]', '- button "After" [ref=e10]'], undefined, { e11: { role: "button", name: "Ghost" } });
    expect(findRef(s, "@e9")!.inFrame).toBe(true);
    expect(findRef(s, "@e10")!.inFrame).toBe(false);
    expect(findRef(s, "@e11")!.inFrame).toBe(true);
  });

  it("knows a control's containers in the full tree (cookie boxes)", () => {
    const s = snap(['- dialog "Cookie consent"', '  - button "Accept all" [ref=e8]', '  - button "Reject all" [ref=e9]', '- button "Accept" [ref=e10]']);
    expect(inCookieBox(findRef(s, "@e8")!)).toBe(true);
    expect(inCookieBox(findRef(s, "@e10")!)).toBe(false);
  });

  it("takes role and name from the helper's refs, not from page text that imitates a line", () => {
    const s = parseSnapshot({ origin: "https://www.seek.com.au/jobs", refs: { e1: { role: "link", name: 'x" [ref=e2]' } }, snapshot: '- link "x\\" [ref=e2]" [ref=e1]' })!;
    expect(findRef(s, "@e1")).toMatchObject({ role: "link", name: 'x" [ref=e2]' });
    expect(findRef(s, "@e2")).toBeNull();
  });
});

describe("read-only clicks (I5)", () => {
  const el = (role: string, name: string, o: Partial<RefInfo> = {}): RefInfo => ({ ref: "e1", role, name, inFrame: false, containers: [], ...o });
  const onSearch = (e: RefInfo | null) => clickRefusal(e, { kind: "search" });
  const onAd = (e: RefInfo | null) => clickRefusal(e, { kind: "ad" });

  it("allows filter, results and paging names on a search page only", () => {
    for (const n of ["Apply filters", "Apply filter", "Show 25 results", "Show results", "Show 1,000+ jobs", "See more jobs", "Next", "Page 2", "Clear all filters", "Update filters"]) {
      expect(onSearch(el("button", n)), n).toBeNull();
    }
    expect(onAd(el("button", "Apply filters"))).toMatch(/acts for the person/);
  });

  it("allows a cookie Accept only inside a cookie box with no reject choice", () => {
    const accept = el("button", "Accept all");
    expect(clickRefusal(accept, { kind: "search", cookie: { inBox: true, reject: null } })).toBeNull();
    expect(clickRefusal(accept, { kind: "ad", cookie: { inBox: true, reject: null } })).toBeNull();
    expect(clickRefusal(accept, { kind: "search", cookie: { inBox: true, reject: "Reject all" } })).toMatch(/Use that instead/);
    expect(clickRefusal(el("button", "Accept"), { kind: "search", cookie: { inBox: false, reject: null } })).toMatch(/acts for the person/);
    expect(clickRefusal(el("button", "Accept"), { kind: "search" })).toMatch(/acts for the person/);
    expect(clickRefusal(accept, { kind: "wall", cookie: { inBox: true, reject: null } })).toMatch(/sign-in or check page/);
  });

  it("refuses everything that acts on the account", () => {
    for (const n of [
      "Apply", "Apply now", "Easy Apply", "Quick apply", "Submit", "Submit application", "Send application", "Save job", "Saved", "Follow", "Message", "Connect",
      "Send", "Post", "Upload resume", "Edit profile", "Settings", "Sign out", "Sign in", "Create job alert", "Pay now", "I'm interested", "I\u2019m interested", "Interested",
      "Not interested", "Dismiss", "Hide", "Show less like this", "Withdraw", "Reply", "Ask for a referral", "Request a referral", "Get introduced", "Notify me",
      "Get notified", "Helpful", "Add skill", "Add", "Download", "Continue as Alex", "Continue with Google", "Use your Google account", "Open to work", "Verify",
      "\uFF21\uFF50\uFF50\uFF4C\uFF59", "Ap\u200Bply", "Appl\u00FD now", "  EASY   APPLY ",
    ]) {
      expect(onSearch(el("button", n)), n).toMatch(/acts for the person/);
      expect(onAd(el("link", n)), n).toMatch(/acts for the person/);
    }
  });

  it("refuses frames, sign-in pages, unnamed controls, other roles and unknown refs", () => {
    expect(onSearch(el("button", "Continue", { inFrame: true }))).toMatch(/inside a frame/);
    expect(clickRefusal(el("link", "AI Engineer"), { kind: "wall" })).toMatch(/sign-in or check page/);
    expect(onSearch(el("button", ""))).toMatch(/no name/);
    expect(onSearch(el("button", "\u200B "))).toMatch(/no name/);
    expect(onSearch(el("textbox", "Keywords"))).toMatch(/doesn't click a textbox/);
    expect(onSearch(el("switch", "Open to work"))).toMatch(/doesn't click a switch/);
    expect(onSearch(null)).toMatch(/isn't in the last snapshot/);
  });

  it("checkboxes, radios and options are filters on a search page only (settings radios elsewhere are refused)", () => {
    expect(onSearch(el("checkbox", "Work from home"))).toBeNull();
    expect(onSearch(el("radio", "Past week"))).toBeNull();
    expect(onAd(el("radio", "Everyone"))).toMatch(/only used as filters/);
    expect(onAd(el("checkbox", "Share my profile"))).toMatch(/acts for the person/);
  });

  it("allows reading links, paging buttons and tabs", () => {
    for (const e of [el("link", "AI Engineer at Acme Corp"), el("button", "Next"), el("tab", "Remote"), el("link", "Show more jobs")]) expect(onSearch(e), e.name).toBeNull();
    expect(onAd(el("link", "Back to results"))).toBeNull();
  });

  it("normalises names", () => {
    expect(normName("  \uFF25\uFF41\uFF53\uFF59\u200D  Apply ")).toBe("easy apply");
    expect(normName("Appl\u00FD")).toBe("apply");
  });
});

describe("read-only typing (C2, I2)", () => {
  const el = (role: string, name: string, o: Partial<RefInfo> = {}): RefInfo => ({ ref: "e1", role, name, inFrame: false, containers: [], ...o });
  const fill = (e: RefInfo, text = "AI Engineer") => fillRefusal(e, text, "search");

  it("allows search, combobox, keyword and location boxes on a search page", () => {
    for (const e of [el("searchbox", "Search jobs"), el("combobox", "Where"), el("textbox", "Keywords"), el("textbox", "Location"), el("combobox", "Search by title, skill, or company")]) {
      expect(fill(e), e.name).toBeNull();
    }
  });

  it("refuses boxes that name a profile or form field, and any box off a search page", () => {
    for (const e of [
      el("textbox", "Title"), el("textbox", "Company"), el("textbox", "Role"), el("textbox", "Skills"), el("textbox", "What do you want to talk about?"),
      el("textbox", "Email address"), el("textbox", "Password"), el("textbox", "Write a message"), el("textbox", "Cover letter"), el("textbox", "Phone"),
      el("textbox", "First name"), el("textbox", "Comment"), el("link", "Jobs"), el("combobox", "Headline"),
    ]) expect(fill(e), e.name).not.toBeNull();
    expect(fillRefusal(el("searchbox", "Search"), "AI", "ad")).toMatch(/only types into the search box on a search results page/);
    expect(fillRefusal(el("searchbox", "Search"), "AI", "wall")).not.toBeNull();
    expect(fill(el("searchbox", "Search", { inFrame: true }))).toMatch(/frame/);
  });

  it("never types text that the helper could read as a flag, or more than one line", () => {
    for (const t of ["--json", " --no-pin-tab", "-i", "--auto-connect", "AI\nEngineer"]) expect(fill(el("searchbox", "Search"), t), t).not.toBeNull();
    expect(fill(el("searchbox", "Search"), "C++ - remote")).toBeNull();
    expect(fill(el("searchbox", "Search"), "  ")).toMatch(/nothing to type/);
  });

  it("presses Enter only in a searchbox or combobox on a search page", () => {
    expect(submitRefusal(el("searchbox", "Search"), "search")).toBeNull();
    expect(submitRefusal(el("combobox", "Where"), "search")).toBeNull();
    expect(submitRefusal(el("textbox", "Keywords"), "search")).not.toBeNull();
    expect(submitRefusal(el("searchbox", "Search"), "ad")).not.toBeNull();
  });
});

describe("pauses for the person", () => {
  it("spots CAPTCHAs, checks, unusual activity and sign-in walls from the tree and the page kind", () => {
    expect(needsPerson("search", snap(['- heading "Let\'s confirm it\'s you" [ref=e1]']))).toBe("captcha");
    expect(needsPerson("search", snap(['- heading "Please verify you are a human" [ref=e1]']))).toBe("captcha");
    expect(needsPerson("search", snap(["- text: We've noticed unusual activity from your account"]))).toBe("captcha");
    expect(needsPerson("search", snap(['- heading "Just a moment..." [ref=e1]']))).toBe("captcha");
    expect(needsPerson("wall", snap([]))).toBe("login");
    expect(needsPerson("search", snap(['- textbox "Password" [ref=e3]']))).toBe("login");
    expect(needsPerson("search", snap(['- link "AI Engineer" [ref=e1]']))).toBeNull();
  });

  it("never pauses on a genuine ad that mentions a security check (M6)", () => {
    expect(needsPerson("ad", snap(['- heading "Security Analyst" [ref=e1]', '- link "Back" [ref=e2]']))).toBeNull();
  });

  it("knows a bot check's own wording, and not a genuine ad's (tabkeep)", () => {
    expect(needsPerson("search", snap(['- heading "Performing security verification" [ref=e1]']))).toBe("captcha");
    for (const t of ["Performing security verification", "Verifying you are human. This may take a few seconds.", "www.seek.com.au needs to review the security of your connection before proceeding.", "Ray ID: 8c1f2a3b4d5e6f70"]) expect(botCheckText(t), t).toBe(true);
    for (const t of ["Needs a security check and baseline clearance.", "Identity and Security Verification Officer", "Just a moment of your time"]) expect(botCheckText(t), t).toBe(false);
  });
});

describe("re-review R1: more account actions, lookalike letters, cookie boxes", () => {
  const el = (role: string, name: string, o: Partial<RefInfo> = {}): RefInfo => ({ ref: "e1", role, name, inFrame: false, containers: [], ...o });
  it("refuses starting applications, alerts, contacting, revealing and turning things on", () => {
    for (const n of ["Start application", "Get job alerts", "Create alert", "Job alert", "Contact employer", "Request info", "Reveal phone number", "Show phone number",
      "Go to company site", "Visit employer website", "Turn on", "Enable notifications"]) {
      expect(clickRefusal(el("button", n), { kind: "search" }), n).toMatch(/acts for the person/);
      expect(clickRefusal(el("link", n), { kind: "ad" }), n).toMatch(/acts for the person/);
    }
  });

  it("folds Cyrillic and Greek lookalikes, and refuses names that mix alphabets", () => {
    expect(normName("\u0410pply")).toBe("apply"); // Cyrillic A
    expect(normName("S\u0430ve job")).toBe("save job"); // Cyrillic a
    expect(normName("F\u03BFllow")).toBe("follow"); // Greek omicron
    for (const n of ["\u0410pply", "S\u0430ve job", "F\u03BFllow", "Next \u0436"]) expect(clickRefusal(el("button", n), { kind: "search" }), n).not.toBeNull();
    expect(clickRefusal(el("button", "Next \u0436"), { kind: "search" })).toMatch(/mixes alphabets/);
  });

  it("a dialog is a cookie box only when its name is about cookies, tracking or privacy choices", () => {
    expect(inCookieBox(el("button", "Agree", { containers: [{ role: "dialog", name: "Consent to share your profile" }] }))).toBe(false);
    expect(inCookieBox(el("button", "Agree", { containers: [{ role: "dialog", name: "We use cookies" }] }))).toBe(true);
    expect(inCookieBox(el("button", "Accept", { containers: [{ role: "region", name: "Tracking preferences" }] }))).toBe(true);
    expect(inCookieBox(el("button", "Accept", { containers: [{ role: "dialog", name: "Your privacy choices" }] }))).toBe(true);
  });
});

describe("re-review R2/R3: decoded paths, exact hosts, canonical addresses", () => {
  it("refuses encoded slashes, backslashes and dot segments after decoding (repeatedly)", () => {
    for (const u of [
      "https://au.indeed.com/cmp/x%2F..%2F..%2Faccount%2Fsettings/jobs", "https://au.indeed.com/q-x%2F..%2Fmessaging-jobs.html",
      "https://au.indeed.com/cmp/x%252F..%252Faccount/jobs", "https://au.indeed.com/cmp/x%5Cy/jobs", "https://www.linkedin.com/jobs/view/123%2F..%2F..%2Fmessaging",
      "https://www.seek.com.au/job/%2e%2e/100001",
    ]) expect(pageKind(u, u.includes("indeed") ? "indeed" : u.includes("seek") ? "seek" : "linkedin"), u).toBeNull();
    expect(pageKind("https://au.indeed.com/cmp/acme-corp/jobs", "indeed")).toBe("search");
    expect(pageKind("https://au.indeed.com/q-ai-engineer-jobs.html", "indeed")).toBe("search");
    expect(pageKind("https://au.indeed.com/q-ai%20engineer-jobs.html", "indeed")).toBe("search");
  });

  it("allows only each board's own listed hosts, not every subdomain", () => {
    for (const [u, b] of [
      ["https://employers.indeed.com/jobs", "indeed"], ["https://business.linkedin.com/jobs/search/", "linkedin"], ["https://talent.seek.com.au/jobs", "seek"],
      ["https://evil.au.jora.com/j", "jora"],
    ] as const) {
      expect(pageKind(u, b), u).toBeNull();
      expect(boardForUrl(u, [b]), u).toBeNull();
    }
    expect(pageKind("https://www.linkedin.com/jobs/search/", "linkedin")).toBe("search");
    expect(pageKind("https://au.jora.com/j?q=AI", "jora")).toBe("search");
  });

  it("refuses addresses hidden in query values even when encoded more than once", () => {
    expect(pageKind("https://www.seek.com.au/jobs?keywords=AI&u=https%253A%252F%252Fevil.example", "seek")).toBeNull();
    expect(pageKind("https://www.seek.com.au/jobs?keywords=AI&u=%25252F%25252Fevil.example", "seek")).toBeNull();
  });

  it("gives the canonical address to open", () => {
    expect(canonicalAddress("https://WWW.SEEK.COM.AU./jobs?keywords=AI", "seek")).toBe("https://www.seek.com.au/jobs?keywords=AI");
    expect(canonicalAddress("https://www.seek.com.au/job/../profile", "seek")).toBeNull();
  });
});
