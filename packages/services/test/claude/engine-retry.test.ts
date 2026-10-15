import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeRunView } from "@careeros/contract";
import { dispatch } from "../../src/dispatch.js";
import { retryLine } from "../../src/claude/engine.js";
import { fakeClaude, type FakeOpts } from "./fake-claude.js";
import { openSample } from "../helpers.js";

/** Long waits (the retry back-off) are caught and run by hand; short ones run as usual. */
function catchLongTimers() {
  const real = globalThis.setTimeout;
  const caught: { ms: number; fn: () => void }[] = [];
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
    if ((ms ?? 0) >= 30_000) { caught.push({ ms: ms!, fn }); return { unref() {} } as unknown as ReturnType<typeof setTimeout>; }
    return real(fn, ms);
  }) as typeof setTimeout);
  return caught;
}
afterEach(() => { vi.restoreAllMocks(); });

function setup(o: FakeOpts) {
  const f = fakeClaude(o);
  const s = openSample();
  s.host.claude = f.host;
  const call = <T>(m: string, ...args: unknown[]) => dispatch(s.ctx, m, args) as Promise<T>;
  return { ...s, f, call, ready: call("claude.consent") };
}
async function until(call: <T>(m: string, ...a: unknown[]) => Promise<T>, pred: (runs: ClaudeRunView[]) => boolean): Promise<ClaudeRunView[]> {
  for (let i = 0; i < 400; i++) {
    const runs = await call<ClaudeRunView[]>("claude.runs");
    if (pred(runs)) return runs;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out waiting for runs");
}
const prompts = (x: ReturnType<typeof setup>) => x.f.runner.calls.filter((c) => c.args[0] === "-p").map((c) => c.input ?? "");

describe("find jobs: if it fails, try again", () => {
  it("a passing failure starts again after 30 seconds, then 2 minutes, up to the chosen number of times", async () => {
    const caught = catchLongTimers();
    const x = setup({ run: () => ({ code: 1, stderr: "Error: socket hang up" }) });
    await x.ready;
    const r = await x.call<ClaudeRunView>("claude.run", "find_jobs", { kind: "workspace" }, { options: { retries: "2" } });
    let runs = await until(x.call, (rs) => rs.some((v) => v.id === r.id && v.retry));
    expect(runs.find((v) => v.id === r.id)).toMatchObject({ status: "failed", retry: { attempt: 1, of: 2 } });
    expect(caught.map((c) => c.ms)).toEqual([30_000]);
    caught.shift()!.fn();
    runs = await until(x.call, (rs) => rs.filter((v) => v.action === "find_jobs").length === 2 && rs.some((v) => v.retry?.attempt === 2));
    expect(caught.map((c) => c.ms)).toEqual([120_000]);
    expect(runs.find((v) => v.retry_of?.attempt === 1)).toBeDefined();
    expect(prompts(x)[1]).toContain("This is retry 1 of 2");
    caught.shift()!.fn();
    runs = await until(x.call, (rs) => rs.filter((v) => v.action === "find_jobs" && v.status === "failed").length === 3);
    // The last try doesn't wait for another.
    expect(runs.some((v) => v.retry)).toBe(false);
    expect(caught).toEqual([]);
  });

  it("Stop drops the wait; nothing starts", async () => {
    const caught = catchLongTimers();
    const x = setup({ run: () => ({ code: 1, stderr: "connect ETIMEDOUT" }) });
    await x.ready;
    const r = await x.call<ClaudeRunView>("claude.run", "find_jobs", { kind: "workspace" }, {});
    await until(x.call, (rs) => rs.some((v) => v.id === r.id && v.retry));
    const v = await x.call<ClaudeRunView>("claude.cancel", r.id);
    expect(v.retry).toBeUndefined();
    const runs = await x.call<ClaudeRunView[]>("claude.runs");
    expect(runs.find((x2) => x2.id === r.id)?.retry).toBeUndefined();
    expect(caught).toHaveLength(1);
    caught[0]!.fn = () => { throw new Error("should not run"); };
  });

  it("never retries when set to Don't", async () => {
    const caught = catchLongTimers();
    const x = setup({ run: () => ({ code: 1, stderr: "Error: socket hang up" }) });
    await x.ready;
    const r = await x.call<ClaudeRunView>("claude.run", "find_jobs", { kind: "workspace" }, { options: { retries: "0" } });
    await until(x.call, (rs) => rs.some((v) => v.id === r.id && v.status === "failed"));
    expect(caught).toEqual([]);
  });

  it("tells the next try which boards were already searched", () => {
    expect(retryLine({ attempt: 2, of: 3, skip: ["seek", "linkedin"] }, ["linkedin", "seek", "indeed"]))
      .toContain("These boards were already searched: SEEK, LinkedIn. Don't search them again");
    expect(retryLine({ attempt: 1, of: 1, skip: [] }, [])).toContain("Carry on where it stopped.");
  });
});
