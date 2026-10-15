import { useState } from "react";
import { Avatar, Button, Dialog, Text, useToast } from "@careeros/brand";
import type { RecentWorkspace } from "@careeros/contract";
import { errorText, useBridge } from "../bridge-context";
import { workspaceDetail, workspaceLabel } from "./context";
import "./workspaces.css";

type RowState =
  | { kind: "idle" }
  | { kind: "confirm-trash" }
  | { kind: "different"; dir: string };

/**
 * One workspace in the list, with only the actions that are safe for it:
 * - the open one: no actions ("You're using this one");
 * - a missing folder: Locate… (accepted only if it is the same workspace) and Remove from list;
 * - an empty one: Remove from list and Move to Trash (after a confirm);
 * - any other: Remove from list. Its files are never touched.
 */
export function WorkspaceRow({ r, busy, act, onChanged, onOpen, canTrash = true, rows = [] }: {
  r: RecentWorkspace; busy: boolean; act: (fn: () => Promise<void>) => Promise<void>; onChanged: () => void;
  /** The welcome screen: an Open button for a workspace that can be opened. */
  onOpen?: (r: RecentWorkspace) => void;
  /** False on the welcome screen: Move to Trash stays in the switcher's list. */
  canTrash?: boolean;
  /** The whole list, so two that read the same get told apart in their button names too. */
  rows?: RecentWorkspace[];
}) {
  const bridge = useBridge();
  const toast = useToast();
  const [st, setSt] = useState<RowState>({ kind: "idle" });
  const label = workspaceLabel(r);
  // Button names for screen readers: "Remove Sam Sample (old-laptop › CareerOS) from this list" when names clash.
  const named = rows.some((o) => o.key !== r.key && workspaceLabel(o) === label) ? `${label} (${r.place})` : label;

  const forget = () => act(async () => { await bridge.workspace.forget(r.key); onChanged(); });
  const trash = () => act(async () => {
    await bridge.workspace.trash(r.key);
    toast({ tone: "success", text: `${label} was moved to the Trash. You can put it back from there.` });
    onChanged();
  });
  const locate = () => act(async () => {
    const dir = await bridge.workspace.pickFolder("open");
    if (!dir) return;
    const res = await bridge.workspace.locate(r.key, dir);
    if (res.relinked) { toast({ tone: "success", text: `Found ${label}. It's in the list again.` }); setSt({ kind: "idle" }); onChanged(); }
    else setSt({ kind: "different", dir });
  });
  const addSeparate = (dir: string) => act(async () => { await bridge.workspace.addRecent(dir); setSt({ kind: "idle" }); onChanged(); });

  return (
    <li className="ws-manage__row">
      <div className="ws-manage__main">
        <Avatar name={label} size="sm" />
        <span className="ws-switch__item-text">
          <span className="ws-switch__item-name">{label}</span>
          <span className="ws-switch__item-folder" title={workspaceDetail(r)}>{workspaceDetail(r)}</span>
        </span>
        <span className="ws-manage__actions">
          {r.current ? (
            <span className="ws-manage__current" title="This is the workspace that's open now. Switch to another one to remove it.">You're using this one</span>
          ) : st.kind === "confirm-trash" ? null : (
            <>
              {onOpen && r.available ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => onOpen(r)} aria-label={`Open ${named}`}>Open</Button> : null}
              {r.problem === "missing" ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void locate()} aria-label={`Locate ${named}'s folder`}>Locate…</Button> : null}
              {r.empty && canTrash ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSt({ kind: "confirm-trash" })} aria-label={`Trash: ${named}`} title="Move to Trash">Trash…</Button> : null}
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void forget()} aria-label={`Remove: ${named}`} title="Remove from this list. The folder stays.">Remove</Button>
            </>
          )}
        </span>
      </div>
      {st.kind === "confirm-trash" ? (
        <div className="ws-manage__note" role="alert">
          <Text role="body-sm" as="p">Move this empty workspace to the Trash? It has no companies, jobs or files of yours. You can put it back from the Trash.</Text>
          <span className="ws-manage__note-actions">
            <Button size="sm" variant="danger" loading={busy} onClick={() => void trash()}>Trash folder</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSt({ kind: "idle" })}>Cancel</Button>
          </span>
        </div>
      ) : null}
      {st.kind === "different" ? (
        <div className="ws-manage__note" role="alert">
          <Text role="body-sm" as="p">That folder holds a different workspace, so it can't stand in for this one.</Text>
          <span className="ws-manage__note-actions">
            <Button size="sm" variant="secondary" disabled={busy} title="Add it as a separate workspace" onClick={() => void addSeparate(st.dir)}>Add separately</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSt({ kind: "idle" })}>Cancel</Button>
          </span>
        </div>
      ) : null}
    </li>
  );
}

/** "Remove from this list": every workspace on this computer, including the open one, with what can be done to each. */
export function ManageWorkspaces({ open, onClose, rows, onChanged }: { open: boolean; onClose: () => void; rows: RecentWorkspace[]; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast({ tone: "danger", text: errorText(e) }); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Remove from this list"
      actions={<Button variant="secondary" onClick={onClose}>Done</Button>}>
      <Text role="body" muted>This only takes a workspace off the list. Its folder and files stay where they are, and you can open it again later. Only an empty workspace can be moved to the Trash.</Text>
      {rows.length ? (
        <ul className="list-plain ws-manage">
          {rows.map((r) => <WorkspaceRow key={r.key} r={r} rows={rows} busy={busy} act={act} onChanged={onChanged} />)}
        </ul>
      ) : <Text role="body-sm" muted as="p">No workspaces are listed.</Text>}
    </Dialog>
  );
}
