import { useEffect, useState } from "react";
import { Button, Pill, PRODUCT_NAME, Text } from "@careeros/brand";
import { INSTALL_PAGE_URL, type SetupToolId, type SetupToolView, type SetupView } from "@careeros/contract";
import { errorText, useBridge, useLoad } from "../bridge-context";
import { errorSentence } from "./ErrorBanner";
import { copyText, TerminalFallback } from "./TerminalFix";
import "./tool-install.css";

/** "2:05" since an ISO time, ticking each second, so a long install never looks stuck. "" when unknown. */
export function useElapsed(since: string | undefined): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  const start = since ? Date.parse(since) : NaN;
  if (!Number.isFinite(start)) return "";
  const s = Math.max(0, Math.floor((now - start) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Elapsed({ since }: { since: string }) {
  const t = useElapsed(since);
  return t ? <Text role="body-sm" as="span" muted className="tinstall__elapsed" aria-label={`Running for ${t}`}>{t}</Text> : null;
}

/** Homebrew isn't on this Mac: the person installs it themselves (it needs their Mac password, which the app never asks for). */
function HomebrewNeeded({ view, names, plural, onCheck, checking, onOpen }: { view: SetupView; names: string; plural: boolean; onCheck: () => void; checking: boolean; onOpen: (url: string) => void }) {
  const [copied, setCopied] = useState<"" | "yes" | "no">("");
  const copy = async () => setCopied((await copyText(view.homebrew.command)) ? "yes" : "no");
  return (
    <div className="tinstall__brew">
      <Text role="body-sm">
        {names} {plural ? "install" : "installs"} with Homebrew, which isn&apos;t on this Mac yet. Homebrew asks for your Mac password, so install it yourself:
        open Terminal, paste this line, press Return and follow what it says. Then come back and choose Check again.
      </Text>
      <code className="csetup__code tinstall__cmd">{view.homebrew.command}</code>
      <div className="csetup__row">
        <Button size="sm" variant="secondary" onClick={() => void copy()}>{copied === "yes" ? "Copied" : "Copy"}</Button>
        <Button size="sm" variant="ghost" loading={checking} onClick={onCheck}>Check again</Button>
        <Button size="sm" variant="ghost" title="Opens brew.sh in your browser" onClick={() => onOpen(view.homebrew.url)}>About Homebrew</Button>
      </div>
      <Text role="body-sm" muted aria-live="polite">{copied === "no" ? "Copying didn't work here. Select the line and copy it yourself." : ""}</Text>
    </div>
  );
}

function statePill(t: SetupToolView) {
  return t.state === "too_old" ? <Pill tone="warning">{t.version ? `Too old (${t.version})` : "Too old"}</Pill> : <Pill tone="neutral">Not installed</Pill>;
}

/**
 * Install rows for the tools a card needs (Claude Code, Node.js, Python, ffmpeg). Shows only what's missing or too
 * old, plus how the last install here ended. Install asks in a native dialog that names the exact command; nothing
 * runs at launch. Without Homebrew, the person gets the one line to run themselves. Renders nothing when all is well.
 */
export function ToolInstall({ ids, onInstalled, intro, why, bare = false }: {
  ids: readonly SetupToolId[]; onInstalled?: () => void; intro?: string;
  /** What each tool is for here, when the card's own context says it better than the general line. */
  why?: Partial<Record<SetupToolId, string>>;
  /** Inside a step that already names the tool and says why (Claude setup): only the action, progress and result. */
  bare?: boolean;
}) {
  const bridge = useBridge();
  const status = useLoad((b) => b.setup.status(false), [], ["setup"]);
  const [busy, setBusy] = useState<"" | "check" | SetupToolId>("");
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const v = status.data;
  if (!v) return null;
  const mine = v.tools.filter((t) => ids.includes(t.id));
  const lastHere = v.last && ids.includes(v.last.id as SetupToolId) ? v.last : null;
  const shown = mine.filter((t) => t.state !== "ok" || v.installing?.id === t.id || lastHere?.id === t.id || error?.id === t.id);
  if (!shown.length) return null;

  const check = async () => {
    setBusy("check");
    try { await bridge.setup.status(true); status.reload(); } finally { setBusy(""); }
  };
  const install = async (id: SetupToolId) => {
    setBusy(id);
    setError(null);
    try {
      const r = await bridge.setup.install(id);
      status.reload();
      if (r.last?.id === id && r.last.ok) onInstalled?.();
    } catch (e) {
      setError({ id, text: errorText(e) });
      status.reload();
    } finally { setBusy(""); }
  };
  const stop = async () => { try { await bridge.setup.cancel(); } finally { status.reload(); } };
  const brewMissing = mine.filter((t) => t.state !== "ok" && t.via === "homebrew" && !v.homebrew.found);

  return (
    <div className="tinstall" aria-label="Tools to install">
      {intro ? <Text role="body-sm">{intro}</Text> : null}
      <ul className="tinstall__list">
        {shown.map((t) => {
          const running = v.installing?.id === t.id;
          const result = lastHere?.id === t.id && !running ? lastHere : null;
          const err = error?.id === t.id ? error.text : null;
          const blockedByBrew = t.via === "homebrew" && !v.homebrew.found && t.state !== "ok";
          const other = v.installing && !running ? v.installing.name : "";
          return (
            <li key={t.id} className="tinstall__item">
              {bare ? null : <div className="tinstall__head">
                <Text role="body" as="span" className="csetup__title">{t.name}</Text>
                {t.state === "ok" ? <Pill tone="success">Installed</Pill> : running ? <Pill tone="accent">Installing</Pill> : statePill(t)}
              </div>}
              {!bare && t.state !== "ok" && !running ? <Text role="body-sm" muted>{t.needs === t.name ? why?.[t.id] ?? t.why : `${why?.[t.id] ?? t.why} Needs ${t.needs}.`}</Text> : null}
              {running ? (
                <div className="tinstall__progress" role="status" aria-live="polite" aria-label="Install progress">
                  <span className="tinstall__dot" aria-hidden="true" />
                  <Text role="body-sm" as="span" className="tinstall__line">{v.installing!.line || `Starting: ${t.command}`}</Text>
                  <Elapsed since={v.installing!.started_at} />
                  <Button size="sm" variant="ghost" onClick={() => void stop()}>Stop</Button>
                </div>
              ) : t.state !== "ok" && !blockedByBrew ? (
                v.can_install ? (
                  <div className="csetup__row">
                    <Button size="sm" variant="primary" loading={busy === t.id} disabled={!!other} aria-label={`${t.state === "too_old" ? "Update" : "Install"} ${t.name}`}
                      title={other ? `${other} is installing. One at a time.` : `Asks first, then runs: ${t.command}`}
                      onClick={() => void install(t.id)}>{t.state === "too_old" ? "Update" : "Install"}</Button>
                    <Text role="body-sm" muted as="span" className="tinstall__runs">Runs <code>{t.command}</code></Text>
                  </div>
                ) : (
                  <div className="csetup__row">
                    <Text role="body-sm" as="span">This copy of {PRODUCT_NAME} can&apos;t install it. The install guide lists the command.</Text>
                    <Button size="sm" variant="secondary" onClick={() => void bridge.links.open(INSTALL_PAGE_URL)}>Install guide</Button>
                  </div>
                )
              ) : null}
              {err ? <div role="alert"><Text role="body-sm" className="tinstall__error">{err}</Text></div> : null}
              {result ? <div aria-live="polite"><Text role="body-sm" className={result.ok ? "tinstall__ok" : "tinstall__error"}>{result.message}</Text></div> : null}
              {result && !result.ok && result.fix && t.state !== "ok" ? <TerminalFallback fix={result.fix} /> : null}
            </li>
          );
        })}
      </ul>
      {brewMissing.length ? <HomebrewNeeded view={v} names={brewMissing.map((t) => t.name).join(" and ")} plural={brewMissing.length > 1} onCheck={() => void check()} checking={busy === "check"} onOpen={(u) => void bridge.links.open(u)} /> : null}
      {status.error ? <Text role="body-sm" muted>{errorSentence(status.error)}</Text> : null}
    </div>
  );
}
