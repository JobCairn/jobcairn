import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsData } from "@careeros/contract";
import { getPath, isDateField, toValue } from "../src/components/FieldForm";
import { loadFixture, MockBridge } from "../src/mock/MockBridge";
import { SettingsScreen } from "../src/screens/Settings";
import { renderApp } from "./render";

// The whole screen mounts every tab's panel at once, and some flows are many steps: give them room on a loaded machine.
vi.setConfig({ testTimeout: 15_000 });
/** Waits that ride on the real autosave pause (800 ms) or a reload: generous, so a loaded machine doesn't flake them. */
const SLOW = { timeout: 8000 };

/** The page-level autosave line by the tab bar. */
const saveLine = () => { const el = document.querySelector<HTMLElement>(".autosave-status [role=status]"); if (!el) throw new Error("no autosave line"); return el; };
const saves = (b: MockBridge) => b.calls.filter((c) => c.method === "settings.save").map((c) => c.args);
const field = (over: object) => ({ path: "x", label: "X", type: "string", options: [], optionLabels: {}, help: "", pattern: "", fields: [], ...over });


/** The API key row is folded away while Claude uses the person's plan; opens it (no-op once a key is saved). */
async function openApiKey() {
  const b = await screen.findByRole("button", { name: /^(Use an API key instead|Switch back to my Claude plan)$/ });
  if (b.getAttribute("aria-expanded") === "false") fireEvent.click(b);
}

describe("toValue", () => {
  it("converts form text to typed values", () => {
    expect(toValue(field({ type: "string[]" }), " a, b ,, c ")).toEqual({ value: ["a", "b", "c"] });
    expect(toValue(field({ type: "number|null" }), "")).toEqual({ value: null });
    expect(toValue(field({ type: "number" }), "12x")).toEqual({ error: "Enter a number." });
    expect(toValue(field({ type: "number|null" }), "-")).toEqual({ error: "Enter a number." });
    expect(toValue(field({ pattern: "^(\\d{4}-\\d{2}-\\d{2})?$" }), "30/06/2028")).toEqual({ error: "Doesn't match the expected format." });
  });
  it("rejects fractions on integer fields with 'Enter a whole number.'", () => {
    expect(toValue(field({ type: "integer" }), "1.5")).toEqual({ error: "Enter a whole number." });
    expect(toValue(field({ type: "integer|null" }), "2.25")).toEqual({ error: "Enter a whole number." });
    expect(toValue(field({ type: "integer" }), "4")).toEqual({ value: 4 });
    expect(toValue(field({ type: "integer|null" }), "")).toEqual({ value: null });
  });
});

describe("getPath", () => {
  it("reads a dotted path's own properties", () => {
    expect(getPath({ a: { b: 1 } }, "a.b")).toBe(1);
    expect(getPath({ a: { b: 1 } }, "a.c")).toBeUndefined();
    expect(getPath({ a: null }, "a.b")).toBeUndefined();
    expect(getPath(null, "a.b")).toBeUndefined();
  });

  it("refuses __proto__, prototype and constructor segments and never pollutes Object.prototype", () => {
    expect(getPath({}, "__proto__.polluted")).toBeUndefined();
    expect(getPath({}, "constructor.prototype.polluted")).toBeUndefined();
    expect(getPath({ a: {} }, "a.prototype.polluted")).toBeUndefined();
    // The reads above must never have set anything on the shared prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("Settings", () => {
  beforeEach(() => { window.location.hash = ""; sessionStorage.clear(); });
  it("has no Save or Discard footer: the forms save themselves", async () => {
    renderApp(<SettingsScreen />);
    await screen.findByLabelText("Full name");
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(screen.queryByText("You have unsaved changes.")).toBeNull();
    expect(saveLine()).toHaveTextContent("Changes save automatically");
  });
  it("saves a select as soon as it changes, sends only that field, and job eligibility follows", async () => {
    const { bridge } = renderApp(<SettingsScreen />);
    await userEvent.selectOptions(await screen.findByLabelText("Work rights"), "citizen");
    await waitFor(() => expect(saves(bridge)).toEqual([["profile", [{ path: "work_rights.status", value: "citizen" }]]]));
    expect((await bridge.jobs.list({})).hiddenIneligible).toBe(0);
  });
  it("keeps commas while typing a list and saves it as a list", async () => {
    const { bridge } = renderApp(<SettingsScreen />);
    const words = await screen.findByLabelText("Keywords");
    await userEvent.clear(words);
    await userEvent.type(words, "RAG, ");
    // A pause in typing saves, but the trailing comma stays in the box so you can keep typing the list.
    await waitFor(() => expect(saves(bridge).at(-1)).toEqual(["profile", [{ path: "targets.keywords", value: ["RAG"] }]]), SLOW);
    expect(words).toHaveValue("RAG, ");
    await userEvent.type(words, "Evals");
    expect(words).toHaveValue("RAG, Evals");
    await userEvent.tab();
    await waitFor(() => expect(saves(bridge).at(-1)).toEqual(["profile", [{ path: "targets.keywords", value: ["RAG", "Evals"] }]]));
  });
  it("edits the visa expiry with a date picker and saves the ISO date", async () => {
    const { bridge } = renderApp(<SettingsScreen />);
    const visa = await screen.findByLabelText("Visa expiry");
    expect(visa).toHaveAttribute("type", "date");
    fireEvent.change(visa, { target: { value: "2029-01-31" } });
    await waitFor(() => expect(saves(bridge)[0]).toEqual(["profile", [{ path: "work_rights.visa_expiry", value: "2029-01-31" }]]));
    expect(await waitFor(() => saveLine())).toHaveTextContent("All changes saved");
  });
  it("rejects text that doesn't match a field's format", () => {
    const f = { path: "x", label: "X", type: "string", options: [], optionLabels: {}, help: "", pattern: "^(\\d{4}-\\d{2}-\\d{2})?$", fields: [] };
    expect(toValue(f, "30/06/2028")).toEqual({ error: "Doesn't match the expected format." });
    expect(isDateField(f)).toBe(true);
    expect(isDateField({ ...f, pattern: "", label: "Phone" })).toBe(false);
  });
  it("sends only the changed fields, never the whole profile", async () => {
    const { bridge } = renderApp(<SettingsScreen />);
    await userEvent.clear(await screen.findByLabelText("Full name"));
    await userEvent.type(screen.getByLabelText("Full name"), "Alex Sample");
    await userEvent.tab();
    await waitFor(() => expect(saves(bridge).at(-1)).toEqual(["profile", [{ path: "contact.name", value: "Alex Sample" }]]));
    // Leaving the field and waiting past the typing pause doesn't send it a second time.
    const count = saves(bridge).length;
    await new Promise((r) => setTimeout(r, 1000));
    expect(saves(bridge)).toHaveLength(count);
    // Every save (a slow machine may also save mid-typing) carries that one field only.
    for (const [kind, changes] of saves(bridge)) {
      expect(kind).toBe("profile");
      expect((changes as { path: string }[]).map((c) => c.path)).toEqual(["contact.name"]);
    }
  });
  it("validates partial or invalid numeric input instead of silently saving null", async () => {
    // A native type="number" input reports an empty value for perfectly normal in-progress
    // keystrokes ("-", "1e", "."), which used to read as "cleared" and silently save null.
    const { bridge } = renderApp(<SettingsScreen />);
    const min = await screen.findByLabelText("Minimum salary");
    expect(min).toHaveAttribute("type", "text");
    expect(min).toHaveAttribute("inputmode", "decimal");

    // Set the box straight to each bad value (never through empty, which is a valid "no minimum").
    fireEvent.change(min, { target: { value: "-" } });
    fireEvent.blur(min);
    expect(await screen.findByText("Enter a number.")).toBeInTheDocument();
    expect(min).toHaveAttribute("aria-invalid", "true");
    expect(min).toHaveValue("-");
    expect(saveLine()).toHaveTextContent("Fix Minimum salary to save it");

    fireEvent.change(min, { target: { value: "12x" } });
    fireEvent.blur(min);
    expect(await screen.findByText("Enter a number.")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 1200));
    expect(saves(bridge)).toEqual([]);
    expect(min).toHaveValue("12x");
  });
  it("lets a later change from elsewhere show through, and saves a retyped old value again", async () => {
    const { bridge } = renderApp(<SettingsScreen />);
    const name = await screen.findByLabelText("Full name");
    await userEvent.clear(name);
    await userEvent.type(name, "Alex Paused");
    await waitFor(() => expect(saves(bridge).at(-1)).toEqual(["profile", [{ path: "contact.name", value: "Alex Paused" }]]), SLOW);
    await userEvent.tab();
    await bridge.settings.save("profile", [{ path: "contact.name", value: "Alex Other" }]);
    await waitFor(() => expect(screen.getByLabelText("Full name")).toHaveValue("Alex Other"), SLOW);
    const count = saves(bridge).length;
    await userEvent.clear(screen.getByLabelText("Full name"));
    await userEvent.type(screen.getByLabelText("Full name"), "Alex Paused");
    await userEvent.tab();
    await waitFor(() => expect(saves(bridge).length).toBeGreaterThan(count), SLOW);
    expect(saves(bridge).at(-1)).toEqual(["profile", [{ path: "contact.name", value: "Alex Paused" }]]);
  });
  it("offers to start a list again instead of crashing when it holds a string or an object", async () => {
    for (const bad of ["oops", { place: "oops" }]) {
      const f = loadFixture();
      (f.profile as Record<string, unknown>).locations = bad;
      const b = new MockBridge({ fixture: f });
      const { unmount } = renderApp(<SettingsScreen />, { bridge: b });
      // The places list lives under Search (it's a search filter), not Profile.
      await userEvent.click(await screen.findByRole("tab", { name: "Search" }));
      expect((await screen.findAllByText(/This list couldn't be read/)).length).toBeGreaterThan(0);
      await userEvent.click(screen.getAllByRole("button", { name: "Reset list" })[0]!);
      await waitFor(() => expect(saves(b).at(-1)).toEqual(["profile", [{ path: "locations", value: [] }]]));
      unmount();
    }
  });
  it("keeps an unsaved draft after switching tabs and back", async () => {
    renderApp(<SettingsScreen />);
    const name = await screen.findByLabelText("Full name");
    await userEvent.clear(name);
    await userEvent.type(name, "Alex Draft");
    await userEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    await userEvent.click(screen.getByRole("tab", { name: "Profile" }));
    expect(screen.getByLabelText("Full name")).toHaveValue("Alex Draft");
  });
  it("opens the section named in the link, such as Home's Set a search deadline", async () => {
    renderApp(<SettingsScreen />, { hash: "#/settings?tab=search" });
    expect(await screen.findByRole("tab", { name: "Search" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByLabelText("Search deadline")).toBeVisible();
    window.location.hash = "";
  });
  it("won't save a search deadline that isn't a real date", async () => {
    const bridge = new MockBridge();
    await expect(bridge.settings.save("search", [{ path: "search_deadline", value: "2026-02-30" }])).rejects.toThrow(/real date/);
    await expect(bridge.settings.save("search", [{ path: "search_deadline", value: "2026-03-31" }])).resolves.toBeTruthy();
  });
  it("keeps every tab panel mounted but marks only the active one as not hidden", async () => {
    // Every section stays mounted (so a draft survives switching tabs); this checks the `hidden`
    // DOM attribute directly, independent of CSS (jsdom doesn't apply layout, so this can't see
    // whether `hidden` actually hides anything - that's covered by the brand base-styles test).
    renderApp(<SettingsScreen />);
    const panels = () => [...document.querySelectorAll(".tabs__panel > div")] as HTMLElement[];
    await screen.findByLabelText("Full name");
    expect(panels()).toHaveLength(7);
    expect(panels().filter((p) => !p.hasAttribute("hidden"))).toHaveLength(1);

    await userEvent.click(await screen.findByRole("tab", { name: "Connections" }));
    const visible = panels().filter((p) => !p.hasAttribute("hidden"));
    expect(visible).toHaveLength(1);
    expect(within(visible[0]!).getByRole("button", { name: /Search in my Chrome/ })).toBeInTheDocument();
  });
  it("says Saving… while a save is in flight, then All changes saved", async () => {
    const b = new MockBridge();
    const real = b.settings.save.bind(b.settings);
    let release!: () => void;
    b.settings.save = (...args) => new Promise<SettingsData>((resolve) => { release = () => resolve(real(...args)); });
    renderApp(<SettingsScreen />, { bridge: b });
    await userEvent.selectOptions(await screen.findByLabelText("Work rights"), "citizen");
    expect(await waitFor(() => saveLine())).toHaveTextContent("Saving…");
    release();
    await waitFor(() => expect(saveLine()).toHaveTextContent("All changes saved"));
  });
  it("saves a text field after a short pause in typing, without leaving it", async () => {
    const { bridge } = renderApp(<SettingsScreen />);
    const name = await screen.findByLabelText("Full name");
    await userEvent.clear(name);
    await userEvent.type(name, "Alex Paused");
    expect(name).toHaveFocus();
    await waitFor(() => expect(saves(bridge).at(-1)).toEqual(["profile", [{ path: "contact.name", value: "Alex Paused" }]]), SLOW);
  });
  it("shows a failed save inline with Try again and keeps what was typed", async () => {
    const b = new MockBridge();
    const real = b.settings.save.bind(b.settings);
    let fail = true;
    b.settings.save = (...args) => (fail ? Promise.reject(new Error("The settings file is locked.")) : real(...args));
    renderApp(<SettingsScreen />, { bridge: b });
    const name = await screen.findByLabelText("Full name");
    await userEvent.clear(name);
    await userEvent.type(name, "Alex Retry");
    await userEvent.tab();
    expect(await screen.findByText(/Not saved: The settings file is locked\./)).toBeInTheDocument();
    expect(name).toHaveValue("Alex Retry");
    expect(saveLine()).toHaveTextContent("Couldn't save Full name");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again to save Full name" }));
    await waitFor(() => expect(saveLine()).toHaveTextContent("All changes saved"));
    expect(screen.queryByText(/Not saved:/)).toBeNull();
    expect((await b.settings.get("profile")).values).toMatchObject({ contact: { name: "Alex Retry" } });
  });
  it("puts back the last change with Undo", async () => {
    const { bridge } = renderApp(<SettingsScreen />);
    const rights = await screen.findByLabelText("Work rights");
    const before = (rights as HTMLSelectElement).value;
    await userEvent.selectOptions(rights, "citizen");
    await userEvent.click(await screen.findByRole("button", { name: "Undo the change to Work rights" }));
    await waitFor(() => expect(saves(bridge).at(-1)).toEqual(["profile", [{ path: "work_rights.status", value: before }]]));
    await waitFor(() => expect(screen.getByLabelText("Work rights")).toHaveValue(before));
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
  });
  it("shows the error over stale data when a reload fails, and stops saving", async () => {
    const b = new MockBridge();
    const get = b.settings.get;
    let calls = 0;
    b.settings.get = (kind) => {
      calls += 1;
      if (calls > 1 && kind === "profile") return Promise.reject(new Error("the settings file is not readable"));
      return get(kind);
    };
    renderApp(<SettingsScreen />, { bridge: b });
    await screen.findByLabelText("Full name");
    b.emitExternalChange("settings");
    expect(await screen.findByText("Settings can't be refreshed", undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByLabelText("Full name")).toBeInTheDocument();
    expect(screen.getByLabelText("Full name")).toBeDisabled();
    expect(b.calls.filter((c) => c.method === "settings.save")).toEqual([]);
  });
  it("shows a clear error when settings fail to load at all", async () => {
    const b = new MockBridge();
    b.settings.get = () => Promise.reject(new Error("the settings file is not readable"));
    renderApp(<SettingsScreen />, { bridge: b });
    // Both Profile and Search are mounted (hidden) at once now, so both of their forms hit the
    // same failing load and each show their own copy of this error.
    expect(await screen.findAllByText("Settings can't load")).not.toHaveLength(0);
    expect(screen.queryByLabelText("Full name")).not.toBeInTheDocument();
  });

  it("folds the API key away while Claude uses the person's plan, and switches either way", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<SettingsScreen />, { hash: "#/settings?tab=connections&c=claude" });
    expect(await screen.findByText(/Using your Claude plan/)).toBeInTheDocument();
    const more = screen.getByRole("button", { name: "Use an API key instead" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText("Anthropic API key").closest("[hidden]")).not.toBeNull();
    await user.click(more);
    await user.type(screen.getByLabelText("Anthropic API key"), "sk-" + "fictional-" + "key");
    await user.click(screen.getByRole("button", { name: "Save Anthropic API key" }));
    expect(await screen.findByText(/Using your API key/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Switch back to my Claude plan" }));
    await waitFor(() => expect(bridge.calls.some((c) => c.method === "secrets.remove" && c.args[0] === "anthropic_api_key")).toBe(true));
    expect(await screen.findByText(/Using your Claude plan/)).toBeInTheDocument();
  });
  it("stores secrets without showing them back", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(<SettingsScreen />, { hash: "#/settings?tab=connections&c=claude" });
    await openApiKey();
    const input = await screen.findByLabelText("Anthropic API key");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "off");
    await user.type(input, "sk-" + "fictional-" + "key");
    await user.click(screen.getByRole("button", { name: "Save Anthropic API key" }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    // Saved: the field is gone and the row reads "Saved · Replace · Remove"; the value is never shown back.
    expect(screen.queryByLabelText("Anthropic API key")).toBeNull();
    expect(screen.getByRole("button", { name: "Replace Anthropic API key" })).toBeInTheDocument();
    expect(bridge.calls.find((c) => c.method === "secrets.set")?.args).toEqual(["anthropic_api_key", "<redacted>"]);
  });
  it("clears the input on a failed save too, and does not pretend it saved", async () => {
    const user = userEvent.setup();
    const b = new MockBridge();
    b.secrets.set = async () => { throw new Error("No secret service is running"); };
    renderApp(<SettingsScreen />, { bridge: b, hash: "#/settings?tab=connections&c=claude" });
    await openApiKey();
    const input = await screen.findByLabelText("Anthropic API key");
    await user.type(input, "sk-" + "fictional-" + "key");
    await user.click(screen.getByRole("button", { name: "Save Anthropic API key" }));
    expect(await screen.findByText("No secret service is running")).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    // The success toast ("Anthropic API key saved") must not appear alongside the error.
    expect(screen.queryByText("Anthropic API key saved")).not.toBeInTheDocument();
  });
  it("shows a plain message and a Try again button when the OS denies Keychain access, and the rest of the app keeps working", async () => {
    const user = userEvent.setup();
    const b = new MockBridge();
    b.secrets.set = async () => { throw new Error("CareerOS couldn't use the Keychain, so your key wasn't saved."); };
    renderApp(<SettingsScreen />, { bridge: b, hash: "#/settings?tab=connections&c=claude" });
    await openApiKey();
    const input = await screen.findByLabelText("Anthropic API key");
    await user.type(input, "abcd" + "efgh" + "ijkl" + "mnop");
    await user.click(screen.getByRole("button", { name: "Save Anthropic API key" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("couldn't use the Keychain");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Nothing else broke: the field and the rest of Connections are still there and usable.
    expect(screen.getByLabelText("Anthropic API key")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Search in my Chrome/ })).toBeInTheDocument();
  });
  it("clears a shown Keychain-denied message as soon as the person starts typing again", async () => {
    const user = userEvent.setup();
    const b = new MockBridge();
    b.secrets.set = async () => { throw new Error("CareerOS couldn't use the Keychain, so your key wasn't saved."); };
    renderApp(<SettingsScreen />, { bridge: b, hash: "#/settings?tab=connections&c=claude" });
    await openApiKey();
    const input = await screen.findByLabelText("Anthropic API key");
    await user.type(input, "abcd" + "efgh" + "ijkl" + "mnop");
    await user.click(screen.getByRole("button", { name: "Save Anthropic API key" }));
    await screen.findByRole("alert");
    await user.type(input, "x");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("doesn't confuse a denied Keychain access with secure storage being missing entirely", async () => {
    const user = userEvent.setup();
    const b = new MockBridge();
    b.secrets.set = async () => { throw new Error("Secure storage isn't available on this computer, so the secret was not saved."); };
    renderApp(<SettingsScreen />, { bridge: b, hash: "#/settings?tab=connections&c=claude" });
    await openApiKey();
    const input = await screen.findByLabelText("Anthropic API key");
    await user.type(input, "abcd" + "efgh" + "ijkl" + "mnop");
    await user.click(screen.getByRole("button", { name: "Save Anthropic API key" }));
    expect(await screen.findByText(/Secure storage isn't available/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });
  it("never marks the Keychain note seen just from mounting a hidden Connections panel", async () => {
    localStorage.removeItem("careeros.secrets.keychainNoticeSeen");
    const b = new MockBridge();
    b.app.info = () => Promise.resolve({ version: "0.1.0", shell: "mock", platform: "darwin" });
    // Every tab panel mounts at once, Connections included, even while Profile is the one showing.
    renderApp(<SettingsScreen />, { bridge: b });
    await screen.findByLabelText("Full name");
    expect(localStorage.getItem("careeros.secrets.keychainNoticeSeen")).toBeNull();
  });
  it("shows the Keychain pre-prompt note on macOS, in the row being used, only until that row is actually saved", async () => {
    localStorage.removeItem("careeros.secrets.keychainNoticeSeen");
    const user = userEvent.setup();
    const b = new MockBridge();
    b.app.info = () => Promise.resolve({ version: "0.1.0", shell: "mock", platform: "darwin" });
    const { unmount } = renderApp(<SettingsScreen />, { bridge: b, hash: "#/settings?tab=connections&c=claude" });
    await openApiKey();
    const input = await screen.findByLabelText("Anthropic API key");
    const keyRow = input.closest(".secret") as HTMLElement;
    expect(within(keyRow).getByText(/Your Mac may ask for your login password/)).toBeInTheDocument();
    await user.type(input, "abcd" + "efgh" + "ijkl" + "mnop");
    await user.click(within(keyRow).getByRole("button", { name: "Save Anthropic API key" }));
    await screen.findByText("Saved");
    unmount();

    // A fresh mount, on the same install, never shows it again.
    renderApp(<SettingsScreen />, { bridge: b, hash: "#/settings?tab=connections&c=claude" });
    await openApiKey();
    await screen.findAllByText(/Anthropic API key/);
    expect(screen.queryByText(/Your Mac may ask for your login password/)).not.toBeInTheDocument();
  });
  it("never shows the Keychain pre-prompt note off macOS", async () => {
    localStorage.removeItem("careeros.secrets.keychainNoticeSeen");
    // MockBridge's default platform ("mock") stands in for any non-macOS platform here.
    renderApp(<SettingsScreen />, { hash: "#/settings?tab=connections&c=claude" });
    await openApiKey();
    await screen.findByLabelText("Anthropic API key");
    expect(screen.queryByText(/Your Mac may ask for your login password/)).not.toBeInTheDocument();
  });
  it("disables the secret Save button while it's in flight", async () => {
    const user = userEvent.setup();
    const b = new MockBridge();
    let release!: () => void;
    b.secrets.set = () => new Promise((resolve) => { release = () => resolve({ name: "anthropic_api_key", available: true, set: true }); });
    renderApp(<SettingsScreen />, { bridge: b, hash: "#/settings?tab=connections&c=claude" });
    await openApiKey();
    const input = await screen.findByLabelText("Anthropic API key");
    await user.type(input, "sk-" + "fictional-" + "key");
    const button = screen.getByRole("button", { name: "Save Anthropic API key" });
    await user.click(button);
    expect(button).toBeDisabled();
    release();
  });
  it("fires exactly one secrets.set call on a rapid double click while saving", async () => {
    const user = userEvent.setup();
    const b = new MockBridge();
    let calls = 0;
    const realSet = b.secrets.set;
    b.secrets.set = (...args: Parameters<typeof realSet>) => { calls += 1; return realSet(...args); };
    renderApp(<SettingsScreen />, { bridge: b, hash: "#/settings?tab=connections&c=claude" });
    await openApiKey();
    const input = await screen.findByLabelText("Anthropic API key");
    await user.type(input, "sk-" + "fictional-" + "key");
    const button = screen.getByRole("button", { name: "Save Anthropic API key" });
    // Two synchronous clicks, with no await between them, race against useAction's in-flight
    // guard instead of the button's disabled state (which only updates on the next render).
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByText("Saved")).toBeInTheDocument());
    expect(calls).toBe(1);
  });
  it("asks for confirmation before removing a secret, and Cancel removes nothing", async () => {
    const user = userEvent.setup();
    const b = new MockBridge();
    await b.secrets.set("anthropic_api_key", "sk-" + "fictional-" + "key");
    renderApp(<SettingsScreen />, { bridge: b, hash: "#/settings?tab=connections&c=claude" });
    await openApiKey();
    await user.click(await screen.findByRole("button", { name: "Remove Anthropic API key" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove the Anthropic API key?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(b.calls.find((c) => c.method === "secrets.remove")).toBeUndefined();
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });
  it("removes a secret once the confirm dialog's Remove button is clicked", async () => {
    const user = userEvent.setup();
    const b = new MockBridge();
    await b.secrets.set("anthropic_api_key", "sk-" + "fictional-" + "key");
    renderApp(<SettingsScreen />, { bridge: b, hash: "#/settings?tab=connections&c=claude" });
    await openApiKey();
    await user.click(await screen.findByRole("button", { name: "Remove Anthropic API key" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove the Anthropic API key?" });
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Anthropic API key removed")).toBeInTheDocument();
    expect(b.calls.find((c) => c.method === "secrets.remove")?.args).toEqual(["anthropic_api_key"]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("fires exactly one secrets.remove call on a rapid double click while removing", async () => {
    const user = userEvent.setup();
    const b = new MockBridge();
    await b.secrets.set("anthropic_api_key", "sk-" + "fictional-" + "key");
    let calls = 0;
    const realRemove = b.secrets.remove;
    b.secrets.remove = (...args: Parameters<typeof realRemove>) => { calls += 1; return realRemove(...args); };
    renderApp(<SettingsScreen />, { bridge: b, hash: "#/settings?tab=connections&c=claude" });
    await openApiKey();
    await user.click(await screen.findByRole("button", { name: "Remove Anthropic API key" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove the Anthropic API key?" });
    const confirmButton = within(dialog).getByRole("button", { name: "Remove" });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls).toBe(1);
  });
  it("shows the Gmail wizard in the Email row when not connected, with a Set up action on the row", async () => {
    renderApp(<SettingsScreen />, { bridge: new MockBridge({ mailConnected: false }), hash: "#/settings?tab=connections&c=email" });
    expect(await screen.findByRole("button", { name: "Test connection" })).toBeInTheDocument();
    expect(within(document.getElementById("settings-conn-email")!).getByText("Not set up")).toBeInTheDocument();
  });
  it("the mock refuses the generic secrets.remove for the Gmail password, like the services", async () => {
    const b = new MockBridge();
    await expect(b.secrets.remove("gmail_app_password")).rejects.toThrow("Use Disconnect in Settings > Email to remove the Gmail app password.");
    expect((await b.mail.status()).connected).toBe(true);
  });
  it("says when secure storage is missing", async () => {
    renderApp(<SettingsScreen />, { bridge: new MockBridge({ secretStoreAvailable: false }), hash: "#/settings?tab=connections&c=claude" });
    await openApiKey();
    expect((await screen.findAllByText(/Secure storage isn't available/)).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Anthropic API key")).not.toBeInTheDocument();
  });
  it("lists connections as rows with status; secrets live inside their service", async () => {
    renderApp(<SettingsScreen />, { hash: "#/settings?tab=connections" });
    const claude = await screen.findByRole("button", { name: /^Claude\b/, expanded: false });
    const email = screen.getByRole("button", { name: /^Email \(Gmail\)/ });
    expect(screen.getByRole("button", { name: /^Search in my Chrome/ })).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByText("Secrets")).toBeNull();
    // One row open at a time.
    await userEvent.click(email);
    expect(email).toHaveAttribute("aria-expanded", "true");
    // Email is the mail wizard / connected view: Disconnect, never a generic Gmail password row.
    expect(await screen.findByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Gmail app password")).toBeNull();
    expect(screen.getAllByText(/^Connected as /).length).toBeGreaterThan(0);
    await userEvent.click(claude);
    expect(claude).toHaveAttribute("aria-expanded", "true");
    expect(email).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText("Anthropic API key")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(await screen.findByText("Claude Code found (version 2.1.280)")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Claude" })).toBeNull();
  });
  it("keeps the old Claude tab link working: it opens Connections with Claude expanded", async () => {
    renderApp(<SettingsScreen />, { hash: "#/settings?tab=claude" });
    expect(await screen.findByRole("tab", { name: "Connections" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("button", { name: /^Claude\b/ })).toHaveAttribute("aria-expanded", "true");
  });
  it("opens Claude by itself when it needs setup", async () => {
    sessionStorage.clear();
    renderApp(<SettingsScreen />, { bridge: new MockBridge({ claudeEngine: { consent: false } }), hash: "#/settings?tab=connections" });
    await waitFor(() => expect(screen.getByRole("button", { name: /^Claude\b/ })).toHaveAttribute("aria-expanded", "true"), SLOW);
    expect(screen.getByText("Set up needed")).toBeInTheDocument();
  });
  it("doesn't take over a row the person opened while Claude was still being checked", async () => {
    sessionStorage.clear();
    const bridge = new MockBridge({ claudeEngine: { consent: false } });
    const engine = bridge.claude.engine;
    let release!: () => void;
    const checked = new Promise<void>((r) => { release = r; });
    bridge.claude.engine = ((...a: Parameters<typeof engine>) => checked.then(() => engine(...a))) as typeof engine;
    renderApp(<SettingsScreen />, { bridge, hash: "#/settings?tab=connections" });
    const email = await screen.findByRole("button", { name: /^Email \(Gmail\)/ });
    await userEvent.click(email);
    expect(email).toHaveAttribute("aria-expanded", "true");
    release();
    expect(await screen.findByText("Set up needed", {}, SLOW)).toBeInTheDocument();
    expect(email).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^Claude\b/ })).toHaveAttribute("aria-expanded", "false");
  });
  it("keeps Save disabled until a secret is typed, and says why", async () => {
    renderApp(<SettingsScreen />, { hash: "#/settings?tab=connections&c=claude" });
    await openApiKey();
    const save = await screen.findByRole("button", { name: "Save Anthropic API key" });
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription("Paste the Anthropic API key first.");
    await userEvent.type(screen.getByLabelText("Anthropic API key"), "x");
    expect(save).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Show Anthropic API key" }));
    expect(screen.getByLabelText("Anthropic API key")).toHaveAttribute("type", "text");
  });
  it("links to where to get a key, through the safe link opener", async () => {
    const { bridge } = renderApp(<SettingsScreen />, { hash: "#/settings?tab=connections&c=claude" });
    await openApiKey();
    const row = (await screen.findByLabelText("Anthropic API key")).closest(".secret") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: /Get one/ }));
    expect(bridge.opened).toEqual(["https://console.anthropic.com/settings/keys"]);
  });
  it("groups the profile under short headings", async () => {
    renderApp(<SettingsScreen />, { hash: "#/settings?tab=profile" });
    for (const h of ["About you", "Work rights", "Experience"]) expect(await screen.findByRole("heading", { name: h, level: 3 })).toBeInTheDocument();
    // Search filters (roles, places, pay, companies to skip) live under Search only.
    expect(screen.queryByRole("heading", { name: "Salary", level: 3 })).toBeNull();
  });

  it("resolves 'Follow the system' through matchMedia instead of hard-coding a theme", async () => {
    const original = window.matchMedia;
    const matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    window.matchMedia = matchMedia as unknown as typeof window.matchMedia;
    try {
      renderApp(<SettingsScreen />);
      await userEvent.click(await screen.findByRole("tab", { name: "Appearance" }));
      // "system" is already the default, so clicking it again wouldn't fire a change event;
      // switch away and back to force a real one.
      await userEvent.click(screen.getByLabelText("Paper (light)"));
      await userEvent.click(screen.getByLabelText("Follow the system"));
      expect(matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: light)");
      expect(document.documentElement.dataset.theme).toBe("paper");
      expect(localStorage.getItem("careeros.theme")).toBe("system");
    } finally {
      window.matchMedia = original;
    }
  });
  it("switches theme", async () => {
    renderApp(<SettingsScreen />);
    await userEvent.click(await screen.findByRole("tab", { name: "Appearance" }));
    await userEvent.click(screen.getByLabelText("Paper (light)"));
    expect(document.documentElement.dataset.theme).toBe("paper");
    expect(localStorage.getItem("careeros.theme")).toBe("paper");
  });
  it("keeps the theme choice after a reload", async () => {
    const { unmount } = renderApp(<SettingsScreen />);
    await userEvent.click(await screen.findByRole("tab", { name: "Appearance" }));
    await userEvent.click(screen.getByLabelText("Paper (light)"));
    unmount();
    renderApp(<SettingsScreen />);
    await userEvent.click(await screen.findByRole("tab", { name: "Appearance" }));
    expect(screen.getByLabelText("Paper (light)")).toBeChecked();
    expect(document.documentElement.dataset.theme).toBe("paper");
  });
  it("keeps tabs keyboard operable", async () => {
    renderApp(<SettingsScreen />);
    const profileTab = await screen.findByRole("tab", { name: "Profile" });
    profileTab.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Search" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Appearance" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Appearance" })).toHaveAttribute("aria-selected", "true");
  });

  it("turns OS notifications for long tasks on and off under Appearance", async () => {
    renderApp(<SettingsScreen />, { hash: "#/settings?tab=appearance" });
    const box = await screen.findByRole("checkbox", { name: /Tell me when a task that took over 30 seconds finishes/ });
    expect(box).toBeChecked();
    await userEvent.click(box);
    expect(localStorage.getItem("careeros.notify")).toBe("off");
    await userEvent.click(box);
    expect(localStorage.getItem("careeros.notify")).toBe("on");
  });
});
