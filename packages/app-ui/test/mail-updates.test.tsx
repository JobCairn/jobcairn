import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TodayCard } from "../src/home/cards";
import { MockBridge } from "../src/mock/MockBridge";
import { MailScreen } from "../src/screens/Mail";
import { renderApp } from "./render";

const ACME = ["acme-corp", "2026-01-12-ai-engineer"] as const;
const LABS = ["example-labs", "2026-01-12-backend-engineer-llm"] as const;
const INTERVIEW = "companies/acme-corp/jobs/2026-01-12-ai-engineer/emails/2026-01-14-interview-for-ai-engineer-a1b2c3.json";

describe("Updates from your mail", { timeout: 20_000 }, () => {
  it("shows what an email suggests, and changes nothing until you press Update", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<MailScreen />);
    const card = await screen.findByRole("region", { name: "Updates from your mail" });
    expect(within(card).getByText("AI Engineer")).toBeInTheDocument();
    expect(within(card).getByText(/Acme Corp/)).toBeInTheDocument();
    expect(within(card).getByText(/The employer asked to talk or interview \(email of 14 January 2026\)\. Now Applied\./)).toBeInTheDocument();
    const update = within(card).getByRole("button", { name: "Update to Interview: AI Engineer at Acme Corp" });
    expect(update).toHaveTextContent("Update to Interview");
    expect((await bridge.jobs.get(...ACME)).job.status).toBe("Applied");

    await user.click(update);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Updates from your mail" })).not.toBeInTheDocument());
    const job = (await bridge.jobs.get(...ACME)).job;
    expect(job.status).toBe("Interview");
    expect(job.timeline.at(-1)).toMatchObject({ event: "Status: Interview", note: "From an email: The employer asked to talk or interview (email of 14 January 2026)." });
    expect(bridge.calls.find((c) => c.method === "mail.updates.accept")?.args).toEqual([...ACME, "Interview", INTERVIEW]);
    expect(await screen.findByText("AI Engineer moved to Interview")).toBeInTheDocument();
  });

  it("Dismiss removes the row and leaves the job alone", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<MailScreen />, { bridge: new MockBridge({ mailDemo: true }) });
    const card = await screen.findByRole("region", { name: "Updates from your mail" });
    expect(within(card).getAllByRole("listitem")).toHaveLength(2);
    await user.click(within(card).getByRole("button", { name: "Dismiss: Backend Engineer (LLM) at Example Labs" }));
    await waitFor(() => expect(within(card).getAllByRole("listitem")).toHaveLength(1));
    expect((await bridge.jobs.get(...LABS)).job.status).toBe("Found");
    expect(await bridge.mail.updates.list()).toHaveLength(1);
  });

  it("Open email shows that email", async () => {
    const user = userEvent.setup();
    renderApp(<MailScreen />);
    const card = await screen.findByRole("region", { name: "Updates from your mail" });
    await user.click(within(card).getByRole("button", { name: "Open email: AI Engineer at Acme Corp" }));
    const viewer = await screen.findByRole("region", { name: "Message" });
    expect(within(screen.getByRole("toolbar", { name: "Message actions" })).getByText("Interview for AI Engineer")).toBeInTheDocument();
    expect(within(viewer).getByText("Acme Talent")).toBeInTheDocument();
  });

  it("hides once the job has moved on by hand", async () => {
    const bridge = new MockBridge();
    await bridge.jobs.setStatus(...ACME, "Interview", "");
    expect(await bridge.mail.updates.list()).toEqual([]);
    renderApp(<MailScreen />, { bridge });
    await screen.findByRole("tablist", { name: "Mail sections" });
    expect(screen.queryByRole("region", { name: "Updates from your mail" })).not.toBeInTheDocument();
  });

  it("Home's Today card counts them and goes to Mail", async () => {
    const user = userEvent.setup();
    const bridge = new MockBridge();
    const h = await bridge.home.summary();
    expect(h.mailUpdates).toBe(1);
    renderApp(<TodayCard h={h} />, { bridge });
    await user.click(within(screen.getByRole("list", { name: "Shortcuts" })).getByRole("button", { name: "1 update from your mail" }));
    expect(window.location.hash).toBe("#/mail");
  });
});
