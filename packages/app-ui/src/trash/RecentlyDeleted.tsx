import { useState } from "react";
import { Button, Card, Dialog, Icons, SectionTitle, Text, useToast } from "@careeros/brand";
import type { TrashItem, TrashTargetKind } from "@careeros/contract";
import { errorText, useBridge, useLoad } from "../bridge-context";
import { EmptyState, Loading } from "../components/States";
import { fmtDayOf } from "../reading/dates";

const KIND: Record<TrashTargetKind, string> = {
  job: "Job", company: "Company", job_file: "Job file", resume: "Resume", topic: "Learn topic", video: "Video", research: "Research",
};

/** Settings › Workspace: what was deleted in the last 30 days, with Restore and Delete forever. */
export function RecentlyDeleted() {
  const bridge = useBridge();
  const toast = useToast();
  const list = useLoad((b) => b.trash.list(), [], ["trash"]);
  const [busy, setBusy] = useState<string | null>(null);
  const [forget, setForget] = useState<TrashItem | null>(null);
  const items = list.data ?? [];

  const restore = async (it: TrashItem) => {
    setBusy(it.id);
    try { await bridge.trash.restore(it.id); toast({ tone: "success", text: `Restored ${it.title}.` }); }
    catch (e) { toast({ tone: "danger", text: errorText(e) }); }
    finally { setBusy(null); }
  };
  const deleteForever = async (it: TrashItem) => {
    setForget(null);
    setBusy(it.id);
    try { await bridge.trash.forget(it.id, true); toast({ tone: "success", text: `Deleted ${it.title} for good.` }); }
    catch (e) { toast({ tone: "danger", text: errorText(e) }); }
    finally { setBusy(null); }
  };

  return (
    <Card className="stack" aria-labelledby="settings-deleted-title" data-tour="settings-deleted">
      <SectionTitle icon={Icons.trash} title="Recently deleted" id="settings-deleted-title" />
      <Text role="body-sm" muted as="p">Deleted items stay here for 30 days, then go for good when the app opens.</Text>
      {list.loading && !list.data ? <Loading /> : list.error ? <Text role="body" as="p">{list.error}</Text> : !items.length ? (
        <EmptyState text="Nothing deleted in the last 30 days." />
      ) : (
        <ul className="list-plain trash-list">
          {items.map((it) => (
            <li key={it.id} className="trash-list__item">
              <div className="grow stack trash-list__text">
                <Text role="body" truncate title={it.title}>{it.title}{it.also ? ` and ${it.also}` : ""}</Text>
                <Text role="body-sm" muted>{KIND[it.kind]} · Deleted {fmtDayOf(it.deleted_at)} · Goes for good {fmtDayOf(it.purge_at)}</Text>
              </div>
              <div className="row trash-list__actions">
                <Button size="sm" icon={Icons.putBack} loading={busy === it.id} aria-label={`Restore ${it.title}`} onClick={() => void restore(it)}>Restore</Button>
                <Button size="sm" variant="ghost" disabled={busy === it.id} aria-label={`Delete ${it.title} forever`} onClick={() => setForget(it)}>Delete forever</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={forget !== null} onClose={() => setForget(null)} title={`Delete ${forget?.title ?? ""} for good?`}
        actions={<><Button variant="ghost" onClick={() => setForget(null)}>Cancel</Button><Button variant="danger" icon={Icons.trash} onClick={() => void deleteForever(forget!)}>Delete forever</Button></>}>
        <Text role="body">{forget?.also ? `It and ${forget.also} are removed from this computer. ` : "It is removed from this computer. "}This can&apos;t be undone.</Text>
      </Dialog>
    </Card>
  );
}
