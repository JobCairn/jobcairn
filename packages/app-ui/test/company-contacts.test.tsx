import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockBridge, loadFixture } from "../src/mock/MockBridge";
import { CompanyScreen } from "../src/screens/Company";
import { renderApp } from "./render";

const CAREERS = "careers" + "@" + "example.com";
const route = (slug: string) => ({ screen: "company" as const, slug, tab: "contacts" });

afterEach(() => { cleanup(); window.location.hash = ""; });

describe("Company contacts tab", () => {
  it("shows the careers page, job board and emails grouped by kind, with source, date and the published-only note", async () => {
    const { bridge } = renderApp(<CompanyScreen route={route("acme-corp")} />);
    expect(await screen.findByText("Only addresses the company publishes. Check before sending.")).toBeInTheDocument();
    const careers = screen.getByRole("list", { name: "Careers emails" });
    expect(within(careers).getByText(CAREERS)).toBeInTheDocument();
    expect(within(careers).getByRole("button", { name: "Found on acme.example.com" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "HR emails" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "General emails" })).toBeInTheDocument();
    expect(screen.getAllByText("Not confirmed")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Open acme.example.com" }));
    await userEvent.click(screen.getByRole("button", { name: "Open boards.example.com" }));
    expect(bridge.calls.filter((c) => c.method === "links.open").map((c) => c.args[0])).toEqual(["https://acme.example.com/careers", "https://boards.example.com/acme-corp"]);
  });

  it("copies an address", async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, "writeText");
    renderApp(<CompanyScreen route={route("acme-corp")} />);
    await user.click(await screen.findByRole("button", { name: `Copy ${CAREERS}` }));
    expect(write).toHaveBeenCalledWith(CAREERS);
    expect(await screen.findByText("Address copied")).toBeInTheDocument();
  });

  it("Email opens the draft editor filed on the company's job, prefilled with the address", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<CompanyScreen route={route("acme-corp")} />);
    await user.click(await screen.findByRole("button", { name: `Email ${CAREERS}` }));
    const editor = await screen.findByRole("form", { name: "Email draft" });
    expect(within(editor).getByRole("button", { name: `Remove ${CAREERS}` })).toBeInTheDocument();
    await user.type(within(editor).getByLabelText("Subject"), "Question about roles");
    await user.click(within(editor).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "mail.drafts.save")?.args).toEqual([
      "acme-corp", "2026-01-12-ai-engineer", "", expect.objectContaining({ to: CAREERS, subject: "Question about roles" }),
    ]));
  });

  it("offers Research company when there are no contacts yet", async () => {
    renderApp(<CompanyScreen route={route("example-labs")} />);
    expect(await screen.findByText(/No careers page or contact emails for Example Labs yet/)).toBeInTheDocument();
    expect((await screen.findAllByRole("button", { name: /Research company/ })).length).toBeGreaterThan(0);
  });

  it("drops bad entries and says so", async () => {
    const f = loadFixture();
    f.texts["companies/example-labs/contacts.json"] = JSON.stringify({
      careers_url: "http://labs.example.com/careers",
      emails: [{ address: "jobs" + "@" + "example.com", kind: "recruiting", source_url: "https://labs.example.com/jobs", confirmed: true }, { address: "bad", kind: "hr", source_url: "https://labs.example.com" }],
    });
    renderApp(<CompanyScreen route={route("example-labs")} />, { bridge: new MockBridge({ fixture: f }) });
    expect(await screen.findByRole("list", { name: "Recruiting emails" })).toBeInTheDocument();
    expect(screen.queryByText(/Careers page/)).toBeNull();
    expect(screen.getByText(/1 entry was left out/)).toBeInTheDocument();
  });
});
