import fs from "node:fs";
import path from "node:path";
import { parseVersion } from "@careeros/contract";

/**
 * The CareerOS plugin ships with the app and is loaded for each run with `--plugin-dir` (spec 2026-10-10,
 * fix round 1, decision a). Nothing is installed into Claude Code and the person's ~/.claude is never changed,
 * so there is no install, update or marketplace step: only a check that the bundled folder is there.
 */
export interface BundledPlugin { found: boolean; version: string }

/** Reads `<dir>/.claude-plugin/plugin.json`. Not found when the folder or manifest is missing, or the name is wrong. */
export function bundledPlugin(dir: string): BundledPlugin {
  try {
    if (!fs.lstatSync(dir).isDirectory()) return { found: false, version: "" };
    const j = JSON.parse(fs.readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8")) as { name?: unknown; version?: unknown };
    if (j.name !== "careeros") return { found: false, version: "" };
    return { found: true, version: typeof j.version === "string" && parseVersion(j.version) ? j.version : "" };
  } catch { return { found: false, version: "" }; }
}
