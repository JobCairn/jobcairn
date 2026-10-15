import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeMailProvider, type BackgroundScheduler, type MailAccount } from "@careeros/mail";
import type { AppState, AppStateStore, DocumentPrinter, Host, MailHost, SecretStore, ShellHost } from "./host.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };

/** An in-memory secret store for tests (never the real Keychain). Keys as in the real store. */
export function memorySecrets(available = true): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  const need = () => { if (!available) throw new Error("Secure storage isn't available on this computer, so the secret was not saved."); };
  return {
    values,
    available: () => available,
    has: (n) => values.has(n),
    get: (n) => values.get(n) ?? null,
    set: (n, v) => { need(); values.set(n, v); },
    remove: (n) => { values.delete(n); },
    move: (from, to) => { if (values.has(from)) { values.set(to, values.get(from)!); values.delete(from); } },
  };
}

export function memoryState(initial: Partial<AppState> = {}): AppStateStore & { value: AppState } {
  const store = {
    value: { lastWorkspace: null, recent: [], ...initial } as AppState,
    read: () => structuredClone(store.value),
    write: (s: AppState) => { store.value = structuredClone(s); },
  };
  return store;
}

export interface FakeShell extends ShellHost {
  picks: (string | null)[]; files: (string | null)[]; opened: string[]; openedPaths: string[]; notes: string[]; shown: string[]; copied: string[]; claude: boolean;
  /** Files "saved" through the save dialog; `saveAnswer` false acts like Cancel. */
  saved: { name: string; bytes: Uint8Array; kind: string }[]; saveAnswer: boolean;
  /**
   * Paths "moved to the Trash". With `trashDir` (a temporary folder in tests) they are moved there; without it they are
   * deleted, like the real Trash takes them away. `trashFails` makes the Trash refuse.
   */
  trashed: string[]; trashDir: string | null; trashFails: boolean;
}

export function fakeShell(opts: { picks?: (string | null)[]; files?: (string | null)[]; claude?: boolean; trashDir?: string } = {}): FakeShell {
  const s: FakeShell = {
    picks: [...(opts.picks ?? [])], files: [...(opts.files ?? [])], opened: [], openedPaths: [], notes: [], shown: [], copied: [], claude: opts.claude ?? false, saved: [], saveAnswer: true,
    trashed: [], trashDir: opts.trashDir ?? null, trashFails: false,
    pickFolder: async () => s.picks.shift() ?? null,
    pickFile: async () => s.files.shift() ?? null,
    openExternal: async (url, note) => { s.opened.push(url); if (note) s.notes.push(note); return true; },
    showItemInFolder: (p) => { s.shown.push(p); },
    openPath: async (p) => { s.openedPaths.push(p); },
    trashItem: async (p) => {
      if (s.trashFails) throw new Error("The Trash isn't available.");
      if (s.trashDir) fs.renameSync(p, path.join(s.trashDir, `${s.trashed.length}-${path.basename(p)}`));
      else fs.rmSync(p, { force: true, recursive: true });
      s.trashed.push(p);
    },
    openClaudeDesktop: async () => s.claude,
    copyText: (text) => { s.copied.push(text); },
    saveFile: async (name, bytes, kind) => { if (!s.saveAnswer) return false; s.saved.push({ name, bytes, kind }); return true; },
  };
  return s;
}

export interface FakePrinter extends DocumentPrinter { html: string[] }

/** Records the HTML it was asked to print and returns a tiny file that starts like a PDF. */
export function fakePrinter(): FakePrinter {
  const p: FakePrinter = {
    html: [],
    toPdf: async (html) => { p.html.push(html); return new TextEncoder().encode(`%PDF-1.7\n% ${identity.name} test printer, ${html.length} bytes of HTML\n%%EOF\n`); },
  };
  return p;
}

export type FakeHost = Host & { shell: FakeShell; secrets: ReturnType<typeof memorySecrets>; state: ReturnType<typeof memoryState>; printer: FakePrinter };

export function fakeHost(over: Partial<FakeHost> = {}): FakeHost {
  return {
    secrets: memorySecrets(), state: memoryState(), shell: fakeShell(), printer: fakePrinter(),
    info: { version: "0.1.0", shell: "electron", platform: "test" }, ...over,
  };
}

export const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

export interface FakeMailHost extends MailHost {
  fake: FakeMailProvider; accounts: MailAccount[]; images: string[];
  /** Every log line, in order; `logsBy` keeps them per workspace id ("" for the app-wide log). */
  logs: string[]; logsBy: Map<string, string[]>;
}

/** A mail host whose provider is one FakeMailProvider; a password other than goodPassword fails sign-in. */
export function fakeMailHost(opts: { provider?: FakeMailProvider; goodPassword?: string } = {}): FakeMailHost {
  const fake = opts.provider ?? new FakeMailProvider();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "careeros-userdata-"));
  const h: FakeMailHost = {
    fake, accounts: [], logs: [], logsBy: new Map(), images: [],
    lockFile: (id) => path.join(dir, `mail-sync-${id}.lock`),
    provider: (account) => {
      h.accounts.push(account);
      if (opts.goodPassword && account.password !== opts.goodPassword) { const bad = new FakeMailProvider(); bad.failWith = "auth"; return bad; }
      return fake;
    },
    fetchImage: async (url) => { h.images.push(url); return { type: "image/png", body: PNG_1X1 }; },
    log: (line, id = "") => { h.logs.push(line); h.logsBy.set(id, [...(h.logsBy.get(id) ?? []), line]); },
    readLog: (id = "") => [...(h.logsBy.get(id) ?? [])],
    backgroundCommand: (workspace) => ({ program: "/fictional/app", args: ["--background-sync", "--workspace", workspace] }),
  };
  return h;
}

export interface FakeJob { program: string; args: string[]; minutes: number }
/** Per-workspace fake schedules. `installed` is the only one (null with none; throws with several). */
export interface FakeScheduler {
  (workspaceId: string): BackgroundScheduler;
  jobs: Map<string, FakeJob>;
  readonly installed: FakeJob | null;
  /** When set, remove() throws this message (an OS that refuses). */
  failRemove: string | null;
}
export function fakeScheduler(supported = true): FakeScheduler {
  const jobs = new Map<string, FakeJob>();
  const f = ((id: string): BackgroundScheduler => ({
    supported,
    status: async () => (jobs.has(id) ? { installed: true, detail: "Scheduled (fake)." } : { installed: false, detail: "Not scheduled." }),
    install: async (o) => { if (!supported) throw new Error("Background sync isn't available on this system."); jobs.set(id, o); },
    remove: async () => { if (f.failRemove) throw new Error(f.failRemove); jobs.delete(id); },
  })) as FakeScheduler;
  Object.defineProperty(f, "jobs", { value: jobs });
  Object.defineProperty(f, "installed", {
    get: () => { if (jobs.size > 1) throw new Error("More than one workspace has a schedule; read jobs instead."); return [...jobs.values()][0] ?? null; },
  });
  f.failRemove = null;
  return f;
}
