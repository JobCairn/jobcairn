import crypto from "node:crypto";
import { readMeta, updateRecord, layout } from "@careeros/core";

/** The switcher keeps this many workspaces (app state `recent`, most recent first). */
export const MAX_RECENT = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isWorkspaceId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** The switcher's opaque token for a folder: the renderer never sees the path, only this. */
export const recentKey = (root: string): string => crypto.createHash("sha256").update(`careeros-recent\0${root}`).digest("hex").slice(0, 16);

/** The workspace's stable id from workspace.json, or "" when it has none yet (or a malformed one). */
export function workspaceIdOf(root: string): string {
  try { const id = readMeta(root).workspace_id; return isWorkspaceId(id) ? id : ""; } catch { return ""; }
}

/** Gives the workspace a random id on first open (or replaces a malformed one) and returns it. */
export function ensureWorkspaceId(root: string): string {
  const id = workspaceIdOf(root);
  if (id) return id;
  const fresh = crypto.randomUUID();
  updateRecord("workspace", layout(root).workspaceFile, (m) => { m.workspace_id = fresh; });
  return fresh;
}
