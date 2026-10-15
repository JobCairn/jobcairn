import { useId, useMemo, useState, type ReactNode } from "react";
import { Button, Card, Dialog, Icon, Icons, Pill, Select, Text } from "@careeros/brand";
import { mailViewUrl, type MailAddressView, type MailMessageView, type MailView } from "@careeros/contract";
import { useAction, useBridge, useLoad } from "../bridge-context";
import { navigate } from "../router";
import { bytes, fmtDateTime } from "../format";
import { ErrorState, Loading } from "./States";
import { gmailLink } from "../mail/gmail";
import { MoreMenu, type MoreItem } from "../mail/MoreMenu";
import { useFileViewer } from "../viewer";

export interface JobTarget { company_slug: string; company_name: string; id: string; title: string }

/** Every job, for "file under" and "move to" pickers. */
export function useJobTargets(): JobTarget[] {
  const jobs = useLoad((b) => b.jobs.list({ showIneligible: true, limit: 500 }), [], ["jobs"]);
  return useMemo(() => (jobs.data?.rows ?? []).map((r) => ({ company_slug: r.company_slug, company_name: r.company_name, id: r.id, title: r.title })), [jobs.data]);
}

/**
 * A button that is sometimes off, with the reason tied to it for screen readers and as a tooltip.
 * `quiet` keeps the reason out of the page text, for a button that is off most of the time by design (Move).
 */
export function ButtonWhy({ why, quiet, children, ...rest }: Parameters<typeof Button>[0] & { why?: string; quiet?: boolean }) {
  const id = useId();
  return (
    // A disabled button gets no pointer events in some engines, so the tooltip sits on the wrapper.
    <span className="mail-why-wrap" title={why}>
      <Button {...rest} disabled={!!why || rest.disabled} aria-describedby={why ? id : undefined}>{children}</Button>
      {why ? <span id={id} className={quiet ? "sr-only" : "field__help"}>{why}</span> : null}
    </span>
  );
}

function Who({ label, list, aside }: { label: string; list: MailAddressView[]; aside?: ReactNode }) {
  if (!list.length) return null;
  return (
    <div className={`mail-meta__line${aside ? " mail-meta__line--aside" : ""}`}>
      <Text role="label">{label}</Text>
      <span>
        {list.map((a, i) => (
          <span key={`${a.address}-${i}`} className="mail-addr">
            {a.name ? <span className="mail-addr__name">{a.name}</span> : null}
            {/* The real address always shows next to the display name, so a look-alike name can't hide it. */}
            <span className="mail-addr__address">{a.address}</span>
          </span>
        ))}
      </span>
      {aside}
    </div>
  );
}

/** Where the message is filed. A job opens that job's Mail tab, unless the viewer is already on it. */
function Filed({ v, here }: { v: MailMessageView; here?: { slug: string; id: string } }) {
  if (v.triage) return <span>Mail to sort</span>;
  if (!v.job_id) return <span>{v.company_name} (company mail)</span>;
  const label = `${v.job_title} · ${v.company_name}`;
  if (here && here.slug === v.company_slug && here.id === v.job_id) return <span>{label}</span>;
  return (
    <span>
      <Button size="sm" variant="ghost" icon={Icons.jobs} className="mail-job-link" title={`Open this job's mail: ${label}`}
        onClick={() => navigate({ screen: "job", slug: v.company_slug, id: v.job_id, tab: "mail" })}>{label}</Button>
    </span>
  );
}

export function MessageViewer({ mailRef, onReply, showMove, here, fill, menu = [], onBack, onFull }: {
  mailRef: string; onReply?: (v: MailMessageView) => void; showMove?: boolean;
  /** The job page this viewer sits on, so the "Filed" link isn't offered for the page you're on. */
  here?: { slug: string; id: string };
  /** The parent gives the viewer a fixed height: the email body then takes all the room left. */
  fill?: boolean;
  /** More low-priority actions for the "⋯" menu, after Move and Email settings. */
  menu?: MoreItem[];
  /** The email has the whole page: a Back button returns to the list. */
  onBack?: () => void;
  /** Offered beside the list: give this email the whole page. */
  onFull?: () => void;
}) {
  const bridge = useBridge();
  const { busy, run } = useAction();
  // A move gives the message a new ref; follow it until the parent opens a different message.
  const [moved, setMoved] = useState<{ from: string; to: string } | null>(null);
  const [moveTo, setMoveTo] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [view, setView] = useState<MailView>("original");
  const ref = moved && moved.from === mailRef ? moved.to : mailRef;
  const msg = useLoad((b) => b.mail.get(ref), [ref], ["mail"]);
  const account = useLoad((b) => b.mail.status(), [], ["mail"]).data?.address ?? "";
  const targets = useJobTargets();
  const v = msg.data;
  const viewer = useFileViewer((v?.attachments ?? []).filter((a) => a.saved_rel && !a.risky).map((a) => ({ rel: a.saved_rel, title: a.name }))); // file viewer lane
  if (msg.error && !v) return <ErrorState title="This email can't be shown" text={msg.error} />;
  if (!v) return <Loading />;

  const sameCompany = targets.filter((t) => t.company_slug === v.company_slug);
  const dest = moveTo ?? v.job_id;
  const loadImages = () => run("images", async () => { await bridge.mail.loadImages(v.ref); msg.reload(); });
  const save = (part: string) => run(`save-${part}`, async () => { await bridge.mail.saveAttachment(v.ref, part); msg.reload(); }, "Saved to the job folder");
  const move = () => run("move", async () => {
    const r = await bridge.mail.move(v.ref, dest ? { company_slug: v.company_slug, id: dest } : { company_slug: v.company_slug });
    setMoved({ from: mailRef, to: r.ref });
    setMoveTo(null);
    setMoving(false);
  }, "Moved");
  const saveWhy = v.triage ? "Assign this email to a job first." : !v.has_raw ? "The original email was removed to save space." : undefined;
  const gmail = gmailLink(v.message_id, account);
  // Plain text is offered only while the original is kept; without it the viewer already shows the text.
  const shown: MailView = v.has_raw ? view : "original";
  const toMeOnly = v.direction === "in" && v.to.length === 1 && !!account && v.to[0]!.address.toLowerCase() === account.toLowerCase();
  const canMove = !!showMove && !v.triage && sameCompany.length > 0;
  const items: MoreItem[] = [
    ...(canMove ? [{ id: "move", label: "Move…", onSelect: () => setMoving(true) }] : []),
    ...menu,
    { id: "settings", label: "Email settings", onSelect: () => navigate({ screen: "settings", tab: "connections", c: "email" }) },
  ];

  return (
    <Card className={`mail-viewer${fill ? " mail-viewer--fill" : ""}`} aria-label="Message">
      <div className="mail-viewer__bar" role="toolbar" aria-label="Message actions">
        {onBack ? <Button size="sm" variant="ghost" icon={Icons.back} aria-label="Back to mail" title="Back to mail (Esc)" onClick={onBack} /> : null}
        <Text role="heading-2" className="mail-viewer__subject">{v.subject || "(no subject)"}</Text>
        {v.has_raw ? (
          <div className="seg" role="group" aria-label="Show the email as">
            <button type="button" className="seg__item" aria-pressed={shown === "original"} onClick={() => setView("original")}>Original</button>
            <button type="button" className="seg__item" aria-pressed={shown === "text"} onClick={() => setView("text")}>Plain text</button>
          </div>
        ) : null}
        {onReply && v.direction === "in" ? <Button size="sm" icon={Icons.reply} onClick={() => onReply(v)}>Reply</Button> : null}
        {gmail ? (
          <Button size="sm" variant="ghost" icon={Icons.openExternal} title="Opens this email in Gmail in your browser" onClick={() => void bridge.links.open(gmail)}>Open Gmail</Button>
        ) : null}
        {onFull ? <Button size="sm" variant="ghost" icon={Icons.widen} aria-label="Read at full width" title="Read at full width" onClick={onFull} /> : null}
        <MoreMenu items={items} />
      </div>
      <div className="mail-meta">
        <Who label="From" list={[v.from]} aside={<time className="mail-meta__date" dateTime={v.date}><span className="sr-only">Date </span>{fmtDateTime(v.date)}</time>} />
        {/* Mail sent only to you doesn't need a To line: that's most job mail, and the room goes to the email. */}
        {toMeOnly ? null : <Who label="To" list={v.to} />}
        <Who label="Cc" list={v.cc} />
        <Who label="Reply to" list={v.reply_to} />
        <div className="mail-meta__line"><Text role="label">Filed</Text><Filed v={v} here={here} /></div>
      </div>
      {v.warnings.map((w) => <p key={w} role="alert" className="mail-warning">{w}</p>)}
      {v.too_large ? <div><Pill tone="warning">Only the headers were kept</Pill></div> : null}
      {v.remote_images > 0 && !v.images_allowed && shown === "original" ? (
        <div className="mail-images-bar row">
          <Icon icon={Icons.imagesBlocked} size="sm" />
          <Text role="body-sm">Images are blocked to protect your privacy.</Text>
          <Button size="sm" loading={busy === "images"} onClick={() => void loadImages()}>Load images</Button>
        </div>
      ) : null}
      {viewer.element}
      {v.attachments.length ? (
        <div className="chip-group mail-attachments">
          {v.attachments.map((a) => (
            <div key={a.part} role="group" aria-label={a.name} className="mail-chip">
              <div className="row mail-chip__head">
                <Icon icon={Icons.attach} size="sm" />
                <span className="mail-chip__name" title={a.name}>{a.name}</span>
                <Text role="body-sm" muted>{bytes(a.size)}</Text>
              </div>
              {a.risky ? <Text role="body-sm" className="mail-chip__risk">This kind of file can run programs. Only open it if you expected it.</Text> : null}
              {a.saved_rel ? (
                <>{a.risky ? null : <Button size="sm" variant="ghost" icon={Icons.show} aria-label={`View ${a.name}`} onClick={() => viewer.open(a.saved_rel)}>View</Button>}<Button size="sm" variant="ghost" icon={Icons.showInFolder} aria-label={`Show file: ${a.name}`} title="Show in folder" onClick={() => void bridge.files.reveal(a.saved_rel)}>Show file</Button></>
              ) : (
                <ButtonWhy size="sm" why={saveWhy} loading={busy === `save-${a.part}`} onClick={() => void save(a.part)}>Save to job folder</ButtonWhy>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {/* sandbox="" : no scripts, forms, popups, same-origin or top navigation. The frame's CSP blocks every fetch.
          The key re-creates the frame when images are allowed or the view changes, so it reloads with the right body. */}
      <iframe key={`${v.ref}-${v.images_allowed ? "img" : "noimg"}-${shown}`} title={shown === "text" ? "Email body, plain text" : "Email body"} className="mail-frame"
        sandbox="" referrerPolicy="no-referrer" src={mailViewUrl(bridge.mailUrl(v.ref), shown)} />
      {canMove ? (
        <Dialog open={moving} onClose={() => { setMoving(false); setMoveTo(null); }} title="Move to another job"
          actions={<>
            <Button variant="ghost" onClick={() => { setMoving(false); setMoveTo(null); }}>Cancel</Button>
            <ButtonWhy quiet variant="primary" why={dest === v.job_id ? "Choose a different job to move it." : undefined} loading={busy === "move"} onClick={() => void move()}>Move</ButtonWhy>
          </>}>
          <div className="stack">
            <Text role="body-sm" muted>Moves this email, and where it shows up, to another job at {v.company_name}.</Text>
            <Select label="Move to" value={dest} onChange={(e) => setMoveTo(e.target.value)}
              options={[{ value: "", label: `${v.company_name} (company folder)` }, ...sameCompany.map((t) => ({ value: t.id, label: t.title }))]} />
          </div>
        </Dialog>
      ) : null}
    </Card>
  );
}
