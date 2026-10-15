import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { identity } from "@careeros/brand";
import { fmtTime } from "../src/format";
import { loadFixture, MockBridge } from "../src/mock/MockBridge";
import { fieldLabel, minutesText, PrivacyScreen } from "../src/screens/Privacy";
import { renderApp, cutAndHover } from "./render";

const calls = (b: MockBridge, m: string) => b.calls.filter((c) => c.method === m).map((c) => c.args);
// RTL's findBy*/waitFor poll via (now faked) setTimeout, so they never settle once
// vi.useFakeTimers() is active: flush pending microtasks (the mock's promise-based fetches)
// with a zero-length fake advance instead, then query synchronously.
const flush = () => act(() => vi.advanceTimersByTimeAsync(0));

describe("Privacy", () => {
  it("shows both folders locked", async () => {
    renderApp(<PrivacyScreen />);
    expect(await screen.findByRole("switch", { name: "Lock Identity documents" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Lock Employment records" })).toHaveAttribute("aria-checked", "true");
  });
  it("asks before unlocking, and locks again without asking", async () => {
    const { bridge } = renderApp(<PrivacyScreen />);
    const sw = await screen.findByRole("switch", { name: "Lock Employment records" });
    await userEvent.click(sw);
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(calls(bridge, "privacy.setLocked")).toEqual([]);
    await userEvent.click(sw);
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
    await userEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    expect(calls(bridge, "privacy.setLocked")).toEqual([["me/employment", false], ["me/employment", true]]);
  });
  it("allows a request once for the chosen time, then re-locks on demand", async () => {
    const { bridge } = renderApp(<PrivacyScreen />);
    const req = await screen.findByRole("region", { name: "Access request" });
    expect(req).toHaveTextContent("Need your visa expiry date for the Acme Corp cover letter");
    await userEvent.selectOptions(within(req).getByLabelText("Time limit"), "30");
    await userEvent.click(within(req).getByRole("button", { name: /^Allow for/ }));
    expect(await screen.findByText(/Identity documents: open until/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Access request" })).not.toBeInTheDocument();
    expect(calls(bridge, "privacy.allow")[0]?.[1]).toBe(30);
    await userEvent.click(screen.getByRole("button", { name: "Re-lock Identity documents now" }));
    await waitFor(() => expect(screen.queryByText(/Identity documents: open until/)).not.toBeInTheDocument());
    expect(screen.getByRole("list", { name: "Activity" })).toHaveTextContent("Re-locked");
  });
  it("denies a request", async () => {
    const { bridge } = renderApp(<PrivacyScreen />);
    await userEvent.click(within(await screen.findByRole("region", { name: "Access request" })).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Access request" })).not.toBeInTheDocument());
    expect(calls(bridge, "privacy.deny")).toHaveLength(1);
    expect(calls(bridge, "privacy.allow")).toHaveLength(0);
  });

  // --- Screen rules (stale data, rejections, toasts, double clicks, untrusted text) ---

  it("defaults the Allow-for duration to 15 minutes and offers only the brief's choices", async () => {
    renderApp(<PrivacyScreen />);
    const req = await screen.findByRole("region", { name: "Access request" });
    const select = within(req).getByLabelText("Time limit") as HTMLSelectElement;
    expect(select.value).toBe("15");
    expect([...select.options].map((o) => o.value)).toEqual(["15", "30", "60", "120"]);
  });

  it("shows an empty activity list plainly", async () => {
    // A fresh workspace has no privacy activity yet: nothing has been locked, allowed or
    // denied, so the Activity feed starts empty.
    renderApp(<PrivacyScreen />);
    await screen.findByRole("switch", { name: "Lock Identity documents" });
    expect(screen.getByText(/Activity: nothing yet/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Activity" })).not.toBeInTheDocument();
  });

  it("shows the error over stale data and hides lock switches and request actions when a reload fails", async () => {
    const b = new MockBridge();
    const get = b.privacy.get;
    let calls2 = 0;
    b.privacy.get = () => {
      calls2 += 1;
      if (calls2 > 1) return Promise.reject(new Error("the privacy state file is not readable"));
      return get();
    };
    renderApp(<PrivacyScreen />, { bridge: b });
    await screen.findByRole("switch", { name: "Lock Identity documents" });
    const req = await screen.findByRole("region", { name: "Access request" });
    b.emitExternalChange("privacy");
    expect(await screen.findByText("Privacy settings can't be refreshed")).toBeInTheDocument();
    // The stale rows stay on screen so the candidate can see what they were, but nothing that
    // mutates (lock switches, allow/deny, the duration picker) survives.
    expect(screen.queryByRole("switch", { name: "Lock Identity documents" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Lock Employment records" })).toBeNull();
    expect(screen.getByText("Identity documents")).toBeInTheDocument();
    expect(screen.getByText(/Need your visa expiry date/)).toBeInTheDocument();
    expect(within(req).queryByLabelText("Time limit")).toBeNull();
    expect(within(req).queryByRole("button", { name: /^Allow for/ })).toBeNull();
    expect(within(req).queryByRole("button", { name: "Deny" })).toBeNull();
  });

  it("hides the Re-lock now button once a reload fails while a grant is open", async () => {
    const b = new MockBridge();
    const get = b.privacy.get;
    let calls3 = 0;
    b.privacy.get = () => {
      calls3 += 1;
      if (calls3 > 2) return Promise.reject(new Error("the privacy state file is not readable"));
      return get();
    };
    renderApp(<PrivacyScreen />, { bridge: b });
    await userEvent.click(within(await screen.findByRole("region", { name: "Access request" })).getByRole("button", { name: /^Allow for/ }));
    await screen.findByText(/Identity documents: open until/);
    b.emitExternalChange("privacy");
    expect(await screen.findByText("Privacy settings can't be refreshed")).toBeInTheDocument();
    expect(screen.getByText(/Identity documents: open until/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Re-lock .* now/ })).toBeNull();
  });

  it("shows a clear error when privacy settings fail to load at all", async () => {
    const b = new MockBridge();
    b.privacy.get = () => Promise.reject(new Error("the privacy state file is not readable"));
    renderApp(<PrivacyScreen />, { bridge: b });
    expect(await screen.findByText("Privacy settings can't load")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Lock Identity documents" })).toBeNull();
  });

  it("toasts an error and leaves the switch locked when unlocking is rejected, without a false success toast", async () => {
    const b = new MockBridge();
    b.privacy.setLocked = async () => { throw new Error("The privacy state file is not writable"); };
    renderApp(<PrivacyScreen />, { bridge: b });
    const sw = await screen.findByRole("switch", { name: "Lock Employment records" });
    await userEvent.click(sw);
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText("The privacy state file is not writable")).toBeInTheDocument();
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText("Employment records unlocked")).not.toBeInTheDocument();
  });

  it("toasts an error when denying a request is rejected, and the request stays pending", async () => {
    const b = new MockBridge();
    b.privacy.deny = async () => { throw new Error("The request has already expired"); };
    renderApp(<PrivacyScreen />, { bridge: b });
    const req = await screen.findByRole("region", { name: "Access request" });
    await userEvent.click(within(req).getByRole("button", { name: "Deny" }));
    expect(await screen.findByText("The request has already expired")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Access request" })).toBeInTheDocument();
  });

  it("disables the Unlock button while the call is in flight, as a double-click guard", async () => {
    const b = new MockBridge();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const setLocked = b.privacy.setLocked;
    b.privacy.setLocked = async (folder, locked) => { await held; return setLocked(folder, locked); };
    renderApp(<PrivacyScreen />, { bridge: b });
    const sw = await screen.findByRole("switch", { name: "Lock Employment records" });
    await userEvent.click(sw);
    const unlockBtn = within(screen.getByRole("dialog")).getByRole("button", { name: "Unlock" });
    await userEvent.click(unlockBtn);
    await waitFor(() => expect(unlockBtn).toBeDisabled());
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("fires exactly one privacy.allow call on a rapid double click", async () => {
    const b = new MockBridge();
    let count = 0;
    const allow = b.privacy.allow;
    b.privacy.allow = (id, minutes) => { count += 1; return allow(id, minutes); };
    renderApp(<PrivacyScreen />, { bridge: b });
    const req = await screen.findByRole("region", { name: "Access request" });
    const button = within(req).getByRole("button", { name: /^Allow for/ });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Access request" })).not.toBeInTheDocument());
    expect(count).toBe(1);
  });

  it("fires exactly one privacy.revoke call on a rapid double click of Re-lock now", async () => {
    const { bridge: b } = renderApp(<PrivacyScreen />);
    const req = await screen.findByRole("region", { name: "Access request" });
    await userEvent.click(within(req).getByRole("button", { name: /^Allow for/ }));
    const relock = await screen.findByRole("button", { name: "Re-lock Identity documents now" });
    let count = 0;
    const revoke = b.privacy.revoke;
    b.privacy.revoke = (folder) => { count += 1; return revoke(folder); };
    fireEvent.click(relock);
    fireEvent.click(relock);
    await waitFor(() => expect(screen.queryByText(/Identity documents: open until/)).not.toBeInTheDocument());
    expect(count).toBe(1);
  });

  it("renders an untrusted request reason and field name as plain text, truncated with a tooltip", async () => {
    const f = loadFixture();
    const why = "<img src=x onerror=alert(1)>-" + "a".repeat(200);
    const field = "<script>bad()<" + "/script>-" + "b".repeat(100);
    f.requests = [{ ...f.requests[0]!, why, field }];
    renderApp(<PrivacyScreen />, { bridge: new MockBridge({ fixture: f }) });
    const req = await screen.findByRole("region", { name: "Access request" });
    expect(within(req).queryByRole("img")).toBeNull();
    const whyNode = within(req).getByText(why);
    cutAndHover(whyNode);
    expect(whyNode).toHaveAttribute("title", why);
    expect(whyNode.className).toMatch(/truncate/);
    const fieldNode = within(req).getByText(`Only needs: ${field}`);
    cutAndHover(fieldNode);
    expect(fieldNode).toHaveAttribute("title", `Only needs: ${field}`);
  });

  it("renders a bidi-disguised request reason with the hidden control character made visible", async () => {
    const f = loadFixture();
    const why = "Need your visa‮expiry.pdf date";
    const cleaned = "Need your visa�expiry.pdf date";
    f.requests = [{ ...f.requests[0]!, why }];
    renderApp(<PrivacyScreen />, { bridge: new MockBridge({ fixture: f }) });
    const req = await screen.findByRole("region", { name: "Access request" });
    expect(within(req).getByText(cleaned)).toBeInTheDocument();
    expect(within(req).queryByText(why)).toBeNull();
  });

  it("renders untrusted activity text as plain text, truncated with a tooltip", async () => {
    // Fixture-seeded via MockOptions.activity, standing in for activity text sourced from
    // outside this process (e.g. a tampered log) - not a direct poke at MockBridge's private
    // `activity` field.
    const detail = "<img src=x onerror=alert(1)>-" + "c".repeat(200);
    const b = new MockBridge({ activity: [{ at: "2026-01-15T08:00:00.000Z", event: "Unlocked", detail }] });
    renderApp(<PrivacyScreen />, { bridge: b });
    const list = await screen.findByRole("list", { name: "Activity" });
    expect(within(list).queryByRole("img")).toBeNull();
    const node = within(list).getByText(detail);
    cutAndHover(node);
    expect(node).toHaveAttribute("title", detail);
    expect(node.className).toMatch(/truncate/);
  });

  // --- Fix round 1 ---

  it("truncates a long 'who' with a tooltip", async () => {
    const f = loadFixture();
    const who = "a-very-long-mcp-agent-identifier-" + "x".repeat(100);
    f.requests = [{ ...f.requests[0]!, who }];
    renderApp(<PrivacyScreen />, { bridge: new MockBridge({ fixture: f }) });
    const req = await screen.findByRole("region", { name: "Access request" });
    const label = within(req).getByText(`${who} asks to read your identity documents`);
    cutAndHover(label);
    expect(label).toHaveAttribute("title", `${who} asks to read your identity documents`);
    expect(label.className).toMatch(/truncate/);
  });

  it("names the folder concretely in the unlock dialog", async () => {
    renderApp(<PrivacyScreen />);
    await userEvent.click(await screen.findByRole("switch", { name: "Lock Identity documents" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Passport, visa and other identity documents/)).toBeInTheDocument();
  });

  it("closes the unlock dialog if a reload fails while it's open", async () => {
    const b = new MockBridge();
    const get = b.privacy.get;
    let n = 0;
    b.privacy.get = () => {
      n += 1;
      if (n > 1) return Promise.reject(new Error("the privacy state file is not readable"));
      return get();
    };
    renderApp(<PrivacyScreen />, { bridge: b });
    const sw = await screen.findByRole("switch", { name: "Lock Employment records" });
    await userEvent.click(sw);
    await screen.findByRole("dialog");
    b.emitExternalChange("privacy");
    expect(await screen.findByText("Privacy settings can't be refreshed")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("ignores Escape and a scrim click while the Unlock call is in flight", async () => {
    const b = new MockBridge();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const setLocked = b.privacy.setLocked;
    b.privacy.setLocked = async (folder, locked) => { await held; return setLocked(folder, locked); };
    renderApp(<PrivacyScreen />, { bridge: b });
    const sw = await screen.findByRole("switch", { name: "Lock Employment records" });
    await userEvent.click(sw);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Unlock" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.mouseDown(document.querySelector(".dialog-scrim")!);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("cancels the unlock dialog with Escape, without calling setLocked", async () => {
    const { bridge } = renderApp(<PrivacyScreen />);
    const sw = await screen.findByRole("switch", { name: "Lock Employment records" });
    await userEvent.click(sw);
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls(bridge, "privacy.setLocked")).toEqual([]);
  });

  it("says the folder is already unlocked instead of 'open for N minutes' when it needs no grant", async () => {
    renderApp(<PrivacyScreen />);
    // me/identity is the fixture's request's target folder: unlock it directly first, so the
    // mock's allow() (mirroring the real service) adds no grant for it.
    const sw = await screen.findByRole("switch", { name: "Lock Identity documents" });
    await userEvent.click(sw);
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
    const req = await screen.findByRole("region", { name: "Access request" });
    await userEvent.click(within(req).getByRole("button", { name: /^Allow for/ }));
    expect(await screen.findByText("Already unlocked; no time limit applies")).toBeInTheDocument();
    expect(screen.queryByText(/Identity documents: open until/)).not.toBeInTheDocument();
  });

  it("toasts an error and adds no grant when Allow once is rejected (the request was already decided elsewhere)", async () => {
    const b = new MockBridge();
    b.privacy.allow = async () => { throw new Error("The request has already been decided"); };
    renderApp(<PrivacyScreen />, { bridge: b });
    const req = await screen.findByRole("region", { name: "Access request" });
    await userEvent.click(within(req).getByRole("button", { name: /^Allow for/ }));
    expect(await screen.findByText("The request has already been decided")).toBeInTheDocument();
    expect(screen.queryByText(/: open until/)).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Access request" })).toBeInTheDocument();
  });

  describe("decided and expired requests", () => {
    const NOW = new Date("2026-01-15T09:00:00.000Z");
    const base = () => ({ ...loadFixture().requests[0]! });

    it("shows an Allowed request from the last 24 hours as read-only, with its end time", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(NOW);
        const f = loadFixture();
        f.requests = [{
          ...base(), status: "allowed", decided_at: "2026-01-15T08:50:00.000Z", expires_at: "2026-01-15T09:05:00.000Z",
        }];
        renderApp(<PrivacyScreen />, { bridge: new MockBridge({ fixture: f, now: NOW }) });
        await flush();
        const card = screen.getByRole("region", { name: "Past request" });
        expect(card).toHaveTextContent("Need your visa expiry date for the Acme Corp cover letter");
        expect(within(card).getByText(`Allowed until ${fmtTime("2026-01-15T09:05:00.000Z")}`)).toBeInTheDocument();
        expect(within(card).queryByRole("button")).toBeNull();
        expect(within(card).queryByLabelText("Time limit")).toBeNull();
      } finally { vi.useRealTimers(); }
    });

    it("shows a Denied request from the last 24 hours as read-only", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(NOW);
        const f = loadFixture();
        f.requests = [{ ...base(), status: "denied", decided_at: "2026-01-15T07:00:00.000Z" }];
        renderApp(<PrivacyScreen />, { bridge: new MockBridge({ fixture: f, now: NOW }) });
        await flush();
        const card = screen.getByRole("region", { name: "Past request" });
        expect(within(card).getByText("Denied")).toBeInTheDocument();
        expect(within(card).queryByRole("button")).toBeNull();
      } finally { vi.useRealTimers(); }
    });

    it("shows an Expired request from the last 24 hours as read-only", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(NOW);
        const f = loadFixture();
        // decided_at (the original allow time) is well over 24 hours old; expires_at (when it
        // actually expired) is recent - the expired case must use the latter, not the former.
        f.requests = [{
          ...base(), status: "expired", decided_at: "2026-01-10T09:00:00.000Z", expires_at: "2026-01-15T08:00:00.000Z",
        }];
        renderApp(<PrivacyScreen />, { bridge: new MockBridge({ fixture: f, now: NOW }) });
        await flush();
        const card = screen.getByRole("region", { name: "Past request" });
        expect(within(card).getByText("Expired")).toBeInTheDocument();
        expect(within(card).queryByRole("button")).toBeNull();
      } finally { vi.useRealTimers(); }
    });

    it("does not show a decided request older than 24 hours", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(NOW);
        const f = loadFixture();
        f.requests = [{ ...base(), status: "denied", decided_at: "2026-01-14T08:00:00.000Z" }];
        renderApp(<PrivacyScreen />, { bridge: new MockBridge({ fixture: f, now: NOW }) });
        await flush();
        expect(screen.getByRole("switch", { name: "Lock Identity documents" })).toBeInTheDocument();
        expect(screen.queryByRole("region", { name: "Past request" })).not.toBeInTheDocument();
        expect(screen.queryByRole("region", { name: "Access request" })).not.toBeInTheDocument();
      } finally { vi.useRealTimers(); }
    });

    it("puts pending requests first, then decided ones, newest first", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(NOW);
        const f = loadFixture();
        const pending = { ...base(), id: "pending-1", folder: "me/identity" as const, why: "Pending ask", created_at: "2026-01-15T08:00:00.000Z" };
        const olderDenied = { ...base(), id: "denied-older", folder: "me/employment" as const, status: "denied" as const, why: "Older denial", decided_at: "2026-01-15T06:00:00.000Z" };
        const newerDenied = { ...base(), id: "denied-newer", folder: "me/employment" as const, status: "denied" as const, why: "Newer denial", decided_at: "2026-01-15T08:30:00.000Z" };
        f.requests = [olderDenied, pending, newerDenied];
        renderApp(<PrivacyScreen />, { bridge: new MockBridge({ fixture: f, now: NOW }) });
        await flush();
        const cards = screen.getAllByRole("region", { name: /Access request|Past request/ });
        expect(cards.map((c) => c.textContent?.includes("Pending ask") ? "pending" : c.textContent?.includes("Newer denial") ? "newer" : "older")).toEqual(["pending", "newer", "older"]);
      } finally { vi.useRealTimers(); }
    });
  });

  describe("grant countdown", () => {
    const NOW = new Date("2026-01-15T09:00:00.000Z");
    const REQUEST_ID = "20260114t090000-b197f7"; // the fixture's one (pending) request

    it("shows the time remaining alongside the end time, and ticks it down every 60 seconds", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(NOW);
        const b = new MockBridge({ now: NOW });
        renderApp(<PrivacyScreen />, { bridge: b });
        await flush();
        expect(screen.getByRole("region", { name: "Access request" })).toBeInTheDocument();
        await act(async () => { await b.privacy.allow(REQUEST_ID, 15); });
        expect(screen.getByText(`Identity documents: open until ${fmtTime("2026-01-15T09:15:00.000Z")} (15 minutes left)`)).toBeInTheDocument();
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(screen.getByText(`Identity documents: open until ${fmtTime("2026-01-15T09:15:00.000Z")} (14 minutes left)`)).toBeInTheDocument();
      } finally { vi.useRealTimers(); }
    });

    it("clamps at zero and triggers a reload instead of ever showing a negative time left", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(NOW);
        const b = new MockBridge({ now: NOW });
        renderApp(<PrivacyScreen />, { bridge: b });
        await flush();
        expect(screen.getByRole("region", { name: "Access request" })).toBeInTheDocument();
        await act(async () => { await b.privacy.allow(REQUEST_ID, 1); });
        expect(screen.getByText(`Identity documents: open until ${fmtTime("2026-01-15T09:01:00.000Z")} (1 minute left)`)).toBeInTheDocument();
        const before = b.calls.filter((c) => c.method === "privacy.get").length;
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(b.calls.filter((c) => c.method === "privacy.get").length).toBeGreaterThan(before);
        expect(screen.queryByText(/-\d+ minutes? left/)).not.toBeInTheDocument();
      } finally { vi.useRealTimers(); }
    });

    it("clears its 60-second timer on unmount", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(NOW);
        const b = new MockBridge({ now: NOW });
        const { unmount } = renderApp(<PrivacyScreen />, { bridge: b });
        await flush();
        expect(screen.getByRole("region", { name: "Access request" })).toBeInTheDocument();
        await act(async () => { await b.privacy.allow(REQUEST_ID, 15); });
        expect(screen.getByText(/: open until/)).toBeInTheDocument();
        unmount();
        const before = b.calls.filter((c) => c.method === "privacy.get").length;
        await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
        expect(b.calls.filter((c) => c.method === "privacy.get").length).toBe(before);
      } finally { vi.useRealTimers(); }
    });
  });

  // Final review I4.
  it("warns when a locked folder was moved, and accepting asks first and keeps the old place on the list (re-review R1)", async () => {
    const b = new MockBridge();
    b.simulateLockProblem({ folder: "me/identity", kind: "missing", found_at: "me-x/identity" });
    renderApp(<PrivacyScreen />, { bridge: b });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your identity documents folder was moved or replaced. Your locked files may be somewhere else in the workspace.");
    expect(alert).toHaveTextContent("It looks like they are now in me-x/identity.");
    // "Move it back" is the main action; accepting is secondary and confirms first.
    expect(within(alert).getByRole("button", { name: "Move back: me-x/identity to Identity documents" })).toHaveClass("btn--primary");
    await userEvent.click(within(alert).getByRole("button", { name: "Lock again" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(`Files in me-x/identity will stay locked. ${identity.name} will also lock the new identity documents folder.`);
    expect(calls(b, "privacy.acceptFolders")).toEqual([]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls(b, "privacy.acceptFolders")).toEqual([]);
    await userEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Lock again" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Lock them" }));
    expect(await screen.findByText("Locked folders are set")).toBeInTheDocument();
    // Not resolved for the old place: it still shows, with only "Move it back" left to do.
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Files that were in your identity documents folder are now in me-x/identity. They stay locked until you move them back."));
    expect(within(screen.getByRole("alert")).queryByRole("button", { name: "Lock again" })).not.toBeInTheDocument();
  });
  it("moves a folder back, and only then clears the warning", async () => {
    const b = new MockBridge();
    b.simulateLockProblem({ folder: "me/identity", kind: "elsewhere", found_at: "me-x/identity" });
    renderApp(<PrivacyScreen />, { bridge: b });
    const alert = await screen.findByRole("alert");
    await userEvent.click(within(alert).getByRole("button", { name: "Move back: me-x/identity to Identity documents" }));
    const ok = await screen.findByText("Moved back to Identity documents");
    expect(ok.closest(".toast")).toHaveClass("toast--success");
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(calls(b, "privacy.moveBack")).toEqual([["me/identity"]]);
  });
  it("keeps the warning and says why when moving back is refused", async () => {
    const b = new MockBridge();
    b.simulateLockProblem({ folder: "me/identity", kind: "elsewhere", found_at: "me-x/identity" });
    b.privacy.moveBack = () => Promise.reject(new Error("me/identity isn't empty, so me-x/identity can't move back into it. Its files stay locked where they are."));
    renderApp(<PrivacyScreen />, { bridge: b });
    const alert = await screen.findByRole("alert");
    await userEvent.click(within(alert).getByRole("button", { name: "Move back: me-x/identity to Identity documents" }));
    const msg = await screen.findByText(/isn't empty, so me-x\/identity can't move back/);
    expect(msg.closest(".toast")).toHaveClass("toast--danger");
    expect(screen.queryByText("Moved back to Identity documents")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("They stay locked until you move them back.");
  });
  it("keeps the warning and shows the reason when accepting the folders fails", async () => {
    const b = new MockBridge();
    b.simulateLockProblem({ folder: "me/employment", kind: "link", found_at: null });
    b.privacy.acceptFolders = () => Promise.reject(new Error("me/employment isn't a real folder. Move it out of the way first."));
    renderApp(<PrivacyScreen />, { bridge: b });
    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent("It looks like");
    expect(within(alert).queryByRole("button", { name: /Move .* back/ })).not.toBeInTheDocument();
    await userEvent.click(within(alert).getByRole("button", { name: "Lock again" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(`Files that were in your employment records folder will stay locked wherever they are. ${identity.name} will also lock the new employment records folder.`);
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Lock them" }));
    const msg = await screen.findByText("me/employment isn't a real folder. Move it out of the way first.");
    expect(msg.closest(".toast")).toHaveClass("toast--danger");
    expect(screen.queryByText("Locked folders are set")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Your employment records folder was moved or replaced.");
  });
  it("shows a found location as plain text, never as markup", async () => {
    const b = new MockBridge();
    b.simulateLockProblem({ folder: "me/identity", kind: "replaced", found_at: "evil\u202Egnp.exe" });
    renderApp(<PrivacyScreen />, { bridge: b });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("\u202E");
  });
});

describe("Privacy wording", () => {
  it("says each lock state in words next to its switch", async () => {
    renderApp(<PrivacyScreen />);
    const sw = await screen.findByRole("switch", { name: "Lock Identity documents" });
    expect(sw.parentElement).toHaveTextContent("Locked");
    expect(sw).toHaveAttribute("title", expect.stringMatching(/^Locked\./));
  });
  it("offers one allow button that names the chosen time", async () => {
    renderApp(<PrivacyScreen />);
    const req = await screen.findByRole("region", { name: "Access request" });
    expect(within(req).getByRole("button", { name: "Allow for 15 minutes" })).toBeInTheDocument();
    await userEvent.selectOptions(within(req).getByLabelText("Time limit"), "60");
    expect(within(req).getByRole("button", { name: "Allow for 1 hour" })).toBeInTheDocument();
    expect(within(req).queryByRole("button", { name: "Allow once" })).toBeNull();
  });
  it("turns plain field keys into words and leaves anything else as sent", () => {
    expect(fieldLabel("visa_expiry")).toBe("Visa expiry");
    expect(fieldLabel("<b>x</b>")).toBe("<b>x</b>");
    expect(minutesText(120)).toBe("2 hours");
    expect(minutesText(30)).toBe("30 minutes");
  });
});
