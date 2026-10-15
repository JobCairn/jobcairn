import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { loadFixture, MockBridge } from "../src/mock/MockBridge";
import { stepBody, TOURS, tourForRoute, type TourStep } from "../src/tour/content";
import { availableSteps, findTarget, holeFor, isExampleFolder, neighbour, placeCard, resolveStep } from "../src/tour/engine";
import { setVideoProbe } from "../src/tour/journeys";
import { resetTourStore } from "../src/tour/store";

// jsdom has no layout: give every element a size so "is it on screen?" checks pass for whatever is rendered.
// Controls that aren't rendered at all (or sit in a hidden section) still count as missing.
beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() =>
    ({ x: 120, y: 120, top: 120, left: 120, width: 240, height: 40, right: 360, bottom: 160, toJSON: () => ({}) }) as DOMRect);
  setVideoProbe(async () => false);
});
afterEach(() => {
  vi.restoreAllMocks();
  resetTourStore();
  setVideoProbe(null);
  window.location.hash = "";
});

const step = (id: string, target = `#${id}`): TourStep => ({ id, target, title: id, body: id });

/** A bridge whose folder is the made-up example (the onboarding lane adds `isSample` to the folder status). */
function exampleBridge(opts: { status?: string } = {}): MockBridge {
  const f = loadFixture();
  if (opts.status) (f.profile as { work_rights: { status: string } }).work_rights.status = opts.status;
  const b = new MockBridge({ fixture: f });
  const current = b.workspace.current;
  b.workspace = { ...b.workspace, current: async () => { const ws = await current(); return ws ? { ...ws, isSample: true } as typeof ws : ws; } };
  return b;
}
function withStatus(status: string): MockBridge {
  const f = loadFixture();
  (f.profile as { work_rights: { status: string } }).work_rights.status = status;
  return new MockBridge({ fixture: f });
}
const tourCard = () => screen.findByRole("dialog", {}, { timeout: 4000 });
const helpButton = () => screen.findByRole("button", { name: "Show me around this page" });

describe("tour engine", () => {
  it("skips steps whose control isn't on screen, and keeps going from where it was", () => {
    const all = [step("a"), step("b"), step("c"), step("d")];
    const avail = availableSteps(all, (sel) => sel !== "#b");
    expect(avail.map((s) => s.id)).toEqual(["a", "c", "d"]);
    expect(resolveStep(all, avail, null)?.id).toBe("a");
    expect(resolveStep(all, avail, "c")?.id).toBe("c");
    // "b" vanished while showing: move on to the next one that's there.
    expect(resolveStep(all, avail, "b")?.id).toBe("c");
    expect(resolveStep(all, [all[0]!], "d")?.id).toBe("a");
    expect(resolveStep(all, [], "a")).toBeNull();
    expect(neighbour(avail, "a", 1)?.id).toBe("c");
    expect(neighbour(avail, "c", -1)?.id).toBe("a");
    expect(neighbour(avail, "d", 1)).toBeNull();
  });

  it("only counts controls that are actually shown", () => {
    document.body.innerHTML = `<div id="shown"></div><div hidden><button id="inside-hidden"></button></div><span id="none" style="display:none"></span>`;
    expect(findTarget("#shown")).not.toBeNull();
    expect(findTarget("#inside-hidden")).toBeNull();
    expect(findTarget("#none")).toBeNull();
    expect(findTarget("#missing")).toBeNull();
    expect(findTarget("[[bad selector")).toBeNull();
    vi.mocked(Element.prototype.getBoundingClientRect).mockReturnValue({ top: 0, left: 0, width: 0, height: 0 } as DOMRect);
    expect(findTarget("#shown")).toBeNull(); // squeezed out of a narrow window
    document.body.innerHTML = "";
  });

  it("puts the card beside the control and always on screen", () => {
    const view = { width: 1024, height: 768 };
    const card = { width: 340, height: 180 };
    expect(placeCard({ top: 100, left: 100, width: 200, height: 40 }, card, view).side).toBe("bottom");
    expect(placeCard({ top: 650, left: 100, width: 200, height: 40 }, card, view).side).toBe("top");
    const big = placeCard(holeFor({ top: -200, left: 0, width: 1024, height: 2000 }, view), card, view);
    expect(big.top).toBeGreaterThanOrEqual(12);
    expect(big.top + card.height).toBeLessThanOrEqual(768);
    expect(placeCard({ top: 100, left: 900, width: 100, height: 40 }, card, view).left).toBeLessThanOrEqual(1024 - 340 - 12);
  });

  it("reads the example flag defensively", () => {
    expect(isExampleFolder({ root: "/x", isSample: true })).toBe(true);
    expect(isExampleFolder({ root: "/x" })).toBe(false);
    expect(isExampleFolder({ root: "/x", isSample: "yes" })).toBe(false);
    expect(isExampleFolder(null)).toBe(false);
  });

  it("every tour has 3 to 6 steps and plain, friendly words", () => {
    const banned = /\b(workspace|fixture|sample|demo|mcp|slug|ipc)\b/i;
    for (const def of Object.values(TOURS)) {
      expect(def.steps.length, def.id).toBeGreaterThanOrEqual(3);
      expect(def.steps.length, def.id).toBeLessThanOrEqual(6);
      const words = [def.intro.title, def.intro.body, ...def.steps.flatMap((s) => [s.title, ...(["primary", "secondary", "off"] as const).map((f) => (typeof s.body === "function" ? s.body(f) : s.body))])];
      for (const w of words) {
        expect(w, w).not.toMatch(banned);
        expect(w, w).not.toMatch(/—/);
        expect(w.split(/(?<=[.!?])\s+/).length, w).toBeLessThanOrEqual(2);
      }
    }
  });
});

describe("the mail tours point at real controls", () => {
  it("Mail has its own tour, and every step's control is on the screen", async () => {
    expect(tourForRoute({ screen: "mail" })).toBe("mail");
    window.location.hash = "#/mail";
    render(<App bridge={new MockBridge()} />);
    await screen.findByRole("list", { name: "Job mail" }, { timeout: 5000 });
    for (const s of TOURS.mail.steps.filter((x) => x.id !== "connect")) expect(findTarget(s.target), s.id).not.toBeNull();
    expect(findTarget(TOURS.mail.steps.find((x) => x.id === "connect")!.target)).toBeNull();
  });
  it("before Gmail is connected (as in the example), the Mail tour points at Connect Gmail", async () => {
    window.location.hash = "#/mail";
    render(<App bridge={new MockBridge({ mailConnected: false })} />);
    await screen.findByRole("button", { name: "Connect Gmail" }, { timeout: 5000 });
    expect(TOURS.mail.steps.filter((s) => findTarget(s.target)).map((s) => s.id)).toEqual(["connect"]);
  });
  it("the job tour shows the Mail tab, and Try it opens it", async () => {
    const mail = TOURS.job.steps.find((s) => s.id === "mail")!;
    expect(mail).toBeDefined();
    window.location.hash = "#/job/acme-corp/2026-01-12-ai-engineer";
    render(<App bridge={new MockBridge()} />);
    await screen.findByRole("tablist", { name: "Job sections" }, { timeout: 5000 });
    for (const s of TOURS.job.steps.filter((x) => x.id === "mail" || x.id === "tabs")) expect(findTarget(s.target), s.id).not.toBeNull();
    await userEvent.click(findTarget(mail.tryIt!.target ?? mail.target)! as HTMLElement);
    expect(await screen.findByRole("button", { name: "New email" })).toHaveAttribute("data-tour", "job-mail-new");
  });
});

describe("when a tour appears", () => {
  it("starts by itself on a first visit in the example folder, with a welcome card", async () => {
    window.location.hash = "#/jobs";
    const b = exampleBridge();
    render(<App bridge={b} />);
    const card = await tourCard();
    expect(card).toHaveAccessibleName(/This is Jobs/);
    expect(within(card).getByText("Video coming soon")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Start tour" }));
    expect(await screen.findByRole("dialog", { name: /^1 of \d Find more jobs/ })).toBeInTheDocument();
  });

  it("never starts by itself in a real folder", async () => {
    window.location.hash = "#/jobs";
    render(<App bridge={new MockBridge()} />);
    await helpButton();
    await act(() => new Promise((r) => setTimeout(r, 1300)));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a workspace onboarding just made offers Home's tour once, as a welcome card that can be closed", async () => {
    window.location.hash = "#/home";
    const b = new MockBridge();
    await b.workspace.create("/fictional/alex-example/CareerOS", "Alex Example");
    render(<App bridge={b} />);
    const card = await tourCard();
    expect(card).toHaveAccessibleName(/Home/);
    expect((await b.tour.state()).welcome).toBe(true);
  });

  it("isn't offered again once seen or skipped", async () => {
    window.location.hash = "#/jobs";
    const b = exampleBridge();
    await b.tour.mark("jobs", "dismissed");
    render(<App bridge={b} />);
    await helpButton();
    await act(() => new Promise((r) => setTimeout(r, 1300)));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the help button shows you around the page you're on, and follows you to the next page", async () => {
    window.location.hash = "#/jobs";
    render(<App bridge={new MockBridge()} />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const help = await within(nav).findByRole("button", { name: "Show me around this page" });
    await screen.findByRole("textbox", { name: "Search jobs" });
    await userEvent.click(help);
    expect(await screen.findByRole("dialog", { name: /^1 of \d Find more jobs/ })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(help).toHaveFocus());
    act(() => { window.location.hash = "#/privacy"; });
    await screen.findByRole("heading", { name: "Privacy", level: 1 });
    await userEvent.click(await within(nav).findByRole("button", { name: "Show me around this page" }));
    expect(await screen.findByRole("dialog", { name: /^1 of \d Locked by default/ })).toBeInTheDocument();
  });
});

describe("driving a tour", () => {
  it("Next, Back, Try it and Done, then remembers it was seen", async () => {
    window.location.hash = "#/jobs";
    const b = new MockBridge();
    render(<App bridge={b} />);
    await screen.findByRole("textbox", { name: "Search jobs" });
    await userEvent.click(await helpButton());
    const first = await screen.findByRole("dialog", { name: /^1 of (\d) / });
    const total = Number(/of (\d)/.exec(first.textContent ?? "")![1]);
    expect(within(first).queryByRole("button", { name: "Back" })).toBeNull();
    await userEvent.click(within(first).getByRole("button", { name: "Next" }));
    const second = await screen.findByRole("dialog", { name: /^2 of \d Search the list/ });
    expect(second).toHaveFocus();
    await userEvent.click(within(second).getByRole("button", { name: "Try it" }));
    expect(screen.getByRole("textbox", { name: "Search jobs" })).toHaveFocus();
    await userEvent.click(within(second).getByRole("button", { name: "Back" }));
    await screen.findByRole("dialog", { name: /^1 of \d/ });
    await userEvent.keyboard("{ArrowRight}");
    await screen.findByRole("dialog", { name: /^2 of \d/ });
    for (let i = 2; i < total; i++) await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Next" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(async () => expect((await b.tour.state()).tours.jobs?.mark).toBe("seen"));
  });

  it("Skip tour closes it and records the skip; Tab stays inside the card", async () => {
    window.location.hash = "#/jobs";
    const b = new MockBridge();
    render(<App bridge={b} />);
    await screen.findByRole("textbox", { name: "Search jobs" });
    await userEvent.click(await helpButton());
    const card = await screen.findByRole("dialog", { name: /^1 of \d/ });
    await userEvent.tab();
    expect(within(card).getByRole("button", { name: "Skip tour" })).toHaveFocus();
    await userEvent.tab();
    expect(within(card).getByRole("button", { name: "Next" })).toHaveFocus();
    await userEvent.tab();
    expect(within(card).getByRole("button", { name: "Skip tour" })).toHaveFocus();
    await userEvent.click(within(card).getByRole("button", { name: "Skip tour" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(async () => expect((await b.tour.state()).tours.jobs?.mark).toBe("dismissed"));
  });

  it("follows work rights: sponsorship steps show only for people who need them", async () => {
    const count = async (status: string) => {
      window.location.hash = "#/home";
      const { unmount } = render(<App bridge={withStatus(status)} />);
      await screen.findByLabelText("Today");
      await userEvent.click(await helpButton());
      const card = await screen.findByRole("dialog", { name: /^1 of \d/ });
      const n = Number(/of (\d)/.exec(card.textContent ?? "")![1]);
      const titles: string[] = [];
      for (let i = 0; i < n; i++) {
        const c = screen.getByRole("dialog");
        titles.push(c.querySelector(".tour-card__title")!.textContent!);
        await userEvent.click(within(c).getByRole("button", { name: i === n - 1 ? "Done" : "Next" }));
      }
      unmount();
      resetTourStore();
      return titles;
    };
    const sponsored = await count("needs_sponsorship");
    const citizen = await count("citizen");
    expect(sponsored).toContain("Your visa countdown");
    expect(sponsored).toContain("What the ads say about visas");
    expect(citizen).not.toContain("Your visa countdown");
    expect(citizen).not.toContain("What the ads say about visas");
    expect(citizen.length).toBeLessThan(sponsored.length);
  }, 30_000);
});

describe("Settings: replay and turn off", () => {
  it("Replay all tours brings them back, even in a real folder; Turn off stops them", async () => {
    window.location.hash = "#/settings?tab=appearance";
    const b = new MockBridge();
    await b.tour.mark("jobs", "seen");
    render(<App bridge={b} />);
    await userEvent.click(await screen.findByRole("button", { name: "Replay tours" }, { timeout: 10_000 }));
    await waitFor(async () => expect(await b.tour.state()).toEqual({ off: false, replay: true, tours: {} }));
    // The Settings tour now offers itself; skip it, then turn tips off.
    const offer = await tourCard();
    await userEvent.click(within(offer).getByRole("button", { name: "Not now" }));
    await userEvent.click(await screen.findByRole("button", { name: "Tips off" }));
    await waitFor(async () => expect((await b.tour.state()).off).toBe(true));
    expect(await screen.findByRole("button", { name: "Tips on" })).toBeInTheDocument();
    act(() => { window.location.hash = "#/jobs"; });
    await screen.findByRole("textbox", { name: "Search jobs" });
    await act(() => new Promise((r) => setTimeout(r, 1300)));
    expect(screen.queryByRole("dialog")).toBeNull();
  }, 20_000);

  it("after a replay, a real folder offers each page's tour once", async () => {
    window.location.hash = "#/jobs";
    const b = new MockBridge();
    await b.tour.replayAll();
    render(<App bridge={b} />);
    expect(await tourCard()).toHaveAccessibleName(/This is Jobs/);
  });
});

describe("guide video on the first card", () => {
  it("the welcome card and the first tip offer the video when it exists", async () => {
    setVideoProbe(async () => true);
    window.location.hash = "#/jobs";
    render(<App bridge={exampleBridge()} />);
    const card = await tourCard();
    const watch = within(card).getByRole("button", { name: "Watch the 1-minute video" });
    await userEvent.click(watch);
    const player = await screen.findByRole("dialog", { name: "Find and score jobs" });
    expect(player.querySelector("video track")).toHaveAttribute("kind", "captions");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Find and score jobs" })).toBeNull());
    // Back on the tour's welcome card, not closed by the same Esc.
    const back = await screen.findByRole("dialog", { name: /This is Jobs/ });
    await waitFor(() => expect(within(back).getByRole("button", { name: "Watch the 1-minute video" })).toHaveFocus());
    await userEvent.click(within(back).getByRole("button", { name: "Start tour" }));
    const first = await screen.findByRole("dialog", { name: /^1 of \d/ });
    expect(within(first).getByRole("button", { name: "Watch the 1-minute video" })).toBeInTheDocument();
    await userEvent.click(within(first).getByRole("button", { name: "Next" }));
    const second = await screen.findByRole("dialog", { name: /^2 of \d/ });
    expect(within(second).queryByRole("button", { name: "Watch the 1-minute video" })).toBeNull();
  });

  it("Settings has no video of its own, so its welcome card only shows you around", async () => {
    window.location.hash = "#/settings";
    const b = exampleBridge();
    render(<App bridge={b} />);
    const card = await tourCard();
    expect(card).toHaveAccessibleName(/Your settings/);
    expect(within(card).queryByText("Video coming soon")).toBeNull();
    expect(within(card).getByRole("button", { name: "Start tour" })).toBeInTheDocument();
  });
});

describe("Recruiters tour", () => {
  const shown = () => availableSteps(TOURS.recruiters.steps, (sel) => !!findTarget(sel)).map((s) => s.id);

  it("walks the cards when there are agencies", async () => {
    window.location.hash = "#/recruiters";
    render(<App bridge={new MockBridge()} />);
    await screen.findByRole("article", { name: "Acme Recruiting" });
    await waitFor(() => expect(shown()).toEqual(["head", "find", "card", "email", "track", "bulk"]));
    expect(tourForRoute({ screen: "recruiters" })).toBe("recruiters");
  });

  it("still runs with no agencies: the screen and the Find recruiters button", async () => {
    const f = loadFixture();
    f.agencies = [];
    window.location.hash = "#/recruiters";
    render(<App bridge={new MockBridge({ fixture: f })} />);
    await screen.findByText(/No recruiters yet/);
    await waitFor(() => expect(shown()).toEqual(["head", "find"]));
  });

  it("mentions the sponsorship question only to people who need sponsorship", () => {
    const email = TOURS.recruiters.steps.find((s) => s.id === "email")!;
    expect(stepBody(email, "primary")).toMatch(/sponsorship question/);
    expect(stepBody(email, "off")).not.toMatch(/sponsor/i);
  });
});
