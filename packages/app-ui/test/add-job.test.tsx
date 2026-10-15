import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AddJobDialog, asLink, routeHint } from "../src/addjob/AddJobDialog";
import { MockBridge } from "../src/mock/MockBridge";
import { JobsScreen } from "../src/screens/Jobs";
import { renderApp } from "./render";

const dialog = () => screen.getByRole("dialog");
async function paste(text: string) {
  const box = within(dialog()).getByLabelText("Job link or ad text");
  await userEvent.click(box);
  await userEvent.paste(text);
}

describe("Add a job: the hint says where a link is read from", () => {
  it("routes applicant systems, boards and other sites", () => {
    expect(asLink(" https://jobs.lever.co/acme/x ")).toBe("https://jobs.lever.co/acme/x");
    expect(asLink("Senior AI Engineer\nAcme")).toBeNull();
    expect(routeHint("https://boards.greenhouse.io/examplelabs/jobs/1", null)).toMatch(/^Greenhouse job: its public details are read/);
    expect(routeHint("https://www.seek.com.au/job/1", true)).toMatch(/read in your Chrome, in a new tab that closes/);
    expect(routeHint("https://www.seek.com.au/job/1", false)).toMatch(/Connect Chrome first, or paste the ad's text/);
    expect(routeHint("https://careers.example.com/42", null)).toMatch(/isn't read from the app/);
    expect(routeHint("http://example.com", null)).toMatch(/https:\/\//);
  });
});

describe("Add a job dialog", () => {
  it("reads an applicant-system link, shows an editable preview, and saves it to the shortlist", async () => {
    const { bridge } = renderApp(<JobsScreen route={{ screen: "jobs" }} />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Add job" }));
    await paste("https://boards.greenhouse.io/example-labs/jobs/4012345");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Continue" }));
    expect(await within(dialog()).findByLabelText("Job title")).toHaveValue("Applied AI Engineer");
    expect(within(dialog()).getByLabelText("Company")).toHaveValue("Example Labs");
    expect(within(dialog()).getByLabelText("Work rights in the ad")).toHaveValue("sponsorship_offered");
    expect(within(dialog()).getByText("Visa sponsorship is available for the right candidate.")).toBeInTheDocument();
    // The person corrects the title before saving.
    const t = within(dialog()).getByLabelText("Job title");
    await userEvent.clear(t);
    await userEvent.type(t, "Applied AI Engineer (Platform)");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save job" }));
    expect(await within(dialog()).findByText(/Applied AI Engineer \(Platform\) at Example Labs is in your jobs/)).toBeInTheDocument();
    const add = bridge.calls.find((c) => c.method === "jobs.add")!;
    expect(add.args[1]).toBe("Saved");
    expect(add.args[0]).toMatchObject({ title: "Applied AI Engineer (Platform)", company: "Example Labs", url: "https://boards.greenhouse.io/example-labs/jobs/4012345", rights: "sponsorship_offered" });
    expect(within(dialog()).getByRole("button", { name: "Score fit" })).toBeInTheDocument();
    expect(within(dialog()).getByRole("button", { name: "Tailor resume" })).toBeInTheDocument();
    expect(within(dialog()).getByRole("button", { name: "About Example Labs" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("table")).toHaveTextContent("Applied AI Engineer (Platform)"));
  });

  it("can't save without a title or company, and says why", async () => {
    renderApp(<AddJobDialog open onClose={() => undefined} />);
    await paste("Some ad text without much in it.\nMore text here.");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Continue" }));
    const company = await within(dialog()).findByLabelText("Company");
    await userEvent.clear(company);
    const save = within(dialog()).getByRole("button", { name: "Save job" });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute("title", "Add the company to save.");
  });

  it("asks for the ad's text when a board needs Chrome, and previews the pasted text with the link kept", async () => {
    const { bridge } = renderApp(<AddJobDialog open onClose={() => undefined} />);
    await paste("https://www.seek.com.au/job/81234567");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Continue" }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent("SEEK ads are read in your own Chrome");
    const text = within(dialog()).getByLabelText("The ad's text");
    await userEvent.click(text);
    await userEvent.paste("Data Engineer\nAcme Recruiting\nRemote\n\nWorking holiday visa holders welcome.");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Continue" }));
    expect(await within(dialog()).findByLabelText("Job title")).toHaveValue("Data Engineer");
    expect(bridge.calls.filter((c) => c.method === "jobs.preview").at(-1)!.args[0]).toMatchObject({ url: "https://www.seek.com.au/job/81234567" });
    expect(within(dialog()).getByLabelText("Work rights in the ad")).toHaveValue("visa_ok");
  });

  it("says when the job is already in the list, and offers to open it instead of saving twice", async () => {
    const bridge = new MockBridge();
    renderApp(<AddJobDialog open onClose={() => undefined} />, { bridge });
    await paste("AI Engineer\nAcme Corp\n\nBuild agents.");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Continue" }));
    expect(await within(dialog()).findByText("Already in your jobs: AI Engineer at Acme Corp.")).toBeInTheDocument();
    expect(within(dialog()).getByRole("button", { name: "Open it" })).toBeInTheDocument();
    expect(within(dialog()).queryByRole("button", { name: "Save job" })).not.toBeInTheDocument();
  });

  it("hands the saved job to the caller when it asks (Resumes: For a job ad)", async () => {
    let got = "";
    renderApp(<AddJobDialog open onClose={() => undefined} saveLabel="Save and tailor" onAdded={(j) => { got = `${j.company_slug}/${j.id}`; }} />);
    await paste("Prompt Engineer\nExample Studio\n\nWrite prompts.");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Continue" }));
    await userEvent.click(await within(dialog()).findByRole("button", { name: "Save and tailor" }));
    await waitFor(() => expect(got).toMatch(/^example-studio\/\d{4}-\d{2}-\d{2}-prompt-engineer$/));
  });
});
