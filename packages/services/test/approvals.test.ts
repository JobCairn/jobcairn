import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { layout, listApprovals, proposeApproval, proposeEmailSend, readApproval, readRecord, updateRecord, writeDraft } from "@careeros/core";
import { approvalHandlers as AP, CHANGED_SINCE_OPENED } from "../src/approvals.js";
import { approvalDigest } from "../src/read.js";
import { applyHandlers } from "../src/apply.js";
import { ServiceContext } from "../src/context.js";
import { openWorkspace } from "../src/workspace.js";
import { openSample } from "./helpers.js";

const LABS = ["example-labs", "2026-01-12-backend-engineer-llm"] as const;
const job = (root: string) => readRecord("job", layout(root).jobFile(...LABS));
/** The digest a card showing this approval right now would send back. */
const dg = (root: string, id: string) => approvalDigest(readApproval(root, id));
const pending = (root: string) => listApprovals(root).find((a) => a.status === "pending")!;

describe("approvals (Review Focus 3)", () => {
  it("runs a status change once", async () => {
    const { ctx, root } = openSample();
    const id = pending(root).id;
    expect(await AP["approvals.approve"](ctx, id, dg(root, id))).toMatchObject({ status: "done", result_note: "Status set to Interview" });
    expect(job(root).status).toBe("Interview");
    await expect(AP["approvals.approve"](ctx, id, dg(root, id))).rejects.toThrow(/is done; it can't become approved/);
    expect(job(root).timeline.filter((e) => e.event === "Status: Interview")).toHaveLength(1);
  });

  it("runs once when two approves race", async () => {
    const { ctx, root } = openSample();
    const id = pending(root).id;
    const results = await Promise.allSettled([AP["approvals.approve"](ctx, id, dg(root, id)), AP["approvals.approve"](ctx, id, dg(root, id))]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(job(root).timeline.filter((e) => e.event === "Status: Interview")).toHaveLength(1);
  });

  it("declines without running anything", () => {
    const { ctx, root } = openSample();
    expect(AP["approvals.decline"](ctx, pending(root).id, "Not yet")).toMatchObject({ status: "declined", result_note: "Not yet" });
    expect(job(root).status).toBe("Found");
  });

  it("hands off an application: opens the https link and the folder, and logs it", async () => {
    const { ctx, root, host } = openSample();
    const app = path.join(layout(root).jobDir(...LABS), "application");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "resume.md"), "# Alex Example\n");
    applyHandlers["apply.requestApproval"](ctx, ...LABS);
    const a = listApprovals(root).find((x) => x.action === "apply_handoff")!;
    expect(await AP["approvals.approve"](ctx, a.id, dg(root, a.id))).toMatchObject({ status: "done" });
    expect(host.shell.shown).toEqual([app]);
    expect(host.shell.opened.every((u) => u.startsWith("https://"))).toBe(true);
    expect(job(root).timeline.at(-1)?.event).toBe("Handed off");
  });

  it("fails an email send, without throwing, when this app has no mail support", async () => {
    const { ctx, root } = openSample();
    // proposeApproval rebuilds the draft and checks its digest (R-C), so this needs a real draft
    // and a connected account rather than a hand-built payload.
    updateRecord("integrations", layout(root).integrations, (i) => { i.mail.address = "alex" + "@" + "example.com"; });
    const { draft_id } = writeDraft(root, LABS[0], LABS[1], {
      to: [{ name: "", address: "talent" + "@" + "example.org" }], cc: [], subject: "Send follow-up", attach: [],
      in_reply_to: "", references: [], purpose: "", body: "Hi,\n\nJust checking in.\n\nRegards,\nAlex",
    });
    const a = proposeEmailSend(root, LABS[0], LABS[1], draft_id, "app", ctx.clock());
    expect(await AP["approvals.approve"](ctx, a.id, dg(root, a.id))).toMatchObject({ status: "failed", result_note: "Email isn't available in this version of the app." });
    expect(listApprovals(root).find((x) => x.id === a.id)?.status).toBe("failed");
  });

  it("records a failure instead of throwing when the action can't finish", async () => {
    const { ctx, root } = openSample();
    const id = pending(root).id;
    fs.rmSync(layout(root).jobDir(...LABS), { recursive: true });
    expect(await AP["approvals.approve"](ctx, id, dg(root, id))).toMatchObject({ status: "failed", result_note: `no job ${LABS[0]}/${LABS[1]}` });
  });

  it("runs once when two windows on the same workspace approve the same card", async () => {
    const { ctx, root, host } = openSample();
    const other = new ServiceContext(host);
    other.setRoot(root);
    const id = pending(root).id;
    const results = await Promise.allSettled([AP["approvals.approve"](ctx, id, dg(root, id)), AP["approvals.approve"](other, id, dg(root, id))]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(job(root).timeline.filter((e) => e.event === "Status: Interview")).toHaveLength(1);
  });

  it("marks a hand-off failed when the person cancels opening the link", async () => {
    const { ctx, root, host } = openSample();
    const app = path.join(layout(root).jobDir(...LABS), "application");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "resume.md"), "# Alex Example\n");
    host.shell.openExternal = async () => false;
    applyHandlers["apply.requestApproval"](ctx, ...LABS);
    const a = listApprovals(root).find((x) => x.action === "apply_handoff")!;
    const events = job(root).timeline.length;
    expect(await AP["approvals.approve"](ctx, a.id, dg(root, a.id))).toMatchObject({ status: "failed", result_note: "You cancelled opening the link." });
    expect(host.shell.shown).toEqual([]);
    expect(job(root).timeline).toHaveLength(events);
  });

  it("refuses an approval whose record changed after the card was shown (final review I3)", async () => {
    const { ctx, root } = openSample();
    const id = pending(root).id;
    const shown = AP["approvals.list"](ctx).find((a) => a.id === id)!;
    const file = path.join(root, ".careeros", "approvals", `${id}.json`);
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    rec.payload.status = "Rejected";
    fs.writeFileSync(file, JSON.stringify(rec));
    await expect(AP["approvals.approve"](ctx, id, shown.digest)).rejects.toThrow(CHANGED_SINCE_OPENED);
    expect(readApproval(root, id).status).toBe("pending");
    expect(job(root).status).toBe("Found");
    // Reviewed again: the fresh card carries the new digest, and that one runs.
    const again = AP["approvals.list"](ctx).find((a) => a.id === id)!;
    expect(again.digest).not.toBe(shown.digest);
    expect(await AP["approvals.approve"](ctx, id, again.digest)).toMatchObject({ status: "done", result_note: "Status set to Rejected" });
  });

  it("says From you only for approvals this app created and nobody changed (final review I3)", async () => {
    const { ctx, root, host } = openSample();
    const app = path.join(layout(root).jobDir(...LABS), "application");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "resume.md"), "# Alex Example\n");
    applyHandlers["apply.requestApproval"](ctx, ...LABS);
    const mine = listApprovals(root).find((x) => x.action === "apply_handoff")!;
    // A record that claims to be from the app, but the app never made it.
    const forged = proposeApproval(root, { action: "status_change", title: "Move to Interview", payload: { company_slug: LABS[0], id: LABS[1], status: "Interview" }, created_by: "app" }, ctx.clock());
    const view = (id: string) => AP["approvals.list"](ctx).find((a) => a.id === id)!;
    expect(view(mine.id).from_app).toBe(true);
    expect(view(forged.id)).toMatchObject({ created_by: "app", from_app: false });
    expect(view(pending(root).id).from_app).toBe(false);
    // Remembered outside the workspace, per workspace.
    expect(Object.keys(host.state.value.appApprovals?.[root] ?? {})).toEqual([mine.id]);
    openWorkspace(ctx, root); // re-opening rewrites lastWorkspace/recent, and must keep the rest of app state
    expect(view(mine.id).from_app).toBe(true);
    // Changing the app's own record afterwards loses the label too.
    const file = path.join(root, ".careeros", "approvals", `${mine.id}.json`);
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    rec.payload.url = "https://jobs.example.com/elsewhere";
    fs.writeFileSync(file, JSON.stringify(rec));
    expect(view(mine.id).from_app).toBe(false);
  });

  it("keeps absolute paths out of a failed approval's note (final review M2)", async () => {
    const { ctx, root } = openSample();
    const id = pending(root).id;
    fs.writeFileSync(layout(root).jobFile(...LABS), JSON.stringify({ schema: 1, id: 7 }));
    const out = await AP["approvals.approve"](ctx, id, dg(root, id));
    expect(out.status).toBe("failed");
    expect(out.result_note).not.toContain(root);
    expect(out.result_note).toContain(`companies/${LABS[0]}/jobs/${LABS[1]}/job.json`);
    expect(readApproval(root, id).result_note).not.toContain(root);
  });
});
