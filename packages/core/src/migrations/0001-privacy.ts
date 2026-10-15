import path from "node:path";
import { layout } from "../paths.js";
import { writeClaudeSettings } from "../privacy.js";
import { updateRecord } from "../store.js";
import type { Migration } from "./index.js";

// Adds workspace.privacy (lock list + grants, filled from schema defaults) and
// regenerates .claude/settings.json from it.
export const privacyMigration: Migration = {
  id: 1,
  name: "privacy lock list and Claude settings",
  files: (root) => [layout(root).workspaceFile, path.join(root, ".claude", "settings.json")],
  run: (root) => {
    updateRecord("workspace", layout(root).workspaceFile, () => undefined);
    writeClaudeSettings(root);
  },
};
