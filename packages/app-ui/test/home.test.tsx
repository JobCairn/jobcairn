import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { homeAnalytics, type RankedJob } from "@careeros/contract";
import { NextUpCard } from "../src/home/cards";
import { ageText, coachText, daysAgoText, reasonText, todaySentence } from "../src/home/copy";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { scenarioOptions } from "../src/mock/scenarios";
import { HomeScreen } from "../src/screens/Home";
import { renderApp } from "./render";

const LABS = { slug: "example-labs", id: "2026-01-12-backend-engineer-llm" };
const full = () => new MockBridge(scenarioOptions("?data=full"));
const empty = () => new MockBridge(scenarioOptions("?data=empty"));

describe("Home (sample workspace)", () => {
  it("greets by first name and counts the visa days", async () => {
    renderApp(<HomeScreen />);
    const heading = await screen.findByRole("heading", { name: /, Alex\.$/ });
    expect(heading.querySelector("em")).toHaveTextContent("Alex.");
    expect(screen.getByText("897")).toBeInTheDocument();
    expect(screen.getByText("days left on visa")).toBeInTheDocument();
  });
  it("says so when no visa date is set", async () => {
    const f = loadFixture();
    (f.profile.work_rights as Record<string, unknown>).visa_expiry = "";
    renderApp(<HomeScreen />, { bridge: new MockBridge({ fixture: f }) });
    expect(await screen.findByText("No visa date set")).toBeInTheDocument();
  });
  it("opens with a Today sentence and shortcut chips", async () => {
    renderApp(<HomeScreen />, { bridge: new MockBridge({ mailConnected: false }) });
    const today = await screen.findByRole("region", { name: "Today" });
    expect(today).toHaveTextContent("Nothing urgent. 1 role still needs a score.");
    const chips = within(today).getByRole("list", { name: "Shortcuts" });
    expect(within(chips).getAllByRole("button").map((b) => b.textContent)).toEqual(["1 approval waiting", "1 access request waiting", "2 files in your drop box", "Set a search deadline"]);
    await userEvent.click(within(chips).getByRole("button", { name: "2 files in your drop box" }));
    expect(window.location.hash).toBe("#/inbox");
    await userEvent.click(within(chips).getByRole("button", { name: "Set a search deadline" }));
    expect(window.location.hash).toBe("#/settings?tab=search");
  });
  it("puts unread mail ahead of less urgent shortcuts, so it is never pushed out", async () => {
    renderApp(<HomeScreen />);
    const today = await screen.findByRole("region", { name: "Today" });
    const chips = within(today).getByRole("list", { name: "Shortcuts" });
    expect(within(chips).getAllByRole("button").map((b) => b.textContent)).toEqual(["1 approval waiting", "1 access request waiting", "2 unread emails", "2 files in your drop box"]);
  });
  it("adds an unread-mail shortcut to Mail when the unread mail is on more than one job", async () => {
    renderApp(<HomeScreen />, { bridge: new MockBridge({ inbox: [] }) });
    const today = await screen.findByRole("region", { name: "Today" });
    const chips = within(today).getByRole("list", { name: "Shortcuts" });
    await userEvent.click(within(chips).getByRole("button", { name: "2 unread emails" }));
    expect(window.location.hash).toBe("#/mail");
  });
  it("deep-links the unread-mail shortcut to the job's Mail tab when it is all on one job", async () => {
    const bridge = new MockBridge({ inbox: [] });
    await bridge.mail.get("companies/example-labs/jobs/2026-01-12-backend-engineer-llm/emails/2026-01-13-urgent-confirm-your-details-d4e5f6.json");
    renderApp(<HomeScreen />, { bridge });
    const today = await screen.findByRole("region", { name: "Today" });
    const chips = within(today).getByRole("list", { name: "Shortcuts" });
    await userEvent.click(within(chips).getByRole("button", { name: "1 unread email" }));
    expect(window.location.hash).toBe("#/job/acme-corp/2026-01-12-ai-engineer?tab=mail");
  });
  it("shows no unread-mail shortcut when Gmail isn't connected", async () => {
    renderApp(<HomeScreen />, { bridge: new MockBridge({ inbox: [], mailConnected: false }) });
    const today = await screen.findByRole("region", { name: "Today" });
    const chips = within(today).getByRole("list", { name: "Shortcuts" });
    expect(within(chips).queryByRole("button", { name: /unread email/ })).toBeNull();
  });
  it("shows the pipeline with coaching text instead of zeros", async () => {
    renderApp(<HomeScreen />);
    const pipe = await screen.findByRole("region", { name: "Pipeline" });
    const steps = within(pipe).getAllByRole("listitem");
    expect(steps.map((s) => s.getAttribute("aria-label"))).toEqual(["Found: 3", "Shortlisted: 1", "Applying: 1", "Applied: 1", "Interview: 0", "Offer: 0"]);
    expect(steps[4]).toHaveTextContent("No replies yet. 1 application out, latest sent 2 days ago.");
    expect(steps[1]).toHaveTextContent("33%");
    expect(pipe).toHaveTextContent("Weekly trends show after two weeks of history.");
    expect(screen.getByRole("region", { name: "Weekly recap" })).toBeInTheDocument();
  });
  it("ranks next up with a reason, the job's age and one action that starts Claude", async () => {
    const { bridge } = renderApp(<HomeScreen />);
    const list = await screen.findByRole("list", { name: "Next up" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Backend Engineer (LLM)");
    expect(rows[0]).toHaveTextContent("Ad silent on visas · not scored yet · sponsor 20");
    expect(rows[0]).toHaveTextContent("Found 3 days ago");
    await userEvent.click(within(rows[0]!).getByRole("button", { name: "Score Backend Engineer (LLM) at Example Labs" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "claude.run")?.args.slice(0, 2)).toEqual(["score_job", { kind: "job", company_slug: LABS.slug, id: LABS.id }]));
    // The row follows its own run in place.
    expect(await within(rows[0]!).findByRole("button", { name: /Cancel/ })).toBeInTheDocument();
  });
  it("leaves approvals and access requests to the Today chips, with no separate Waiting card", async () => {
    renderApp(<HomeScreen />);
    const today = await screen.findByRole("region", { name: "Today" });
    expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull();
    await userEvent.click(within(today).getByRole("button", { name: "1 approval waiting" }));
    expect(window.location.hash).toBe("#/approvals");
  });
  it("puts Sponsorship mix at the top of the right column", async () => {
    renderApp(<HomeScreen />);
    await screen.findByRole("region", { name: "Sponsorship mix" });
    const cols = document.querySelectorAll(".home-grid > .home-col");
    expect(cols[1]!.firstElementChild).toHaveAttribute("aria-label", "Sponsorship mix");
  });
  it("tells you when preparing a role fails, and stays on Home", async () => {
    const bridge = full();
    bridge.apply.prepare = () => Promise.reject(new Error("The job folder is missing."));
    renderApp(<HomeScreen />, { bridge, hash: "#/" });
    const list = await screen.findByRole("list", { name: "Next up" });
    await userEvent.click(within(list).getAllByRole("button", { name: /^Prepare / })[0]!);
    expect(await screen.findByText(/The job folder is missing\./)).toBeInTheDocument();
    expect(window.location.hash).not.toMatch(/^#\/apply\//);
    expect(bridge.calls.some((c) => c.method === "claude.run")).toBe(false);
  });
  it("puts unscored roles in a Not scored yet strip", async () => {
    const { bridge } = renderApp(<HomeScreen />);
    const map = await screen.findByRole("region", { name: "Opportunity map" });
    expect(map).toHaveTextContent("Roles appear here once they have a fit score and a sponsor score.");
    expect(map).toHaveTextContent("1 role not scored yet");
    await userEvent.click(within(map).getByRole("button", { name: "Score these roles" }));
    await waitFor(() => expect(bridge.calls.filter((c) => c.method === "claude.run" && c.args[0] === "score_job")).toHaveLength(1));
    expect(await within(map).findByText(/^Scoring: 0 of 1 done\.$|^0 of 1 finished\.$/)).toBeInTheDocument();
  });
  it("links each sponsorship segment to the Jobs list filtered to it", async () => {
    renderApp(<HomeScreen />);
    const mix = await screen.findByRole("region", { name: "Sponsorship mix" });
    await userEvent.click(within(mix).getByRole("button", { name: "Sponsorship offered: 1 role. Show them" }));
    expect(window.location.hash).toBe("#/jobs?label=sponsorship_offered");
  });
  it("sorts the shortlisted salary into a 482 band without making a visa claim", async () => {
    renderApp(<HomeScreen />);
    const card = await screen.findByRole("region", { name: "482 salary check" });
    expect(card).toHaveTextContent("1 shortlisted role");
    expect(card).toHaveTextContent("check the Home Affairs website");
    expect(card.textContent).not.toMatch(/eligible|qualif|you can get/i);
  });
  it("refreshes when something changes", async () => {
    const { bridge } = renderApp(<HomeScreen />);
    expect(await screen.findByRole("button", { name: "2 files in your drop box" })).toBeInTheDocument();
    await bridge.inbox.file("acme-corp-cover-letter.pdf", { kind: "me", dir: "resumes" }, "");
    expect(await screen.findByRole("button", { name: "1 file in your drop box" })).toBeInTheDocument();
  });
});

describe("Home (12 weeks of history)", () => {
  it("shows the map with an Apply first quadrant and the data as a table", async () => {
    renderApp(<HomeScreen />, { bridge: full() });
    const map = await screen.findByRole("region", { name: "Opportunity map" });
    expect(within(map).getByText("Apply first")).toBeInTheDocument();
    const table = map.querySelector(".sr-only > table")!;
    expect(table.querySelectorAll("tbody tr").length).toBeGreaterThan(5);
    const dot = within(map).getAllByRole("link").find((l) => l.getAttribute("aria-label")?.includes("fit"))!;
    await userEvent.click(dot);
    expect(window.location.hash).toMatch(/^#\/job\//);
  });
  it("caps next up at 8 rows with See all, and shows trends and the weekly goal", async () => {
    renderApp(<HomeScreen />, { bridge: full() });
    const list = await screen.findByRole("list", { name: "Next up" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(8);
    expect(screen.getByRole("button", { name: "All jobs" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Pipeline" })).toHaveTextContent(/this week, \d+ the week before/);
    const activity = screen.getByRole("region", { name: "Weekly activity" });
    expect(activity).toHaveTextContent("Goal 5 a week");
    expect(activity.querySelectorAll(".sr-only > table tbody tr")).toHaveLength(12);
    // A table can't be clipped by sr-only reliably, so each chart table sits inside an sr-only div.
    expect(document.querySelectorAll("table.sr-only")).toHaveLength(0);
    expect(screen.getByRole("region", { name: "Today" })).toHaveTextContent(/days until your search deadline/);
  });
  it("puts each pipeline stat in its own column and the trend on its own line", async () => {
    renderApp(<HomeScreen />, { bridge: full() });
    const pipe = await screen.findByRole("region", { name: "Pipeline" });
    const row = within(pipe).getAllByRole("listitem")[1]!;
    expect(row.querySelector(".funnel-row__conv")).toHaveTextContent(/^\d+% of found$/);
    expect(row.querySelector(".funnel-row__now")).toHaveTextContent(/^\d+ here now$/);
    expect(pipe.querySelector(".funnel-head")).toHaveTextContent("From previousHere nowUsual stay");
    expect(row.querySelector(".funnel-row__trend")).toHaveTextContent(/this week/);
    expect(row.querySelector(".funnel-row__trend")!.parentElement).toBe(row);
  });
  it("makes the next-up action primary by meaning, not by position", () => {
    const base = { company_name: "Acme Corp", status: "Found" as const, fit: 80, sponsor: 90, salary: "", ageDays: 1, ageFrom: "posted" as const, waitingDays: null };
    const jobs: RankedJob[] = [
      { ...base, company_slug: "acme-corp", id: "a", title: "Data Engineer", wr_label: "silent", fit: null, action: "score" },
      { ...base, company_slug: "acme-corp", id: "b", title: "AI Engineer", wr_label: "sponsorship_offered", action: "prepare" },
      { ...base, company_slug: "acme-corp", id: "c", title: "ML Engineer", wr_label: "sponsorship_offered", action: "prepare" },
    ];
    renderApp(<NextUpCard jobs={jobs} total={3} focus="primary" />);
    const primary = screen.getAllByRole("button").filter((b) => b.className.includes("btn--primary"));
    expect(primary.map((b) => b.getAttribute("aria-label"))).toEqual(["Prepare AI Engineer at Acme Corp"]);
    cleanup();
    renderApp(<NextUpCard jobs={[jobs[0]!]} total={1} focus="primary" />);
    expect(screen.getAllByRole("button").filter((b) => b.className.includes("btn--primary"))).toHaveLength(0);
  });
  it("Practise opens that job's interview prep in Learn", async () => {
    const job: RankedJob = { company_slug: "acme-corp", id: "d", title: "AI Engineer", company_name: "Acme Corp", status: "Interview", wr_label: "silent", fit: 80, sponsor: null, salary: "", ageDays: 1, ageFrom: "posted", waitingDays: null, action: "practise" };
    renderApp(<NextUpCard jobs={[job]} total={1} focus="off" />);
    await userEvent.click(screen.getByRole("button", { name: "Practise AI Engineer at Acme Corp" }));
    expect(window.location.hash).toBe("#/learn?job=acme-corp/d");
  });
  it("shows a Next up row's source", () => {
    const job: RankedJob = {
      company_slug: "acme-corp", id: "d", title: "AI Engineer", company_name: "Acme Corp", source: "browser", source_site: "LinkedIn",
      status: "Interview", wr_label: "silent", fit: 80, sponsor: null, salary: "", ageDays: 1, ageFrom: "posted", waitingDays: null, action: "practise",
    };
    renderApp(<NextUpCard jobs={[job]} total={1} focus="off" />);
    expect(screen.getByLabelText("Found on LinkedIn")).toBeInTheDocument();
  });
  it("shows the compact Set up checklist in a real workspace that isn't set up yet", async () => {
    renderApp(<HomeScreen />);
    expect(await screen.findByText(/^Set up /, { selector: "h2, h3, [id='guide-title']" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show all" })).toBeInTheDocument();
  });
  it("archives a stale role from Home", async () => {
    const { bridge } = renderApp(<HomeScreen />, { bridge: full() });
    const stale = await screen.findByRole("region", { name: "Going stale" });
    const button = within(stale).getAllByRole("button", { name: /^Archive / })[0]!;
    await userEvent.click(button);
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "jobs.setStatus")?.args[2]).toBe("Skipped"));
  });
  it("prepares the top role: Applying, Claude asked, then the Apply screen", async () => {
    const { bridge } = renderApp(<HomeScreen />, { bridge: full() });
    const list = await screen.findByRole("list", { name: "Next up" });
    const prep = within(list).getAllByRole("button", { name: /^Prepare / })[0]!;
    await userEvent.click(prep);
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/apply\//));
    expect(bridge.calls.some((c) => c.method === "apply.prepare")).toBe(true);
    expect(bridge.calls.some((c) => c.method === "claude.run" && c.args[0] === "tailor_application")).toBe(true);
  });
  it("lists sources from the search log", async () => {
    renderApp(<HomeScreen />, { bridge: full() });
    const src = await screen.findByRole("region", { name: "Sources" });
    expect(within(src).getByRole("rowheader", { name: "SEEK" })).toBeInTheDocument();
  });
});

describe("Home by candidate type", () => {
  const as = (status: string) => new MockBridge(scenarioOptions(`?data=full&rights=${status}`));
  const SPONSOR_TEXT = /sponsor|482|visa/i;

  it("needs_sponsorship: mix first, 482 bands, the sponsorship chip and tier", async () => {
    renderApp(<HomeScreen />, { bridge: as("needs_sponsorship") });
    const mix = await screen.findByRole("region", { name: "Sponsorship mix" });
    expect(document.querySelectorAll(".home-grid > .home-col")[1]!.firstElementChild).toBe(mix);
    expect(screen.getByRole("region", { name: "482 salary check" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Opportunity map" })).toBeInTheDocument();
    expect(screen.getByText("days left on visa")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Today" })).getByRole("button", { name: /with sponsorship$/ })).toBeInTheDocument();
    const rows = within(screen.getByRole("list", { name: "Next up" })).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Ad says sponsorship");
  });

  it("full_visa: the mix as plain info, no 482 bands, no sponsorship tier or chip", async () => {
    renderApp(<HomeScreen />, { bridge: as("full_visa") });
    const mix = await screen.findByRole("region", { name: "Sponsorship mix" });
    expect(mix).toHaveTextContent("For your information");
    expect(screen.queryByRole("region", { name: "482 salary check" })).toBeNull();
    expect(screen.queryByText("482", { exact: false })).toBeNull();
    expect(within(screen.getByRole("region", { name: "Today" })).queryByRole("button", { name: /with sponsorship$/ })).toBeNull();
    expect(screen.getByRole("region", { name: "Next up section" })).not.toHaveTextContent("ads that say they sponsor");
    expect(document.querySelector(".next-row__reason.is-sponsor")).toBeNull();
  });

  it("citizen: no sponsorship, visa or 482 anywhere, and the right column starts with the next card", async () => {
    renderApp(<HomeScreen />, { bridge: as("citizen") });
    await screen.findByRole("region", { name: "Next up section" });
    expect(screen.queryByRole("region", { name: "Sponsorship mix" })).toBeNull();
    expect(screen.queryByRole("region", { name: "482 salary check" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Opportunity map" })).toBeNull();
    const right = document.querySelectorAll(".home-grid > .home-col")[1]!;
    expect(["Not scored yet", "Going stale"]).toContain(right.firstElementChild!.getAttribute("aria-label"));
    expect(document.querySelector(".screen-head")!.textContent).not.toMatch(SPONSOR_TEXT);
    expect(document.querySelector(".home-grid")!.textContent).not.toMatch(SPONSOR_TEXT);
  });
});

describe("Home (empty workspace)", () => {
  it("guides instead of showing zeros and hides empty charts", async () => {
    renderApp(<HomeScreen />, { bridge: empty() });
    expect(await screen.findByRole("region", { name: "Today" })).toHaveTextContent("Start by adding roles: run a search, or use Add job to paste a link.");
    expect(screen.queryByRole("region", { name: "Pipeline" })).toBeNull();
    expect(screen.getByRole("region", { name: "Next up section" })).toHaveTextContent("Nothing to act on.");
    expect(screen.queryByRole("region", { name: "Opportunity map" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull();
  });
});

describe("Home copy", () => {
  const now = new Date("2026-01-15T09:00:00.000Z");
  it("writes relative days", () => {
    expect([0, 1, 3, 25, 90].map(daysAgoText)).toEqual(["today", "yesterday", "3 days ago", "4 weeks ago", "3 months ago"]);
    expect(daysAgoText(null)).toBe("");
    expect(ageText({ ageDays: 3, ageFrom: "posted" })).toBe("Posted 3 days ago");
  });
  it("coaches each empty stage", () => {
    const a = homeAnalytics({ rows: [], events: [], searches: [], goals: {}, now });
    expect(coachText("offer", a.funnel)).toBe("Offers show up here after interviews.");
    expect(coachText("interview", a.funnel)).toBe("Interviews show up here once you apply.");
    expect(todaySentence(a, 0)).toBe("Start by adding roles: run a search, or use Add job to paste a link.");
  });
  it("builds the Today sentence from real counts", () => {
    const a = homeAnalytics({ rows: [], events: [], searches: [], goals: { search_deadline: "2026-02-24" }, now });
    a.today.readySponsored = 1; a.today.followUpsDue = 2;
    expect(todaySentence(a, 5)).toBe("1 role says it sponsors and is ready to apply · 2 follow-ups due · 40 days until your search deadline.");
  });
  it("leads a follow-up reason with how long ago you applied", () => {
    expect(reasonText({
      company_slug: "a", id: "b", title: "AI Engineer", company_name: "Acme Corp", status: "Applied", wr_label: "sponsorship_offered",
      fit: 82, sponsor: 95, salary: "$150k+", ageDays: 3, ageFrom: "posted", action: "follow_up", waitingDays: 9,
    })).toBe("Applied 9 days ago, no reply yet · Ad says sponsorship · fit 82 · sponsor 95 · $150k+");
  });
});
