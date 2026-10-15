import { useState, type ReactNode } from "react";
import { Button, Dialog, Icons, Text, useToast } from "@careeros/brand";
import type { TrashCheck, TrashItem, TrashTarget } from "@careeros/contract";
import { errorText, useBridge } from "../bridge-context";
import { Loading } from "../components/States";

/** How long the "Deleted … Undo" toast stays. */
export const UNDO_MS = 10_000;

export interface DeleteOptions {
  /** The confirm button: "Delete job". At most two words. */
  label: string;
  /** For more than one item: what they are ("jobs"), so the title reads "Delete 3 jobs?". */
  plural?: string;
  /** One more sentence of the screen's own for the dialog ("This is the copy you sent."). */
  note?: string;
  /** After the move, e.g. leave the deleted job's page. */
  onDeleted?: (items: TrashItem[]) => void;
  /** After Undo put everything back, e.g. go back to the job's page. */
  onRestored?: () => void;
}

interface Asking { targets: TrashTarget[]; opts: DeleteOptions; checks: TrashCheck[] | null; error: string }

/** "Delete AI Engineer at Acme Corp?" or "Delete Acme Corp and its 2 jobs?" */
export function deleteTitle(checks: TrashCheck[], plural = "items"): string {
  if (checks.length !== 1) return `Delete ${checks.length} ${plural}?`;
  const c = checks[0]!;
  return `Delete ${c.title}${c.also ? ` and ${c.also}` : ""}?`;
}

/**
 * Delete with a confirm dialog and Undo. `ask(targets, opts)` checks the items (their names, what goes with them,
 * and whether one can't go right now), asks, moves them to Recently deleted, then offers Undo in a toast.
 * Render `element` once in the screen.
 */
export function useDelete(): { ask: (targets: TrashTarget[], opts: DeleteOptions) => void; element: ReactNode } {
  const bridge = useBridge();
  const toast = useToast();
  const [asking, setAsking] = useState<Asking | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = (targets: TrashTarget[], opts: DeleteOptions) => {
    if (!targets.length) return;
    setAsking({ targets, opts, checks: null, error: "" });
    void Promise.all(targets.map((t) => bridge.trash.check(t))).then(
      (checks) => setAsking((a) => (a && a.targets === targets ? { ...a, checks } : a)),
      (e: unknown) => setAsking((a) => (a && a.targets === targets ? { ...a, error: errorText(e) } : a)),
    );
  };

  const undo = (items: TrashItem[], opts: DeleteOptions) => {
    void (async () => {
      try {
        for (const it of items) await bridge.trash.restore(it.id);
        toast({ tone: "success", text: items.length === 1 ? `Restored ${items[0]!.title}.` : `Restored ${items.length} items.` });
        opts.onRestored?.();
      } catch (e) {
        toast({ tone: "danger", text: errorText(e) });
      }
    })();
  };

  const confirm = async () => {
    if (!asking?.checks) return;
    const { targets, opts } = asking;
    setBusy(true);
    try {
      const items = await bridge.trash.move(targets);
      setAsking(null);
      opts.onDeleted?.(items);
      toast({
        text: items.length === 1 ? `Deleted ${items[0]!.title}.` : `Deleted ${items.length} ${opts.plural ?? "items"}.`,
        action: { label: "Undo", ariaLabel: items.length === 1 ? `Undo deleting ${items[0]!.title}` : "Undo delete", onClick: () => undo(items, opts) },
        timeoutMs: UNDO_MS,
      });
    } catch (e) {
      setAsking((a) => (a ? { ...a, error: errorText(e) } : a));
    } finally {
      setBusy(false);
    }
  };

  const checks = asking?.checks ?? null;
  const blocked = checks?.find((c) => c.blocked) ?? null;
  const notes = [asking?.opts.note ?? "", checks?.length === 1 ? checks[0]!.note : ""].filter(Boolean);
  const close = () => { if (!busy) setAsking(null); };
  const element = (
    <Dialog open={asking !== null} onClose={close} title={checks ? deleteTitle(checks, asking?.opts.plural) : "Delete"}
      actions={<>
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <Button variant="danger" icon={Icons.trash} loading={busy} disabled={!checks || !!blocked}
          aria-describedby={blocked ? "delete-blocked" : undefined} onClick={() => void confirm()}>{asking?.opts.label ?? "Delete"}</Button>
      </>}>
      {!checks && !asking?.error ? <Loading /> : (
        <div className="stack">
          {checks && checks.length > 1 ? (
            <ul className="list-plain delete-list">{checks.map((c, i) => <li key={i}><Text role="body">{c.title}{c.also ? ` and ${c.also}` : ""}</Text></li>)}</ul>
          ) : null}
          {notes.map((n) => <Text key={n} role="body">{n}</Text>)}
          {blocked ? (
            <Text role="body" as="p" id="delete-blocked" className="delete-blocked">{checks!.length > 1 ? `${blocked.title} can't be deleted right now. ` : ""}{blocked.blocked}</Text>
          ) : checks ? (
            <Text role="body-sm" muted>You can undo this, or restore it from Settings › Workspace for 30 days.</Text>
          ) : null}
          {asking?.error ? <Text role="body" as="p" className="delete-blocked">{asking.error}</Text> : null}
        </div>
      )}
    </Dialog>
  );
  return { ask, element };
}
