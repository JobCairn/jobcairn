import fs from "node:fs";
import path from "node:path";
import { layout } from "../paths.js";
import { writeClaudeSettings } from "../privacy.js";
import { RecordError, updateRecord } from "../store.js";
import type { Migration } from "./index.js";

function companyFiles(root: string): string[] {
  const L = layout(root);
  if (!fs.existsSync(L.companiesDir)) return [];
  return fs.readdirSync(L.companiesDir).sort().map((s) => L.companyFile(s)).filter((f) => fs.existsSync(f));
}

// Fills the 3b mail defaults (company email_match and recruiter, integrations.mail) and
// regenerates .claude/settings.json, which gains the SessionStart grant-expiry hook in Task 3.
export const mailMigration: Migration = {
  id: 2,
  name: "mail fields and Claude session hook",
  files: (root) => [layout(root).integrations, path.join(root, ".claude", "settings.json"), ...companyFiles(root)],
  run: (root) => {
    updateRecord("integrations", layout(root).integrations, () => undefined);
    for (const f of companyFiles(root)) {
      // A hand-broken company file is reported by `careeros validate`; it must not block opening the workspace.
      try { updateRecord("company", f, () => undefined); } catch (e) { if (!(e instanceof RecordError)) throw e; }
    }
    writeClaudeSettings(root);
  },
};
