import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TOUR_IDS, type TourId } from "@careeros/contract";
import { App } from "../src/App";
import { MockBridge } from "../src/mock/MockBridge";
import { SCREENS } from "../src/screens/registry";
import { TOURS, tourForRoute } from "../src/tour/content";
import { parseHash } from "../src/router";

/**
 * Guards so tours never drift from the UI. Rule for every lane: a new screen needs tour steps; a moved control
 * takes its data-tour attribute with it. Steps whose control only shows in some states say why in `optional`.
 */
const ROUTE: Record<TourId, string> = {
  home: "#/home", jobs: "#/jobs", job: "#/job/acme-corp/2026-01-12-ai-engineer", apply: "#/apply/example-labs/2026-01-12-backend-engineer-llm",
  resume: "#/resume/acme-corp/2026-01-12-ai-engineer/resume.md", learn: "#/learn", inbox: "#/inbox", settings: "#/settings",
  applications: "#/applications", searches: "#/searches", companies: "#/companies", company: "#/company/acme-corp", approvals: "#/approvals", privacy: "#/privacy", videos: "#/videos", mail: "#/mail",
  resumes: "#/resumes", recruiters: "#/recruiters", recruiter: "#/recruiter/acme-recruiting",
};
/** Screens with no tour of their own, and why. */
const NO_TOUR: Record<string, string> = {
  video: "One video's player page, opened from a video list; it has a single Play control and no steps worth touring.",
  "resume-variant": "A general resume version in the same resume editor: it uses the resume tour (tourForRoute).",
};

afterEach(() => { cleanup(); window.location.hash = ""; });

describe("tour coverage", () => {
  it("every screen in the router has a tour (or a reason not to)", () => {
    for (const screenName of Object.keys(SCREENS)) {
      if (NO_TOUR[screenName]) continue;
      const route = parseHash(ROUTE[screenName as TourId] ?? `#/${screenName}`);
      // A hash the router can't parse falls back to Home, which would pass for the wrong reason.
      expect(route.screen, `${screenName} needs a route in ROUTE above`).toBe(screenName);
      expect(tourForRoute(route), `${screenName} has no tour: add steps in tour/content.ts`).toBe(screenName);
    }
  });
  it("every tour id has a route here and steps", () => {
    for (const id of TOUR_IDS) {
      expect(ROUTE[id], id).toBeTruthy();
      expect(TOURS[id].steps.length, id).toBeGreaterThan(0);
    }
  });
});

describe("tour anchors", () => {
  for (const id of TOUR_IDS) {
    it(`every required step of the ${id} tour points at something on screen`, async () => {
      window.location.hash = ROUTE[id];
      render(<App bridge={new MockBridge({ resumeDemo: true })} />);
      await screen.findByRole("navigation", { name: "Main" });
      const required = TOURS[id].steps.filter((s) => !s.optional);
      await waitFor(() => {
        const missing = required.filter((s) => !document.querySelector(s.target)).map((s) => `${s.id} (${s.target})`);
        expect(missing, `${id} tour: controls missing`).toEqual([]);
      }, { timeout: 6000 });
    }, 20_000);
  }
});
