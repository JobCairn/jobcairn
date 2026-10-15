import fs from "node:fs";
import path from "node:path";
import { LOCKABLE_DIRS, type LockableDir } from "@careeros/contract";
import { MAX_RECENT, type AppState, type AppStateStore, type InboxOrigin } from "@careeros/services";

const EMPTY: AppState = { lastWorkspace: null, recent: [] };
const QUEUE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HEX64 = /^[0-9a-f]{64}$/;
const FOLDER_ID = /^\d+:\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCKABLE: readonly string[] = LOCKABLE_DIRS;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Keeps only absolute-path keys whose values survive `clean`. */
function perRoot<T>(v: unknown, clean: (x: unknown) => T | undefined): Record<string, T> {
  if (!isObject(v)) return {};
  const out: Record<string, T> = {};
  for (const [root, x] of Object.entries(v)) {
    const c = path.isAbsolute(root) ? clean(x) : undefined;
    if (c !== undefined) out[root] = c;
  }
  return out;
}

/** App state lives in the user-data folder, never inside a workspace. */
export function fileStateStore(file: string): AppStateStore {
  return {
    read() {
      try {
        const v = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AppState>;
        const out: AppState = {
          lastWorkspace: typeof v.lastWorkspace === "string" && path.isAbsolute(v.lastWorkspace) ? v.lastWorkspace : null,
          recent: Array.isArray(v.recent) ? v.recent.filter((r): r is string => typeof r === "string" && path.isAbsolute(r)).slice(0, MAX_RECENT) : [],
        };
        const appApprovals = perRoot(v.appApprovals, (m) => (isObject(m)
          ? Object.fromEntries(Object.entries(m).filter((e): e is [string, string] => QUEUE_ID.test(e[0]) && typeof e[1] === "string" && HEX64.test(e[1])))
          : undefined));
        if (Object.keys(appApprovals).length) out.appApprovals = appApprovals;
        const lockIds = perRoot(v.lockIds, (m) => (isObject(m)
          ? Object.fromEntries(Object.entries(m).filter((e): e is [LockableDir, string] => LOCKABLE.includes(e[0]) && typeof e[1] === "string" && FOLDER_ID.test(e[1])))
          : undefined));
        if (Object.keys(lockIds).length) out.lockIds = lockIds;
        const lockIdHistory = perRoot(v.lockIdHistory, (m) => (isObject(m)
          ? Object.fromEntries(Object.entries(m)
            .filter((e): e is [LockableDir, unknown[]] => LOCKABLE.includes(e[0]) && Array.isArray(e[1]))
            .map(([d, ids]) => [d, ids.filter((x): x is string => typeof x === "string" && FOLDER_ID.test(x))]))
          : undefined));
        if (Object.keys(lockIdHistory).length) out.lockIdHistory = lockIdHistory;
        const recentInfo = perRoot(v.recentInfo, (m) => (isObject(m) && typeof m.id === "string" && (m.id === "" || UUID.test(m.id)) && typeof m.name === "string"
          ? { id: m.id, name: m.name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120) }
          : undefined));
        for (const r of Object.keys(recentInfo)) if (!out.recent.includes(r)) delete recentInfo[r];
        if (Object.keys(recentInfo).length) out.recentInfo = recentInfo;
        // Drop box origins: plain file names (no slash, not hidden) to an absolute path plus the copy's dev/ino.
        const inboxOrigins = perRoot(v.inboxOrigins, (m) => {
          if (!isObject(m)) return undefined;
          const kept = Object.entries(m).filter((e): e is [string, InboxOrigin] => {
            const o = e[1];
            return /^[^/\\\0.][^/\\\0]{0,254}$/.test(e[0]) && isObject(o) && typeof o.path === "string" && path.isAbsolute(o.path)
              && Number.isSafeInteger(o.dev) && Number.isSafeInteger(o.ino);
          }).map(([n, o]) => [n, { path: o.path, dev: o.dev, ino: o.ino }] as const);
          return kept.length ? Object.fromEntries(kept) : undefined;
        });
        if (Object.keys(inboxOrigins).length) out.inboxOrigins = inboxOrigins;
        // In-app updates: only an explicit false is kept (absent means "check automatically").
        if (v.autoUpdate === false) out.autoUpdate = false;
        return out;
      } catch { return { ...EMPTY, recent: [] }; }
    },
    write(s) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}
