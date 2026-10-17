import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex, jobFilePath, newJob, updateRecord, layout } from "@careeros/core";
import { readHandlers as R } from "../src/read.js";
import { openSample } from "./helpers.js";

describe("languages in the jobs read model", () => {
  it("marks an ad that needs a language the profile doesn't list, warns on a higher level, and reads a changed ad again", () => {
    const { ctx, root } = openSample();
    updateRecord("profile", layout(root).profile, (p) => { p.languages = [{ language: "English", level: "native" }, { language: "Japanese", level: "conversational" }]; });
    const german = newJob(root, { company: "Example Labs", title: "Solutions Engineer", jd_text: "You will work with our Berlin office.\nFluent German required." });
    const japanese = newJob(root, { company: "Acme Corp", title: "Account Manager", jd_text: "Business-level Japanese is essential." });
    const plain = newJob(root, { company: "Acme Corp", title: "Data Engineer", jd_text: "Excellent written and verbal English." });
    buildIndex(root);
    const rows = () => R["jobs.list"](ctx, { showIneligible: true }).rows;
    const find = (j: { company_slug: string; id: string }) => rows().find((r) => r.company_slug === j.company_slug && r.id === j.id)!;
    expect(find(german).lang).toMatchObject({ verdict: "block", short: "Needs German", text: "Needs German, which isn't in your profile" });
    expect(find(japanese).lang).toMatchObject({ verdict: "warn", text: "Asks for professional Japanese; your profile says Conversational" });
    expect(find(plain).lang).toBeUndefined();
    // A language block never hides the ad.
    expect(R["jobs.list"](ctx, {}).rows.some((r) => r.id === german.id)).toBe(true);

    const jd = path.join(path.dirname(jobFilePath(root, german.company_slug, german.id)), "jd.md");
    fs.writeFileSync(jd, "German is desirable.\nWe work in English.\nThe role is in Sydney and the team speaks English every day.\n");
    expect(find(german).lang).toBeUndefined();

    expect(R["jobs.get"](ctx, japanese.company_slug, japanese.id).language?.verdict).toBe("warn");
    expect(R["jobs.get"](ctx, plain.company_slug, plain.id).language).toBeNull();
  });

  it("marks nothing in Jobs when the profile lists no languages, and the job page says to add them", () => {
    const { ctx, root } = openSample();
    updateRecord("profile", layout(root).profile, (p) => { p.languages = []; });
    const job = newJob(root, { company: "Example Labs", title: "Support Engineer", jd_text: "Fluent English required." });
    buildIndex(root);
    expect(R["jobs.list"](ctx, { showIneligible: true }).rows.find((r) => r.id === job.id)?.lang).toBeUndefined();
    expect(R["jobs.get"](ctx, job.company_slug, job.id).language).toMatchObject({ verdict: "unknown" });
  });
});
