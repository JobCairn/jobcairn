import { useEffect, useRef, useState } from "react";
import { Button, Dialog, Pill, Text } from "@careeros/brand";
import type { RecheckPreview } from "@careeros/contract";
import { errorText, useAction, useBridge, useLoad } from "../bridge-context";
import { DateText } from "../components/DateText";
import { plural } from "../format";

const TITLE = "Re-check filed mail";

/** "8 emails will go back to Mail to sort. 2 will be unfiled because they aren't job mail." */
export function recheckSummary(p: Pick<RecheckPreview, "sort" | "unfile">): string {
  const why = p.unfile === 1 ? "it isn't job mail" : "they aren't job mail";
  if (p.sort && p.unfile) return `${plural(p.sort, "email")} will go back to Mail to sort, and ${p.unfile} will be unfiled because ${why}.`;
  if (p.sort) return `${plural(p.sort, "email")} will go back to Mail to sort.`;
  if (p.unfile) return `${plural(p.unfile, "email")} will be unfiled because ${why}.`;
  return "Everything filed still matches. Nothing needs to move.";
}

/**
 * The preview and confirmation for "Re-check filed mail": what today's matching rules would move, then one button
 * that moves exactly that list. `auto` is the one-time offer after an update: closing it counts as "not now".
 */
export function RecheckDialog({ open, onClose, auto = false }: { open: boolean; onClose: () => void; auto?: boolean }) {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const [preview, setPreview] = useState<RecheckPreview | null>(null);
  const [problem, setProblem] = useState("");
  const [loadError, setLoadError] = useState("");

  const load = () => {
    setLoadError("");
    bridge.mail.recheck.preview().then(setPreview, (e) => setLoadError(errorText(e)));
  };
  useEffect(() => { if (open) { setPreview(null); setProblem(""); load(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    if (auto) void bridge.mail.recheck.dismiss().catch(() => undefined);
    onClose();
  };
  const apply = () => run("recheck", async () => {
    setProblem("");
    try {
      const r = await bridge.mail.recheck.apply(preview!.token);
      onClose();
      return r;
    } catch (e) {
      // The list changed since the preview (a sync filed more): show the new list and ask again.
      setProblem(errorText(e));
      load();
      throw e;
    }
  }, "Filed mail re-checked");

  const n = preview ? preview.sort + preview.unfile : 0;
  return (
    <Dialog open={open} onClose={close} title={TITLE}
      actions={preview && n > 0 ? (
        <>
          <Button variant="ghost" onClick={close}>{auto ? "Not now" : "Cancel"}</Button>
          <Button variant="primary" loading={busy === "recheck"} onClick={() => void apply()}>Move {plural(n, "email")}</Button>
        </>
      ) : <Button onClick={close}>Close</Button>}>
      <div className="stack recheck">
        {auto ? <Text role="body">Mail matching got stricter: account and no-reply notices from big sites are no longer filed under a company just because of the sender's domain. Some mail filed earlier no longer matches.</Text> : null}
        {problem ? <p role="alert" className="field__error">{problem}</p> : null}
        {loadError ? <p role="alert" className="field__error">The check can't run: {loadError}</p> : !preview ? <Text role="body-sm" muted>Checking filed mail…</Text> : (
          <>
            <Text role="body"><strong>{recheckSummary(preview)}</strong></Text>
            {n > 0 ? (
              <>
                <ul className="list-plain recheck__list" aria-label="Emails that will move">
                  {preview.items.map((i) => (
                    <li key={i.ref} className="recheck__item">
                      <div className="recheck__top">
                        <span className="recheck__subject" title={i.subject}>{i.subject || "(no subject)"}</span>
                        <Pill tone={i.outcome === "sort" ? "accent" : "neutral"}>{i.outcome === "sort" ? "To Mail to sort" : "Unfile"}</Pill>
                      </div>
                      <Text role="body-sm" muted>
                        {i.from.name || i.from.address} · filed under {i.job_title ? `${i.job_title} · ${i.company_name}` : i.company_name} · <DateText value={i.date} />
                      </Text>
                    </li>
                  ))}
                </ul>
                <Text role="body-sm" muted>Mail you filed or moved yourself isn't changed. Files you saved from these emails stay in the job folder.</Text>
              </>
            ) : <Text role="body-sm" muted>Checked {plural(preview.checked, "email")}.</Text>}
          </>
        )}
      </div>
    </Dialog>
  );
}

/** A button that opens the re-check preview, for Settings › Email. */
export function RecheckButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div><Button title={TITLE} onClick={() => setOpen(true)}>Re-check mail…</Button></div>
      <RecheckDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/**
 * The one-time offer after an update that changed the matching rules. Shows the same preview when something
 * would move; when nothing would, it quietly marks the offer as seen. Mounted once in the app shell.
 */
export function MailRecheckPrompt() {
  const bridge = useBridge();
  const status = useLoad((b) => b.mail.status(), [], ["mail"]);
  const [open, setOpen] = useState(false);
  const asked = useRef(false);
  const ready = !!status.data?.available && !!status.data?.connected && !status.data?.syncing;
  useEffect(() => {
    if (!ready || asked.current) return;
    asked.current = true;
    bridge.mail.recheck.preview().then((p) => {
      if (!p.due) return;
      if (p.items.length) setOpen(true);
      else void bridge.mail.recheck.dismiss().catch(() => undefined);
    }, () => { asked.current = false; });
  }, [ready, bridge]);
  return <RecheckDialog open={open} onClose={() => setOpen(false)} auto />;
}
