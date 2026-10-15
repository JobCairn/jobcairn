import fs from "node:fs";
import path from "node:path";
import { careerosDir, writeFileAtomic } from "@careeros/core";
import {
  actionKey, optionsFor, optionValueOk, validateOptions, type ActionId, type ActionTarget, type OptionValue, type RequestChoices, type WorkRightsStatus,
} from "@careeros/contract";

const MAX_BYTES = 16 * 1024;
const plainDir = (p: string) => { try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } };

/**
 * `.careeros/requests/<action key>.json`: the last options a person chose in the request composer, per action and
 * target (so per job). App state, like the hand-off notes; never inside a job folder, so no screen lists it.
 */
function requestsDir(root: string, create: boolean): string | null {
  const top = careerosDir(root);
  const dir = path.join(top, "requests");
  if (!create) return plainDir(top) && plainDir(dir) ? dir : null;
  if (!plainDir(top)) return null;
  let st: fs.Stats | undefined;
  try { st = fs.lstatSync(dir); } catch { st = undefined; }
  if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error(".careeros/requests must be a plain folder.");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The saved options, checked against today's allowlist for this candidate (a sponsorship choice saved before the
 * work-rights status changed is dropped), or null when none are saved (or the file isn't usable).
 */
export function savedOptions(root: string, id: ActionId, t: ActionTarget, status: WorkRightsStatus = "unknown"): Record<string, OptionValue> | null {
  const dir = requestsDir(root, false);
  if (!dir) return null;
  let fd: number;
  try { fd = fs.openSync(path.join(dir, `${actionKey(id, t)}.json`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > MAX_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(fd, "utf8")) as unknown;
    const options = parsed && typeof parsed === "object" ? (parsed as { options?: unknown }).options : undefined;
    // An option the app no longer offers (or a value it no longer allows) is dropped, keeping the rest.
    const clean: Record<string, unknown> = {};
    if (options && typeof options === "object" && !Array.isArray(options)) {
      for (const d of optionsFor(id, status)) {
        const v = (options as Record<string, unknown>)[d.key];
        if (v === undefined) continue;
        if (optionValueOk(id, d.key, v, status)) clean[d.key] = v;
      }
    }
    try { return validateOptions(id, clean, status); } catch { return validateOptions(id, null, status); }
  } catch { return null; } finally { fs.closeSync(fd); }
}

export function saveOptions(root: string, id: ActionId, t: ActionTarget, options: Record<string, OptionValue>, status: WorkRightsStatus = "unknown"): Record<string, OptionValue> {
  const clean = validateOptions(id, options, status);
  const dir = requestsDir(root, true);
  if (!dir) throw new Error("The workspace's .careeros folder isn't a plain folder, so the options weren't saved.");
  writeFileAtomic(path.join(dir, `${actionKey(id, t)}.json`), JSON.stringify({ schema: 1, action: id, options: clean }, null, 2) + "\n");
  return clean;
}

/** The request a one-click "Ask Claude" uses: the saved options with no note, or null (the plain prompt) when none are saved. */
export function savedRequest(root: string, id: ActionId, t: ActionTarget, status: WorkRightsStatus = "unknown"): RequestChoices | null {
  if (!optionsFor(id, status).length) return null;
  const options = savedOptions(root, id, t, status);
  return options ? { options, note: "" } : null;
}

