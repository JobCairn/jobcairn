import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { allowAccessRequest, claudeSettings } from "../src/privacy.js";
import { claudeMd } from "../src/workspace.js";
import { requestAccess } from "../src/queue.js";
import { makeLegacy } from "./fixtures/make-legacy.js";
import { tmpDir } from "./helpers.js";

const json = (r: { out: string }) => JSON.parse(r.out);

describe("cli", () => {
  it("runs the full happy path", () => {
    const ws = path.join(tmpDir(), "ws");
    expect(run(["init", ws, "--name", "Alex Example"]).code).toBe(0);
    const created = json(run(["job", "new", "--ws", ws, "--company", "Acme Corp", "--title", "AI Engineer", "--url", "https://jobs.example.com/9", "--source", "ats"]));
    expect(created.created).toBe(true);
    expect(run(["job", "status", "--ws", ws, created.company_slug, created.id, "Applied"]).code).toBe(0);
    expect(run(["search", "add", "--ws", ws, "--site", "Greenhouse", "--query", "ai engineer", "--location", "Sampletown"]).code).toBe(0);
    expect(run(["search", "check", "--ws", ws, "--site", "Greenhouse", "--query", "ai engineer", "--location", "Sampletown"]).code).toBe(1);
    expect(json(run(["index", "--ws", ws])).jobs).toBe(1);
    expect(run(["validate", "--ws", ws]).code).toBe(0);
  });
  it("uses CAREEROS_WORKSPACE when --ws is absent", () => {
    const ws = path.join(tmpDir(), "ws");
    run(["init", ws]);
    expect(run(["validate"], { CAREEROS_WORKSPACE: ws }).code).toBe(0);
  });
  it("files inbox items into me/ and jobs", () => {
    const ws = path.join(tmpDir(), "ws");
    run(["init", ws]);
    fs.writeFileSync(path.join(ws, "inbox", "grant.pdf"), "x");
    expect(json(run(["inbox", "list", "--ws", ws]))).toEqual(["grant.pdf"]);
    expect(json(run(["inbox", "file", "--ws", ws, "grant.pdf", "--me", "identity/visa", "--note", "visa grant"])).to).toBe(path.join("me", "identity", "visa", "grant.pdf"));
  });
  it("returns exit 1 from validate when files are broken", () => {
    const ws = path.join(tmpDir(), "ws");
    run(["init", ws]);
    fs.writeFileSync(path.join(ws, "settings", "profile.json"), "{");
    const r = run(["validate", "--ws", ws]);
    expect(r.code).toBe(1);
    expect(json(r)[0].file).toBe(path.join("settings", "profile.json"));
  });
  it("prints a helpful error with exit 2 on bad input", () => {
    const r = run(["job", "status", "--ws", tmpDir(), "a", "b", "Ghosted"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/no job|unknown status/);
    expect(run(["nope"]).code).toBe(2);
  });
  it("runs a legacy dry run", () => {
    const src = tmpDir("legacy-"); makeLegacy(src);
    const r = json(run(["import-legacy", src, "--to", path.join(tmpDir(), "ws"), "--dry-run"]));
    expect(r.actions.length).toBeGreaterThan(0);
  });

  // --- Controller requirements beyond the brief ---

  it("never prints secrets: settings/.env contents never appear in any output", () => {
    const ws = path.join(tmpDir(), "ws");
    run(["init", ws]);
    const secret = "GMAIL_APP_PASSWORD=" + "abcd1234wxyz5678";
    fs.writeFileSync(path.join(ws, "settings", ".env"), secret);
    const outputs = [
      run(["validate", "--ws", ws]),
      run(["index", "--ws", ws]),
      json(run(["job", "new", "--ws", ws, "--company", "Acme Corp", "--title", "AI Engineer"])),
      run(["inbox", "list", "--ws", ws]),
    ];
    for (const r of outputs) {
      const text = JSON.stringify(r);
      expect(text).not.toContain("GMAIL_APP_PASSWORD");
      expect(text).not.toContain("abcd1234wxyz5678");
    }
  });

  it("fails with exit code 2 and a clear message when given a folder that isn't a workspace", () => {
    const notWs = tmpDir("plain-");
    const r = run(["validate", "--ws", notWs]);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err.length).toBeGreaterThan(0);
    expect(r.err).not.toMatch(/at .*\(.*:\d+:\d+\)/); // no stack trace
  });

  it("turns every library error into {code: 2, err} with no stack trace", () => {
    const ws = path.join(tmpDir(), "ws");
    run(["init", ws]);
    const r = run(["job", "attach", "--ws", ws, "missing-co", "missing-id", path.join(ws, "nope.txt"), "--label", "X"]);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(typeof r.err).toBe("string");
    expect(r.err).not.toMatch(/\bat\s+\S+:\d+:\d+/);
    expect(r.err).not.toContain("node_modules");
  });

  it("gives exit code 2 and a one-line usage hint for an unknown flag", () => {
    const ws = path.join(tmpDir(), "ws");
    run(["init", ws]);
    const r = run(["validate", "--ws", ws, "--not-a-real-flag", "x"]);
    expect(r.code).toBe(2);
    expect(r.err.trim().split("\n").length).toBe(1);
    expect(r.err).toMatch(/usage|careeros/i);
  });

  it("gives exit code 2 and a one-line usage hint for a missing required flag", () => {
    const ws = path.join(tmpDir(), "ws");
    run(["init", ws]);
    const r = run(["job", "new", "--ws", ws, "--title", "AI Engineer"]);
    expect(r.code).toBe(2);
    expect(r.err.trim().split("\n").length).toBe(1);
    expect(r.err).toMatch(/usage|careeros|--company/i);
  });

  it("refuses --jd-file inside a locked folder, directly or through a symlink", () => {
    const ws = path.join(tmpDir(), "ws");
    run(["init", ws]);
    const secret = path.join(ws, "me", "identity", "visa.txt");
    fs.writeFileSync(secret, "Visa grant for Alex Example (fictional)");
    const link = path.join(tmpDir(), "jd.md");
    fs.symlinkSync(secret, link);
    for (const f of [secret, link]) {
      const r = run(["job", "new", "--ws", ws, "--company", "Acme Corp", "--title", "AI Engineer", "--jd-file", f]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/me\/identity.*locked/);
      expect(r.out).toBe("");
    }
    expect(fs.existsSync(path.join(ws, "companies", "acme-corp"))).toBe(false);
    const env = run(["job", "new", "--ws", ws, "--company", "Acme Corp", "--title", "AI Engineer", "--jd-file", path.join(ws, "settings", ".env")]);
    expect(env.code).toBe(2);
    expect(env.err).toMatch(/settings\/\.env/);
  });
  it("refuses --jd-file given as a path with .. segments that resolves into a locked folder", () => {
    const ws = path.join(tmpDir(), "ws");
    run(["init", ws]);
    const secret = path.join(ws, "me", "identity", "visa.txt");
    fs.writeFileSync(secret, "Visa grant for Alex Example (fictional)");
    const dotdot = path.join(ws, "companies", "..", "me", "identity", "visa.txt");
    const r = run(["job", "new", "--ws", ws, "--company", "Acme Corp", "--title", "AI Engineer", "--jd-file", dotdot]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/me\/identity.*locked/);
    expect(r.out).toBe("");
    expect(fs.existsSync(path.join(ws, "companies", "acme-corp"))).toBe(false);
  });
  // Detects whether this filesystem is case-insensitive by probing a real file;
  // only macOS/Windows-style filesystems make the cased-path bypass meaningful.
  const caseInsensitiveFs = (() => {
    const probe = path.join(tmpDir(), "probe.txt");
    fs.writeFileSync(probe, "x");
    return fs.existsSync(probe.toUpperCase());
  })();
  it.skipIf(!caseInsensitiveFs)("refuses a differently-cased path into a locked folder on a case-insensitive filesystem", () => {
    const ws = path.join(tmpDir(), "ws");
    run(["init", ws]);
    const secret = path.join(ws, "me", "identity", "visa.txt");
    fs.writeFileSync(secret, "Visa grant for Alex Example (fictional)");
    const cased = path.join(ws, "ME", "Identity", "visa.txt");
    const r = run(["job", "new", "--ws", ws, "--company", "Acme Corp", "--title", "AI Engineer", "--jd-file", cased]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/me\/identity.*locked/);
    expect(r.out).toBe("");
    expect(fs.existsSync(path.join(ws, "companies", "acme-corp"))).toBe(false);
  });
  it("allows --jd-file from a locked folder while an allow-once grant is active", () => {
    const ws = path.join(tmpDir(), "ws");
    run(["init", ws]);
    const f = path.join(ws, "me", "employment", "role.md");
    fs.writeFileSync(f, "# Role notes (fictional)\n");
    allowAccessRequest(ws, requestAccess(ws, { folder: "me/employment", why: "Need a start date" }).id, 15);
    expect(run(["job", "new", "--ws", ws, "--company", "Acme Corp", "--title", "AI Engineer", "--jd-file", f]).code).toBe(0);
  });
  it("still accepts an ordinary --jd-file inside the workspace", () => {
    const ws = path.join(tmpDir(), "ws");
    run(["init", ws]);
    const f = path.join(ws, "inbox", "jd.md");
    fs.writeFileSync(f, "# AI Engineer\n");
    expect(json(run(["job", "new", "--ws", ws, "--company", "Acme Corp", "--title", "AI Engineer", "--jd-file", f])).created).toBe(true);
  });

  it("refuses a --jd-file or attach source outside the workspace, in a locked folder, behind a link or with a second name", () => {
    const ws = path.join(tmpDir(), "ws");
    run(["init", ws]);
    const job = json(run(["job", "new", "--ws", ws, "--company", "Acme Corp", "--title", "AI Engineer"]));
    const outside = path.join(tmpDir(), "jd.md");
    fs.writeFileSync(outside, "# AI Engineer\n");
    const secret = path.join(ws, "me", "identity", "visa.txt");
    fs.writeFileSync(secret, "Visa grant for Alex Example (fictional)");
    const dotted = path.join(ws, "me", ".", "identity", "visa.txt");
    const link = path.join(ws, "inbox", "looks-fine.md");
    fs.symlinkSync(secret, link);
    const hard = path.join(ws, "inbox", "hard.txt");
    fs.linkSync(secret, hard);
    const linkOut = path.join(ws, "inbox", "out.md");
    fs.symlinkSync(outside, linkOut);
    for (const f of [outside, dotted, link, hard, linkOut]) {
      const a = run(["job", "new", "--ws", ws, "--company", "Example Labs", "--title", "Engineer", "--jd-file", f]);
      expect(a.code, f).toBe(2);
      const b = run(["job", "attach", "--ws", ws, job.company_slug, job.id, f, "--label", "X"]);
      expect(b.code, f).toBe(2);
      expect(b.out).toBe("");
    }
    expect(fs.existsSync(path.join(ws, "companies", "example-labs"))).toBe(false);
    const ok = path.join(ws, "inbox", "notes.md");
    fs.writeFileSync(ok, "notes");
    expect(run(["job", "attach", "--ws", ws, job.company_slug, job.id, ok, "--label", "Notes"]).code).toBe(0);
  });

  it("lets Claude propose a status change and request access, without carrying anything out", () => {
    const ws = path.join(tmpDir(), "ws");
    run(["init", ws]);
    const job = json(run(["job", "new", "--ws", ws, "--company", "Example Labs", "--title", "Backend Engineer"]));
    const p = run(["approval", "propose", "--ws", ws, "--action", "status_change", "--job", `${job.company_slug}/${job.id}`, "--status", "Interview", "--note", "Invite for Thursday"]);
    expect(p.code).toBe(0);
    expect(json(p)).toMatchObject({ status: "pending", action: "status_change", payload: { status: "Interview" } });
    expect(json(run(["approval", "list", "--ws", ws, "--status", "pending"]))).toHaveLength(1);
    expect(json(run(["job", "status", "--ws", ws, job.company_slug, job.id, "Found"])).status).toBe("Found");
    const r = run(["request", "access", "--ws", ws, "--folder", "me/identity", "--why", "Need the visa expiry date"]);
    expect(json(r)).toMatchObject({ folder: "me/identity", status: "pending" });
    expect(json(run(["request", "list", "--ws", ws]))).toHaveLength(1);
    expect(run(["approval", "propose", "--ws", ws, "--action", "apply_handoff", "--job", `${job.company_slug}/${job.id}`]).code).toBe(2);
  });

  it("never exposes a way to decide an approval or access request from the CLI", () => {
    const ws = path.join(tmpDir(), "ws");
    run(["init", ws]);
    const job = json(run(["job", "new", "--ws", ws, "--company", "Example Labs", "--title", "Backend Engineer"]));
    const approval = json(run(["approval", "propose", "--ws", ws, "--action", "status_change", "--job", `${job.company_slug}/${job.id}`, "--status", "Interview"]));
    const request = json(run(["request", "access", "--ws", ws, "--folder", "me/identity", "--why", "Need it"]));
    for (const argv of [
      ["approval", "decide", "--ws", ws, approval.id, "--status", "approved"],
      ["approval", "approve", "--ws", ws, approval.id],
      ["request", "allow", "--ws", ws, request.id],
      ["request", "decide", "--ws", ws, request.id, "--status", "allowed"],
    ]) {
      const r = run(argv);
      expect(r.code).not.toBe(0);
      expect(r.out).toBe("");
    }
    expect(json(run(["approval", "list", "--ws", ws]))[0]).toMatchObject({ status: "pending" });
    expect(json(run(["request", "list", "--ws", ws]))[0]).toMatchObject({ status: "pending" });
  });

  describe("request access by short folder name (final review follow-up)", () => {
    /** Claude Code's Bash deny rules, simulated: "*" matches anything, the rest literally, over the whole command. */
    const denied = (cmd: string, rules = claudeSettings().permissions.deny) =>
      rules.filter((r) => r.startsWith("Bash(")).some((r) => new RegExp(`^${r.slice(5, -1).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s").test(cmd));

    it("the command CLAUDE.md tells Claude to run isn't denied while both folders are locked", () => {
      const documented = [...claudeMd().matchAll(/`(careeros request access[^`]*)`/g)].map((m) => m[1]!);
      expect(documented).toHaveLength(1);
      const cmd = documented[0]!.replace('"..."', '"Need the visa expiry date"');
      expect(denied(cmd), cmd).toBe(false);
      expect(denied(cmd.replace("--folder identity", "--folder employment"))).toBe(false);
      // Why the alias exists: the full path is caught by the catch-all rule.
      expect(denied(cmd.replace("--folder identity", "--folder me/identity"))).toBe(true);
      // The same rule catches the path inside --why, so the template tells Claude not to write it there.
      expect(denied(cmd.replace('"Need the visa expiry date"', '"Need the visa expiry from me/identity"'))).toBe(true);
      expect(claudeMd()).toContain("When asking for access, don't write the folder's path in --why; describe what you need instead.");
    });

    it("maps identity and employment to the locked folders, still takes the full path, and refuses anything else", () => {
      const ws = path.join(tmpDir(), "ws");
      run(["init", ws]);
      expect(json(run(["request", "access", "--ws", ws, "--folder", "identity", "--why", "Need the visa expiry date"]))).toMatchObject({ folder: "me/identity", status: "pending" });
      expect(json(run(["request", "access", "--ws", ws, "--folder", "employment", "--why", "Need a start date"]))).toMatchObject({ folder: "me/employment" });
      expect(json(run(["request", "access", "--ws", ws, "--folder", "me/identity", "--why", "Need it"]))).toMatchObject({ folder: "me/identity" });
      for (const bad of ["resumes", "me/resumes", "Identity", "me", "identity/", "../identity", "toString", "__proto__"]) {
        const r = run(["request", "access", "--ws", ws, "--folder", bad, "--why", "x"]);
        expect(r.code, bad).not.toBe(0);
        expect(r.err, bad).toMatch(/--folder must be identity or employment/);
      }
      expect(json(run(["request", "list", "--ws", ws]))).toHaveLength(3);
    });
  });
});
