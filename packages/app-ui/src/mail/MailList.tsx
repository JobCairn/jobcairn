import { useRef, type KeyboardEvent } from "react";
import { Icon, Icons } from "@careeros/brand";
import type { MailRow } from "@careeros/contract";
import { DateText } from "../components/DateText";
import { plural } from "../format";

const NEXT = new Set(["ArrowDown", "j"]);
const PREV = new Set(["ArrowUp", "k"]);

/** Where a row is filed, as a short tag: the job, or the company for company mail. "" when not filed. */
export function filedLabel(r: MailRow): { short: string; full: string } {
  if (!r.company_name && !r.job_title) return { short: "", full: "" };
  if (!r.job_title) return { short: r.company_name, full: `${r.company_name} (company mail)` };
  return { short: r.job_title, full: `${r.job_title} · ${r.company_name}` };
}

/**
 * The dense message list: sender and date, subject, then a one-line snippet with a small tag for where it's filed.
 * Up and Down (or j and k) move between messages; Enter or a click opens one. Only the open (or first) row is in
 * the Tab order, so Tab moves on to the reader instead of walking every row.
 */
export function MailList({ rows, open, onOpen, label, tagFor = filedLabel, tour }: {
  rows: MailRow[]; open: string; onOpen: (ref: string) => void; label: string;
  /** The small tag on each row (default: where it's filed); null for no tag. */
  tagFor?: (r: MailRow) => { short: string; full: string } | null;
  tour?: string;
}) {
  const list = useRef<HTMLUListElement>(null);
  const tabRef = rows.some((r) => r.ref === open) ? open : rows[0]?.ref;
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const step = NEXT.has(e.key) ? 1 : PREV.has(e.key) ? -1 : e.key === "Home" ? -Infinity : e.key === "End" ? Infinity : 0;
    if (!step) return;
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>(".mail-row") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0 && Number.isFinite(step)) return;
    e.preventDefault();
    const to = step === -Infinity ? 0 : step === Infinity ? buttons.length - 1 : Math.min(buttons.length - 1, Math.max(0, at + step));
    buttons[to]?.focus();
  };
  return (
    <ul ref={list} className="list-plain mail-list mail-list--dense" aria-label={label} aria-keyshortcuts="ArrowUp ArrowDown J K Enter" onKeyDown={onKey} data-tour={tour}>
      {rows.map((r) => {
        const unread = !r.opened && r.direction === "in";
        const sender = r.direction === "out" ? "You" : r.from.name || r.from.address;
        const filed = tagFor(r) ?? { short: "", full: "" };
        return (
          <li key={r.ref}>
            <button type="button" aria-current={open === r.ref || undefined} tabIndex={r.ref === tabRef ? 0 : -1}
              className={`mail-row${unread ? " is-unread" : ""}${open === r.ref ? " is-current" : ""}`} onClick={() => onOpen(r.ref)}>
              <span className="mail-row__top">
                {unread ? <span className="mail-row__dot" aria-hidden="true" /> : null}
                {unread ? <span className="sr-only">Unread. </span> : null}
                <span className="mail-row__from" title={r.direction === "out" ? undefined : `${r.from.name} ${r.from.address}`.trim()}>{sender}</span>
                <span className="mail-row__date">
                  {r.attachments ? <span className="mail-row__files" title={plural(r.attachments, "file")}><Icon icon={Icons.attach} size="sm" /><span className="sr-only">{plural(r.attachments, "file")}</span></span> : null}
                  <DateText value={r.date} />
                </span>
              </span>
              <span className="mail-row__subject" title={r.subject}>{r.subject || "(no subject)"}</span>
              {r.snippet || filed.short ? (
                <span className="mail-row__bottom">
                  <span className="mail-row__snippet">{r.snippet ?? ""}</span>
                  {filed.short ? <span className="mail-tag" title={filed.full}>{tagFor === filedLabel ? <span className="sr-only">Filed under </span> : null}{filed.short}</span> : null}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
