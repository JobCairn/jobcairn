import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/components/Markdown";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { STRESS_ID, STRESS_JD, STRESS_SLUG, STRESS_TITLE, withStressJob } from "../src/mock/stress-job";
import { fmtDay, fmtDayOf, fmtWhen, isDateOnly, parseDay, relativeDay } from "../src/reading/dates";
import { parseJd, promoteHeadings, splitDate, splitQuote, splitUrls } from "../src/reading/jd";
import { JobScreen } from "../src/screens/Job";
import { renderApp } from "./render";

describe("parseJd", () => {
  it("splits an agent-saved JD into title, key facts and body, dropping the --- rule", () => {
    const jd = parseJd(STRESS_JD, STRESS_TITLE);
    expect(jd.title).toContain("Machine Learning Engineer");
    expect(jd.facts.map((f) => f.label)).toEqual(["Source", "Fetched", "Location", "Salary", "Posted", "Work rights", "Apply via"]);
    expect(jd.body.startsWith("Example Labs builds")).toBe(true);
    expect(jd.body).not.toMatch(/^---$/m);
    expect(jd.body).not.toContain("# Machine");
    expect(jd.body).toContain("### Key Responsibilities");
    expect(jd.body).toContain("### About You");
  });
  it("falls back to plain markdown when the pattern doesn't match, keeping a heading that isn't the title", () => {
    const text = "# About the team\n\n- Python\n- TypeScript\n\nWe build things.";
    expect(parseJd(text, "AI Engineer")).toEqual({ title: "About the team", facts: [], body: text });
    expect(parseJd("# AI Engineer at Acme Corp\n\nBuild LLM agents.", "AI Engineer").body).toBe("Build LLM agents.");
  });
  it("needs at least two known keys before treating bullets as facts", () => {
    expect(parseJd("- Python: 5 years\n- Cooking: none\n\nText").facts).toEqual([]);
  });
  it("promotes only short standalone title-like lines", () => {
    expect(promoteHeadings("Intro text.\n\nWhat You'll Do:\n\nBuild things.")).toBe("Intro text.\n\n### What You'll Do\n\nBuild things.");
    for (const keep of ["This is a full sentence.", "- a list item", "# Already", "Ends here"]) {
      expect(promoteHeadings(`A.\n\n${keep}`)).toBe(`A.\n\n${keep}`);
    }
    expect(promoteHeadings("```\nKey Responsibilities\n\nx\n```")).not.toContain("###");
  });
  it("reads URLs, quotes and approximate dates out of fact values", () => {
    expect(splitUrls("LinkedIn https://www.linkedin.com/jobs/view/1/")).toEqual({ text: "LinkedIn", urls: ["https://www.linkedin.com/jobs/view/1/"] });
    expect(splitUrls("javascript:alert(1) http://x.example")).toEqual({ text: "javascript:alert(1) http://x.example", urls: [] });
    expect(splitQuote('Sponsorship available — "We can sponsor a 482 visa."')).toEqual({ summary: "Sponsorship available", quote: "We can sponsor a 482 visa." });
    expect(splitDate("~2025-12-22 (3 weeks ago)")).toEqual({ approx: true, iso: "2025-12-22", rest: "" });
    expect(splitDate("Reposted 2026-10-08 (original earlier)")).toEqual({ approx: false, iso: "2026-10-08", rest: "Reposted (original earlier)" });
  });
  it("formats days without inventing a time", () => {
    const d = parseDay("2025-12-22")!;
    expect(fmtDay(d)).toBe("22 Dec 2025");
    expect(relativeDay(d, new Date(2026, 0, 12))).toBe("3 weeks ago");
    expect(relativeDay(d, new Date(2025, 11, 22, 23, 59))).toBe("today");
    expect(parseDay("2025-02-30")).toBeNull();
  });
});

describe("Markdown reading", () => {
  it("auto-links bare https URLs, shows the host and opens them in the browser", async () => {
    const { bridge } = renderApp(<Markdown text={"Apply at https://www.linkedin.com/jobs/view/1/. Or http://insecure.example and ftp://x.example."} />);
    const link = screen.getByRole("link", { name: "linkedin.com" });
    expect(link).toHaveAttribute("title", "https://www.linkedin.com/jobs/view/1/");
    await userEvent.click(link);
    expect(bridge.opened).toEqual(["https://www.linkedin.com/jobs/view/1/"]);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByText(/http:\/\/insecure\.example/)).toBeInTheDocument();
  });
  it("renders promoted section lines as headings", () => {
    renderApp(<Markdown text={promoteHeadings("Intro.\n\nKey Responsibilities\n\nShip it.")} />);
    expect(screen.getByRole("heading", { name: "Key Responsibilities", level: 3 })).toBeInTheDocument();
  });
});

describe("Job description reading view", () => {
  const bridge = () => new MockBridge({ fixture: withStressJob(loadFixture()) });
  const route = { screen: "job", slug: STRESS_SLUG, id: STRESS_ID } as const;

  it("shows the full title (wrapping, with a tooltip) once, and key facts above the ad", async () => {
    renderApp(<JobScreen route={route} />, { bridge: bridge() });
    const h1 = await screen.findByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent(STRESS_TITLE);
    expect(h1).toHaveAttribute("title", STRESS_TITLE);
    expect(h1).toHaveClass("job-head__title", "job-head__title--long");
    expect(h1).not.toHaveClass("truncate");
    expect(screen.getAllByText(new RegExp(`^${STRESS_TITLE.slice(0, 30)}`))).toHaveLength(1);
    const facts = screen.getByRole("region", { name: "Key facts" });
    expect(within(facts).getByText("We can sponsor a 482 visa for the right candidate.", { exact: false })).toBeInTheDocument();
    expect(within(facts).getByRole("link", { name: "LinkedIn" })).toHaveAttribute("href", "https://www.linkedin.com/jobs/view/0000000001/");
    expect(within(facts).getByRole("link", { name: "careers.example.com" })).toBeInTheDocument();
    expect(within(facts).getByText(/^about 22 Dec 2025$/)).toBeInTheDocument();
    expect(within(facts).getByText("12 Jan 2026")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Key Responsibilities" })).toBeInTheDocument();
    expect(document.querySelector(".markdown hr")).toBeNull();
  });
  it("puts Status, Open ad and Prepare application in one action row", async () => {
    renderApp(<JobScreen route={route} />, { bridge: bridge() });
    const row = (await screen.findByLabelText("Status")).closest(".job-head__actions")!;
    expect(within(row as HTMLElement).getByRole("button", { name: "Open ad" })).toBeInTheDocument();
    expect(within(row as HTMLElement).getByRole("button", { name: "Prepare application" })).toBeInTheDocument();
  });
});

describe("Key facts work-rights tone", () => {
  const route = { screen: "job", slug: STRESS_SLUG, id: STRESS_ID } as const;
  const withRights = (label: "citizen_pr_only" | "sponsorship_offered", status?: string) => {
    const f = withStressJob(loadFixture());
    const j = f.jobs.find((x) => x.job.id === STRESS_ID)!;
    j.job.work_rights.label = label;
    if (label === "citizen_pr_only") {
      const jd = STRESS_JD.replace(/- Work rights: .*/, "- Work rights: Citizens or PR only — \"Must be an Australian citizen or permanent resident.\"");
      j.description = jd;
      f.texts[`companies/${STRESS_SLUG}/jobs/${STRESS_ID}/jd.md`] = jd;
    }
    if (status) (f.profile as { work_rights: { status: string } }).work_rights.status = status;
    return new MockBridge({ fixture: f });
  };
  const panel = async () => {
    const facts = await screen.findByRole("region", { name: "Key facts" });
    return within(facts).getByText("Work rights").closest(".key-facts__rights")!;
  };

  it("never paints a citizens-only ad as good news for someone who needs sponsorship", async () => {
    renderApp(<JobScreen route={route} />, { bridge: withRights("citizen_pr_only") });
    const p = await panel();
    expect(p).toHaveAttribute("data-tone", "danger");
    expect(p).toHaveTextContent("Citizens or PR only");
  });
  it("shows a sponsorship offer as good news for someone who needs it", async () => {
    renderApp(<JobScreen route={route} />, { bridge: withRights("sponsorship_offered") });
    expect(await panel()).toHaveAttribute("data-tone", "success");
  });
  it("shows a citizens-only ad as neutral for a citizen", async () => {
    renderApp(<JobScreen route={route} />, { bridge: withRights("citizen_pr_only", "citizen") });
    expect(await panel()).toHaveAttribute("data-tone", "neutral");
    expect(screen.getByText("Citizens/PR only").closest(".pill")).not.toHaveClass("pill--danger");
  });
});

describe("fmtWhen", () => {
  it("never invents a time for a date-only value", () => {
    expect(isDateOnly("2026-10-08")).toBe(true);
    expect(isDateOnly("2026-10-08T00:00:00")).toBe(true);
    expect(isDateOnly("2026-10-08T09:30:00.000Z")).toBe(false);
    expect(fmtWhen("2026-10-08")).toBe("8 Oct 2026");
    expect(fmtWhen("2026-10-08T00:00:00")).toBe("8 Oct 2026");
    expect(fmtWhen("2026-10-08T09:30:00.000Z")).toMatch(/\d:\d\d/);
    expect(fmtWhen("not a date")).toBe("");
    expect(fmtDayOf("2026-10-08")).toBe("8 Oct 2026");
  });
});
