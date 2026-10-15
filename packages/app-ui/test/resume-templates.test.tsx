import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RESUME_LAYOUTS, TEMPLATE_INFO } from "@careeros/contract";
import { MockBridge } from "../src/mock/MockBridge";
import { RESUME_JOB } from "../src/mock/resume-fixture";
import { ResumeStudioScreen } from "../src/screens/ResumeStudio";
import { renderApp } from "./render";

// Fictional data only (Alex Example).
const ROUTE = { screen: "resume", slug: RESUME_JOB.slug, id: RESUME_JOB.id, file: "resume.md" } as const;
const studio = (bridge = new MockBridge({ resumeDemo: true })) => { renderApp(<ResumeStudioScreen route={ROUTE} />, { bridge }); return bridge; };
const preview = () => screen.getByRole("article", { name: "Page preview" });
const gallery = () => screen.getByRole("radiogroup", { name: "Template" });
const radios = () => within(gallery()).getAllByRole("radio") as HTMLInputElement[];
const saves = (b: MockBridge) => b.calls.filter((c) => c.method === "resume.save");
const openStyle = async () => { await screen.findByLabelText("Name"); fireEvent.click(screen.getByRole("tab", { name: "Style" })); };

describe("template gallery", { timeout: 30_000 }, () => {
  it("shows at least 14 templates, each drawn with the person's resume and marked ATS-safe or ATS caution", async () => {
    studio();
    await openStyle();
    expect(radios().length).toBe(RESUME_LAYOUTS.length);
    expect(radios().length).toBeGreaterThanOrEqual(14);
    const cards = [...gallery().querySelectorAll<HTMLElement>(".rs-template")];
    for (const card of cards) {
      const l = card.dataset.layout as (typeof RESUME_LAYOUTS)[number];
      // The thumbnail is the real page, with the person's name on it.
      expect(within(card).getByText("Alex Example", { selector: ".rp-name *, .rp-name" })).toBeInTheDocument();
      expect(within(card).getByText(TEMPLATE_INFO[l].twoColumn ? "ATS caution" : "ATS-safe")).toBeInTheDocument();
    }
    expect(cards.filter((c) => within(c).queryByText("ATS caution")).map((c) => c.dataset.layout).sort()).toEqual(["sidebar", "split"]);
    // The caution says why, in words.
    expect(within(gallery().querySelector<HTMLElement>('[data-layout="sidebar"]')!).getByText(/read them out of order/)).toBeInTheDocument();
  });

  it("filters by style and keeps the chosen template in view", async () => {
    studio();
    await openStyle();
    fireEvent.click(screen.getByRole("radio", { name: "Academic" }));
    const shown = radios().map((r) => r.value);
    // Academic templates, plus the chosen one (Classic) so it stays reachable.
    expect(shown.sort()).toEqual(["classic", "executive", "scholar"]);
    fireEvent.click(screen.getByRole("radio", { name: "Creative" }));
    expect(radios().map((r) => r.value).sort()).toEqual(["classic", "sidebar", "swiss", "timeline"]);
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(radios()).toHaveLength(RESUME_LAYOUTS.length);
  });

  it("moves between templates with the keyboard and shows the larger page on focus", async () => {
    studio();
    await openStyle();
    const first = radios()[0]!;
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "End" });
    expect(document.activeElement).toBe(radios().at(-1));
    expect(radios().at(-1)!.checked).toBe(true);
    expect(preview()).toHaveClass("rp-layout--split");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(radios()[0]!.checked).toBe(true);
    // Mouse hover opens the larger page after a short pause.
    fireEvent.mouseEnter(gallery().querySelector('[data-layout="banner"]')!);
    await waitFor(() => expect(document.querySelector(".rs-peek .rs-peek__title")?.textContent).toBe("Banner"));
    fireEvent.mouseLeave(gallery().querySelector('[data-layout="banner"]')!);
    expect(document.querySelector(".rs-peek")).toBeNull();
  });

  it("resets type and spacing to the template but keeps the colour; black-and-white templates say the colour doesn't apply", async () => {
    const b = studio();
    await openStyle();
    fireEvent.click(screen.getByRole("radio", { name: "Navy" }));
    fireEvent.click(within(gallery()).getByRole("radio", { name: /^Timeline/ }));
    expect(preview()).toHaveClass("rp-dates--gutter");
    expect(screen.queryByRole("button", { name: /Reset to Timeline defaults/ })).toBeNull();
    fireEvent.click(within(screen.getByRole("group", { name: "Dates" })).getByRole("radio", { name: "Right-aligned" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset to Timeline defaults" }));
    expect(preview()).toHaveClass("rp-dates--gutter");
    await waitFor(() => expect(saves(b).length).toBeGreaterThan(0), { timeout: 4000 });
    await waitFor(() => expect(saves(b).at(-1)!.args[3]).toMatchObject({ layout: "timeline", accent: "navy", dates: "gutter" }), { timeout: 4000 });
    fireEvent.click(within(gallery()).getByRole("radio", { name: /^Plain/ }));
    expect(screen.getByText(/Plain is black and white/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Navy" })).toBeDisabled();
  });

  it("draws two-column templates with the main column first and the side column after it", async () => {
    studio();
    await openStyle();
    fireEvent.click(screen.getByRole("radio", { name: /^Sidebar/ }));
    const cols = preview().querySelector(".rp-cols")!;
    expect([...cols.children].map((c) => c.className)).toEqual(["rp-main", "rp-side"]);
    expect(within(cols.querySelector<HTMLElement>(".rp-side")!).getByText("Skills")).toBeInTheDocument();
    expect(within(cols.querySelector<HTMLElement>(".rp-main")!).getByText("Experience")).toBeInTheDocument();
    // The header stays above both columns.
    expect(preview().querySelector(".rp-head")!.compareDocumentPosition(cols) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("sets Scholar's text in the brand's text serif and leaves Classic on Geist", async () => {
    studio();
    await openStyle();
    fireEvent.click(screen.getByRole("radio", { name: /^Scholar/ }));
    expect(preview()).toHaveClass("t-text-serif");
    fireEvent.click(screen.getByRole("radio", { name: /^Classic/ }));
    expect(preview()).not.toHaveClass("t-text-serif");
  });
});
