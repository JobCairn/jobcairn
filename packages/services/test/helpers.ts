import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ServiceContext } from "../src/context.js";
import { fakeHost, fakeShell, memorySecrets, type FakeHost, type FakeMailHost, type FakeScheduler } from "../src/fakes.js";
import { openWorkspace } from "../src/workspace.js";

export const FIXED = new Date("2026-01-15T09:00:00.000Z");
export const SAMPLE = path.resolve(import.meta.dirname, "../../../samples/alex-example");

export function tmpDir(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "careeros-svc-")));
}

export function sampleCopy(): string {
  const dest = path.join(tmpDir(), "CareerOS");
  fs.cpSync(SAMPLE, dest, { recursive: true });
  return dest;
}

export interface CtxOpts {
  now?: Date; picks?: (string | null)[]; files?: (string | null)[]; secretsAvailable?: boolean; claude?: boolean;
  mail?: FakeMailHost; scheduler?: FakeScheduler;
}

export function makeCtx(opts: CtxOpts = {}): { ctx: ServiceContext; host: FakeHost; setNow(d: Date): void } {
  let now = opts.now ?? FIXED;
  const host = fakeHost({
    now: () => now,
    shell: fakeShell({ picks: opts.picks, files: opts.files, claude: opts.claude }),
    secrets: memorySecrets(opts.secretsAvailable ?? true),
    ...(opts.mail ? { mail: opts.mail } : {}),
    ...(opts.scheduler ? { scheduler: opts.scheduler } : {}),
  });
  return { ctx: new ServiceContext(host), host, setNow: (d) => { now = d; } };
}

export function openSample(opts: CtxOpts = {}) {
  const x = makeCtx(opts);
  openWorkspace(x.ctx, sampleCopy());
  return { ...x, root: x.ctx.requireRoot() };
}

export const minutes = (n: number) => new Date(FIXED.getTime() + n * 60_000);
