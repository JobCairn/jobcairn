import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM module without types
import { applyAllowlist, checkPath, checkText, mask, parseAllowlist } from "../scripts/privacy/rules.mjs";

const scanScript = fileURLToPath(new URL("../scripts/privacy/scan.mjs", import.meta.url));

const gmail = "someone" + "@" + "gmail.com";
const realPhone = "04" + "12 345 678";
// Hoisted so the scanner's own self-scan of this file doesn't see "passport"/"tfn"
// textually adjacent to digits (the id-number bridge tolerates quotes/operators,
// unlike the email/phone patterns above).
const passportDigits = "N1234567";
const tfnDigits = "123456789";

describe("privacy rules", () => {
  it("blocks .env files but allows .env.example", () => {
    expect(checkPath(".env")[0]?.rule).toBe("env-file");
    expect(checkPath("samples/alex-example/settings/.env")[0]?.rule).toBe("env-file");
    expect(checkPath(".env.local")[0]?.rule).toBe("env-file");
    expect(checkPath(".env.example")).toEqual([]);
  });
  it("blocks documents and images outside samples/public", () => {
    expect(checkPath("docs/resume.pdf")[0]?.rule).toBe("binary-outside-samples");
    expect(checkPath("packages/core/x.docx")[0]?.rule).toBe("binary-outside-samples");
    expect(checkPath("samples/alex-example/me/resumes/a.pdf")).toEqual([]);
    expect(checkPath("public/logo.png")).toEqual([]);
  });
  it("flags real-looking emails, allows reserved ones", () => {
    expect(checkText("a.md", `contact ${gmail}`)[0]?.rule).toBe("email");
    expect(checkText("a.md", "alex" + "@" + "example.com and noreply" + "@" + "anthropic.com")).toEqual([]);
    expect(checkText("a.md", "x" + "@" + "users.noreply.github.com")).toEqual([]);
  });
  it("flags real mobile numbers, allows the fictional 0491 57x range", () => {
    expect(checkText("a.md", `call ${realPhone}`)[0]?.rule).toBe("phone");
    expect(checkText("a.md", "call +61 4" + "12 345 678")[0]?.rule).toBe("phone");
    expect(checkText("a.md", "call 0491 570 006")).toEqual([]);
  });
  it("flags ID words followed by long numbers", () => {
    expect(checkText("a.md", "passport no " + passportDigits)[0]?.rule).toBe("id-number");
    expect(checkText("a.md", "TFN: " + tfnDigits)[0]?.rule).toBe("id-number");
    expect(checkText("a.md", "passport photo required")).toEqual([]);
  });
  it("applies the denylist everywhere, case-insensitively, and masks output", () => {
    const f = checkText("samples/x.md", "Hello Jordan Realname", ["jordan realname"]);
    expect(f[0]).toMatchObject({ rule: "denylist", line: 1 });
    expect(f[0]?.sample).not.toContain("realname");
    expect(mask("abcdefgh")).toBe("ab****gh");
  });
});

describe("privacy allowlist", () => {
  it("drops a finding whose file and rule match an allowlist entry exactly", () => {
    const findings = [{ file: "docs/plan.md", line: 10, rule: "id-number" }];
    const allowlist = parseAllowlist("docs/plan.md id-number  # fictional test digits\n");
    expect(applyAllowlist(findings, allowlist)).toEqual([]);
  });
  it("still reports the same rule in a different file", () => {
    const findings = [
      { file: "docs/plan.md", line: 10, rule: "id-number" },
      { file: "docs/other.md", line: 3, rule: "id-number" },
    ];
    const allowlist = parseAllowlist("docs/plan.md id-number  # fictional test digits\n");
    const kept = applyAllowlist(findings, allowlist);
    expect(kept).toEqual([{ file: "docs/other.md", line: 3, rule: "id-number" }]);
  });
  it("ignores a denylist entry in the allowlist", () => {
    const findings = [{ file: "docs/plan.md", line: 1, rule: "denylist", sample: "xx" }];
    const allowlist = parseAllowlist("docs/plan.md denylist  # should never be allowlisted\n");
    expect(allowlist).toEqual([]);
    expect(applyAllowlist(findings, allowlist)).toEqual(findings);
  });
});

describe("privacy scan CLI handles unusual filenames", () => {
  it("scans quoted/non-ASCII staged paths without crashing, reporting both under the email rule", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-scan-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: tmp });
      const gmail = "someone" + "@" + "gmail.com";
      fs.writeFileSync(path.join(tmp, 'weird"name.txt'), `contact ${gmail}\n`);
      fs.writeFileSync(path.join(tmp, "café.txt"), `contact ${gmail}\n`);
      execFileSync("git", ["add", "-A"], { cwd: tmp });

      let stdout = "";
      let stderr = "";
      let status = 0;
      try {
        execFileSync("node", [scanScript, "--staged"], {
          cwd: tmp,
          encoding: "utf8",
          env: { ...process.env, CAREEROS_DENYLIST: path.join(tmp, "no-such-denylist.txt") },
        });
      } catch (err: any) {
        stdout = err.stdout ?? "";
        stderr = err.stderr ?? "";
        status = err.status ?? 1;
      }

      expect(status).toBe(1);
      expect(stderr).not.toContain("fatal:");
      expect(stderr).not.toMatch(/at .*\.(mjs|js):\d+/);
      expect(stderr).toContain("weird");
      expect(stderr).toContain("café.txt");
      const emailLines = stderr.split("\n").filter((l) => l.includes("email"));
      expect(emailLines.length).toBe(2);
      void stdout;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
