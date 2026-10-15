import fs from "node:fs";
import path from "node:path";
import { fetchRemoteImage, GmailProvider, nodeImageFetcher, redact, type Fetcher, type MailAccount, type MailProvider, type RequestFn, type Resolver } from "@careeros/mail";
import { isWorkspaceId, type MailHost } from "@careeros/services";

const MAX_LOG_BYTES = 256 * 1024;

/** The mail log in user data: redacted, one line per entry, owner-only, trimmed to its newest half past 256 KB. */
/**
 * Remote images for "Load images": node:https with no agent, proxy or cookie jar, and a lookup that refuses any
 * private, loopback or link-local address on every connection (so a public name that resolves inward, or rebinds,
 * is never fetched). Chromium's network stack is not used: it would skip that check and add its own headers.
 */
export function remoteImageFetcher(deps: { resolve?: Resolver; request?: RequestFn } = {}): Fetcher {
  return nodeImageFetcher(deps);
}

export function fileLog(file: string): { log(line: string): void; read(): string[] } {
  const lines = () => { try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  return {
    log(line) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${redact(line).replace(/[\r\n]+/g, " ")}\n`, { mode: 0o600 });
      if (fs.statSync(file).size > MAX_LOG_BYTES) {
        const all = lines();
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${all.slice(Math.floor(all.length / 2)).join("\n")}\n`, { mode: 0o600 });
        fs.renameSync(tmp, file);
      }
    },
    read: () => lines().slice(-50),
  };
}

/** Only a workspace id (a UUID) ever becomes part of a file name in user data. */
function idPart(id: string): string {
  if (!isWorkspaceId(id)) throw new Error("That workspace id can't name a mail file.");
  return id;
}

/**
 * The Electron mail host. Everything kept outside the workspace is per workspace (keyed by its workspace_id):
 * the sync lock `mail-sync-<id>.lock` and the log `logs/mail-sync-<id>.log` in user data. Lines with no workspace
 * (a background run for a folder that isn't one) go to the app-wide `logs/mail-sync.log`.
 */
export function electronMailHost(o: {
  userData: string; fetcher: Fetcher; allowedHosts: string[];
  background: (workspace: string) => { program: string; args: string[] };
  provider?: (a: MailAccount) => MailProvider;
}): MailHost {
  const logs = new Map<string, ReturnType<typeof fileLog>>();
  const logFor = (id?: string) => {
    const key = id === undefined || id === "" ? "" : idPart(id);
    let l = logs.get(key);
    if (!l) { l = fileLog(path.join(o.userData, "logs", key ? `mail-sync-${key}.log` : "mail-sync.log")); logs.set(key, l); }
    return l;
  };
  return {
    provider: o.provider ?? ((account) => new GmailProvider(account, { allowedHosts: o.allowedHosts })),
    fetchImage: (url) => fetchRemoteImage(url, o.fetcher),
    lockFile: (id) => path.join(o.userData, `mail-sync-${idPart(id)}.lock`),
    log: (line, id) => logFor(id).log(line),
    readLog: (id) => logFor(id).read(),
    backgroundCommand: o.background,
  };
}
