// Vite/Vitest aliases for @careeros/brand, mirroring package.json "exports", so every tool
// resolves the brand package from this checkout (worktrees can share another checkout's node_modules).
import fs from "node:fs";
import path from "node:path";

export function brandAlias(dir = import.meta.dirname) {
  const exp = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).exports;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Object.entries(exp)
    .sort(([a], [b]) => b.length - a.length)
    .map(([sub, target]) => {
      if (sub.endsWith("/*")) {
        const base = sub.slice(2, -2);
        return { find: new RegExp(`^@careeros/brand/${esc(base)}/(.*)$`), replacement: path.join(dir, target.slice(2, -2)) + "/$1" };
      }
      const name = sub === "." ? "@careeros/brand" : `@careeros/brand/${sub.slice(2)}`;
      return { find: new RegExp(`^${esc(name)}$`), replacement: path.join(dir, target) };
    });
}
