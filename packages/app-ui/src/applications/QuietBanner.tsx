import { useState } from "react";
import { Button, Card, Checkbox, Icon, Icons, Text } from "@careeros/brand";
import { NO_RESPONSE_NOTE, quietApplications, quietText, type JobRow } from "@careeros/contract";
import { useAction, useBridge, useLoad } from "../bridge-context";
import { displayName } from "../components/displayName";
import { fmtWhen } from "../reading/dates";

const KEY = "careeros.quiet.dismissed";
const keyOf = (r: JobRow) => `${r.company_slug}/${r.id}`;
const dismissed = () => { try { return sessionStorage.getItem(KEY) === "1"; } catch { return false; } };

/**
 * Applications and Jobs: one banner for applications that have had no reply for 60 days (spec
 * 2026-10-17-statuses-followups-mail-rules). Review lists them, all ticked; Mark No response changes only the ticked
 * ones. Nothing changes without that click, and Not now hides the banner for this session.
 */
export function QuietBanner() {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const { data } = useLoad((b) => b.jobs.list({ statuses: ["Applied"], limit: 500 }), [], ["jobs"]);
  const [hidden, setHidden] = useState(dismissed);
  const [open, setOpen] = useState(false);
  const [off, setOff] = useState<Set<string>>(() => new Set());
  if (hidden || !data) return null;
  const quiet = quietApplications(data.rows, new Date());
  if (!quiet.length) return null;
  const picked = quiet.filter((r) => !off.has(keyOf(r)));
  const toggle = (r: JobRow) => setOff((s) => { const n = new Set(s); if (n.has(keyOf(r))) n.delete(keyOf(r)); else n.add(keyOf(r)); return n; });
  const hide = () => { try { sessionStorage.setItem(KEY, "1"); } catch { /* private mode */ } setHidden(true); };
  const confirm = () => run("quiet", async () => {
    for (const r of picked) await bridge.jobs.setStatus(r.company_slug, r.id, "No response", NO_RESPONSE_NOTE);
    setOpen(false);
  }, picked.length === 1 ? "1 application marked No response" : `${picked.length} applications marked No response`);
  return (
    <Card className="stack quiet-banner" role="region" aria-label="Applications with no reply">
      <div className="row">
        <Icon icon={Icons.history} size="sm" />
        <Text role="body" className="grow">{quietText(quiet.length)}</Text>
        {open ? null : <Button size="sm" onClick={() => setOpen(true)} aria-label="Review applications with no reply">Review</Button>}
        <Button size="sm" variant="ghost" onClick={hide} aria-label="Not now: hide this for this session">Not now</Button>
      </div>
      {open ? (
        <>
          <ul className="list-plain stack-tight" aria-label="Pick which to mark No response">
            {quiet.map((r) => (
              <li key={keyOf(r)}>
                <Checkbox label={`${displayName(r.title)} · ${displayName(r.company_name)} · last activity ${fmtWhen(r.last_activity) || r.last_activity.slice(0, 10)}`}
                  checked={!off.has(keyOf(r))} onChange={() => toggle(r)} />
              </li>
            ))}
          </ul>
          <div className="row">
            <Button size="sm" variant="primary" disabled={!picked.length} loading={busy === "quiet"} onClick={() => void confirm()}
              aria-label={`Mark ${picked.length} as No response`}>Confirm</Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Text role="body-sm" muted>You can change a status back on the job page.</Text>
          </div>
        </>
      ) : null}
    </Card>
  );
}
