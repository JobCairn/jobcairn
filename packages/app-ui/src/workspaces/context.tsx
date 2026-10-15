import { createContext, useContext } from "react";
import type { RecentWorkspace } from "@careeros/contract";
import { fmtDate } from "../format";

/** What the workspace switcher asks of the app around it (App's Gate provides it). */
export interface WorkspaceFlow {
  /** "Start a new one": show the setup page for a new workspace (Cancel comes back). */
  startNew(): void;
  /** A different workspace is open now: go Home and start every screen afresh. */
  switched(): void;
}

const Ctx = createContext<WorkspaceFlow>({ startNew: () => undefined, switched: () => undefined });
export const WorkspaceFlowProvider = Ctx.Provider;
export const useWorkspaceFlow = () => useContext(Ctx);

/** The name to show for a workspace: the person's name, else the folder's own name. */
export const workspaceLabel = (w: { name: string; folder: string }) => w.name.trim() || w.folder;

/** The quiet second line: "personal-workspace › CareerOS · 52 companies · created 10 Oct 2026", or why it can't open. */
/** `short`: the one-line menu row (folder and companies); the full line, with the date, is its tooltip. */
export function workspaceDetail(r: RecentWorkspace, short = false): string {
  if (!r.available) return `${r.place} · ${r.problem === "not_workspace" ? "Not a workspace any more" : "Can't find this folder"}`;
  const parts = [r.place];
  if (r.companies !== null) parts.push(r.companies === 0 ? "No companies yet" : `${r.companies} ${r.companies === 1 ? "company" : "companies"}`);
  const created = r.created ? fmtDate(r.created) : "";
  if (created && !short) parts.push(`created ${created}`);
  return parts.join(" · ");
}
