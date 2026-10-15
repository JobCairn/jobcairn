import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "@careeros/brand";
import type { TrashTarget } from "@careeros/contract";
import { MockBridge } from "../src/mock/MockBridge";
import { JobScreen } from "../src/screens/Job";
import { JobsScreen } from "../src/screens/Jobs";
import { CompanyScreen } from "../src/screens/Company";
import { SettingsScreen } from "../src/screens/Settings";
import { useDelete } from "../src/trash";
import { renderApp } from "./render";

const ACME = { screen: "job", slug: "acme-corp", id: "2026-01-12-ai-engineer" } as const;
const LABS = { screen: "job", slug: "example-labs", id: "2026-01-12-backend-engineer-llm" } as const;
const has = (b: MockBridge, slug: string, id: string) => b.jobs.list({}).then((l) => l.rows.some((r) => r.company_slug === slug && r.id === id));

afterEach(() => { window.location.hash = ""; });

describe("Delete a job", () => {
  it("asks with the job's name, leaves the page, and Undo brings the job and the page back", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<JobScreen route={ACME} />);
    await user.click(await screen.findByRole("button", { name: "More job actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete job" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete AI Engineer at Acme Corp?" });
    expect(bridge.calls.some((c) => c.method === "trash.move")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Delete job" }));
    await waitFor(() => expect(window.location.hash).toBe("#/jobs"));
    expect(await has(bridge, ACME.slug, ACME.id)).toBe(false);
    await user.click(await screen.findByRole("button", { name: "Undo deleting AI Engineer at Acme Corp" }));
    await waitFor(() => expect(window.location.hash).toBe(`#/job/${ACME.slug}/${ACME.id}`));
    expect(await has(bridge, ACME.slug, ACME.id)).toBe(true);
  });

  it("says why a job can't be deleted, with Delete turned off", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<JobScreen route={LABS} />);
    await user.click(await screen.findByRole("button", { name: "More job actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete job" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/waiting for your approval/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Delete job" })).toBeDisabled();
    expect(bridge.calls.some((c) => c.method === "trash.move")).toBe(false);
  });

  it("deletes a row from the Jobs table after asking", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<JobsScreen route={{ screen: "jobs" }} />);
    await user.click(await screen.findByRole("button", { name: "Delete job: AI Engineer" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete AI Engineer at Acme Corp?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete job" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Delete job: AI Engineer" })).toBeNull());
    expect(await has(bridge, ACME.slug, ACME.id)).toBe(false);
  });
});

describe("Delete a company", () => {
  it("names the jobs that go with it", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<CompanyScreen route={{ screen: "company", slug: "acme-corp" }} />);
    await user.click(await screen.findByRole("button", { name: "More company actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete company" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Acme Corp and its 1 job?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete company" }));
    await waitFor(() => expect(window.location.hash).toBe("#/companies"));
    expect(await has(bridge, ACME.slug, ACME.id)).toBe(false);
  });
});

function Harness({ targets }: { targets: TrashTarget[] }) {
  const del = useDelete();
  return <><Button onClick={() => del.ask(targets, { label: "Delete jobs", plural: "jobs" })}>Go</Button>{del.element}</>;
}

describe("Delete several", () => {
  it("lists them, deletes them together, and one Undo restores them all", async () => {
    const user = userEvent.setup();
    const targets: TrashTarget[] = [{ kind: "job", company_slug: ACME.slug, id: ACME.id }, { kind: "job", company_slug: "acme-recruiting", id: "2026-01-12-ai-developer" }];
    const { bridge } = renderApp(<Harness targets={targets} />);
    await user.click(screen.getByRole("button", { name: "Go" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete 2 jobs?" });
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);
    await user.click(within(dialog).getByRole("button", { name: "Delete jobs" }));
    await screen.findByText("Deleted 2 jobs.");
    expect((await bridge.trash.list()).length).toBe(2);
    await user.click(screen.getByRole("button", { name: "Undo delete" }));
    await screen.findByText("Restored 2 items.");
    expect(await has(bridge, ACME.slug, ACME.id)).toBe(true);
  });

  it("one that can't go stops all of them", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<Harness targets={[{ kind: "job", company_slug: ACME.slug, id: ACME.id }, { kind: "job", company_slug: LABS.slug, id: LABS.id }]} />);
    await user.click(screen.getByRole("button", { name: "Go" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete 2 jobs?" });
    expect(await within(dialog).findByText(/Backend Engineer.* can't be deleted right now/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Delete jobs" })).toBeDisabled();
    expect(await has(bridge, ACME.slug, ACME.id)).toBe(true);
  });
});

describe("Settings › Workspace › Recently deleted", () => {
  it("restores an item, and deletes one forever only after asking", async () => {
    const user = userEvent.setup();
    const bridge = new MockBridge();
    await bridge.trash.move([{ kind: "job", company_slug: ACME.slug, id: ACME.id }]);
    await bridge.trash.move([{ kind: "company", company_slug: "acme-recruiting" }]);
    renderApp(<SettingsScreen />, { bridge, hash: "#/settings?tab=workspace" });
    const card = await screen.findByLabelText("Recently deleted");
    expect(await within(card).findByText("Acme Recruiting and its 1 job")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Restore AI Engineer at Acme Corp" }));
    await waitFor(() => expect(within(card).queryByText("AI Engineer at Acme Corp")).toBeNull());
    expect(await has(bridge, ACME.slug, ACME.id)).toBe(true);

    await user.click(within(card).getByRole("button", { name: "Delete Acme Recruiting forever" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Acme Recruiting for good?" });
    expect((await bridge.trash.list()).length).toBe(1);
    await user.click(within(dialog).getByRole("button", { name: "Delete forever" }));
    await within(card).findByText("Nothing deleted in the last 30 days.");
  });
});
