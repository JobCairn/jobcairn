import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { routePage, writePage } from "../src/components/listPage";
import { listAllJobs } from "../src/jobs/list-all";
import { withManyRows } from "../src/mock/demo-rows";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { parseHash, toHash } from "../src/router";
import { CompaniesScreen } from "../src/screens/Companies";
import { JobsScreen } from "../src/screens/Jobs";
import { SearchesScreen } from "../src/screens/Searches";
import { renderApp } from "./render";

const many = (n: number) => new MockBridge({ fixture: withManyRows(loadFixture(), n) });
const bodyRows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1).filter((r) => !r.classList.contains("table__spacer")) as HTMLTableRowElement[];
const pager = (name: string) => screen.getByRole("navigation", { name: `${name} pages` });

afterEach(() => { window.location.hash = ""; });

describe("list pages in the address", () => {
  it("round-trips the page for Jobs, Companies and Searches, and leaves page 1 out", () => {
    for (const hash of ["#/companies?p=3", "#/searches?p=2", "#/jobs?p=4", "#/jobs?status=Applying&p=2", "#/jobs?q=ai&p=5"]) {
      expect(toHash(parseHash(hash))).toBe(hash);
    }
    expect(parseHash("#/companies?p=3")).toEqual({ screen: "companies", page: 3 });
    expect(parseHash("#/jobs?status=Applying&p=2")).toEqual({ screen: "jobs", status: "Applying", page: 2 });
    expect(toHash({ screen: "companies", page: 1 })).toBe("#/companies");
    expect(toHash({ screen: "jobs", filters: "q=ai", page: 2 })).toBe("#/jobs?q=ai&p=2");
  });
  it("ignores junk page numbers", () => {
    for (const p of ["0", "1", "-2", "abc", "1.5", "999999"]) expect(parseHash(`#/companies?p=${p}`)).toEqual({ screen: "companies" });
    // A page on a Home link to Jobs doesn't turn it into a filtered list.
    expect(parseHash("#/jobs?status=Applied&p=2")).toEqual({ screen: "jobs", status: "Applied", page: 2 });
  });
  it("writes the page without a new history entry, and keeps the filters", () => {
    window.location.hash = "#/jobs?q=ai";
    const len = window.history.length;
    writePage(3);
    expect(window.location.hash).toBe("#/jobs?q=ai&p=3");
    expect(routePage()).toBe(3);
    writePage(1);
    expect(window.location.hash).toBe("#/jobs?q=ai");
    expect(window.history.length).toBe(len);
    window.location.hash = "#/home";
    writePage(2);
    expect(window.location.hash).toBe("#/home");
  });
});

describe("long lists", () => {
  it("Companies pages 127 companies 50 at a time and keeps the page in the address", async () => {
    window.location.hash = "#/companies";
    renderApp(<CompaniesScreen />, { bridge: many(124) });
    const nav = await screen.findByRole("navigation", { name: "Companies pages" });
    expect(within(nav).getByText("1–50 of 127")).toBeInTheDocument();
    expect(bodyRows()).toHaveLength(50);
    await userEvent.click(within(nav).getByRole("button", { name: "Page 3" }));
    expect(bodyRows()).toHaveLength(27);
    expect(window.location.hash).toBe("#/companies?p=3");
    // Filtering starts again at page 1.
    await userEvent.type(screen.getByLabelText("Find a company"), "Example Company 00");
    await waitFor(() => expect(window.location.hash).toBe("#/companies"));
    expect(within(pager("Companies")).getByText(/^1–50 of /)).toBeInTheDocument();
  });

  it("Companies opens on the page in the address", async () => {
    window.location.hash = "#/companies?p=2";
    renderApp(<CompaniesScreen />, { bridge: many(124) });
    const nav = await screen.findByRole("navigation", { name: "Companies pages" });
    expect(within(nav).getByText("51–100 of 127")).toBeInTheDocument();
    expect(window.location.hash).toBe("#/companies?p=2");
  });

  it("Back from a company returns to the same page of the list", async () => {
    window.location.hash = "#/companies";
    render(<App bridge={many(124)} />);
    const nav = await screen.findByRole("navigation", { name: "Companies pages" }, { timeout: 8000 });
    await userEvent.click(within(nav).getByRole("button", { name: "Page 2" }));
    const first = bodyRows()[0]!;
    const name = first.cells[0]!.textContent;
    await userEvent.click(first);
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/company\//));
    window.history.back();
    await waitFor(() => expect(window.location.hash).toBe("#/companies?p=2"), { timeout: 8000 });
    const back = await screen.findByRole("navigation", { name: "Companies pages" }, { timeout: 8000 });
    expect(within(back).getByText("51–100 of 127")).toBeInTheDocument();
    expect(bodyRows()[0]!.cells[0]!.textContent).toBe(name);
  });

  it("Back from a job returns to the same page of Jobs, with its filters", async () => {
    window.location.hash = "#/jobs";
    render(<App bridge={many(124)} />);
    const search = await screen.findByPlaceholderText("Search title, company or place", undefined, { timeout: 8000 });
    await userEvent.type(search, "Example");
    await waitFor(() => expect(window.location.hash).toBe("#/jobs?q=Example"));
    const nav = await screen.findByRole("navigation", { name: "Jobs pages" });
    await userEvent.click(within(nav).getByRole("button", { name: "Page 2" }));
    expect(window.location.hash).toBe("#/jobs?q=Example&p=2");
    const first = bodyRows()[0]!;
    const role = first.textContent;
    await userEvent.click(first);
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/job\//));
    window.history.back();
    await waitFor(() => expect(window.location.hash).toBe("#/jobs?q=Example&p=2"), { timeout: 8000 });
    await waitFor(() => expect(bodyRows()[0]?.textContent).toBe(role), { timeout: 8000 });
    expect(within(pager("Jobs")).getByRole("button", { name: "Page 2" })).toHaveAttribute("aria-current", "page");
  });

  it("Searches pages its log, with filters and the count pinned above the table", async () => {
    window.location.hash = "#/searches";
    renderApp(<SearchesScreen />, { bridge: many(127) });
    const nav = await screen.findByRole("navigation", { name: "Searches pages" });
    expect(within(nav).getByText(/^1–50 of 128$/)).toBeInTheDocument();
    const top = screen.getByLabelText("Find a search").closest(".table-top")!;
    expect(top.className).toContain("table-top--sticky");
    expect(within(top as HTMLElement).getByText(/128 searches/)).toBeInTheDocument();
  });

  it("Jobs fetches every match in chunks, so the footer counts all of them", async () => {
    const b = many(1000);
    const spy = vi.spyOn(b.jobs, "list");
    const all = await listAllJobs(b, { sort: "default" });
    expect(all.rows.length).toBe(all.total);
    expect(all.total).toBeGreaterThan(1000);
    expect(spy.mock.calls.length).toBe(Math.ceil(all.total / 500));
    window.location.hash = "#/jobs";
    renderApp(<JobsScreen route={{ screen: "jobs" }} />, { bridge: b });
    const nav = await screen.findByRole("navigation", { name: "Jobs pages" }, { timeout: 8000 });
    expect(within(nav).getByText(`1–50 of ${all.total}`)).toBeInTheDocument();
    // The search box sits in the sticky block with the count and the Columns menu.
    const top = screen.getByPlaceholderText("Search title, company or place").closest(".table-top")!;
    expect(within(top as HTMLElement).getByRole("button", { name: "Columns" })).toBeInTheDocument();
  });

  it("Jobs keeps its page in the address alongside its filters", async () => {
    window.location.hash = "#/jobs?p=2";
    renderApp(<JobsScreen route={{ screen: "jobs", page: 2 }} />, { bridge: many(127) });
    const nav = await screen.findByRole("navigation", { name: "Jobs pages" }, { timeout: 8000 });
    expect(within(nav).getByRole("button", { name: "Page 2" })).toHaveAttribute("aria-current", "page");
    await waitFor(() => expect(window.location.hash).toBe("#/jobs?p=2"));
    await userEvent.type(screen.getByPlaceholderText("Search title, company or place"), "x");
    await waitFor(() => expect(window.location.hash).toBe("#/jobs?q=x"));
  });

  it("has no footer for a one-row list", async () => {
    renderApp(<SearchesScreen />, { bridge: many(0) });
    await screen.findByRole("table");
    expect(screen.queryByRole("navigation", { name: "Searches pages" })).toBeNull();
  });
});
