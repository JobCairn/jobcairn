import { describe, expect, it } from "vitest";
import { buildIndex, newJob } from "@careeros/core";
import { readHandlers as R } from "../src/read.js";
import { openSample } from "./helpers.js";

/** Made-up ad text, long enough to compare. */
const AD = [
  "Example Labs is hiring a platform engineer to look after the systems our product teams build on.",
  "You will run our cloud infrastructure, improve the deploy pipeline and help engineers ship safely and often.",
  "We use Terraform, Kubernetes and TypeScript, and we write things down so the next person can pick them up.",
  "You will be on a small, friendly team with real ownership, flexible hours and time set aside to learn.",
].join(" ");

describe("ghost and repost flags in the jobs read model", () => {
  it("flags a reposted ad, an old posting and a closed one; Hide likely stale leaves out the reposted and closed ads", () => {
    const { ctx, root } = openSample();
    const first = newJob(root, { company: "Example Labs", title: "Platform Engineer", posted: "2026-01-10", jd_text: AD });
    const again = newJob(root, { company: "Example Labs Pty Ltd", title: "Platform Engineer (Cloud)", posted: "2026-01-14", jd_text: AD });
    const old = newJob(root, { company: "Acme Corp", title: "Site Reliability Engineer", posted: "2025-11-01", jd_text: "A short ad." });
    const closed = newJob(root, { company: "Acme Corp", title: "Data Engineer", jd_text: "A short ad. Applications close 10 January 2026." });
    buildIndex(root);
    const rows = R["jobs.list"](ctx, { showIneligible: true }).rows;
    const find = (j: { company_slug: string; id: string }) => rows.find((r) => r.company_slug === j.company_slug && r.id === j.id)!;
    expect(find(first).ghost).toBeUndefined();
    expect(find(again).ghost?.repost).toMatch(/^The same ad text as "Platform Engineer"/);
    expect(find(old).ghost?.stale).toMatch(/^Posted 75 days ago/);
    expect(find(closed).closes_on).toBe("2026-01-10");
    expect(find(closed).ghost?.closed).toMatch(/closed on 10 Jan 2026/);

    const hidden = R["jobs.list"](ctx, { showIneligible: true, hideStale: true }).rows.map((r) => r.id);
    expect(hidden).toContain(first.id);
    expect(hidden).not.toContain(again.id);
    expect(hidden).toContain(old.id);
    expect(hidden).not.toContain(closed.id);

    expect(R["jobs.get"](ctx, again.company_slug, again.id).ghost?.repost).toMatch(/Platform Engineer/);
    expect(R["jobs.get"](ctx, first.company_slug, first.id).ghost).toBeUndefined();
  });
});
