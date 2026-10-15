import fs from "node:fs";
import path from "node:path";
import { type Clock, iso } from "./clock.js";
import { LATEST_DATA_VERSION, type Migration, MIGRATIONS } from "./migrations/index.js";
import { insideRoot, layout } from "./paths.js";
import { safeChmod } from "./perm.js";
import { readRecord, updateRecord } from "./store.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };

export function pendingMigrations(root: string, list: Migration[] = MIGRATIONS): Migration[] {
  const meta = readRecord("workspace", layout(root).workspaceFile);
  const latest = Math.max(LATEST_DATA_VERSION, ...list.map((m) => m.id));
  if (meta.data_version > latest) {
    throw new Error(`this workspace was saved by a newer ${identity.name} (data version ${meta.data_version}, this app knows ${latest}). Update ${identity.name} before opening it.`);
  }
  return [...list].sort((a, b) => a.id - b.id).filter((m) => m.id > meta.data_version);
}

export function migrate(root: string, list: Migration[] = MIGRATIONS, c?: Clock): { applied: number[]; backup: string | null } {
  const todo = pendingMigrations(root, list);
  if (!todo.length) return { applied: [], backup: null };
  const L = layout(root);
  const backup = path.join(L.backupDir, iso(c).replace(/[:.]/g, "-"));
  const applied: number[] = [];
  for (const m of todo) {
    for (const f of m.files(root)) {
      if (!fs.existsSync(f)) continue;
      const st = fs.lstatSync(f);
      if (st.isSymbolicLink() || !st.isFile() || !insideRoot(root, f)) {
        throw new Error(`migration ${m.id} (${m.name}) refused: ${path.relative(root, f)} is not a regular file inside the workspace`);
      }
      const dest = path.join(backup, path.relative(root, f));
      // Keep the first copy: it is the true pre-run original when several migrations touch one file.
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f, dest);
      safeChmod(dest, st.mode & 0o777);
    }
    try {
      m.run(root);
    } catch (e) {
      throw new Error(`migration ${m.id} (${m.name}) failed: ${(e as Error).message}. Files backed up in ${backup}`);
    }
    updateRecord("workspace", L.workspaceFile, (w) => { w.data_version = m.id; });
    applied.push(m.id);
  }
  return { applied, backup };
}
