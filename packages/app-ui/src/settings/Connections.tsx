import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button, Icon, Icons, Pill, ServiceMarks, Text, type IconGlyph, type PillTone } from "@careeros/brand";
import { SECRET_NAMES, type SecretStatus } from "@careeros/contract";
import { useAction, useBridge, useLoad } from "../bridge-context";
import { ClaudeSetup, useClaudeEngine } from "../claude";
import { ClaudeProjectSettings } from "../claude/ClaudeWorkspace";
import { ChromeSearchSettings, useChromeSearch } from "../chrome";
import { errorSentence } from "../components/ErrorBanner";
import { ErrorState } from "../components/States";
import { CONNECTIONS, type ConnectionId } from "../router";
import { initialConnection, rememberConnection, rememberedConnection } from "./connection-state";
import { SecretRow } from "./SecretRow";
import { LinkedInImport } from "../outreach/LinkedInImport";
import { formatWhen, MailSetup } from "../components/MailSetup";

/** Which connection each secret belongs to. A secret not listed here (or removed by another branch) is skipped. */
export const SECRET_HOME: Partial<Record<string, ConnectionId>> = { anthropic_api_key: "claude", gmail_app_password: "email" };

interface Summary { tone: PillTone; pill: string; line: string; needsSetup: boolean; action?: ReactNode }

/** The secrets that live in one connection, with their rows. */
function Secrets({ id, statuses, broken, reload, platform }: { id: ConnectionId; statuses: SecretStatus[]; broken: boolean; reload: () => void; platform?: string }) {
  const mine = statuses.filter((s) => SECRET_HOME[s.name] === id);
  if (!mine.length) return null;
  if (!mine[0]!.available) return <Text role="body-sm" muted>Secure storage isn't available on this computer, so secrets can't be saved here.</Text>;
  return <div className="conn__secrets">{mine.map((s) => <SecretRow key={s.name} status={s} broken={broken} onChanged={reload} platform={platform} />)}</div>;
}

/**
 * Email (Gmail): the mail wizard (test first, then save) or the connected view with Disconnect. The Gmail app
 * password is set, replaced and removed only here, never through a generic secret row.
 */
export function EmailConnection() {
  return <MailSetup embedded />;
}

/** Search in my Chrome: the Chrome lane's setup (boards, remote control, sign-ins). */
export function ChromeConnection() {
  return <div className="conn__pane conn__pane--chrome"><ChromeSearchSettings /></div>;
}

/**
 * Claude: one way of paying at a time. Signed in with a Claude plan, the API key stays folded away behind "Use an
 * API key instead"; with a key saved, runs bill that key (the engine passes it to Claude Code), so the key row shows
 * with "Switch back to my Claude plan". Either way the other option is one click.
 */
function ClaudeConnection({ secrets, ready, keySet, onSwitchToPlan, switching }: {
  secrets: ReactNode; ready: boolean;
  /** An Anthropic API key is saved for this workspace. */
  keySet: boolean; onSwitchToPlan: () => void; switching: boolean;
}) {
  const [details, setDetails] = useState(false);
  const [useKey, setUseKey] = useState(false);
  const id = useId();
  const keyId = useId();
  return (
    <div className="conn__pane">
      {ready ? (
        <>
          <Text role="body-sm" muted as="p">{keySet ? "Using your API key: Anthropic bills each run to it." : "Using your Claude plan. You're signed in, so there's nothing else to set up."}</Text>
          <button type="button" className="disclosure" aria-expanded={details} aria-controls={id} onClick={() => setDetails((d) => !d)}>
            <Icon icon={details ? Icons.collapse : Icons.expand} size="sm" />{details ? "Hide details" : "Show details"}
          </button>
          <div id={id} hidden={!details}><ClaudeSetup variant="settings" /></div>
        </>
      ) : <ClaudeSetup variant="settings" />}
      <ClaudeProjectSettings />
      {keySet ? (
        <>
          {secrets}
          <div className="csetup__row">
            <Button size="sm" variant="ghost" loading={switching} aria-label="Switch back to my Claude plan" onClick={onSwitchToPlan}>Claude plan</Button>
          </div>
        </>
      ) : (
        <>
          <button type="button" className="disclosure" aria-label={useKey ? "Hide the API key" : "Use an API key instead"} aria-expanded={useKey} aria-controls={keyId} onClick={() => setUseKey((u) => !u)}>
            <Icon icon={useKey ? Icons.collapse : Icons.expand} size="sm" />{useKey ? "Hide key" : "API key"}
          </button>
          <div id={keyId} hidden={!useKey}>
            <Text role="body-sm" muted as="p">Only if you pay Anthropic per use. While a key is saved, runs bill the key instead of your Claude plan.</Text>
            {secrets}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ id, icon, name, summary, open, onToggle, children }: { id: ConnectionId; icon: IconGlyph; name: string; summary: Summary; open: boolean; onToggle: () => void; children: ReactNode }) {
  const panelId = `conn-${id}-panel`;
  const ref = useRef<HTMLDivElement>(null);
  return (
    <section className={`conn${open ? " is-open" : ""}`} id={`settings-conn-${id}`} data-section={id} aria-labelledby={`conn-${id}-head`} ref={ref}>
      <div className="conn__bar">
        <h3 className="conn__h">
          <button type="button" id={`conn-${id}-head`} className="conn__head" aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
            <span className="conn__icon" aria-hidden="true"><Icon icon={icon} /></span>
            <span className="conn__text">
              <span className="conn__name">{name}</span>
              <span className="conn__line">{summary.line}</span>
            </span>
            <span className="conn__chev" aria-hidden="true"><Icon icon={Icons.expand} size="sm" /></span>
          </button>
        </h3>
        {/* A fixed-width end column, so the chevrons and status pills line up from one service to the next. */}
        <span className="conn__end">
          <span className="conn__pill"><Pill tone={summary.tone}>{summary.pill}</Pill></span>
          {summary.action ? <span className="conn__action">{summary.action}</span> : null}
        </span>
      </div>
      <div className="conn__panel" id={panelId} role="region" aria-labelledby={`conn-${id}-head`} inert={!open} aria-hidden={!open}>
        <div className="conn__inner">{children}</div>
      </div>
    </section>
  );
}

/**
 * Settings > Connections: one row per service (Claude, Email, Search in my Chrome). Collapsed rows show the logo,
 * status and the main action, so the common task needs no scrolling; one row opens at a time. A service that
 * needs setup starts open. Deep links (settings?tab=connections&c=email) open and scroll to their row.
 */
export function Connections({ asked, section }: { asked?: ConnectionId; section?: string }) {
  const bridge = useBridge();
  const engine = useClaudeEngine();
  const { busy, run } = useAction();
  const secrets = useLoad((b) => Promise.all(SECRET_NAMES.map((n) => b.secrets.status(n))), [], []);
  const info = useLoad((b) => b.app.info(), [], []);
  const platform = info.data?.platform;
  const e = engine.data;
  const claudeReady = !!e?.ready;
  const [open, setOpen] = useState<ConnectionId | null>(() => initialConnection({ asked, remembered: rememberedConnection(), needsSetup: [] }));
  // Once the engine is known: a Claude that needs setup starts open (unless a link asked for another row, or the
  // person already opened or closed a row while the check ran: a slow check must not take over their choice).
  const chose = useRef(false);
  const settled = useRef(false);
  useEffect(() => {
    if (settled.current || !e) return;
    settled.current = true;
    if (!asked && !chose.current && !e.ready) setOpen("claude");
  }, [e, asked]);
  useEffect(() => { if (asked) setOpen(asked); }, [asked]);
  useEffect(() => { rememberConnection(open); }, [open]);
  useEffect(() => {
    const target = section ? document.getElementById(`settings-${section}`) : asked ? document.getElementById(`settings-conn-${asked}`) : null;
    if (!target) return undefined;
    target.scrollIntoView?.({ block: "center", behavior: "smooth" });
    target.classList.add("is-flash");
    const t = setTimeout(() => target.classList.remove("is-flash"), 1700);
    return () => clearTimeout(t);
  }, [asked, section, secrets.data]);

  const statuses = secrets.data ?? [];
  const broken = !!secrets.error;
  const choose = (id: ConnectionId) => { chose.current = true; setOpen(id); };
  const toggle = (id: ConnectionId) => { chose.current = true; setOpen((o) => (o === id ? null : id)); };
  const recheck = () => run("recheck", async () => { await bridge.claude.engine(true); engine.reload(); });
  const keySet = statuses.some((x) => x.name === "anthropic_api_key" && x.set);
  // Saving or removing the key changes how Claude Code signs in, so Claude's state is checked again.
  const keyChanged = () => { secrets.reload(); void bridge.claude.engine(true).then(() => engine.reload(), () => engine.reload()); };
  const switchToPlan = () => run("plan", async () => { await bridge.secrets.remove("anthropic_api_key"); keyChanged(); }, "Switched back to your Claude plan.");
  const mail = useLoad((b) => b.mail.status(), [], ["mail", "settings"]);
  const m = mail.data;
  const chrome = useChromeSearch();
  const chromeOn = !!chrome.data?.settings.enabled;
  const chromeOff = !chromeOn && (!!chrome.data?.offer_turn_on || !!chrome.data?.settings.set_up_at);

  const summaries: Record<ConnectionId, Summary> = {
    claude: !e ? { tone: "neutral", pill: engine.error ? "Can't check" : "Checking", line: engine.error ? "Claude's setup can't be checked right now." : "Checking Claude Code…", needsSetup: false }
      : e.ready ? { tone: "success", pill: "Ready", line: `Claude Code ${e.cli.version} · ${keySet ? "your API key, billed per use" : "your Claude plan"} · runs on this computer`, needsSetup: false,
        action: <Button size="sm" variant="ghost" loading={busy === "recheck"} onClick={() => void recheck()}>Check again</Button> }
      : { tone: "warning", pill: "Set up needed", line: "Claude Code runs the work for you. Set it up once.", needsSetup: true,
        action: open === "claude" ? undefined : <Button size="sm" variant="primary" onClick={() => choose("claude")}>Set up</Button> },
    email: !m ? { tone: "neutral", pill: mail.error ? "Can't check" : "Checking", line: mail.error ? "Email's status can't be checked right now." : "Checking Gmail…", needsSetup: false }
      : !m.available ? { tone: "neutral", pill: "Not available", line: "Email isn't available in this version of the app.", needsSetup: false }
      : m.connected ? { tone: m.last_error ? "warning" : "success", pill: m.last_error ? "Needs a look" : "Connected",
        line: m.last_error ? m.last_error : `Connected as ${m.address}${m.last_sync ? ` · last sync ${formatWhen(m.last_sync)}` : ""}`, needsSetup: false }
      : { tone: "neutral", pill: "Not set up", line: "Read job email and send replies from Gmail, after your OK.", needsSetup: false,
        action: open === "email" ? undefined : <Button size="sm" variant="secondary" onClick={() => choose("email")}>Set up</Button> },
    chrome: chromeOn
      ? { tone: chrome.data!.connected ? "success" : "neutral", pill: chrome.data!.connected ? "On" : "On, not connected", line: `Searches ${chrome.data!.settings.boards.length} job ${chrome.data!.settings.boards.length === 1 ? "board" : "boards"} in your own Chrome.${chrome.data!.connected ? "" : " Connects when a search starts."}`, needsSetup: false }
      : chromeOff ? { tone: "warning", pill: "Off", line: "Set up, but off, so Claude searches the web. Turn it on to search your signed-in boards.", needsSetup: false,
        action: open === "chrome" ? undefined : <Button size="sm" variant="secondary" onClick={() => choose("chrome")}>Turn on</Button> }
      : { tone: "neutral", pill: "Not set up", line: "Search job boards in your own Chrome, with your own sign-ins.", needsSetup: false,
        action: open === "chrome" ? undefined : <Button size="sm" variant="secondary" onClick={() => choose("chrome")}>Set up</Button> },
  };
  const rows: Record<ConnectionId, { icon: IconGlyph; name: string; body: ReactNode }> = {
    claude: { icon: ServiceMarks.claude, name: "Claude", body: <ClaudeConnection ready={claudeReady} keySet={keySet} switching={busy === "plan"} onSwitchToPlan={() => void switchToPlan()}
      secrets={<Secrets id="claude" statuses={statuses} broken={broken} reload={keyChanged} platform={platform} />} /> },
    email: { icon: ServiceMarks.gmail, name: "Email (Gmail)", body: <EmailConnection /> },
    chrome: { icon: ServiceMarks.chrome, name: "Search in my Chrome", body: <ChromeConnection /> },
  };
  return (
    <div className="conns">
      {secrets.error && !secrets.data ? <ErrorState title="Saved keys can't be shown" text={errorSentence(secrets.error)} /> : null}
      {CONNECTIONS.map((id) => (
        <Row key={id} id={id} icon={rows[id].icon} name={rows[id].name} summary={summaries[id]} open={open === id}
          onToggle={() => toggle(id)}>
          {rows[id].body}
        </Row>
      ))}
      <LinkedInImport />
    </div>
  );
}
