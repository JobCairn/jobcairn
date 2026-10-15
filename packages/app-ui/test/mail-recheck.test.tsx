import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MailSetup } from "../src/components/MailSetup";
import { MailRecheckPrompt, recheckSummary } from "../src/mail/Recheck";
import { MockBridge } from "../src/mock/MockBridge";
import { MailScreen } from "../src/screens/Mail";
import { renderApp } from "./render";

const demo = () => new MockBridge({ mailDemo: true });

describe("Re-check filed mail", { timeout: 20_000 }, () => {
  it("says what will move in plain words", () => {
    expect(recheckSummary({ sort: 8, unfile: 0 })).toBe("8 emails will go back to Mail to sort.");
    expect(recheckSummary({ sort: 0, unfile: 1 })).toBe("1 email will be unfiled because it isn't job mail.");
    expect(recheckSummary({ sort: 1, unfile: 2 })).toBe("1 email will go back to Mail to sort, and 2 will be unfiled because they aren't job mail.");
    expect(recheckSummary({ sort: 0, unfile: 0 })).toBe("Everything filed still matches. Nothing needs to move.");
  });

  it("offers the check once after an update, with the preview, and moves only after confirming", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<MailRecheckPrompt />, { bridge: demo() });
    const dialog = await screen.findByRole("dialog", { name: "Re-check filed mail" });
    expect(await within(dialog).findByText("1 email will go back to Mail to sort, and 1 will be unfiled because it isn't job mail.")).toBeInTheDocument();
    const list = within(dialog).getByRole("list", { name: "Emails that will move" });
    expect(within(list).getByText("Review your Acme Account settings")).toBeInTheDocument();
    expect(within(list).getByText("Unfile")).toBeInTheDocument();
    expect(within(list).getByText("To Mail to sort")).toBeInTheDocument();
    expect(bridge.calls.some((c) => c.method === "mail.recheck.apply")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Move 2 emails" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(bridge.calls.find((c) => c.method === "mail.recheck.apply")?.args[0]).toMatch(/^[0-9a-f]{64}$/);
    expect((await bridge.mail.recheck.preview()).due).toBe(false);
  });

  it("counts Not now as seen, and never offers it when nothing would move", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<MailRecheckPrompt />, { bridge: demo() });
    await user.click(await screen.findByRole("button", { name: "Not now" }));
    await waitFor(() => expect(bridge.calls.some((c) => c.method === "mail.recheck.dismiss")).toBe(true));
    expect(bridge.calls.some((c) => c.method === "mail.recheck.apply")).toBe(false);
    const plain = new MockBridge();
    renderApp(<MailRecheckPrompt />, { bridge: plain });
    await waitFor(() => expect(plain.calls.some((c) => c.method === "mail.recheck.preview")).toBe(true));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("is in Settings › Email and in the Mail screen's menu", async () => {
    const user = userEvent.setup();
    renderApp(<MailSetup />);
    await user.click(await screen.findByRole("button", { name: "Re-check mail…" }));
    const dialog = await screen.findByRole("dialog", { name: "Re-check filed mail" });
    expect(await within(dialog).findByText("Everything filed still matches. Nothing needs to move.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    renderApp(<MailScreen />, { bridge: demo() });
    await user.click(await screen.findByRole("button", { name: "More mail actions" }));
    expect(screen.getByRole("menuitem", { name: "Free space…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Email settings" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Re-check mail…" }));
    expect(await screen.findByRole("button", { name: "Move 2 emails" })).toBeInTheDocument();
  });
});
