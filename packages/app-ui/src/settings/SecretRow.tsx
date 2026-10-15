import { useId, useRef, useState } from "react";
import { Button, Dialog, Icon, Icons, PRODUCT_NAME, Pill, Text, useToast } from "@careeros/brand";
import type { SecretName, SecretStatus } from "@careeros/contract";
import { errorText, useAction, useBridge } from "../bridge-context";
import { isKeychainDenied } from "./keychain";

/** Remembers, once per install, that the person has already seen the Keychain pre-prompt note below. */
const KEYCHAIN_NOTICE_KEY = "careeros.secrets.keychainNoticeSeen";
function keychainNoticeSeen(): boolean {
  try { return localStorage.getItem(KEYCHAIN_NOTICE_KEY) === "1"; } catch { return false; }
}
function markKeychainNoticeSeen(): void {
  try { localStorage.setItem(KEYCHAIN_NOTICE_KEY, "1"); } catch { /* private mode: show it again next time, harmless */ }
}



/** What each secret is called, where to get one, and a one-line note. Data-driven: a secret another branch removes just disappears. */
export const SECRET_INFO: Partial<Record<string, { label: string; url: string; note: string }>> = {
  anthropic_api_key: { label: "Anthropic API key", url: "https://console.anthropic.com/settings/keys", note: "Only needed if you pay Anthropic per use instead of using a Claude plan." },
  gmail_app_password: { label: "Gmail app password", url: "https://myaccount.google.com/apppasswords", note: "A 16-letter password Google makes for one app. Your normal password isn't used." },
};
export const secretLabel = (n: string) => SECRET_INFO[n]?.label ?? n.replaceAll("_", " ");
/** The anchor a link can scroll to: settings?…&section=anthropic-api-key. */
export const secretSection = (n: string) => n.replaceAll("_", "-");

/**
 * One secret: its name with a small status pill, then either the saved state ("Saved · Replace · Remove") or a
 * password field with show/hide and Save on one line. Save stays disabled until something is typed, and says so.
 */
export function SecretRow({ status, broken, onChanged, platform }: { status: SecretStatus; broken: boolean; onChanged: () => void; platform?: string }) {
  const bridge = useBridge();
  const toast = useToast();
  const { busy, run } = useAction();
  const n = status.name;
  const label = secretLabel(n);
  const info = SECRET_INFO[n];
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [keychainError, setKeychainError] = useState<string | null>(null);
  const inputId = useId();
  const whyId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const editing = !status.set || replacing;
  // Every settings tab mounts at once (including hidden ones), so this row can exist unseen - reading
  // localStorage at mount only decides whether this row is still eligible to show the note; it doesn't mark
  // it seen. Only an actual Save (below) does that, since that's the real first operation that may prompt.
  const [noticeSeen, setNoticeSeen] = useState(() => keychainNoticeSeen());
  // Macos only: other platforms' equivalents (DPAPI, libsecret) don't show this kind of interactive prompt.
  const showKeychainNotice = editing && platform === "darwin" && !noticeSeen;

  const save = () => run(`secret-${n}`, async () => {
    // This is the actual first operation that may trigger the OS prompt, so the note - if this row showed
    // it - counts as seen right here, not just from mounting (this row may be mounted unseen, hidden behind
    // another open tab).
    if (showKeychainNotice) { markKeychainNoticeSeen(); setNoticeSeen(true); }
    // The typed value never stays in state once the call settles, whether it worked or not: a graceful Deny
    // means trying again with a freshly pasted value, not reusing one that may already have gone stale.
    try {
      await bridge.secrets.set(n as SecretName, value);
      onChanged(); setReplacing(false); setKeychainError(null);
    } catch (e) {
      const message = errorText(e);
      setKeychainError(isKeychainDenied(message) ? message : null);
      throw e;
    } finally {
      setValue(""); setShow(false);
    }
  }, `${label} saved`);
  const remove = () => run(`remove-${n}`, async () => {
    try { await bridge.secrets.remove(n as SecretName); onChanged(); } finally { setConfirming(false); }
  }, `${label} removed`);
  const openHelp = () => info && void bridge.links.open(info.url).catch((e: unknown) => toast({ tone: "danger", text: errorText(e) }));

  return (
    <div className="secret" id={`settings-${secretSection(n)}`} data-section={secretSection(n)}>
      <div className="secret__head">
        <label htmlFor={inputId} className="secret__label">{label}</label>
        <Pill tone={status.set ? "success" : "neutral"}>{status.set ? "Saved" : "Not set"}</Pill>
      </div>
      {info ? <Text role="body-sm" muted className="secret__note">{info.note}</Text> : null}
      {broken ? null : editing ? (
        <>
          {showKeychainNotice ? (
            <Text role="body-sm" muted className="secret__keychain-notice">
              Your Mac may ask for your login password so {PRODUCT_NAME} can keep this safe in the Keychain. Choose Always Allow.
            </Text>
          ) : null}
          <form className="secret__row" onSubmit={(e) => { e.preventDefault(); if (value) void save(); }}>
            <span className="secret__field">
              <input ref={inputRef} id={inputId} className="input secret__input" type={show ? "text" : "password"} autoComplete="off" spellCheck={false}
                value={value} placeholder={status.set ? "Paste the new one" : "Paste it here"} onChange={(e) => { setValue(e.target.value); setKeychainError(null); }} />
              <button type="button" className="secret__eye" aria-label={show ? `Hide ${label}` : `Show ${label}`} aria-pressed={show} onClick={() => setShow((s) => !s)}>
                <Icon icon={show ? Icons.hide : Icons.show} size="sm" />
              </button>
            </span>
            <Button type="submit" aria-label={`Save ${label}`} loading={busy === `secret-${n}`} disabled={!value} aria-describedby={value ? undefined : whyId}
              title={value ? undefined : `Paste the ${label} first`}>Save</Button>
            {replacing ? <Button variant="ghost" onClick={() => { setReplacing(false); setValue(""); setKeychainError(null); }}>Cancel</Button> : null}
            <span id={whyId} className="sr-only">Paste the {label} first.</span>
          </form>
          {keychainError ? (
            <div className="secret__keychain-error" role="alert">
              <Text role="body-sm">{keychainError}</Text>
              <Button size="sm" variant="secondary" onClick={() => { setKeychainError(null); inputRef.current?.focus(); }}>Try again</Button>
            </div>
          ) : null}
        </>
      ) : (
        <div className="secret__row secret__row--saved">
          <Text role="body-sm" muted>Saved in this computer's secure storage. It's never shown again.</Text>
          <Button size="sm" variant="secondary" aria-label={`Replace ${label}`} onClick={() => setReplacing(true)}>Replace</Button>
          <Button size="sm" variant="ghost" aria-label={`Remove ${label}`} loading={busy === `remove-${n}`} onClick={() => setConfirming(true)}>Remove</Button>
        </div>
      )}
      {info && editing ? (
        <button type="button" className="text-link secret__help" title="Where do I get this?" onClick={openHelp}>
          Get one<Icon icon={Icons.openExternal} size="sm" />
        </button>
      ) : null}
      <Dialog open={confirming} onClose={() => setConfirming(false)} title={`Remove the ${label}?`}
        actions={<>
          <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
          <Button variant="danger" loading={busy === `remove-${n}`} onClick={() => void remove()}>Remove</Button>
        </>}>
        <Text role="body">This takes it out of secure storage. You can add it again later.</Text>
      </Dialog>
    </div>
  );
}
