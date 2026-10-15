import { useId, useRef, useState } from "react";
import { Button, Card, Dialog, Icons, Input, Pill, PRODUCT_NAME, Select, Text, Textarea, useToast } from "@careeros/brand";
import type { MailStatus, MailTestResult } from "@careeros/contract";
import { errorText, useAction, useBridge, useLoad } from "../bridge-context";
import { fmtDateTime, plural } from "../format";
import { errorSentence } from "./ErrorBanner";
import { Loading } from "./States";
import { isKeychainDenied } from "../settings/keychain";
import { RecheckButton } from "../mail/Recheck";

export const GOOGLE_LINKS = {
  twoStep: "https://myaccount.google.com/signinoptions/twosv",
  appPasswords: "https://myaccount.google.com/apppasswords",
  imap: "https://mail.google.com/mail/u/0/#settings/fwdandpop",
} as const;

/** Background sync choices. The services and the contract accept any whole number from 15 to 1440. */
const MINUTES = [15, 30, 60, 120, 240, 720, 1440];
const everyLabel = (m: number) => (m < 60 ? `Every ${m} minutes` : m === 60 ? "Every hour" : m % 60 === 0 ? `Every ${m / 60} hours` : `Every ${m} minutes`);

const BAD_PASSWORD = "An app password is 16 letters. Copy it again from Google's App Passwords page.";
/**
 * The same rule as the services' normalizePassword: four groups of four letters, with one space
 * (or none) between groups, as Google shows it. Checked here too so a normal Google password is
 * refused before anything is sent to Gmail.
 */
const looksLikeAppPassword = (p: string) => /^[A-Za-z]{4}(?:[ \u00a0]?[A-Za-z]{4}){3}$/.test(p.trim());


export function formatWhen(iso: string, now = new Date()): string {
  if (!iso) return "never";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "never";
  const mins = Math.round((now.getTime() - t.getTime()) / 60_000);
  if (mins >= 0 && mins < 1) return "just now";
  if (mins >= 1 && mins < 60) return `${mins} min ago`;
  if (mins < 0 && mins > -60) return `in ${-mins} min`;
  // Same words as every other date in the app: "12 Jan 2026, 9:00 pm".
  return fmtDateTime(iso);
}

/** Opens a Google help page in the system browser through links.open (https only, behind the shell's confirm). */
function useOpenLink() {
  const bridge = useBridge();
  const toast = useToast();
  return (url: string) => void bridge.links.open(url).catch((e: unknown) => toast({ tone: "danger", text: `Couldn't open the link: ${errorText(e)}` }));
}

/** A one-line reason shown under a disabled control, tied to it with aria-describedby. */
function Why({ id, children }: { id: string; children: string }) {
  return <Text role="body-sm" muted id={id} className="mail-why">{children}</Text>;
}

function Wizard({ onSaved }: { onSaved: () => void }) {
  const bridge = useBridge();
  const open = useOpenLink();
  const toast = useToast();
  const { busy, run } = useAction();
  const whyId = useId();
  const passwordRef = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<MailTestResult | null>(null);
  const [tested, setTested] = useState("");
  const [problem, setProblem] = useState("");
  const [keychainError, setKeychainError] = useState("");

  const test = async () => {
    if (testing) return;
    setProblem("");
    setKeychainError("");
    setResult(null);
    setTested("");
    // The renderer holds the password for this one call only: the field clears now, pass or fail.
    const pw = password;
    setPassword("");
    if (!looksLikeAppPassword(pw)) { setProblem(BAD_PASSWORD); return; }
    setTesting(true);
    try {
      const r = await bridge.mail.testConnection(address.trim(), name.trim(), pw);
      setResult(r);
      setTested(r.ok ? address.trim() : "");
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setTesting(false);
    }
  };
  const save = () => run("save", async () => {
    try {
      await bridge.mail.saveAccount(tested, name.trim());
    } catch (e) {
      const message = errorText(e);
      if (!isKeychainDenied(message)) throw e;
      // The Mac said no to the Keychain. The tested password is gone from main, so the next try starts with a fresh paste and test.
      setKeychainError(message); setResult(null); setTested("");
      return;
    }
    setKeychainError("");
    onSaved();
    toast({ tone: "success", text: "Gmail connected" });
  });
  const canSave = !!result?.ok && tested !== "" && tested === address.trim();
  const why = !address.trim() && !password ? "Enter your Gmail address and app password to test."
    : !address.trim() ? "Enter your Gmail address to test."
    : !password ? (result ? "Paste the app password again to test again." : "Paste the app password to test.")
    : "";

  return (
    <div className="stack">
      <Text role="body" muted>
        Connect Gmail so {PRODUCT_NAME} can file job emails under the right job and send the emails you approve. It takes about two minutes.
      </Text>
      <ol className="wizard-steps">
        <li><div className="wizard-step">
          <Text role="label">Turn on 2-Step Verification</Text>
          <Text role="body-sm" muted>Google only offers app passwords once this is on.</Text>
          <Button variant="ghost" size="sm" icon={Icons.openExternal} title="Open Google's 2-Step Verification page" onClick={() => open(GOOGLE_LINKS.twoStep)}>2-Step Verification</Button>
        </div></li>
        <li><div className="wizard-step">
          <Text role="label">Create an app password</Text>
          <Text role="body-sm" muted>Name it {PRODUCT_NAME}. Google shows 16 letters once, so copy them.</Text>
          <Button variant="ghost" size="sm" icon={Icons.openExternal} title="Open Google's App Passwords page" onClick={() => open(GOOGLE_LINKS.appPasswords)}>App passwords</Button>
        </div></li>
        <li><div className="wizard-step">
          <Text role="label">Check that IMAP is on</Text>
          <Text role="body-sm" muted>In Gmail's settings, under Forwarding and POP/IMAP.</Text>
          <Button variant="ghost" size="sm" icon={Icons.openExternal} title="Open Gmail's IMAP settings" onClick={() => open(GOOGLE_LINKS.imap)}>IMAP settings</Button>
        </div></li>
        <li><div className="wizard-step">
          <Text role="label">Enter your details and test</Text>
          <form className="stack mail-form" onSubmit={(e) => { e.preventDefault(); void test(); }}>
            <Input label="Gmail address" type="email" autoComplete="off" spellCheck={false} value={address}
              onChange={(e) => { setAddress(e.target.value); setResult(null); setTested(""); }} />
            <Input label="Your name, as people will see it" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)}
              help="Shown next to your address on emails you send." />
            <Input ref={passwordRef} label="App password (16 letters)" type="password" autoComplete="off" spellCheck={false} value={password} onChange={(e) => setPassword(e.target.value)}
              help={`Paste it as Google shows it. Spaces are fine. ${PRODUCT_NAME} keeps it in this computer's secure storage and never shows it again.`} />
            {problem ? <p role="alert" className="field__error">{problem}</p> : null}
            <div className="row">
              <Button type="submit" variant={canSave ? "secondary" : "primary"} loading={testing} disabled={!!why}
                aria-describedby={why ? whyId : undefined}>Test connection</Button>
              {canSave ? <Button variant="primary" loading={busy === "save"} onClick={() => void save()}>Save &amp; connect</Button> : null}
            </div>
            {why ? <Why id={whyId}>{why}</Why> : null}
          </form>
          {keychainError ? (
            <div className="secret__keychain-error" role="alert">
              <Text role="body-sm">{keychainError} Paste the app password again and test, then save.</Text>
              <Button size="sm" variant="secondary" onClick={() => { setKeychainError(""); passwordRef.current?.focus(); }}>Try again</Button>
            </div>
          ) : null}
        </div></li>
      </ol>
      {result ? (
        <div className="stack mail-result">
          <p role="status" className={result.ok ? "mail-result__ok" : "mail-result__bad"}>
            {result.ok
              ? "Gmail accepted the address and app password. Save to finish."
              : "The test didn't pass. Follow the fix below, then paste the app password again and test."}
          </p>
          <ul className="list-plain" aria-label="Connection test">
            {result.checks.map((c) => (
              <li key={c.id} className="check-line">
                <Pill tone={c.ok ? "success" : "danger"}>{c.ok ? "Passed" : "Failed"}</Pill>
                <div>
                  <Text role="label">{c.label}</Text>
                  <Text role="body-sm">{c.message}</Text>
                  {c.fix ? <Text role="body-sm" muted>{c.fix}</Text> : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function BackgroundSync() {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const labelId = useId();
  const whyId = useId();
  const bg = useLoad((b) => b.mail.background.status(), [], ["mail"]);
  if (bg.error && !bg.data) return <Text role="body-sm" className="field__error">Background sync status can't be shown: {errorSentence(bg.error)}.</Text>;
  if (!bg.data) return <Loading />;
  const d = bg.data;
  const set = (on: boolean, minutes: number) => run("background", async () => { await bridge.mail.background.set(on, minutes); bg.reload(); });
  const options = (MINUTES.includes(d.minutes) ? MINUTES : [...MINUTES, d.minutes].sort((a, b) => a - b)).map((m) => ({ value: String(m), label: everyLabel(m) }));
  return (
    <div className="stack">
      <div className="row">
        <button type="button" role="switch" className="switch switch--plain" aria-checked={d.on} aria-labelledby={labelId}
          aria-describedby={!d.supported ? whyId : undefined} disabled={!d.supported || busy === "background"} onClick={() => void set(!d.on, d.minutes)} />
        <div className="grow">
          <Text role="label" id={labelId}>Sync in the background</Text>
          <Text role="body-sm" muted>Checks Gmail even when {PRODUCT_NAME} is closed.</Text>
        </div>
        <div className="mail-every">
          <Select label="How often" hideLabel value={String(d.minutes)} disabled={!d.supported || busy === "background"}
            aria-describedby={!d.supported ? whyId : undefined} onChange={(e) => void set(d.on, Number(e.target.value))} options={options} />
        </div>
      </div>
      <Text role="body-sm" muted id={!d.supported ? whyId : undefined}>{d.detail}</Text>
      {d.log.length ? (
        <details className="mail-log">
          <summary>Background runs</summary>
          <pre className="mail-preview" aria-label="Background sync log">{d.log.join("\n")}</pre>
        </details>
      ) : null}
    </div>
  );
}

function Connected({ status, reload }: { status: MailStatus; reload: () => void }) {
  const bridge = useBridge();
  const open = useOpenLink();
  const { busy, run } = useAction();
  const replaceWhy = useId();
  const sigWhy = useId();
  const syncWhy = useId();
  const [signature, setSignature] = useState(status.signature);
  const [replacement, setReplacement] = useState("");
  const [replaceProblem, setReplaceProblem] = useState("");
  const [confirm, setConfirm] = useState(false);

  const replace = () => {
    // Like the wizard: the field clears at once, and a normal password never leaves the renderer.
    const v = replacement;
    setReplacement("");
    setReplaceProblem("");
    if (!looksLikeAppPassword(v)) { setReplaceProblem(BAD_PASSWORD); return; }
    void run("replace", async () => {
      try { await bridge.secrets.set("gmail_app_password", v); reload(); }
      catch (e) { setReplaceProblem(errorText(e)); throw e; }
    }, "App password replaced");
  };
  const disconnect = () => run("disconnect", async () => {
    // The dialog stays open (its button busy) until the call settles, so a failure isn't shown behind a dialog that looks done.
    try { await bridge.mail.disconnect(); reload(); } finally { setConfirm(false); }
  }, "Gmail disconnected");
  const saveSignature = () => run("signature", async () => { await bridge.mail.setSignature(signature); reload(); }, "Signature saved");
  const sync = () => run("sync", async () => { await bridge.mail.syncNow(); reload(); }, "Mail synced");

  const sigChanged = signature.replace(/\s+$/, "") !== status.signature.replace(/\s+$/, "");
  const { stored, triaged } = status.counts;
  const lastLine = status.last_sync
    ? `Last sync ${formatWhen(status.last_sync)}${status.last_error ? "." : `: ${plural(stored, "email")} filed under jobs, ${plural(triaged, "email")} to sort.`}`
    : "Not synced yet.";

  return (
    <div className="stack">
      <div className="row row--between row--top mail-head">
        <div className="stack-tight">
          <div className="row">
            {status.last_error ? <Pill tone="warning">Needs attention</Pill> : null}
            <Text role="label">Connected as {status.address}</Text>
          </div>
          <Text role="body-sm" muted>{lastLine}{status.next_sync && !status.syncing ? ` Next sync ${formatWhen(status.next_sync)}.` : ""}</Text>
        </div>
        <div className="row">
          <Button icon={Icons.redo} loading={busy === "sync" || status.syncing} aria-describedby={status.syncing ? syncWhy : undefined} onClick={() => void sync()}>Sync now</Button>
          <Button variant="ghost" onClick={() => setConfirm(true)}>Disconnect</Button>
        </div>
      </div>
      {status.syncing ? <Why id={syncWhy}>A sync is running now.</Why> : null}
      {status.last_error ? <p role="alert" className="field__error">The last sync failed: {status.last_error}</p> : null}
      {status.cloud_folder ? (
        <Text role="body-sm" muted>Your {PRODUCT_NAME} folder is in {status.cloud_folder}. Saved emails and attachments sync there too, so keep that account private.</Text>
      ) : null}

      <div className="mail-section stack">
        <Text role="label" as="h3">App password</Text>
        <div className="row row--top">
          <div className="grow">
            <Input label="Replace the app password" type="password" autoComplete="off" spellCheck={false} value={replacement}
              onChange={(e) => { setReplacement(e.target.value); setReplaceProblem(""); }}
              error={replaceProblem || undefined}
              help={`${PRODUCT_NAME} tests the new password first and keeps the old one if it fails.`} />
          </div>
          <Button className="mail-inline-btn" disabled={!replacement} loading={busy === "replace"} aria-describedby={!replacement ? replaceWhy : undefined}
            onClick={replace}>Replace password</Button>
        </div>
        {!replacement ? <Why id={replaceWhy}>Paste a new app password to replace the current one.</Why> : null}
      </div>

      <div className="mail-section stack">
        <Text role="label" as="h3">Signature</Text>
        <div className="split">
          <Textarea label="Signature" hideLabel rows={4} value={signature} onChange={(e) => setSignature(e.target.value)}
            help={`Added to the end of every email you send from ${PRODUCT_NAME}.`} />
          <div className="field">
            <span className="field__label sr-only">Preview</span>
            <pre className="mail-preview" aria-label="Signature preview">{`Hi,\n\n…\n\n${signature.trim()}`}</pre>
          </div>
        </div>
        <div className="row">
          <Button disabled={!sigChanged} loading={busy === "signature"} aria-describedby={!sigChanged ? sigWhy : undefined} onClick={() => void saveSignature()}>Save signature</Button>
          {!sigChanged ? <Why id={sigWhy}>No changes to save.</Why> : null}
        </div>
      </div>

      <div className="mail-section stack">
        <Text role="label" as="h3">Background sync</Text>
        <BackgroundSync />
      </div>

      <div className="mail-section stack">
        <Text role="label" as="h3">Filed mail</Text>
        <Text role="body-sm" muted>Checks the mail {PRODUCT_NAME} filed earlier against today's matching rules. You see what would move before anything does. Mail you filed yourself isn't changed.</Text>
        <RecheckButton />
      </div>

      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Disconnect Gmail?"
        actions={<><Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button><Button variant="danger" loading={busy === "disconnect"} onClick={() => void disconnect()}>Disconnect Gmail</Button></>}>
        <div className="stack">
          <Text role="body">{PRODUCT_NAME} removes the app password from this computer and stops syncing. Emails already saved stay where they are.</Text>
          <Text role="body-sm" muted>To cut access completely, also delete the app password on Google's App Passwords page.</Text>
          <div><Button variant="ghost" size="sm" icon={Icons.openExternal} title="Open Google's App Passwords page" onClick={() => open(GOOGLE_LINKS.appPasswords)}>App passwords</Button></div>
        </div>
      </Dialog>
    </div>
  );
}

/**
 * The Gmail wizard (not connected) or the connected view with Disconnect. `embedded`: inside Settings > Connections'
 * Email row, which already has the heading and the region, so this renders only its content.
 */
export function MailSetup({ embedded = false }: { embedded?: boolean }) {
  const status = useLoad((b) => b.mail.status(), [], ["mail", "settings"]);
  const s = status.data;
  const body = (
    <>
      {status.error && !s ? (
        <p role="alert" className="field__error">Email settings can't be shown: {errorSentence(status.error)}.</p>
      ) : !s ? <Loading /> : !s.secure_storage ? (
        // The one message for the whole Connections tab: the Secrets card hides itself in this case.
        <Text role="body">Secure storage isn't available on this computer, so Gmail can't be connected and keys can't be saved. {PRODUCT_NAME} never keeps a password or key in a plain file.</Text>
      ) : !s.available ? (
        <Text role="body" muted>Email isn't available in this version of the app.</Text>
      ) : s.connected ? <Connected status={s} reload={status.reload} /> : <Wizard onSaved={status.reload} />}
    </>
  );
  if (embedded) return <div className="stack conn__pane">{body}</div>;
  return (
    <Card className="stack" aria-label="Email">
      <Text role="heading-2">Email</Text>
      {body}
    </Card>
  );
}
