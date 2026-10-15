import { describe, expect, it } from "vitest";
import * as core from "@careeros/core";
import {
  APPROVAL_ACTIONS, APPROVAL_STATUSES, createRemoteBridge, JOB_SOURCES, JOB_STATUSES, JOB_SUBDIRS, LOCKABLE_DIRS, ME_DIRS, METHODS,
  REQUEST_STATUSES, topicSlug, WR_LABELS, WR_STATUSES, type MethodName,
} from "../src/index.js";

describe("createRemoteBridge", () => {
  it("routes every bridge call to exactly the METHODS list", async () => {
    const seen = new Set<string>();
    const bridge = createRemoteBridge({
      call: async (m: MethodName) => { seen.add(m); return null; },
      onChange: () => () => undefined, pathForFile: () => null, fileUrl: (r) => `careeros-file://ws/${r}`, mailUrl: (r) => `careeros-mail://msg/${r}`,
    });
    const walk = async (group: Record<string, unknown>) => {
      for (const v of Object.values(group)) {
        if (typeof v === "function") await (v as (...a: unknown[]) => Promise<unknown>)();
        else if (typeof v === "object" && v !== null) await walk(v as Record<string, unknown>);
      }
    };
    for (const [ns, group] of Object.entries(bridge)) {
      if (typeof group !== "object" || group === null) continue;
      expect(ns).toMatch(/^[a-z]+$/);
      await walk(group as Record<string, unknown>);
    }
    expect([...seen].sort()).toEqual(Object.keys(METHODS).sort());
    expect(bridge.fileUrl("learning/a b.md")).toBe("careeros-file://ws/learning/a b.md");
    expect(bridge.mailUrl("x")).toBe("careeros-mail://msg/x");
  });
});

describe("constants mirror core", () => {
  it("matches core's enums", () => {
    expect(JOB_STATUSES).toEqual(core.JOB_STATUSES);
    expect(WR_LABELS).toEqual(core.WR_LABELS);
    expect(WR_STATUSES).toEqual(core.WR_STATUSES);
    expect(JOB_SOURCES).toEqual(core.JOB_SOURCES);
    expect(LOCKABLE_DIRS).toEqual(core.LOCKABLE_DIRS);
    expect(ME_DIRS).toEqual(core.ME_DIRS);
    expect(JOB_SUBDIRS).toEqual(core.JOB_SUBDIRS);
    expect(APPROVAL_ACTIONS).toEqual(core.APPROVAL_ACTIONS);
    expect(APPROVAL_STATUSES).toEqual(core.APPROVAL_STATUSES);
    expect(REQUEST_STATUSES).toEqual(core.REQUEST_STATUSES);
  });
  it("makes the same topic slugs as core", () => {
    for (const s of ["RAG pipelines", "Kubernetes (basics)", "C++ & Rust", "Café design"]) expect(topicSlug(s)).toBe(core.slugify(s, "topic"));
  });
});

describe("isEligible parity with core", () => {
  // Every work-rights status vs every ad label: contract's pure logic must agree with
  // core's isEligible (packages/core/src/eligibility.ts) call for call, since the renderer
  // (contract) and the services (core) must never disagree about who can apply.
  it("agrees with core.isEligible for every status/label combination", async () => {
    const { isEligible } = await import("../src/index.js");
    for (const status of WR_STATUSES) {
      for (const label of WR_LABELS) {
        expect(isEligible(status, label), `${status} vs ${label}`).toBe(core.isEligible(status, label));
      }
    }
  });
  it("matches on a named table of real-world cases", async () => {
    const { isEligible } = await import("../src/index.js");
    const cases: { status: (typeof WR_STATUSES)[number]; label: (typeof WR_LABELS)[number]; expected: boolean }[] = [
      { status: "citizen", label: "citizen_pr_only", expected: true },
      { status: "pr", label: "clearance", expected: true },
      { status: "full_visa", label: "citizen_pr_only", expected: false },
      { status: "full_visa", label: "sponsorship_offered", expected: true },
      { status: "limited_visa", label: "clearance", expected: false },
      { status: "limited_visa", label: "silent", expected: true },
      { status: "needs_sponsorship", label: "citizen_pr_only", expected: false },
      { status: "needs_sponsorship", label: "sponsorship_offered", expected: true },
      { status: "unknown", label: "clearance", expected: true },
    ];
    for (const { status, label, expected } of cases) {
      expect(isEligible(status, label), `${status} vs ${label}`).toBe(expected);
      expect(core.isEligible(status, label), `core: ${status} vs ${label}`).toBe(expected);
    }
  });
});
