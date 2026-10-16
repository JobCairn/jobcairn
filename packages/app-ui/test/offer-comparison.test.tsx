import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { ApplicationsScreen } from "../src/screens/Applications";
import { parseMoney, parsePercent } from "../src/jobs/OfferComparison";
import { renderApp } from "./render";

vi.setConfig({ testTimeout: 20_000 });
beforeEach(() => { window.location.hash = "#/applications"; sessionStorage.clear(); localStorage.clear(); });

/** The mock workspace with its first two jobs at Offer. */
function offersBridge(n = 2): MockBridge {
  const f = loadFixture();
  for (const j of f.jobs.slice(0, n)) j.job.status = "Offer";
  return new MockBridge({ fixture: f });
}
const card = () => screen.findByRole("region", { name: "Compare offers" });
/** The card opened (it starts closed): what the tests below compare in. */
async function openCard(): Promise<HTMLElement> {
  const c = await card();
  const toggle = within(c).getByRole("button", { name: /offer comparison$/ });
  if (toggle.getAttribute("aria-expanded") !== "true") await userEvent.click(toggle);
  return c;
}

describe("parsing what is typed", () => {
  it("reads money and percentages", () => {
    expect(parseMoney("$120,000")).toBe(120_000);
    expect(parseMoney("120k")).toBe(120_000);
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("lots")).toBeUndefined();
    expect(parsePercent("11.5")).toBe(0.115);
    expect(parsePercent("12%")).toBe(0.12);
    expect(parsePercent("")).toBeNull();
    expect(parsePercent("80")).toBeUndefined();
  });
});

describe("Compare offers", () => {
  it("isn't shown without an offer", async () => {
    renderApp(<ApplicationsScreen />);
    await screen.findByRole("tablist", { name: "Application stages" });
    expect(screen.queryByLabelText("Compare offers")).toBeNull();
  });

  it("shows two offers side by side, totals them with 12% super, and saves through the bridge", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<ApplicationsScreen />, { bridge: offersBridge() });
    const c = await openCard();
    const table = await within(c).findByRole("table", { name: "Offers side by side" });
    const cols = within(table).getAllByRole("columnheader");
    expect(cols).toHaveLength(2);
    const bases = within(table).getAllByRole("textbox", { name: /^Base: / });
    await user.type(bases[0]!, "120k");
    await user.type(bases[1]!, "$100,000");
    await user.type(within(table).getAllByRole("textbox", { name: /^Bonus: / })[1]!, "10000");
    const total = within(table).getByRole("row", { name: /^Total a year/ });
    expect(total).toHaveTextContent("$134,400");
    expect(total).toHaveTextContent("$122,000");
    expect(within(total).getAllByText("Highest")).toHaveLength(1);
    // Super is editable per offer.
    await user.type(within(table).getAllByRole("textbox", { name: /^Super %: / })[1]!, "11.5");
    expect(total).toHaveTextContent("$121,500");
    await user.click(within(table).getAllByRole("button", { name: /^Save offer: / })[0]!);
    await waitFor(() => expect(bridge.calls.find((x) => x.method === "jobs.setOffer")?.args[2]).toMatchObject({ base: 120_000, super_rate: null, bonus: null }));
  });

  it("refuses an amount it can't read", async () => {
    const user = userEvent.setup();
    renderApp(<ApplicationsScreen />, { bridge: offersBridge() });
    const table = await within(await openCard()).findByRole("table", { name: "Offers side by side" });
    const base = within(table).getAllByRole("textbox", { name: /^Base: / })[0]!;
    await user.type(base, "lots");
    expect(base).toHaveAttribute("aria-invalid", "true");
    expect(within(table).getAllByRole("button", { name: /^Save offer: / })[0]).toBeDisabled();
  });

  it("with one offer, lets you tick another job in to compare", async () => {
    const user = userEvent.setup();
    const f = loadFixture();
    f.jobs[0]!.job.status = "Offer";
    f.jobs[1]!.job.status = "Interview";
    renderApp(<ApplicationsScreen />, { bridge: new MockBridge({ fixture: f }) });
    const c = await openCard();
    expect(within(c).getByText("Tick two or more jobs to compare them side by side.")).toBeInTheDocument();
    expect(within(c).queryByRole("table")).toBeNull();
    await user.click(within(c).getByRole("checkbox", { name: /\(Interview\)$/ }));
    expect(within(await within(c).findByRole("table", { name: "Offers side by side" })).getAllByRole("columnheader")).toHaveLength(2);
  });

  it("never calls a ticked-in interview \"another offer\", and drafts only for jobs at Offer", async () => {
    const user = userEvent.setup();
    const f = loadFixture();
    f.jobs[0]!.job.status = "Offer";
    f.jobs[1]!.job.status = "Interview";
    const bridge = new MockBridge({ fixture: f });
    renderApp(<ApplicationsScreen />, { bridge });
    const c = await openCard();
    await user.click(within(c).getByRole("checkbox", { name: /\(Interview\)$/ }));
    const table = await within(c).findByRole("table", { name: "Offers side by side" });
    const bases = within(table).getAllByRole("textbox", { name: /^Base: / });
    await user.type(bases[0]!, "120000");
    await user.type(bases[1]!, "150000");
    const drafts = within(table).getAllByRole("button", { name: /^Draft negotiation email: / });
    expect(drafts[1]).toBeDisabled();
    expect(drafts[1]).toHaveAttribute("title", "Only for a job at Offer.");
    await waitFor(() => expect(drafts[0]).toBeEnabled());
    await user.click(drafts[0]!);
    await waitFor(() => expect(bridge.claudeSim.requests).toHaveLength(1));
    expect(bridge.claudeSim.requests[0]!.request.note).not.toMatch(/another offer/);
  });

  it("still saves the draft when you leave and come back before Claude finishes", async () => {
    const user = userEvent.setup();
    const bridge = offersBridge();
    const first = renderApp(<ApplicationsScreen />, { bridge });
    const table = await within(await openCard()).findByRole("table", { name: "Offers side by side" });
    await user.type(within(table).getAllByRole("textbox", { name: /^Base: / })[0]!, "120000");
    const draft = within(table).getAllByRole("button", { name: /^Draft negotiation email: / })[0]!;
    await waitFor(() => expect(draft).toBeEnabled());
    await user.click(draft);
    await waitFor(() => expect(bridge.claudeSim.requests).toHaveLength(1));
    first.unmount();
    act(() => bridge.claudeSim.finish(bridge.claudeSim.runs[0]!.id));
    renderApp(<ApplicationsScreen />, { bridge });
    await waitFor(() => expect(bridge.calls.some((x) => x.method === "mail.drafts.save")).toBe(true));
    await waitFor(() => expect(window.location.hash).toMatch(/\?tab=mail$/));
  });

  it("Draft negotiation email: saves the offer, asks Claude with numbers only, saves a Mail draft and never sends", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<ApplicationsScreen />, { bridge: offersBridge() });
    const table = await within(await openCard()).findByRole("table", { name: "Offers side by side" });
    const bases = within(table).getAllByRole("textbox", { name: /^Base: / });
    await user.type(bases[0]!, "120000");
    await user.type(bases[1]!, "130000");
    const draft = within(table).getAllByRole("button", { name: /^Draft negotiation email: / })[0]!;
    await waitFor(() => expect(draft).toBeEnabled());
    await user.click(draft);
    await waitFor(() => expect(bridge.claudeSim.requests).toHaveLength(1));
    const req = bridge.claudeSim.requests[0]!;
    expect(req.action).toBe("draft_email");
    expect(req.request.options).toMatchObject({ purpose: "negotiate", mode: "new" });
    expect(req.request.note).toMatch(/^The offer is \$120,000 base plus 12% super, \$134,400 a year in total\. I hold another offer worth \$145,600/);
    expect(bridge.calls.findIndex((x) => x.method === "jobs.setOffer")).toBeLessThan(bridge.calls.findIndex((x) => x.method === "claude.run"));
    act(() => bridge.claudeSim.finish(bridge.claudeSim.runs[0]!.id));
    await waitFor(() => expect(bridge.calls.some((x) => x.method === "mail.drafts.save")).toBe(true));
    const saved = bridge.calls.find((x) => x.method === "mail.drafts.save")!;
    expect(saved.args[2]).toBe("");
    expect(saved.args[3]).toMatchObject({ subject: expect.stringMatching(/offer$/), body: expect.stringMatching(/^Hi,\n\nThank you for the offer/) });
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/job\/.+\?tab=mail$/));
    expect(bridge.calls.some((x) => x.method === "mail.drafts.propose")).toBe(false);
    expect((await bridge.approvals.list()).filter((a) => a.action === "email_send")).toHaveLength(0);
  });
  it("starts as one closed line with the offer count, and remembers when you open it", async () => {
    const user = userEvent.setup();
    const bridge = offersBridge();
    const first = renderApp(<ApplicationsScreen />, { bridge });
    const c = await card();
    expect(c).toHaveTextContent("2 offers");
    const toggle = within(c).getByRole("button", { name: "Show offer comparison" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(c).queryByRole("group", { name: "Jobs to compare" })).toBeNull();
    expect(within(c).queryByRole("table")).toBeNull();
    await user.click(toggle);
    expect(within(c).getByRole("button", { name: "Hide offer comparison" })).toHaveAttribute("aria-expanded", "true");
    expect(within(c).getByRole("group", { name: "Jobs to compare" })).toBeInTheDocument();
    await within(c).findByRole("table", { name: "Offers side by side" });
    first.unmount();
    renderApp(<ApplicationsScreen />, { bridge });
    const again = await card();
    expect(within(again).getByRole("button", { name: "Hide offer comparison" })).toHaveAttribute("aria-expanded", "true");
    await user.click(within(again).getByRole("button", { name: "Hide offer comparison" }));
    expect(within(again).queryByRole("group", { name: "Jobs to compare" })).toBeNull();
  });

  it("lists one job a row, offers first and ticked, each with its status", async () => {
    const f = loadFixture();
    f.jobs[0]!.job.status = "Applied";
    f.jobs[1]!.job.status = "Offer";
    f.jobs[2]!.job.status = "Interview";
    renderApp(<ApplicationsScreen />, { bridge: new MockBridge({ fixture: f }) });
    const pick = within(await openCard()).getByRole("group", { name: "Jobs to compare" });
    const boxes = within(pick).getAllByRole("checkbox");
    expect(boxes.map((b) => b.getAttribute("aria-label")!.replace(/^.*\((\w+)\)$/, "$1"))).toEqual(["Offer", "Interview", "Applied"]);
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([true, false, false]);
    const items = within(pick).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText("Offer")).toHaveClass("pill");
    expect(within(pick).queryByRole("searchbox")).toBeNull();
  });

  it("with more than eight jobs, a search narrows the list and keeps what you ticked", async () => {
    const user = userEvent.setup();
    const f = loadFixture();
    const base = f.jobs[0]!;
    for (let i = 0; i < 8; i++) f.jobs.push({ ...structuredClone(base), job: { ...structuredClone(base.job), id: `2026-01-12-extra-role-${i}`, title: `Extra role ${i}`, url: `https://jobs.example.com/extra-${i}` } });
    f.jobs.forEach((j, i) => { j.job.status = i < 2 ? "Offer" : "Applied"; });
    const target = "Extra role 5";
    renderApp(<ApplicationsScreen />, { bridge: new MockBridge({ fixture: f }) });
    const c = await openCard();
    const pick = within(c).getByRole("group", { name: "Jobs to compare" });
    const all = within(pick).getAllByRole("checkbox").length;
    expect(all).toBe(f.jobs.length);
    const search = within(pick).getByRole("searchbox", { name: "Search jobs to compare" });
    await user.type(search, target);
    const shown = within(pick).getAllByRole("checkbox");
    expect(shown.length).toBeLessThan(all);
    expect(shown.every((b) => b.getAttribute("aria-label")!.toLowerCase().includes(target.toLowerCase()))).toBe(true);
    // The two offers are hidden by the search but still ticked: the comparison still shows them.
    expect(within(await within(c).findByRole("table", { name: "Offers side by side" })).getAllByRole("columnheader")).toHaveLength(2);
    await user.clear(search);
    await user.type(search, "zzz no such job");
    expect(within(pick).getByText("No jobs match.")).toBeInTheDocument();
  });
});
