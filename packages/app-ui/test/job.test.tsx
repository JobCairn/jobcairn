import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { JobScreen } from "../src/screens/Job";
import { parseHash, toHash } from "../src/router";
import { resetTrail, trailSnapshot, visit } from "../src/nav";
import { renderApp } from "./render";

const ACME = { screen: "job", slug: "acme-corp", id: "2026-01-12-ai-engineer" } as const;
const LABS = { screen: "job", slug: "example-labs", id: "2026-01-12-backend-engineer-llm" } as const;

describe("Job route", () => {
  it("round-trips start=1, only alongside the Score tab", () => {
    const r = { ...LABS, tab: "score", start: true } as const;
    expect(toHash(r)).toBe("#/job/example-labs/2026-01-12-backend-engineer-llm?tab=score&start=1");
    expect(parseHash(toHash(r))).toEqual(r);
    expect(parseHash("#/job/example-labs/2026-01-12-backend-engineer-llm?tab=files&start=1")).toEqual({ ...LABS, tab: "files" });
    expect(toHash({ ...LABS, tab: "files", start: true })).toBe("#/job/example-labs/2026-01-12-backend-engineer-llm?tab=files");
  });
  it("keeps a start link in the Back trail without its start", () => {
    resetTrail();
    visit(toHash({ ...LABS, tab: "score", start: true }));
    expect(trailSnapshot().map((e) => e.hash)).toEqual(["#/job/example-labs/2026-01-12-backend-engineer-llm?tab=score"]);
    resetTrail();
  });
});

describe("Job", () => {
  it("starts scoring an unscored job from a start link, then drops start from the address", async () => {
    window.location.hash = toHash({ ...LABS, tab: "score", start: true });
    const { bridge } = renderApp(<JobScreen route={{ ...LABS, tab: "score", start: true }} />);
    await screen.findByRole("button", { name: /^Score this job: Scoring/ });
    expect(bridge.calls.filter((c) => c.method === "claude.run")).toHaveLength(1);
    expect(window.location.hash).toBe("#/job/example-labs/2026-01-12-backend-engineer-llm?tab=score");
  });

  it("shows the title, work-rights pill and description", async () => {
    renderApp(<JobScreen route={ACME} />);
    expect(await screen.findByRole("heading", { name: "AI Engineer", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("Sponsorship offered")).toBeInTheDocument();
    expect(screen.getByText(/Build LLM agents/)).toBeInTheDocument();
  });
  it("shows a clear error for a job that is gone", async () => {
    renderApp(<JobScreen route={{ screen: "job", slug: "acme-corp", id: "2026-01-01-deleted" }} />);
    expect(await screen.findByText("This job can't be shown")).toBeInTheDocument();
    const detail = screen.getByText(/^No job /);
    expect(detail).toBeInTheDocument();
    expect(detail.textContent).not.toMatch(/\.\./);
    await userEvent.click(screen.getByRole("button", { name: "Open Jobs" }));
    expect(window.location.hash).toBe("#/jobs");
  });
  it("shows the error and hides mutating actions when the job disappears while it's open, instead of trusting stale data", async () => {
    const b = new MockBridge();
    const get = b.jobs.get;
    let calls = 0;
    b.jobs.get = async (s, i) => {
      calls += 1;
      if (calls > 1) throw new Error("no job acme-corp/2026-01-12-ai-engineer");
      return get(s, i);
    };
    renderApp(<JobScreen route={{ ...ACME, tab: "files" }} />, { bridge: b });
    expect(await screen.findByRole("heading", { name: "AI Engineer", level: 1 })).toBeInTheDocument();
    b.emitExternalChange("jobs");
    expect(await screen.findByText("This job can't be shown")).toBeInTheDocument();
    // The stale heading can stay on screen, but every mutating control must be gone.
    expect(screen.queryByLabelText("Status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Prepare application" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Attach file" })).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: /^Timeline/ }));
    expect(screen.queryByLabelText("Add a note")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add note" })).toBeNull();
  });
  it("changes status and adds notes to the timeline", async () => {
    renderApp(<JobScreen route={{ ...LABS, tab: "timeline" }} />);
    await userEvent.selectOptions(await screen.findByLabelText("Status"), "Saved");
    expect(await screen.findByText("Status: Saved")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Add a note"), "Asked a friend about the team");
    await userEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(await screen.findByText("Asked a friend about the team")).toBeInTheDocument();
  });
  it("marks missing files and reveals existing ones", async () => {
    const b = new MockBridge();
    const get = b.jobs.get;
    b.jobs.get = async (s, i) => {
      const d = await get(s, i);
      return { ...d, files: [...d.files, { path: "gone.pdf", rel: `companies/${s}/jobs/${i}/gone.pdf`, label: "Old offer", at: "", exists: false, size: null, kind: "pdf" }] };
    };
    renderApp(<JobScreen route={{ ...ACME, tab: "files" }} />, { bridge: b });
    const row = (await screen.findByText("Old offer")).closest("li")!;
    expect(within(row).getByText("Missing")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /Show/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show in folder: Job description" }));
    expect(b.revealed).toEqual(["companies/acme-corp/jobs/2026-01-12-ai-engineer/jd.md"]);
  });
  it("toasts only after a real attach, not when the file picker is cancelled", async () => {
    const b = new MockBridge();
    let picked = false;
    (b.files as { pick(): Promise<string | null> }).pick = async () => { picked = true; return null; };
    renderApp(<JobScreen route={{ ...ACME, tab: "files" }} />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Attach file" }));
    await waitFor(() => expect(picked).toBe(true));
    expect(screen.queryByText("File attached")).toBeNull();
    expect(b.calls.some((c) => c.method === "jobs.attach")).toBe(false);
  });
  it("lists gaps and links each to Learn", async () => {
    const f = loadFixture();
    f.jobs.find((j) => j.job.company_slug === "acme-corp")!.job.scores.fit.must_haves = [{ skill: "Kubernetes", met: false }];
    renderApp(<JobScreen route={{ ...ACME, tab: "gaps" }} />, { bridge: new MockBridge({ fixture: f }) });
    await userEvent.click(await screen.findByRole("button", { name: "Study Kubernetes" }));
    expect(window.location.hash).toBe("#/learn?topic=kubernetes");
  });
  it("switches tabs through the route", async () => {
    renderApp(<JobScreen route={ACME} />);
    await userEvent.click(await screen.findByRole("tab", { name: /^Timeline/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/job/acme-corp/2026-01-12-ai-engineer?tab=timeline"));
  });

  // acme-corp has no fit/career score and no report by default (unscored), which hides the
  // whole Fit/Sponsor row regardless of focus - so these tests give it a fit value first, like
  // the "doesn't need sponsorship" tests below do, to exercise the sponsor-gating itself.
  function bridgeWithStatus(status: string): MockBridge {
    const f = loadFixture();
    (f.profile as { work_rights: { status: string } }).work_rights.status = status;
    const acme = f.jobs.find((j) => j.job.company_slug === "acme-corp")!;
    acme.job.scores.fit.value = 78;
    return new MockBridge({ fixture: f });
  }

  it("round 2: the Score tab shows the sponsor score and reasons for a candidate who needs sponsorship (primary)", async () => {
    renderApp(<JobScreen route={{ ...ACME, tab: "score" }} />, { bridge: bridgeWithStatus("needs_sponsorship") });
    expect(await screen.findByText(/Sponsor 95/)).toBeInTheDocument();
    expect(screen.getByText("Ad says sponsorship is available")).toBeInTheDocument();
  });
  it("Description shows the sponsor estimate with its top reasons for someone who needs sponsorship, and nothing for a citizen", async () => {
    const { unmount } = renderApp(<JobScreen route={ACME} />, { bridge: bridgeWithStatus("needs_sponsorship") });
    const section = await screen.findByRole("region", { name: "Sponsorship" });
    expect(within(section).getByText("Confirmed")).toBeInTheDocument();
    expect(within(within(section).getByRole("list", { name: "Why" })).getByText("Ad says sponsorship is available")).toBeInTheDocument();
    unmount();
    renderApp(<JobScreen route={ACME} />, { bridge: bridgeWithStatus("citizen") });
    expect(await screen.findByRole("heading", { name: "AI Engineer", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Sponsorship" })).toBeNull();
  });
  it("round 2: the Score tab hides the sponsor score entirely for a citizen (sponsorship off)", async () => {
    renderApp(<JobScreen route={{ ...ACME, tab: "score" }} />, { bridge: bridgeWithStatus("citizen") });
    expect(await screen.findByRole("meter", { name: "Fit score" })).toHaveAttribute("aria-valuenow", "78");
    // The header's "Sponsorship offered" ad badge is unrelated and stays; only the Score tab's
    // own sponsor score and reasons are gated by focus.
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).queryByText(/^Sponsor /)).not.toBeInTheDocument();
    expect(within(panel).queryByText("Ad says sponsorship is available")).not.toBeInTheDocument();
  });
  it("round 2: the Score tab shows the sponsor score as plain info, with no reasons, for a full-rights visa holder (secondary)", async () => {
    renderApp(<JobScreen route={{ ...ACME, tab: "score" }} />, { bridge: bridgeWithStatus("full_visa") });
    expect(await screen.findByText(/Sponsorship info: 95/)).toBeInTheDocument();
    expect(screen.queryByText("Ad says sponsorship is available")).not.toBeInTheDocument();
  });
});

describe("Job score state", () => {
  it("reads the same on Score and Gaps: a fit without a report is scored, not 'no score yet'", async () => {
    const f = loadFixture();
    const acme = f.jobs.find((x) => x.job.company_slug === "acme-corp")!;
    acme.job.scores.fit.value = 78;
    acme.job.timeline.push({ at: "2026-01-13T02:30:00.000Z", event: "Scored", note: "Fit 78" });
    const bridge = new MockBridge({ fixture: f });
    const { unmount } = renderApp(<JobScreen route={{ ...ACME, tab: "score" }} />, { bridge });
    expect(await screen.findByRole("meter", { name: "Fit score" })).toHaveAttribute("aria-valuenow", "78");
    expect(screen.getByText("Scored").nextElementSibling).toHaveTextContent("13 Jan 2026");
    expect(screen.queryByText(/Not scored yet/)).toBeNull();
    expect(await screen.findByRole("button", { name: "Score again" })).toBeInTheDocument();
    unmount();
    renderApp(<JobScreen route={{ ...ACME, tab: "gaps" }} />, { bridge });
    expect(await screen.findByText("No skill gaps were found when this job was scored.")).toBeInTheDocument();
  });
  it("offers Score this job from an unscored job's Gaps tab, and the main button follows the status", async () => {
    renderApp(<JobScreen route={{ ...LABS, tab: "gaps" }} />);
    expect(await screen.findByText(/Not scored yet/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Score" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare application" })).toHaveClass("btn--primary");
  });
  it("shows View application, not Prepare, once a job is applied", async () => {
    renderApp(<JobScreen route={ACME} />);
    expect(await screen.findByRole("button", { name: "View application" })).not.toHaveClass("btn--primary");
    expect(screen.queryByRole("button", { name: "Prepare application" })).toBeNull();
  });
});

describe("Job timeline dates", () => {
  it("shows a date-only entry as a date, with no invented time", async () => {
    const f = loadFixture();
    const labs = f.jobs.find((x) => x.job.company_slug === "example-labs")!;
    labs.job.timeline = [
      { at: "2026-10-08", event: "Imported from the old tracker", note: "" },
      { at: "2026-10-08T00:00:00", event: "Saved", note: "" },
    ];
    renderApp(<JobScreen route={{ ...LABS, tab: "timeline" }} />, { bridge: new MockBridge({ fixture: f }) });
    const list = (await screen.findByText("Imported from the old tracker")).closest("ul")!;
    expect(within(list).getAllByText("8 Oct 2026")).toHaveLength(2);
    expect(list.textContent).not.toMatch(/\d:\d\d|am|pm/i);
  });
});

describe("Job page for a candidate who doesn't need sponsorship", () => {
  const citizen = () => {
    const f = loadFixture();
    (f.profile as { work_rights: { status: string } }).work_rights.status = "citizen";
    const acme = f.jobs.find((x) => x.job.company_slug === "acme-corp")!;
    acme.job.scores.fit.value = 78;
    return new MockBridge({ fixture: f });
  };
  it("hides the sponsorship pill", async () => {
    const bridge = citizen();
    renderApp(<JobScreen route={ACME} />, { bridge });
    expect(await screen.findByRole("heading", { name: "AI Engineer", level: 1 })).toBeInTheDocument();
    expect(screen.queryByText("Sponsorship offered")).toBeNull();
  });
  it("leaves the sponsor score out of the Score tab", async () => {
    renderApp(<JobScreen route={{ ...ACME, tab: "score" }} />, { bridge: citizen() });
    expect(await screen.findByRole("meter", { name: "Fit score" })).toHaveAttribute("aria-valuenow", "78");
    expect(screen.queryByText(/^Sponsor /)).toBeNull();
    expect(screen.queryByText("ad says sponsorship is available")).toBeNull();
  });
  it("shows sponsorship again as soon as Settings says they need it", async () => {
    const bridge = citizen();
    renderApp(<JobScreen route={ACME} />, { bridge });
    await screen.findByRole("heading", { name: "AI Engineer", level: 1 });
    await bridge.settings.save("profile", [{ path: "work_rights.status", value: "needs_sponsorship" }]);
    expect(await screen.findByText("Sponsorship offered")).toBeInTheDocument();
  });
});

describe("Job: interview tab", () => {
  it("Open Learn opens Learn on this job's interview prep", async () => {
    renderApp(<JobScreen route={{ ...ACME, tab: "interview" }} />);
    await userEvent.click(await screen.findByRole("button", { name: "Open Learn" }));
    expect(window.location.hash).toBe("#/learn?job=acme-corp/2026-01-12-ai-engineer");
  });
});
