import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { formatWhen, GOOGLE_LINKS } from "../src/components/MailSetup";
import { MOCK_GOOD_PASSWORD } from "../src/mock/mail-mock";
import { MockBridge } from "../src/mock/MockBridge";
import { SettingsScreen } from "../src/screens/Settings";
import { renderApp } from "./render";
import brand from "@careeros/brand/identity.json" with { type: "json" };

const ADDRESS = "alex" + "@" + "example.com";

async function openEmail(bridge: MockBridge) {
  const user = userEvent.setup();
  // Settings > Connections, Email row (the deep link opens it).
  renderApp(<SettingsScreen />, { bridge, hash: "#/settings?tab=connections&c=email" });
  const regions = await screen.findAllByRole("region", { name: /^Email \(Gmail\)/ });
  return { user, card: regions.find((r) => r.id === "conn-email-panel")! };
}

// userEvent types every letter, so the full walk-through can pass 5 s on a loaded machine (as in resume-studio.test).
describe("Email setup", { timeout: 20_000 }, () => {
  it("walks through the steps, tests, then saves only after a pass", async () => {
    const bridge = new MockBridge({ mailConnected: false });
    const { user, card } = await openEmail(bridge);
    await user.click(within(card).getByRole("button", { name: "App passwords" }));
    expect(bridge.opened).toEqual(["https://myaccount.google.com/apppasswords"]);
    await user.type(within(card).getByLabelText("Gmail address"), ADDRESS);
    await user.type(within(card).getByLabelText("Your name, as people will see it"), "Alex Example");
    const pw = within(card).getByLabelText("App password (16 letters)");
    expect(pw).toHaveAttribute("type", "password");
    expect(within(card).queryByRole("button", { name: "Save & connect" })).not.toBeInTheDocument();
    await user.type(pw, MOCK_GOOD_PASSWORD);
    await user.click(within(card).getByRole("button", { name: "Test connection" }));
    const results = await within(card).findByRole("list", { name: "Connection test" });
    expect(within(results).getAllByText("Passed")).toHaveLength(3);
    expect(within(results).getByText(`Gmail will accept mail you send from ${brand.name}. Nothing was sent.`)).toBeInTheDocument();
    expect(pw).toHaveValue("");
    await user.click(within(card).getByRole("button", { name: "Save & connect" }));
    expect(await within(card).findByText(`Connected as ${ADDRESS}`)).toBeInTheDocument();
    expect(within(card).queryByLabelText("App password (16 letters)")).not.toBeInTheDocument();
    expect(JSON.stringify(bridge.calls)).not.toContain(MOCK_GOOD_PASSWORD);
  });
  // The wording main's KeychainAccessError uses (app-electron/src/secret-store.ts).
  const KEYCHAIN_DENIED = "CareerOS couldn't use the Keychain, so your key wasn't saved.";
  async function testThenSave(bridge: MockBridge) {
    const { user, card } = await openEmail(bridge);
    await user.type(within(card).getByLabelText("Gmail address"), ADDRESS);
    await user.type(within(card).getByLabelText("App password (16 letters)"), MOCK_GOOD_PASSWORD);
    await user.click(within(card).getByRole("button", { name: "Test connection" }));
    await within(card).findByRole("list", { name: "Connection test" });
    await user.click(within(card).getByRole("button", { name: "Save & connect" }));
    return { user, card };
  }
  it("a Keychain denial on save shows a plain message and Try again, with no error toast", async () => {
    const bridge = new MockBridge({ mailConnected: false });
    bridge.mail.saveAccount = async () => { throw new Error(KEYCHAIN_DENIED); };
    const { user, card } = await testThenSave(bridge);
    const alert = await within(card).findByRole("alert");
    expect(alert).toHaveTextContent("couldn't use the Keychain");
    expect(alert).toHaveTextContent("Paste the app password again and test, then save.");
    // Only the inline alert says it: no error toast repeats the message.
    expect(screen.getAllByText(/couldn't use the Keychain/)).toHaveLength(1);
    // The tested password is gone, so Save goes away until a fresh paste and test.
    expect(within(card).queryByRole("button", { name: "Save & connect" })).not.toBeInTheDocument();
    expect(within(card).getByLabelText("App password (16 letters)")).toHaveValue("");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(within(card).queryByText(/couldn't use the Keychain/)).not.toBeInTheDocument();
    expect(within(card).getByLabelText("App password (16 letters)")).toHaveFocus();
  });
  it("any other save failure shows the normal error toast, not the Keychain message", async () => {
    const bridge = new MockBridge({ mailConnected: false });
    bridge.mail.saveAccount = async () => { throw new Error("Secure storage isn't available on this computer, so the password was not saved."); };
    const { card } = await testThenSave(bridge);
    expect(await screen.findByText(/Secure storage isn't available on this computer/)).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });
  it("shows each failed check with its fix and offers no save", async () => {
    const { user, card } = await openEmail(new MockBridge({ mailConnected: false }));
    await user.type(within(card).getByLabelText("Gmail address"), ADDRESS);
    await user.type(within(card).getByLabelText("App password (16 letters)"), "zzzz yyyy xxxx wwww");
    await user.click(within(card).getByRole("button", { name: "Test connection" }));
    const results = await within(card).findByRole("list", { name: "Connection test" });
    expect(within(results).getAllByText("Gmail didn't accept the address and app password.")).toHaveLength(2);
    expect(within(results).getAllByText(/paste all 16 letters/)).toHaveLength(2);
    expect(within(card).queryByRole("button", { name: "Save & connect" })).not.toBeInTheDocument();
  });
  it("explains a password that isn't an app password, without contacting Gmail", async () => {
    const bridge = new MockBridge({ mailConnected: false });
    const { user, card } = await openEmail(bridge);
    await user.type(within(card).getByLabelText("Gmail address"), ADDRESS);
    await user.type(within(card).getByLabelText("App password (16 letters)"), "my normal password");
    await user.click(within(card).getByRole("button", { name: "Test connection" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("An app password is 16 letters.");
  });
  it("hides Save again when the address changes after a test", async () => {
    const { user, card } = await openEmail(new MockBridge({ mailConnected: false }));
    const address = within(card).getByLabelText("Gmail address");
    await user.type(address, ADDRESS);
    await user.type(within(card).getByLabelText("App password (16 letters)"), MOCK_GOOD_PASSWORD);
    await user.click(within(card).getByRole("button", { name: "Test connection" }));
    await within(card).findByRole("button", { name: "Save & connect" });
    await user.type(address, "x");
    expect(within(card).queryByRole("button", { name: "Save & connect" })).not.toBeInTheDocument();
  });
  it("edits the signature with a preview, and turns background sync on with the OS status", async () => {
    const bridge = new MockBridge();
    const { user, card } = await openEmail(bridge);
    const sig = await within(card).findByLabelText("Signature");
    await user.clear(sig);
    await user.type(sig, "Alex Example{Enter}Senior AI Engineer");
    expect(within(card).getByLabelText("Signature preview")).toHaveTextContent("Senior AI Engineer");
    await user.click(within(card).getByRole("button", { name: "Save signature" }));
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "mail.setSignature")?.args).toEqual(["Alex Example\nSenior AI Engineer"]));
    await user.click(within(card).getByRole("switch", { name: "Sync in the background" }));
    expect(await within(card).findByText("Scheduled (mock).")).toBeInTheDocument();
    expect(bridge.calls.find((c) => c.method === "mail.background.set")?.args).toEqual([true, 60]);
  });
  it("disconnects after a confirmation", async () => {
    const bridge = new MockBridge();
    const { user, card } = await openEmail(bridge);
    await user.click(await within(card).findByRole("button", { name: "Disconnect" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect Gmail" }));
    expect(await within(card).findByLabelText("Gmail address")).toBeInTheDocument();
  });
});

describe("Email setup details", { timeout: 20_000 }, () => {
  it("accepts the password as Google shows it, in four groups", async () => {
    const { user, card } = await openEmail(new MockBridge({ mailConnected: false }));
    await user.type(within(card).getByLabelText("Gmail address"), ADDRESS);
    await user.type(within(card).getByLabelText("App password (16 letters)"), "abcd efgh ijkl mnop");
    await user.click(within(card).getByRole("button", { name: "Test connection" }));
    expect(await within(card).findByRole("button", { name: "Save & connect" })).toBeInTheDocument();
  });
  it("never sends a normal password to Gmail and never shows the password again", async () => {
    const bridge = new MockBridge({ mailConnected: false });
    const { user, card } = await openEmail(bridge);
    await user.type(within(card).getByLabelText("Gmail address"), ADDRESS);
    await user.type(within(card).getByLabelText("App password (16 letters)"), "my normal password");
    await user.click(within(card).getByRole("button", { name: "Test connection" }));
    await within(card).findByRole("alert");
    expect(bridge.calls.some((c) => c.method === "mail.testConnection")).toBe(false);
    expect(document.body.innerHTML).not.toContain("my normal password");
  });
  it("says why Test connection is disabled", async () => {
    const { user, card } = await openEmail(new MockBridge({ mailConnected: false }));
    const button = within(card).getByRole("button", { name: "Test connection" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Enter your Gmail address and app password to test.");
    await user.type(within(card).getByLabelText("Gmail address"), ADDRESS);
    expect(button).toHaveAccessibleDescription("Paste the app password to test.");
  });
  it("opens every Google help page through the safe-link bridge", async () => {
    const bridge = new MockBridge({ mailConnected: false });
    const { user, card } = await openEmail(bridge);
    await user.click(within(card).getByRole("button", { name: "2-Step Verification" }));
    await user.click(within(card).getByRole("button", { name: "IMAP settings" }));
    expect(bridge.opened).toEqual([GOOGLE_LINKS.twoStep, GOOGLE_LINKS.imap]);
  });
  it("replaces the password only after it tests, and keeps the old one on failure", async () => {
    const bridge = new MockBridge();
    const { user, card } = await openEmail(bridge);
    const field = await within(card).findByLabelText("Replace the app password");
    const button = within(card).getByRole("button", { name: "Replace password" });
    expect(button).toHaveAccessibleDescription("Paste a new app password to replace the current one.");
    await user.type(field, "zzzz yyyy xxxx wwww");
    await user.click(button);
    expect(await within(card).findByText(/The new password didn't work/)).toBeInTheDocument();
    expect(field).toHaveValue("");
    await user.type(field, MOCK_GOOD_PASSWORD);
    await user.click(button);
    expect(await screen.findByText("App password replaced")).toBeInTheDocument();
    expect(JSON.stringify(bridge.calls)).not.toContain(MOCK_GOOD_PASSWORD);
  });
  it("says why Save signature is disabled when nothing changed", async () => {
    const { card } = await openEmail(new MockBridge());
    const button = await within(card).findByRole("button", { name: "Save signature" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("No changes to save.");
  });
  it("offers background intervals from 15 minutes to a day", async () => {
    const bridge = new MockBridge();
    const { user, card } = await openEmail(bridge);
    const every = await within(card).findByLabelText("How often");
    expect([...(every as HTMLSelectElement).options].map((o) => o.value)).toEqual(["15", "30", "60", "120", "240", "720", "1440"]);
    await user.selectOptions(every, "1440");
    await waitFor(() => expect(bridge.calls.find((c) => c.method === "mail.background.set")?.args).toEqual([false, 1440]));
  });
  it("explains when secure storage is missing instead of showing the wizard", async () => {
    const { card } = await openEmail(new MockBridge({ mailConnected: false, secretStoreAvailable: false }));
    expect(await within(card).findByText(/so Gmail can't be connected/)).toBeInTheDocument();
    expect(within(card).queryByLabelText("Gmail address")).not.toBeInTheDocument();
  });
});

describe("formatWhen", () => {
  const now = new Date("2026-01-15T09:00:00.000Z");
  it("speaks in minutes near now and falls back to a date", () => {
    expect(formatWhen("", now)).toBe("never");
    expect(formatWhen("2026-01-15T08:59:50.000Z", now)).toBe("just now");
    expect(formatWhen("2026-01-15T08:45:00.000Z", now)).toBe("15 min ago");
    expect(formatWhen("2026-01-15T09:15:00.000Z", now)).toBe("in 15 min");
    expect(formatWhen("2026-01-12T10:00:00.000Z", now)).toMatch(/12/);
  });
});
