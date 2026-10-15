import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeTourState } from "@careeros/contract";
import { App } from "../src/App";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { parseHash, toHash } from "../src/router";
import { CompaniesScreen } from "../src/screens/Companies";
import { CompanyScreen } from "../src/screens/Company";
import { renderApp } from "./render";

const VISA = /visa|sponsor|482|work rights|citizen|residen/i;

/** Every visible word, plus every tooltip and accessible label, on the page. */
function allText(root: HTMLElement = document.body): string {
  const attrs = [...root.querySelectorAll("[title],[aria-label],[placeholder],[data-tip]")]
    .flatMap((el) => ["title", "aria-label", "placeholder", "data-tip"].map((a) => el.getAttribute(a) ?? ""));
  return [root.textContent ?? "", ...attrs].join("\n");
}

const bridgeFor = (status: string, edit?: (f: ReturnType<typeof loadFixture>) => void) => {
  const f = loadFixture();
  (f.profile as { work_rights: { status: string } }).work_rights.status = status;
  edit?.(f);
  return new MockBridge({ fixture: f });
};
const withListOnly = (f: ReturnType<typeof loadFixture>) => {
  f.employers = [{ name: "Acme Analytics", aliases: [], status: "verified", last_checked: "2026-10-08",
    evidence: [{ date: "2026-10-08", note: "Careers page says they sponsor engineers", url: "https://acme-analytics.example.com/careers" }] }];
};
const withResearch = (f: ReturnType<typeof loadFixture>) => {
  f.texts["companies/acme-corp/research.md"] = "# Acme Corp\n\nA fictional company.\n";
};

afterEach(() => { cleanup(); window.location.hash = ""; });

describe("routes", () => {
  it("parses and writes the Companies list and a company page", () => {
    expect(parseHash("#/companies")).toEqual({ screen: "companies" });
    expect(parseHash("#/company/acme-corp")).toEqual({ screen: "company", slug: "acme-corp" });
    expect(parseHash("#/company/acme-corp?tab=mail")).toEqual({ screen: "company", slug: "acme-corp", tab: "mail" });
    expect(toHash({ screen: "company", slug: "acme-corp", tab: "research" })).toBe("#/company/acme-corp?tab=research");
    expect(parseHash("#/company/../x")).toEqual({ screen: "home" });
    expect(parseHash("#/company/Acme")).toEqual({ screen: "home" });
  });
  it("sends old Sponsors links to Companies, and never writes the old name", () => {
    expect(parseHash("#/sponsors")).toEqual({ screen: "companies" });
    expect(parseHash("#/sponsor/acme-corp")).toEqual({ screen: "company", slug: "acme-corp" });
    expect(toHash(parseHash("#/sponsors"))).toBe("#/companies");
  });
  it("carries a seen Sponsors tour over to Companies", () => {
    const s = sanitizeTourState({ tours: { sponsors: { mark: "seen", at: "2026-10-01T00:00:00.000Z" } } });
    expect(s.tours.companies).toEqual({ mark: "seen", at: "2026-10-01T00:00:00.000Z" });
    expect(Object.keys(s.tours)).not.toContain("sponsors");
  });
});

describe("Companies list", () => {
  it("for a citizen: companies with jobs, fit and stage, and no visa words anywhere", async () => {
    window.location.hash = "#/companies";
    render(<App bridge={bridgeFor("citizen", withListOnly)} />);
    const table = await screen.findByRole("table", { name: /Companies/ });
    const heads = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads.join("|")).toMatch(/Company.*Open jobs.*Best fit.*Your applications/);
    expect(heads.join("|")).not.toMatch(/Sponsor/);
    expect(table.textContent).toContain("Acme Corp");
    // A list-only employer is sponsorship research: not shown to a citizen.
    expect(table.textContent).not.toContain("Acme Analytics");
    await waitFor(() => expect(allText()).not.toMatch(VISA));
  });

  it("for someone who needs sponsorship: the Sponsor score column and list-only employers", async () => {
    renderApp(<CompaniesScreen />, { bridge: bridgeFor("needs_sponsorship", withListOnly) });
    const table = await screen.findByRole("table", { name: /Companies/ });
    expect(within(table).getByRole("columnheader", { name: /Sponsor score/ })).toBeInTheDocument();
    expect(table.textContent).toContain("Acme Analytics");
    expect(screen.getByLabelText("Sponsor status")).toBeInTheDocument();
  });

  it("filters by name and by how far you got, and opens a company", async () => {
    renderApp(<CompaniesScreen />, { bridge: bridgeFor("needs_sponsorship", withListOnly) });
    const table = await screen.findByRole("table", { name: /Companies/ });
    await userEvent.selectOptions(screen.getByLabelText("Show"), "none");
    await waitFor(() => expect(table.textContent).not.toContain("Acme Corp"));
    expect(table.textContent).toContain("Acme Analytics");
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await userEvent.type(screen.getByLabelText("Find a company"), "labs");
    await waitFor(() => expect(within(table).getAllByRole("row").slice(1).map((r) => r.textContent)).toEqual([expect.stringContaining("Example Labs")]));
    await userEvent.click(within(table).getByText("Example Labs"));
    await waitFor(() => expect(window.location.hash).toBe("#/company/example-labs"));
  });

  it("says how a company gets here when there are none", async () => {
    const b = bridgeFor("citizen", (f) => { f.jobs = []; f.companies = []; f.employers = []; });
    renderApp(<CompaniesScreen />, { bridge: b });
    expect(await screen.findByText(/No companies yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Find jobs" }));
    expect(window.location.hash).toBe("#/jobs");
  });
});

describe("Company page", () => {
  it("for a citizen: jobs, mail, research and timeline, and no visa words anywhere", async () => {
    window.location.hash = "#/company/acme-corp";
    render(<App bridge={bridgeFor("citizen", withResearch)} />);
    expect(await screen.findByRole("heading", { name: "Acme Corp", level: 1 })).toBeInTheDocument();
    const tabs = within(screen.getByRole("tablist", { name: "Company sections" })).getAllByRole("tab").map((t) => t.textContent);
    expect(tabs.join("|")).toMatch(/Jobs.*Mail.*Research.*Timeline/);
    expect(tabs.join("|")).not.toMatch(/Sponsor/);
    await screen.findByRole("table", { name: /Jobs at Acme Corp/ });
    expect(screen.getByRole("link", { name: /Back to Companies/ })).toBeInTheDocument();
    await waitFor(() => expect(allText()).not.toMatch(VISA));
    // A citizen typing the old tab name gets the jobs, not the sponsorship section.
    window.location.hash = "#/company/acme-corp?tab=sponsorship";
    await screen.findByRole("table", { name: /Jobs at Acme Corp/ });
    expect(allText()).not.toMatch(VISA);
  });

  it("opens a job from the jobs list", async () => {
    renderApp(<CompanyScreen route={{ screen: "company", slug: "acme-corp" }} />, { bridge: bridgeFor("citizen") });
    const table = await screen.findByRole("table", { name: /Jobs at Acme Corp/ });
    await userEvent.click(within(table).getByText("AI Engineer"));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/job\/acme-corp\//));
  });

  it("lists research files and opens them in the viewer", async () => {
    renderApp(<CompanyScreen route={{ screen: "company", slug: "acme-corp", tab: "research" }} />, { bridge: bridgeFor("citizen", withResearch) });
    await userEvent.click(await screen.findByRole("button", { name: "View Company research" }));
    expect(await screen.findByRole("dialog", { name: /Company research/ })).toBeInTheDocument();
  });

  it("offers research when there are no files yet, and says when a timeline is empty", async () => {
    renderApp(<CompanyScreen route={{ screen: "company", slug: "acme-corp", tab: "research" }} />, { bridge: bridgeFor("citizen") });
    expect(await screen.findByText(/No research or notes yet/)).toBeInTheDocument();
  });

  it("shows mail with the company", async () => {
    renderApp(<CompanyScreen route={{ screen: "company", slug: "acme-corp", tab: "mail" }} />, { bridge: bridgeFor("citizen") });
    expect(await screen.findByText(/Choose an email to read it|No emails with this company yet/)).toBeInTheDocument();
  });

  it("for someone who needs sponsorship: a Sponsorship section with evidence, score and Check again", async () => {
    renderApp(<CompanyScreen route={{ screen: "company", slug: "acme-corp", tab: "sponsorship" }} />, { bridge: bridgeFor("needs_sponsorship") });
    expect(await screen.findByRole("tab", { name: /Sponsorship/ })).toBeInTheDocument();
    expect(await screen.findByText("Evidence, newest first")).toBeInTheDocument();
    expect(screen.getByText("Sponsor score")).toBeInTheDocument();
    expect((await screen.findAllByRole("button", { name: /Check Acme Corp again/ })).length).toBeGreaterThan(0);
  });

  it("a list-only employer: evidence with a safe link, and research explains why it can't run", async () => {
    renderApp(<CompanyScreen route={{ screen: "company", slug: "acme-analytics", tab: "sponsorship" }} />, { bridge: bridgeFor("needs_sponsorship", withListOnly) });
    expect(await screen.findByText("Careers page says they sponsor engineers")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open acme-analytics.example.com" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Research company" })).toBeDisabled();
    expect(screen.getAllByText(/Save a job with this company first/).length).toBeGreaterThan(0);
  });

  it("never offers to open an evidence link that isn't plain https", async () => {
    const b = bridgeFor("needs_sponsorship", (f) => {
      f.employers = [{ name: "Acme Analytics", aliases: [], status: "verified", last_checked: "2026-10-08",
        evidence: [{ date: "2026-10-08", note: "Odd link", url: "javascript:alert(1)" }] }];
    });
    renderApp(<CompanyScreen route={{ screen: "company", slug: "acme-analytics", tab: "sponsorship" }} />, { bridge: b });
    expect(await screen.findByText("Odd link")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Open / })).toBeNull();
    expect(screen.getByText(/Link not opened \(not a plain https address\)/)).toBeInTheDocument();
  });

  it("a citizen never lands on a list-only employer", async () => {
    renderApp(<CompanyScreen route={{ screen: "company", slug: "acme-analytics" }} />, { bridge: bridgeFor("citizen", withListOnly) });
    expect(await screen.findByText("This company isn't in your workspace.")).toBeInTheDocument();
    expect(allText()).not.toMatch(VISA);
  });

  it("explains a company that isn't there, with a way back", async () => {
    renderApp(<CompanyScreen route={{ screen: "company", slug: "no-such-company" }} />, { bridge: bridgeFor("citizen") });
    expect(await screen.findByText("This company can't be shown")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "All companies" }));
    expect(window.location.hash).toBe("#/companies");
  });
});
