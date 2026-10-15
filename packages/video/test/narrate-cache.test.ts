import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tmpDir } from "./helpers.js";

/** narrate.py's paragraph cache, on the real script with macOS `say` (skipped where there is no say, python3 or ffmpeg). */
const NARRATE = path.resolve(import.meta.dirname, "../../../plugin/skills/voice/scripts/narrate.py");
const has = (cmd: string) => { try { execFileSync("/usr/bin/which", [cmd], { stdio: "ignore" }); return true; } catch { return false; } };
const CAN = process.platform === "darwin" && has("say") && has("python3") && has("ffmpeg");

function narrate(dir: string, out: string): { made: number; reused: number; total: number } {
  const r = execFileSync("python3", ["-I", NARRATE, "--engine", "macos_say", "--text-file", "s.txt", "--out", out, "--cache-dir", "cache"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const result = JSON.parse(r.trim().split("\n").at(-1)!) as { timing: string; total: number };
  const t = JSON.parse(fs.readFileSync(result.timing, "utf8")) as { paragraphs_made: number; paragraphs_reused: number };
  return { made: t.paragraphs_made, reused: t.paragraphs_reused, total: result.total };
}

describe.skipIf(!CAN)("narrate.py paragraph cache (real, macOS say)", () => {
  it("makes only changed paragraphs, gives the same audio from the cache, and prunes unused entries", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "s.txt"), "Here is the first part.\n\nThe second part.\n\n[pause 1]\n\nAnd the last part.\n");
    expect(narrate(dir, "a.wav")).toMatchObject({ made: 3, reused: 0 });
    expect(narrate(dir, "b.wav")).toMatchObject({ made: 0, reused: 3 });
    expect(fs.readFileSync(path.join(dir, "a.wav")).equals(fs.readFileSync(path.join(dir, "b.wav")))).toBe(true);
    fs.writeFileSync(path.join(dir, "s.txt"), "Here is the first part.\n\nThe second part, changed.\n\n[pause 1]\n\nAnd the last part.\n");
    expect(narrate(dir, "c.wav")).toMatchObject({ made: 1, reused: 2 });
    expect(fs.readdirSync(path.join(dir, "cache")).filter((n) => n.endsWith(".wav"))).toHaveLength(3);
  }, 120_000);
});
