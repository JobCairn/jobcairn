import { describe, expect, it } from "vitest";
import { layout, readRecord } from "@careeros/core";
import { dispatch, MUTATION_AREAS } from "../src/dispatch.js";
import { jobExtraHandlers as X } from "../src/job-extras.js";
import { openSample } from "./helpers.js";

const ACME = ["acme-corp", "2026-01-12-ai-engineer"] as const;
const OFFER = { base: 120_000, super_rate: null, bonus: 5_000, equity: "", work_mode: "Hybrid", commute: "30 min", start_date: "2026-02-02" };

describe("offer details", () => {
  it("are saved on the job record through the store, with one timeline note", () => {
    const { ctx, root } = openSample();
    expect(X["jobs.setOffer"](ctx, ...ACME, OFFER).job.offer).toEqual(OFFER);
    X["jobs.setOffer"](ctx, ...ACME, { ...OFFER, base: 125_000 });
    const rec = readRecord("job", layout(root).jobFile(...ACME));
    expect(rec.offer).toMatchObject({ base: 125_000, bonus: 5_000 });
    expect(rec.timeline.filter((e) => e.event === "Offer details added")).toHaveLength(1);
    expect(MUTATION_AREAS["jobs.setOffer"]).toContain("jobs");
  });

  it("are checked at the IPC boundary", async () => {
    const { ctx } = openSample();
    await expect(dispatch(ctx, "jobs.setOffer", [...ACME, { ...OFFER, super_rate: 12 }])).rejects.toThrow();
  });
});
