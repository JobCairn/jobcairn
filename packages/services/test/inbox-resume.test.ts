import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { layout, samplePdf } from "@careeros/core";
import type { ResumeFillState, ResumeRead } from "@careeros/contract";
import { dispatch } from "../src/dispatch.js";
import { openSample } from "./helpers.js";

/** "Use this to fill my profile": the drop box hands one waiting file to Fill from my resume, by name only. */

const HEADER = ["Alex Example", "1 Example Street, Sampletown NSW 2000", "0491 570 006 | alex@example.com", "Professional summary", "Experience", "Example Labs, 2023 - Present", "Education", "Skills"];
const VISA = "Visa grant notice\nTransaction reference number: EGO0000000\nSubclass 482. Date of birth: 01 Jan 1990.\nalex@example.com";

function drop(root: string, name: string, data: string | Uint8Array) { fs.writeFileSync(path.join(layout(root).inbox, name), data); }

describe("drop box: fill my profile from a waiting resume", () => {
  it("reads that exact drop box file on this computer and returns only its fields", async () => {
    const { ctx, root } = openSample();
    drop(root, "alex-cv.pdf", samplePdf(HEADER));
    const r = await dispatch(ctx, "inbox.readResume", ["alex-cv.pdf"]) as ResumeRead;
    expect(r).toMatchObject({ file: "alex-cv.pdf", kind: "pdf", fields: { name: "Alex Example", email: "alex@example.com", phone: "0491 570 006" } });
    expect(JSON.stringify(r)).not.toContain(root);
  }, 30_000);

  it("fills the profile and keeps a copy in Resumes; the drop box file then goes to the Trash, not a second copy", async () => {
    const { ctx, root, host } = openSample();
    drop(root, "alex-cv.md", `# Alex Example\n\n${HEADER.slice(1).join("\n")}\n`);
    const r = await dispatch(ctx, "inbox.readResume", ["alex-cv.md"]) as ResumeRead;
    const s = await dispatch(ctx, "inbox.fillProfile", ["alex-cv.md", r.fields, ["email"]]) as ResumeFillState;
    expect(s).toMatchObject({ file: "alex-cv.md", kind: "markdown", seen: false });
    expect(fs.readdirSync(path.join(root, "me", "resumes"))).toContain("alex-cv.md");
    expect(host.shell.trashed).toEqual([path.join(layout(root).inbox, "alex-cv.md")]);
    expect(await dispatch(ctx, "profile.fillState", [])).toEqual(s);
  });

  it("leaves the drop box file waiting when the Trash isn't available", async () => {
    const { ctx, root, host } = openSample();
    delete (host.shell as { trashItem?: unknown }).trashItem;
    drop(root, "alex-cv.md", `# Alex Example\n\n${HEADER.slice(1).join("\n")}\n`);
    const r = await dispatch(ctx, "inbox.readResume", ["alex-cv.md"]) as ResumeRead;
    await dispatch(ctx, "inbox.fillProfile", ["alex-cv.md", r.fields, []]);
    expect(fs.readdirSync(path.join(root, "me", "resumes"))).toContain("alex-cv.md");
    expect(fs.existsSync(path.join(layout(root).inbox, "alex-cv.md"))).toBe(true);
  });

  it("never reads a file that belongs in a locked folder", async () => {
    const { ctx, root } = openSample();
    drop(root, "letter.txt", VISA);
    const msg = "This file looks like it belongs in a locked folder, so it can't be used to fill your profile.";
    await expect(dispatch(ctx, "inbox.readResume", ["letter.txt"])).rejects.toThrow(msg);
    await expect(dispatch(ctx, "inbox.fillProfile", ["letter.txt", { email: "alex@example.com" }, []])).rejects.toThrow(msg);
    expect(fs.existsSync(path.join(root, "me", "resumes", "letter.txt"))).toBe(false);
  });

  it("refuses names that aren't plain drop box files", async () => {
    const { ctx } = openSample();
    for (const bad of ["../settings/profile.json", "/etc/hosts", "_filed.md", ".hidden"]) {
      await expect(dispatch(ctx, "inbox.readResume", [bad])).rejects.toThrow();
    }
    await expect(dispatch(ctx, "inbox.readResume", ["missing.pdf"])).rejects.toThrow(/not in the drop box/);
  });
});
