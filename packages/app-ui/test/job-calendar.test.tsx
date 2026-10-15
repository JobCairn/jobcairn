import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MockBridge } from "../src/mock/MockBridge";
import { JobScreen } from "../src/screens/Job";
import { renderApp } from "./render";

const LABS = { screen: "job", slug: "example-labs", id: "2026-01-12-backend-engineer-llm" } as const;

describe("interview date on the job page", () => {
  it("saves a date and time, then offers Add to Calendar", async () => {
    const { bridge } = renderApp(<JobScreen route={{ ...LABS, tab: "interview" }} />);
    const section = await screen.findByRole("region", { name: "Interview date" });
    expect(within(section).queryByRole("button", { name: "Add to Calendar" })).toBeNull();
    const input = within(section).getByLabelText("Interview date and time");
    await userEvent.type(input, "2026-01-21T14:30");
    await userEvent.click(within(section).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bridge.calls.some((c) => c.method === "jobs.setInterview" && c.args[2] === "2026-01-21T14:30")).toBe(true));
    await userEvent.click(await within(section).findByRole("button", { name: "Add to Calendar" }));
    await waitFor(() => expect(bridge.openedFiles).toEqual(["companies/example-labs/jobs/2026-01-12-backend-engineer-llm/calendar/interview.ics"]));
    expect(await screen.findByText("Opened in your calendar")).toBeInTheDocument();
  });

  it("clears the time", async () => {
    const b = new MockBridge();
    await b.jobs.setInterview(LABS.slug, LABS.id, "2026-01-21T14:30");
    renderApp(<JobScreen route={{ ...LABS, tab: "interview" }} />, { bridge: b });
    const section = await screen.findByRole("region", { name: "Interview date" });
    expect(within(section).getByLabelText("Interview date and time")).toHaveValue("2026-01-21T14:30");
    await userEvent.click(within(section).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(within(section).queryByRole("button", { name: "Add to Calendar" })).toBeNull());
    expect((await b.jobs.get(LABS.slug, LABS.id)).job.interview_at).toBe("");
  });
});

describe("follow-up date on the timeline", () => {
  it("shows when to follow up once applied, with Add to Calendar", async () => {
    const b = new MockBridge();
    await b.jobs.setStatus(LABS.slug, LABS.id, "Applied", "");
    renderApp(<JobScreen route={{ ...LABS, tab: "timeline" }} />, { bridge: b });
    const section = await screen.findByRole("region", { name: "Follow-up date" });
    expect(section).toHaveTextContent(/^Follow up by \w+,? 22 Jan 2026 if there's no reply\./);
    await userEvent.click(within(section).getByRole("button", { name: "Add to Calendar" }));
    await waitFor(() => expect(b.openedFiles).toEqual(["companies/example-labs/jobs/2026-01-12-backend-engineer-llm/calendar/follow-up.ics"]));
  });

  it("isn't there before applying", async () => {
    renderApp(<JobScreen route={{ ...LABS, tab: "timeline" }} />);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("region", { name: "Follow-up date" })).toBeNull();
  });
});
