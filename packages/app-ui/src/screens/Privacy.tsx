import { useEffect, useState } from "react";
import { Button, Card, Dialog, Icon, Icons, Pill, Select, Text, useToast, type PillTone, PRODUCT_NAME, SectionTitle } from "@careeros/brand";
import { LOCKABLE_DIRS, LOCKED_FOLDER_NAMES, lockProblemMessage, type AccessRequestView, type LockableDir, type LockProblemView } from "@careeros/contract";
import { useAction, useBridge, useLoad } from "../bridge-context";
import { displayName } from "../components/displayName";
import { errorSentence } from "../components/ErrorBanner";
import { EmptyState, ErrorState, Loading, ScreenHead } from "../components/States";
import { fmtDateTime, fmtTime, plural } from "../format";

export const ALLOW_MINUTES = [15, 30, 60, 120];
/** "15 minutes", "1 hour", "2 hours". */
export const minutesText = (m: number): string => (m % 60 === 0 ? plural(m / 60, "hour") : plural(m, "minute"));
/** The names the Drop box uses for these folders. The screen shows these names, never the folder paths. */
const FOLDER_NAME = LOCKED_FOLDER_NAMES;
const FOLDER_TEXT: Record<LockableDir, string> = {
  "me/identity": "Passport, visa and other identity documents.",
  "me/employment": "Payslips, contracts and references.",
};
/** "Identity documents" for me/identity; anything unexpected stays as sent. */
const nameOf = (f: string) => (f in FOLDER_NAME ? FOLDER_NAME[f as LockableDir] : f);
/** "your identity documents"; anything unexpected stays as sent. */
const folderName = (f: string) => (f in FOLDER_NAME ? `your ${FOLDER_NAME[f as LockableDir].toLowerCase()}` : f);
/** A request's field name as a person would say it: "visa_expiry" reads "Visa expiry". Anything that isn't a plain key stays as sent. */
export function fieldLabel(field: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(field)) return displayName(field);
  const words = field.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
/** A decided or expired request keeps showing, read-only, for this long after it was settled. */
const DECIDED_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How often the grant countdown (and the decided-request window) re-checks the clock. */
const TICK_MS = 60_000;

/** Ticks every `ms` so a countdown can re-render; the interval is cleared on unmount. */
function useTickingNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** The banner text for a locked folder that isn't where, or what, it was. found_at is a workspace path: untrusted text. */
export function lockProblemText(p: LockProblemView): string {
  if (p.kind === "elsewhere") {
    return `Files that were in your ${nameOf(p.folder).toLowerCase()} folder are now in ${displayName(p.found_at ?? "another folder")}. They stay locked until you move them back.`;
  }
  const base = lockProblemMessage(p.folder);
  return p.found_at ? `${base} It looks like they are now in ${displayName(p.found_at)}.` : base;
}

/** What accepting the folders as they are means, one sentence per folder that moved (final re-review R1). */
export function acceptConfirmText(problems: LockProblemView[]): string {
  return problems.filter((p) => p.kind !== "elsewhere").map((p) => (p.found_at
    ? `Files in ${displayName(p.found_at)} will stay locked. ${PRODUCT_NAME} will also lock the new ${nameOf(p.folder).toLowerCase()} folder.`
    : `Files that were in your ${nameOf(p.folder).toLowerCase()} folder will stay locked wherever they are. ${PRODUCT_NAME} will also lock the new ${nameOf(p.folder).toLowerCase()} folder.`)).join(" ");
}

/** The moment a decided/expired request's final state actually happened, for the 24-hour window. */
const requestWhen = (r: AccessRequestView): string => (r.status === "expired" ? r.expires_at : r.decided_at);

function finalPill(r: AccessRequestView): { text: string; tone: PillTone } {
  if (r.status === "allowed") return { text: `Allowed until ${fmtTime(r.expires_at)}`, tone: "warning" };
  if (r.status === "denied") return { text: "Denied", tone: "danger" };
  return { text: "Expired", tone: "neutral" };
}

export function PrivacyScreen() {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const { data: p, error, reload } = useLoad((b) => b.privacy.get(), [], ["privacy"]);
  const [confirm, setConfirm] = useState<LockableDir | null>(null);
  const [confirmAccept, setConfirmAccept] = useState(false);
  const now = useTickingNow(TICK_MS);

  // A grant can only ever be shown with a non-negative time left: once the tick reaches its
  // end, re-fetch instead of ever rendering a negative number. A fresh read is self-correcting
  // either way, since privacy.get() only ever returns grants that haven't ended yet.
  useEffect(() => {
    if (p?.grants.some((g) => Date.parse(g.until) <= now)) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);

  // A reload failure must not leave a stale confirm dialog sitting over data nobody trusts any
  // more, with a button that would call setLocked against an unknown state.
  useEffect(() => { if (error) { setConfirm(null); setConfirmAccept(false); } }, [error]);

  if (error && !p) return <ErrorState title="Privacy settings can't load" text={errorSentence(error)} />;
  if (!p) return <Loading />;
  // A reload can fail (the shared privacy state file became unreadable) while we still hold
  // the last-known locks, grants, requests and activity. Show the error and hide every
  // control that would lock, unlock, allow, deny or revoke, instead of trusting the stale
  // snapshot to still be true. Follows the same `broken` pattern as Inbox.tsx / Settings.
  const broken = !!error;

  const setLocked = (d: LockableDir, locked: boolean) =>
    run(`lock-${d}`, () => bridge.privacy.setLocked(d, locked), locked ? `${nameOf(d)} locked` : `${nameOf(d)} unlocked`);
  // The confirm dialog stays open (with its buttons disabled, as a double-click guard) until
  // the call settles, instead of closing optimistically on click - so a rejection's error toast
  // isn't shown behind a dialog that already looks like it worked.
  const unlock = (d: LockableDir) => { void setLocked(d, false).finally(() => setConfirm(null)); };
  const unlocking = confirm !== null && busy === `lock-${confirm}`;

  const requests = [...p.requests]
    .filter((r) => r.status === "pending" || now - Date.parse(requestWhen(r)) <= DECIDED_WINDOW_MS)
    .sort((a, b) => {
      const pendingFirst = Number(b.status === "pending") - Number(a.status === "pending");
      if (pendingFirst) return pendingFirst;
      const at = (r: AccessRequestView) => Date.parse(r.status === "pending" ? r.created_at : requestWhen(r));
      return at(b) - at(a);
    });

  return (
    <div className="privacy">
      <ScreenHead title="Privacy" sub="Locked folders are hidden from Claude Code. You decide when it may look inside." />
      {broken ? <ErrorState title="Privacy settings can't be refreshed" text={errorSentence(error!)} /> : null}
      {p.problems.length ? (
        <ErrorState title="A locked folder isn't where it was" text={p.problems.map(lockProblemText).join(" ")}
          action={broken ? undefined : (
            <div className="row">
              {p.problems.filter((x) => x.found_at).map((x) => (
                <Button key={`back-${x.folder}-${x.found_at}`} variant="primary" loading={busy === `back-${x.folder}`}
                  aria-label={`Move back: ${displayName(x.found_at!)} to ${nameOf(x.folder)}`}
                  onClick={() => void run(`back-${x.folder}`, () => bridge.privacy.moveBack(x.folder), `Moved back to ${nameOf(x.folder)}`)}>
                  Move back
                </Button>
              ))}
              {p.problems.some((x) => x.kind !== "elsewhere") ? (
                <Button variant="ghost" title="Lock the private folders again" onClick={() => setConfirmAccept(true)}>Lock again</Button>
              ) : null}
            </div>
          )} />
      ) : null}
      <Card className="stack" data-tour="privacy-folders">
        <SectionTitle icon={Icons.locked} title="Locked folders" />
        {LOCKABLE_DIRS.map((d) => {
          const locked = p.locked.includes(d);
          const grant = p.grants.find((g) => g.folder === d);
          return (
            <div key={d} className="row row--between">
              <span className="grow">
                <Text role="body" as="div">{FOLDER_NAME[d]}</Text>
                <Text role="body-sm" muted as="div">{FOLDER_TEXT[d]}</Text>
              </span>
              {grant ? <Pill tone="warning">Open once</Pill> : null}
              {broken ? (
                <Pill tone={locked ? "neutral" : "warning"}>{locked ? "Locked" : "Open to Claude"}</Pill>
              ) : (
                <span className="lock-state">
                  <span aria-hidden="true" className="lock-state__icon"><Icon icon={locked ? Icons.locked : Icons.unlocked} size="sm" /></span>
                  <Text role="body-sm" as="span" className="lock-state__text">{locked ? "Locked" : "Open to Claude"}</Text>
                  <button type="button" role="switch" className="switch" aria-checked={locked} aria-label={`Lock ${FOLDER_NAME[d]}`}
                    title={locked ? "Locked. Click to open it to Claude Code." : "Open to Claude Code. Click to lock it."}
                    disabled={busy === `lock-${d}`} onClick={() => (locked ? setConfirm(d) : void setLocked(d, true))} />
                </span>
              )}
            </div>
          );
        })}
      </Card>

      {requests.map((r) => (r.status === "pending" ? <RequestCard key={r.id} r={r} readOnly={broken} /> : <DecidedRequestCard key={r.id} r={r} />))}

      {p.grants.length ? (
        <Card className="stack">
          <SectionTitle icon={Icons.unlocked} title="Open now" />
          {p.grants.map((g) => {
            const minutesLeft = Math.max(0, Math.ceil((Date.parse(g.until) - now) / 60_000));
            return (
              <div key={g.folder} className="row row--between">
                <Text role="body">{nameOf(g.folder)}: open until {fmtTime(g.until)} ({plural(minutesLeft, "minute")} left)</Text>
                {broken ? null : (
                  <Button size="sm" aria-label={`Re-lock ${nameOf(g.folder)} now`} loading={busy === `revoke-${g.folder}`}
                    onClick={() => void run(`revoke-${g.folder}`, () => bridge.privacy.revoke(g.folder), `${nameOf(g.folder)} locked again`)}>
                    Re-lock now
                  </Button>
                )}
              </div>
            );
          })}
        </Card>
      ) : null}

      {p.activity.length === 0 ? (
        <EmptyState text="Activity: nothing yet. Every lock, unlock and request will show here." />
      ) : (
      <Card className="stack" data-tour="privacy-activity">
        <SectionTitle icon={Icons.activity} title="Activity" />
        {(
          <ul className="list-plain timeline" aria-label="Activity">
            {p.activity.map((a, i) => (
              <li key={`${a.at}-${i}`}>
                <Text role="body-sm" muted>{fmtDateTime(a.at)}</Text>
                <span>
                  <Text role="body" as="div" truncate>{displayName(a.event)}</Text>
                  {a.detail ? <Text role="body-sm" muted as="div" truncate>{displayName(a.detail)}</Text> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      )}

      <Dialog open={confirmAccept} onClose={() => { if (busy !== "accept-folders") setConfirmAccept(false); }} title="Lock the private folders again?"
        actions={<>
          <Button variant="ghost" disabled={busy === "accept-folders"} onClick={() => setConfirmAccept(false)}>Cancel</Button>
          <Button variant="primary" loading={busy === "accept-folders"}
            onClick={() => { void run("accept-folders", () => bridge.privacy.acceptFolders(), "Locked folders are set").finally(() => setConfirmAccept(false)); }}>
            Lock them
          </Button>
        </>}>
        <Text role="body">{acceptConfirmText(p.problems)}</Text>
      </Dialog>

      <Dialog open={confirm !== null} onClose={() => { if (!unlocking) setConfirm(null); }} title={`Unlock ${confirm ? nameOf(confirm).toLowerCase() : ""}?`}
        actions={<>
          <Button variant="ghost" disabled={unlocking} onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant="danger" loading={unlocking} onClick={() => { if (confirm) unlock(confirm); }}>Unlock</Button>
        </>}>
        <Text role="body">{confirm ? `${FOLDER_TEXT[confirm]} Claude Code will be able to read all of it until you lock it again.` : ""}</Text>
      </Dialog>
    </div>
  );
}

/** A decided or expired request within its 24-hour window: history only, no controls. */
function DecidedRequestCard({ r }: { r: AccessRequestView }) {
  const who = r.who === "claude" ? "Claude" : displayName(r.who);
  const pill = finalPill(r);
  return (
    <Card aria-label="Past request" className="stack">
      <div className="row row--between">
        <Text role="label" as="div" truncate className="grow">{`${who} asked to read ${folderName(r.folder)}`}</Text>
        <Pill tone={pill.tone}>{pill.text}</Pill>
      </div>
      <Text role="body" truncate>{displayName(r.why)}</Text>
      {r.field ? <Text role="body-sm" muted truncate>{`Only needed: ${fieldLabel(r.field)}`}</Text> : null}
    </Card>
  );
}

function RequestCard({ r, readOnly }: { r: AccessRequestView; readOnly: boolean }) {
  const bridge = useBridge();
  const toast = useToast();
  const { busy, run } = useAction();
  const [minutes, setMinutes] = useState(ALLOW_MINUTES.includes(r.minutes) ? r.minutes : 15);
  const who = r.who === "claude" ? "Claude" : displayName(r.who);

  // The success toast depends on what actually happened: `allow` only opens a time-boxed
  // grant when the folder was locked. A folder that was already unlocked needs no grant, so
  // the usual "open for N minutes" message would be misleading - say plainly that no time
  // limit applies instead. `run`'s own `ok` message is static, so this toasts manually.
  const allow = () => run("allow", async () => {
    const state = await bridge.privacy.allow(r.id, minutes);
    const opened = state.grants.some((g) => g.folder === r.folder);
    toast({ text: opened ? `${nameOf(r.folder)}: open for ${minutesText(minutes)}` : "Already unlocked; no time limit applies", tone: "success" });
    return state;
  });

  return (
    <Card highlight aria-label="Access request" className="stack">
      <Text role="label" as="div" truncate>{`${who} asks to read ${folderName(r.folder)}`}</Text>
      <Text role="body" truncate>{displayName(r.why)}</Text>
      {r.field ? <Text role="body-sm" muted truncate>{`Only needs: ${fieldLabel(r.field)}`}</Text> : null}
      {readOnly ? null : (
        <div className="row request-actions">
          <Select label="Time limit" value={String(minutes)} onChange={(e) => setMinutes(Number(e.target.value))}
            options={ALLOW_MINUTES.map((m) => ({ value: String(m), label: minutesText(m) }))} />
          <Button variant="primary" loading={busy === "allow"} onClick={() => void allow()}>{`Allow for ${minutesText(minutes)}`}</Button>
          <Button variant="ghost" loading={busy === "deny"} onClick={() => void run("deny", () => bridge.privacy.deny(r.id), "Request denied")}>Deny</Button>
        </div>
      )}
    </Card>
  );
}
