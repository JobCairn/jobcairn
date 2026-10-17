import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addConfirmedFact, confirmedFactLine, initWorkspace } from "../src/index.js";
import { run } from "../src/cli.js";

// Fictional data only (Alex Example, Acme Corp).
function ws(): string {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "careeros-facts-")), "ws");
  initWorkspace(root, { name: "Alex Example" });
  return root;
}
const factsFile = (root: string) => path.join(root, "me", "history", "confirmed-facts.md");
const now = { now: new Date("2026-10-17T09:00:00Z") };

describe("confirmed facts", () => {
  it("writes one line per fact under a heading, with the day and where", () => {
    expect(confirmedFactLine("  Led   the move\nto Airflow ", "2026-10-17", "your note")).toBe("- Led the move to Airflow (confirmed 2026-10-17, your note)");
    const root = ws();
    expect(addConfirmedFact(root, "Mentored 2 graduates at Acme Corp", "kept in a review", now)).toBe(true);
    expect(addConfirmedFact(root, "Ran the on-call roster", "", now)).toBe(true);
    const text = fs.readFileSync(factsFile(root), "utf8");
    expect(text.startsWith("# Confirmed facts\n")).toBe(true);
    expect(text).toContain("- Mentored 2 graduates at Acme Corp (confirmed 2026-10-17, kept in a review)\n- Ran the on-call roster (confirmed 2026-10-17)\n");
  });

  it("doesn't add the same fact twice", () => {
    const root = ws();
    addConfirmedFact(root, "Mentored 2 graduates at Acme Corp", "a", now);
    expect(addConfirmedFact(root, "mentored 2 graduates at acme corp", "b", { now: new Date("2026-11-01T00:00:00Z") })).toBe(false);
    expect(fs.readFileSync(factsFile(root), "utf8").match(/^- /gm)).toHaveLength(1);
  });

  it("refuses an empty fact and a linked file", () => {
    const root = ws();
    expect(() => addConfirmedFact(root, "  ", "")).toThrow("The fact is empty.");
    const elsewhere = path.join(path.dirname(root), "elsewhere.md");
    fs.writeFileSync(elsewhere, "");
    fs.symlinkSync(elsewhere, factsFile(root));
    expect(() => addConfirmedFact(root, "Something true", "")).toThrow("isn't a plain file");
    expect(fs.readFileSync(elsewhere, "utf8")).toBe("");
  });

  it("careeros fact add saves it", () => {
    const root = ws();
    const r = run(["fact", "add", "Presented at an Example Labs meetup", "--from", "chat", "--ws", root]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ added: true, file: "me/history/confirmed-facts.md" });
    expect(fs.readFileSync(factsFile(root), "utf8")).toContain("- Presented at an Example Labs meetup (confirmed ");
  });
});
