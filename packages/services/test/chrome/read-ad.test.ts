import path from "node:path";
import { describe, expect, it } from "vitest";
import type { JobPreviewResult } from "@careeros/contract";
import { dispatch } from "../../src/dispatch.js";
import type { ChromeHost } from "../../src/chrome/service.js";
import { chromeFor } from "../../src/chrome/service.js";
import { fakeRunner } from "../../src/claude/process.js";
import { fakeBrowser, type FakePage } from "./fake-browser.js";
import { openSample, tmpDir } from "../helpers.js";

/** "Add a job" from a board link, read in the fake browser only (fictional pages; no real Chrome or job site). */
const AD = "https://www.seek.com.au/job/81234567";
const PAGES: Record<string, FakePage> = {
  [AD]: {
    els: [{ ref: "e1", role: "heading", name: "Senior AI Engineer" }, { ref: "e2", role: "button", name: "Quick apply" }],
    main: "Senior AI Engineer\nAcme Corp\nLocation: Sampletown NSW\nHybrid\n\nBuild agents.\n\nVisa sponsorship is available.",
  },
  "https://www.linkedin.com/jobs/view/4012345678/": { els: [{ ref: "e1", role: "link", name: "Sign in" }], redirect: "https://www.linkedin.com/authwall?trk=x" },
  "https://www.linkedin.com/authwall?trk=x": { els: [{ ref: "e1", role: "link", name: "Sign in" }] },
  // SEEK masks the email in the ad's text; the link's address is the real one. A page title and a JobPosting block too.
  "https://www.seek.com.au/job/81234569": {
    els: [
      { ref: "e1", role: "heading", name: "Senior AI Engineer" },
      { ref: "e2", role: "link", name: "••••@example.com", href: "mailto:jobs@example.com?subject=AI%20Engineer%20role" },
      { ref: "e3", role: "link", name: "0491 570 006", href: "tel:0491570006" },
      { ref: "e4", role: "link", name: "Email us", href: "mailto:JOBS@example.com" },
    ],
    main: "Senior AI Engineer\nExample Labs\nSampletown NSW\n\nBuild agents.\n\nEmail: ••••@example.com",
    title: "Senior AI Engineer Job in Sampletown NSW - SEEK",
    ldJson: { 'script[type="application/ld+json"]': JSON.stringify({ "@context": "https://schema.org", "@type": "JobPosting", title: "Lead AI Engineer", hiringOrganization: { "@type": "Organization", name: "Example Labs" } }) },
  },
  "https://www.linkedin.com/jobs/view/4012345679/": {
    els: [{ ref: "e1", role: "heading", name: "AI Engineer" }, { ref: "e2", role: "link", name: "Email", href: "mailto:talent@example.com" }],
    main: "AI Engineer\nAcme Corp\nSampletown NSW\n\nBuild agents.",
    title: "AI Engineer | Acme Corp | LinkedIn",
    ldJson: { 'script[type="application/ld+json"]': "{\"@type\":\"JobPosting\",\"title\":\"Outside main\"}", 'main script[type="application/ld+json"]': "{\"@type\":\"JobPosting\",\"title\":\"Staff AI Engineer\",\"hiringOrganization\":{\"name\":\"Acme Corp\"}}" },
  },
  "https://www.seek.com.au/job/81234568": { els: [{ ref: "e1", role: "heading", name: "Just a moment, checking your browser" }, { ref: "e2", role: "button", name: "Verify" }] },
};

function setup(o: { connect?: boolean } = {}) {
  const s = openSample();
  const fb = fakeBrowser({ pages: PAGES });
  const data = tmpDir();
  const ownBin = path.join(data, "browser-helper", "node_modules", ".bin", "agent-browser");
  const host: ChromeHost = {
    runner: fakeRunner((cmd, args, opts) => fb.runner.run(cmd, args, opts)), platform: "darwin", env: { PATH: "/usr/bin", HOME: "/Users/alex" },
    home: "/Users/alex", dataDir: data, tmpDir: data, chromeInstalled: () => true, openRemotePage: async () => true, portOpen: async () => true,
    isExecutable: (p) => p === ownBin,
  };
  s.host.chrome = host;
  const call = <T>(m: string, ...args: unknown[]) => dispatch(s.ctx, m, args) as Promise<T>;
  return { ...s, fb, call, connect: async () => { if (o.connect !== false) await call("chrome.connect"); } };
}

describe("Add a job: a board link read in the person's Chrome", () => {
  it("reads the page title, the JobPosting block and the ad's contact links (the real address behind a masked email) as data", async () => {
    const x = setup();
    await x.connect();
    x.fb.calls.length = 0;
    const r = await x.call<JobPreviewResult>("jobs.preview", { url: "https://www.seek.com.au/job/81234569" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The JobPosting block beats the loose text; the email behind the masked one is the job's "Apply via".
    expect(r.preview.draft).toMatchObject({ title: "Lead AI Engineer", company: "Example Labs", apply_via: "jobs@example.com" });
    expect(r.preview.draft.jd_text).toContain("Contact links in this ad: jobs@example.com (the ad's text shows it masked as ••••@example.com), 0491570006");
    expect(r.preview.draft.jd_text).not.toContain("subject=");
    // Read-only: no click, nothing opened from a link.
    expect(x.fb.calls.some((c) => c[0] === "click" || c[0] === "open")).toBe(false);
    expect(x.fb.calls).toContainEqual(["get", "title"]);
    expect(x.fb.calls).toContainEqual(["snapshot", "-i", "-c", "-u", "-s", "main"]);
  });

  it("on LinkedIn, the JobPosting block and contact links are read inside its main landmark only", async () => {
    const x = setup();
    await x.connect();
    x.fb.calls.length = 0;
    const r = await x.call<JobPreviewResult>("jobs.preview", { url: "https://www.linkedin.com/jobs/view/4012345679/" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.draft).toMatchObject({ title: "Staff AI Engineer", apply_via: "talent@example.com" });
    const html = x.fb.calls.filter((c) => c[0] === "get" && c[1] === "html").map((c) => c[2]);
    expect(html).toEqual(['main script[type="application/ld+json"]']);
    expect(x.fb.calls.filter((c) => c[0] === "snapshot" && c.includes("-u"))).toEqual([["snapshot", "-i", "-c", "-u", "-s", "main"]]);
  });

  it("asks to connect first, and never connects by itself", async () => {
    const x = setup();
    const r = await x.call<JobPreviewResult>("jobs.preview", { url: AD });
    expect(r).toMatchObject({ ok: false, need: "connect_chrome", site: "SEEK" });
    expect(x.fb.calls).toEqual([]);
  });

  it("reads the ad in a new tab of its own, read-only, then closes that tab", async () => {
    const x = setup();
    await x.connect();
    x.fb.calls.length = 0;
    const r = await x.call<JobPreviewResult>("jobs.preview", { url: `${AD}?type=standout#sol=1` });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview).toMatchObject({ via: "chrome", draft: { url: AD, title: "Senior AI Engineer", company: "Acme Corp", location: "Sampletown NSW", work_mode: "Hybrid", source_site: "SEEK", rights: "sponsorship_offered" } });
    // Only its own tab: opened, looked at, read, closed. No click, no typing; the person's tabs are untouched.
    // The attachment check (get cdp-url) comes first; then only its own tab.
    expect(x.fb.calls[0]).toEqual(["get", "cdp-url"]);
    x.fb.calls.splice(0, 1);
    const verbs = x.fb.calls.map((c) => c[0]);
    expect(verbs).not.toContain("click");
    expect(verbs).not.toContain("fill");
    expect(x.fb.calls[0]!.slice(0, 3)).toEqual(["tab", "new", "--label"]);
    expect(x.fb.calls[0]!.at(-1)).toBe(AD);
    expect(x.fb.calls.at(-1)![0]).toBe("tab");
    expect(x.fb.calls.at(-1)![1]).toBe("close");
    expect([...x.fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin"]);
    for (const a of x.fb.acted) expect(a.tab).toMatch(/^cos-add-/);
  });

  it("stops at a sign-in wall or a security check, says so, and still closes its tab", async () => {
    const x = setup();
    await x.connect();
    expect(await x.call("jobs.preview", { url: "https://www.linkedin.com/jobs/search/?currentJobId=4012345678" })).toMatchObject({ ok: false, need: "sign_in", site: "LinkedIn" });
    expect(await x.call("jobs.preview", { url: "https://www.seek.com.au/job/81234568" })).toMatchObject({ ok: false, need: "check" });
    expect([...x.fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin"]);
  });

  it("opens only a board's job-ad page, never a search or an apply page", async () => {
    const x = setup();
    await x.connect();
    x.fb.calls.length = 0;
    expect(await x.call("jobs.preview", { url: "https://www.seek.com.au/jobs?keywords=ai" })).toMatchObject({ ok: false, need: "not_found" });
    expect(x.fb.calls).toEqual([]);
    // An apply link names the ad: the ad's own page is read, never the apply page.
    expect(await x.call("jobs.preview", { url: "https://www.seek.com.au/job/81234567/apply" })).toMatchObject({ ok: true });
    expect(x.fb.calls.flat().some((a) => a.includes("/apply"))).toBe(false);
  });

  it("waits for a running search instead of sharing the tab session", async () => {
    const x = setup();
    await x.connect();
    (chromeFor(x.ctx) as unknown as { active: unknown }).active = { run: "abcdef123456", boards: ["seek"] };
    expect(await x.call("jobs.preview", { url: AD })).toMatchObject({ ok: false, need: "busy" });
  });
});
