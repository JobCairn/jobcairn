import fs from "node:fs";
import path from "node:path";
import { CancelledError } from "../errors.js";
import type { HfCli, LintFinding, LintReport } from "../hf.js";
import type { Renderer } from "./renderer.js";

/** Check sections whose errors mean the render itself would break (the composition throws while it plays). */
export const BLOCKING_CHECK_SECTIONS = ["runtime"] as const;

/**
 * Composes `hf lint --json` and `hf check --json` into the single `Renderer.lint` call.
 * - lint is quick and static (no browser). Its errors (no duration, no timeline) break the render, so they block,
 *   and check is not run.
 * - check opens a browser and audits runtime, layout, motion and contrast. It repeats lint's findings in its own
 *   `lint` section, which is left out so nothing counts twice. Only runtime errors block; layout, motion and
 *   contrast errors become warnings, because the video still renders and the person can judge the result.
 * - A check that crashes, times out or answers in a way that can't be read is a problem with the tool, not the
 *   video: it never blocks, and `note` says the check was skipped.
 */
export function hyperframesRenderer(hf: HfCli): Renderer {
  return {
    id: "hyperframes",
    async lint(compDir, signal, opts = {}) {
      const lint = await hf.lint(compDir, signal);
      if (lint.errorCount > 0) return lint;
      if (opts.skipCheck) return { ...lint, note: "The layout check was skipped, as you asked." };
      let check: LintReport;
      try {
        check = await hf.check(compDir, signal, { skipSections: ["lint"] });
      } catch (e) {
        if (e instanceof CancelledError || signal?.aborted) throw e;
        return { ...lint, note: "The layout check took too long, so it was skipped." };
      }
      const broken = check.findings.find((f) => f.code === "unreadable" || f.code === "tool_error");
      if (broken) return { ...lint, note: `The layout check couldn't run, so it was skipped. ${broken.message}` };
      const blocks = (f: LintFinding) => f.severity === "error" && (BLOCKING_CHECK_SECTIONS as readonly string[]).includes(f.section ?? "");
      const findings = check.findings.map((f) => (f.severity === "error" && !blocks(f) ? { ...f, severity: "warning" } : f));
      const errorCount = findings.filter(blocks).length;
      const advisory = check.errorCount - errorCount;
      return {
        ok: errorCount === 0, errorCount, warningCount: lint.warningCount + check.warningCount + Math.max(0, advisory),
        findings: [...lint.findings, ...findings],
      };
    },
    // A stale contact sheet from an earlier run (or a symlink planted at that path) must never be
    // handed back as if this run had just produced it, even if this run's own tool call writes
    // nothing at all - deleted non-following before the run, then the result is only trusted if
    // it lstats as a genuine regular file afterwards, never followed (Fix round 1, item 8).
    async snapshot(compDir, times, signal) {
      const sheet = path.join(compDir, "snapshots", "contact-sheet.jpg");
      // A DIRECTORY at the contact sheet path makes a plain, non-recursive rmSync throw a raw
      // ERR_FS_EISDIR whose own message embeds the full filesystem path - refused with a clean,
      // path-free error instead, rather than deleting an arbitrary directory tree found there or
      // leaking that raw error (Fix round 2, item 8).
      let st: fs.Stats | undefined;
      try { st = fs.lstatSync(sheet); } catch { /* doesn't exist - nothing to clear */ }
      if (st?.isDirectory()) throw new Error("the contact sheet path holds a directory, not a file.");
      fs.rmSync(sheet, { force: true });
      await hf.snapshot(compDir, times, signal);
      try {
        return fs.lstatSync(sheet).isFile() ? sheet : null;
      } catch {
        return null;
      }
    },
    async render(job) {
      await hf.render(job.compDir, job.out, job.quality, { signal: job.signal, onPct: job.onPct });
    },
  };
}
