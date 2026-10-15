import { describe, expect, it } from "vitest";
import { JOB_STATUSES, WR_LABELS } from "@careeros/contract";
import { Icons } from "@careeros/brand";
import { fitView, rightsView, sponsorView, statusView } from "../src/jobs/cells/meta";

describe("fitView", () => {
  it("bands the fit at the scoring rubric's thresholds (85 and 70), with the number in the label", () => {
    expect(fitView(92)).toMatchObject({ band: "top", label: "92 of 100, strong match" });
    expect(fitView(85)!.band).toBe("top");
    expect(fitView(84)!.band).toBe("high");
    expect(fitView(70)!.band).toBe("high");
    expect(fitView(69)!.band).toBe("mid");
    expect(fitView(50)!.band).toBe("mid");
    expect(fitView(49)!.band).toBe("low");
    expect(fitView(0)!.band).toBe("low");
  });
  it("is null when the job isn't scored, and clamps odd values", () => {
    expect(fitView(null)).toBeNull();
    expect(fitView(140)!.value).toBe(100);
    expect(fitView(-3)!.value).toBe(0);
  });
});

describe("sponsorView", () => {
  it("makes an ad that offers sponsorship the loudest state, even without a score", () => {
    expect(sponsorView(95, "sponsorship_offered")).toMatchObject({ kind: "explicit", word: "Confirmed", tone: "success", value: 95 });
    expect(sponsorView(null, "sponsorship_offered")).toMatchObject({ kind: "explicit", value: null });
    expect(sponsorView(95, "sponsorship_offered").title).toMatch(/ad says sponsorship is available/i);
  });
  it("uses the Sponsors screen's tier words for everything else", () => {
    expect(sponsorView(92, "silent")).toMatchObject({ kind: "tier", word: "Very high", tone: "success" });
    expect(sponsorView(70, "visa_ok")).toMatchObject({ word: "High", tone: "success" });
    expect(sponsorView(50, "silent")).toMatchObject({ word: "Medium", tone: "warning" });
    expect(sponsorView(20, "silent")).toMatchObject({ word: "Low", tone: "danger" });
    expect(sponsorView(15, "silent")).toMatchObject({ word: "Very low", tone: "danger" });
  });
  it("reads as a blocker when the ad rules sponsorship out, or the employer is on the sanctioned list", () => {
    expect(sponsorView(5, "citizen_pr_only")).toMatchObject({ kind: "blocked", word: "Ruled out", tone: "danger" });
    expect(sponsorView(5, "clearance").title).toMatch(/clearance/i);
    expect(sponsorView(0, "silent")).toMatchObject({ kind: "blocked", word: "Avoid", tone: "danger" });
  });
  it("says unknown, quietly, when there is no score", () => {
    expect(sponsorView(null, "silent")).toMatchObject({ kind: "unknown", word: "Unknown", tone: "neutral", value: null });
  });
});

describe("statusView", () => {
  it("gives every status its own icon and a word, so colour is never the only signal", () => {
    const views = JOB_STATUSES.map(statusView);
    expect(new Set(views.map((v) => v.icon)).size).toBe(JOB_STATUSES.length);
    for (const v of views) {
      expect(v.word.length).toBeGreaterThan(0);
      expect(Icons[v.icon]).toBeTruthy();
    }
  });
  it("marks the good, bad and closed ends of the pipeline", () => {
    expect(statusView("Offer")).toMatchObject({ tone: "success", strong: true });
    expect(statusView("Interview").tone).toBe("success");
    expect(statusView("Rejected").tone).toBe("danger");
    expect(statusView("Skipped").tone).toBe("muted");
    expect(statusView("Found").tone).toBe("muted");
  });
});

describe("rightsView", () => {
  it("shortens every label, keeping the full wording for the tooltip and screen readers", () => {
    for (const l of WR_LABELS) {
      const v = rightsView(l, "primary")!;
      expect(v.short.length).toBeLessThanOrEqual(v.full.length);
      expect(Icons[v.icon]).toBeTruthy();
    }
    expect(rightsView("citizen_pr_only", "primary")).toMatchObject({ short: "PR only", full: "Citizens/PR only", tone: "danger" });
  });
  it("only fills the sponsorship-offered label, and only for someone who needs sponsorship", () => {
    expect(rightsView("sponsorship_offered", "primary")).toMatchObject({ short: "Sponsors", filled: true, tone: "success" });
    expect(rightsView("sponsorship_offered", "secondary")).toMatchObject({ filled: false, tone: "neutral" });
    expect(rightsView("silent", "primary")!.filled).toBe(false);
  });
  it("follows the candidate: hidden or neutral when sponsorship doesn't matter to them", () => {
    expect(rightsView("sponsorship_offered", "off")).toBeNull();
    expect(rightsView("citizen_pr_only", "off")!.tone).toBe("neutral");
    expect(rightsView("clearance", "off")!.tone).toBe("danger");
  });
});
