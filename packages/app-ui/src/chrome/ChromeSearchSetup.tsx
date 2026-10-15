import { useEffect, useId, useState, type ReactNode } from "react";
import { Button, Card, PRODUCT_NAME, Pill, Select, Text, useToast } from "@careeros/brand";
import { BOARD_IDS, type BoardId, type ChromeSearchState } from "@careeros/contract";
import { errorText, useAction, useBridge, useLoad } from "../bridge-context";
import { RunChip, useClaudeRun } from "../claude";
import { ErrorState, Loading } from "../components/States";
import { BoardChips, BoardMark } from "./BoardChips";
import { chromeSetupStep, COPY, diagLines, finishBlocked, profileLine, shownProfile, signInRow, stepState, type StepState } from "./state";
import "../claude/claude.css";
import "./chrome.css";
import { ToolInstall } from "../components/ToolInstall";
import { copyText, TerminalFallback } from "../components/TerminalFix";

const NODE_TOOL = ["node"] as const;
const NODE_WHY = { node: "The browser helper installs with it, so install Node.js first." } as const;

export const CHROME_INSTALL_URL = "https://www.google.com/chrome/";
const WORKSPACE = { kind: "workspace" } as const;
const POLL_MS = 2_000;

function Step({ n, title, state, children }: { n: number; title: string; state: StepState; children?: ReactNode }) {
  return (
    <li className={`csetup__step csetup__step--${state}`} aria-current={state === "current" ? "step" : undefined}>
      <span className="csetup__num" aria-hidden="true">
        {state === "done" ? (
          <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 6.3 5 8.6 9.6 3.6" /></svg>
        ) : n}
      </span>
      <div className="csetup__body">
        <Text role="body" as="span" className="csetup__title">{title}<span className="sr-only"> ({state === "done" ? "done" : state === "current" ? "to do now" : "waiting for an earlier step"})</span></Text>
        {children}
      </div>
    </li>
  );
}

/**
 * One board in step 5: its status and, under it, why (what the tab showed). Every row can bring its tab to the
 * front and take the person's word that they're signed in.
 */
function BoardRow({ b, busy, profileName, onShow, onConfirm }: { b: ChromeSearchState["boards"][number]; busy: string | null; profileName: string; onShow: () => void; onConfirm: () => void }) {
  const row = signInRow(b);
  const details = diagLines(b.diag, profileName);
  return (
    <li className="cboard-row" data-tone={row.tone}>
      <BoardMark id={b.id} />
      <div className="cboard-row__text">
        <div className="cboard-row__head">
          <Text role="body-sm" as="span" className="cboard-row__name">{b.name}</Text>
          {row.tone === "neutral" ? <Text role="body-sm" as="span" muted>{row.label}</Text> : <Pill tone={row.tone}>{row.label}</Pill>}
        </div>
        {row.reason ? <Text role="body-sm" as="p" muted={!row.contradicted} className="cboard-row__why">{row.reason}</Text> : null}
        {details.length ? (
          <details className="cboard-row__details">
            <summary><Text role="body-sm" as="span">Details</Text></summary>
            <ul aria-label={`How the ${b.name} check opened its tab`}>{details.map((l) => <li key={l}><Text role="body-sm" as="span" muted>{l}</Text></li>)}</ul>
          </details>
        ) : null}
      </div>
      <div className="cboard-row__actions">
        {/* Show tab stays last, so it lines up down the list whether or not this row offers I'm signed in. */}
        {row.canConfirm ? (
          <Button size="sm" variant="ghost" aria-label={`Confirm sign-in: ${b.name}`} title={`I'm signed in to ${b.name}`} loading={busy === `confirm-${b.id}`} onClick={onConfirm}>Confirm sign-in</Button>
        ) : null}
        <Button size="sm" variant="secondary" aria-label={`Show the ${b.name} tab`} loading={busy === `show-${b.id}`} onClick={onShow}>Show tab</Button>
      </div>
    </li>
  );
}

/** Why it uses the person's own signed-in Chrome, and what it can and can't do there: before any step. */
export function WhyChrome() {
  const id = useId();
  return (
    <section className="cwhy" aria-labelledby={id}>
      <Text role="heading-2" as="h3" id={id}>{COPY.whyTitle}</Text>
      {COPY.why.map((p) => <Text key={p} role="body" as="p">{p}</Text>)}
      <div className="cwhy__lists">
        <div>
          <Text role="body-sm" as="h4" className="cwhy__head">It can</Text>
          <ul className="cwhy__list cwhy__list--can">{COPY.can.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
        <div>
          <Text role="body-sm" as="h4" className="cwhy__head">It never</Text>
          <ul className="cwhy__list cwhy__list--never">{COPY.never.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      </div>
    </section>
  );
}

/** What the browser helper is, what it does here, its size and where it goes: shown before the person installs it. */
function HelperAbout({ mb }: { mb: number }) {
  return (
    <div className="csetup__about">
      <Text role="body-sm" as="p">{COPY.helperWhat}</Text>
      <Text role="body-sm" as="p">{COPY.helperDoes}</Text>
      <Text role="body-sm" as="p" muted>{COPY.helperWhere(mb)}</Text>
    </div>
  );
}

/** Step 3 without the button: the address to paste into Chrome, a Copy button, and what to tick there. */
function RemoteByHand() {
  const [copied, setCopied] = useState<"" | "yes" | "no">("");
  return (
    <div className="csetup__about">
      <Text role="body-sm" as="p">{COPY.remoteManualTitle}</Text>
      <ol className="csetup__manual">
        <li>
          <Text role="body-sm" as="span">{COPY.remoteManual[0]}</Text>
          <div className="csetup__row">
            <code className="csetup__code">{COPY.remotePage}</code>
            <Button size="sm" variant="secondary" aria-label="Copy the address" onClick={() => void copyText(COPY.remotePage).then((ok) => setCopied(ok ? "yes" : "no"))}>{copied === "yes" ? "Copied" : "Copy"}</Button>
          </div>
        </li>
        <li><Text role="body-sm" as="span">{COPY.remoteManual[1]}</Text></li>
      </ol>
      <Text role="body-sm" muted aria-live="polite">{copied === "no" ? COPY.copyFailed : ""}</Text>
    </div>
  );
}

/** The Chrome search state, re-read when settings change. Null bridge group: not available in this shell. */
export function useChromeSearch() {
  return useLoad((b) => (b.chrome ? b.chrome.state(false) : Promise.resolve(null)), [], ["settings"]);
}

/**
 * Settings > Search: "Where should we look?" (board chips, saved as you tick) and the one-time "Search in my
 * Chrome" setup card: Chrome found, browser helper installed, Chrome's remote control on, connected, signed in
 * to your boards, Finish. Every step says what to do, and every disabled button says why.
 */
export function ChromeSearchSettings() {
  const bridge = useBridge();
  const st = useChromeSearch();
  const { busy, run } = useAction();
  const toast = useToast();
  const check = useClaudeRun("chrome_check", WORKSPACE);
  const s = st.data;
  // When Claude's check finishes, its answers are in the Chrome state: read it again.
  const checkStatus = check.run?.status;
  useEffect(() => { if (checkStatus === "succeeded" || checkStatus === "failed" || checkStatus === "cancelled") st.reload(); }, [checkStatus]); // eslint-disable-line react-hooks/exhaustive-deps
  const next = s ? chromeSetupStep(s) : null;
  // Step 3: while waiting for the person to switch Chrome's remote control on, look again every few seconds.
  useEffect(() => {
    if (next !== "remote") return undefined;
    const t = setInterval(() => st.reload(), POLL_MS);
    return () => clearInterval(t);
  }, [next]); // eslint-disable-line react-hooks/exhaustive-deps

  if (st.error && !s) return <ErrorState title="Search in my Chrome can't be checked" text={st.error} />;
  if (st.loading && s === undefined) return <Loading />;
  const c = bridge.chrome;
  if (!s || !c) {
    // Inside Settings › Connections the row already names the service, so this says only why it's off.
    return <Text role="body" muted>{COPY.unavailable}</Text>;
  }

  const ticked = s.settings.boards;
  const call = (key: string, fn: () => Promise<unknown>, ok?: string) => run(key, async () => { await fn(); st.reload(); }, ok);
  const setBoards = (b: BoardId[]) => void call("boards", () => c.setBoards(b));
  const why = finishBlocked(s, ticked);
  const isOn = s.settings.enabled;
  const hint = profileLine(s);
  const profiles = s.profiles ?? [];
  const pick = shownProfile(s);
  // The select shows the last used profile until one is chosen; the first check saves what it shows.
  const startCheck = () => void run("check", async () => {
    if (!s.settings.profile_dir && pick) await c.setProfile(pick);
    await check.start({});
  });
  const profileName = profiles.find((p) => p.dir === pick)?.name || "chosen";
  const checking = !!check.run && (check.run.status === "running" || check.run.status === "queued");

  return (
    <Card className="stack chrome-setup" aria-label={COPY.title}>
      <WhyChrome />
      <div className="stack">
        <Text role="heading-2">{COPY.boardsLabel}</Text>
        <Text role="body-sm" muted>{COPY.boardsHelp}</Text>
        <BoardChips boards={BOARD_IDS} ticked={ticked} onChange={setBoards} label={COPY.boardsLabel} />
        {!ticked.length ? <Text role="body-sm">Tick at least one job board.</Text> : null}
      </div>

      <div className="stack">
        <div className="row">
          <Text role="heading-2">{COPY.title}</Text>
          {isOn ? <Pill tone={s.ready ? "success" : "neutral"}>{s.ready ? "On" : "On, not connected"}</Pill> : null}
        </div>
        <Text role="body-sm" muted className="chrome-setup__tos">{COPY.tos}</Text>
        {s.problem ? <Text role="body-sm" className="chrome-setup__problem">{s.problem}</Text> : null}
      </div>

      {next === "unavailable" ? <Text role="body" muted>{COPY.unavailable}</Text> : (
        <ol className="csetup__steps">
          <Step n={1} title={s.chrome.found ? "Chrome found" : "Install Chrome"} state={stepState("chrome", next!)}>
            {!s.chrome.found ? (
              <>
                <Text role="body-sm">Google Chrome isn't on this computer. Install it, then choose Check again.</Text>
                <div className="csetup__row">
                  <Button size="sm" variant="primary" onClick={() => void bridge.links.open(CHROME_INSTALL_URL)}>Install Chrome</Button>
                  <Button size="sm" variant="ghost" loading={busy === "recheck"} onClick={() => void call("recheck", () => c.state(true))}>Check again</Button>
                </div>
              </>
            ) : null}
          </Step>

          <Step n={2} title={s.helper.found ? `Browser helper installed (version ${s.helper.version})` : "Install the browser helper"} state={stepState("helper", next!)}>
            {next === "helper" ? (
              <>
                {s.helper.too_old ? <Text role="body-sm">The browser helper here is version {s.helper.version}. Search in my Chrome needs {s.helper.min_version} or newer.</Text> : null}
                <HelperAbout mb={s.helper.size_mb} />
                <ToolInstall ids={NODE_TOOL} why={NODE_WHY} onInstalled={() => void call("recheck", () => c.state(true))} />
                <div className="csetup__row">
                  <Button size="sm" variant="primary" loading={busy === "install" || s.helper.installing} disabled={!s.helper.can_install}
                    title={s.helper.can_install ? undefined : COPY.unavailable}
                    onClick={() => void run("install", async () => { try { await c.install(); } finally { st.reload(); } })}>{s.helper.installing ? "Installing…" : s.helper.too_old ? "Update helper" : "Install helper"}</Button>
                  <Button size="sm" variant="ghost" loading={busy === "recheck"} onClick={() => void call("recheck", () => c.state(true))}>Check again</Button>
                </div>
                {s.helper.fix && !s.helper.installing ? <TerminalFallback fix={s.helper.fix} /> : null}
              </>
            ) : stepState("helper", next!) === "blocked" ? <Text role="body-sm" muted>Available once Chrome is installed.</Text>
              : s.helper.found && s.helper.can_remove ? (
                <div className="csetup__row">
                  <Text role="body-sm" muted as="span">About {s.helper.size_mb} MB in {PRODUCT_NAME}'s own folder.</Text>
                  <Button size="sm" variant="ghost" loading={busy === "remove-helper"}
                    onClick={() => void call("remove-helper", () => c.removeHelper())}>Remove helper</Button>
                </div>
              ) : null}
          </Step>

          <Step n={3} title={s.remote.on ? "Chrome's remote control is on" : "Turn on Chrome's remote control"} state={stepState("remote", next!)}>
            {next === "remote" ? (
              <>
                <Text role="body-sm">{COPY.remoteHow}</Text>
                <div className="csetup__row">
                  <Button size="sm" variant="primary" loading={busy === "remote"} title="Open Chrome's remote control page" onClick={() => void call("remote", () => c.openRemote())}>Remote control</Button>
                </div>
                <RemoteByHand />
                <Text role="body-sm" muted aria-live="polite">{COPY.remoteWaiting}</Text>
              </>
            ) : stepState("remote", next!) === "blocked" ? <Text role="body-sm" muted>Available after the steps above.</Text> : null}
          </Step>

          <Step n={4} title={s.connected ? "Connected to Chrome" : "Connect to Chrome"} state={stepState("connect", next!)}>
            {next === "connect" ? (
              <>
                <Text role="body-sm">{COPY.connectHow}</Text>
                {profiles.length ? null : <Text role="body-sm" muted>{COPY.connectProfiles}</Text>}
                <div className="csetup__row">
                  <Button size="sm" variant="primary" loading={busy === "connect"} onClick={() => void call("connect", () => c.connect())}>Connect</Button>
                </div>
              </>
            ) : stepState("connect", next!) === "blocked" ? <Text role="body-sm" muted>Available after the steps above.</Text> : null}
          </Step>

          <Step n={5} title="Signed in to your boards (optional)" state={next === "boards" ? (isOn ? "done" : "current") : "blocked"}>
            {next === "boards" ? (
              <>
                <Text role="body-sm">{COPY.signInHow}</Text>
                <Text role="body-sm" muted>{COPY.signInWhy}</Text>
                <Text role="body-sm" className="cwho">{COPY.whoBrowses(profileName)}</Text>
                {profiles.length ? (
                  <div className="cprofile-pick">
                    <Select label={COPY.profileLabel} help={COPY.profileHelp} value={pick} disabled={busy === "profile"}
                      options={profiles.map((p) => ({ value: p.dir, label: p.name }))}
                      onChange={(e) => { const dir = e.currentTarget.value; void call("profile", () => c.setProfile(dir)); }} />
                  </div>
                ) : null}
                {hint ? (
                  <Text role="body-sm" as="p" className="cprofile-line" aria-live="polite">
                    <span className="cprofile-line__title">{COPY.profileTitle}</span> {hint}
                  </Text>
                ) : null}
                <ul className="cboards__status">
                  {s.boards.map((b) => <BoardRow key={b.id} b={b} busy={busy} profileName={profiles.find((p) => p.dir === b.diag?.profile_dir)?.name ?? ""}
                    onShow={() => void call(`show-${b.id}`, () => c.showBoard(b.id))}
                    onConfirm={() => void call(`confirm-${b.id}`, () => c.confirmSignIn(b.id))} />)}
                </ul>
                <div className="csetup__row">
                  {check.run && check.run.status !== "succeeded" ? (
                    <RunChip run={check.run} onCancel={() => void check.cancel()} onRetry={startCheck} retrying={busy === "check"} />
                  ) : null}
                  {!checking ? (
                    <Button size="sm" variant="secondary" loading={busy === "check"} disabled={!ticked.length || !check.ready}
                      title={!ticked.length ? "Tick at least one job board above." : !check.ready ? "Set up Claude first in Settings › Claude." : undefined}
                      onClick={startCheck}>{s.boards.some((b) => b.signed_in !== "unchecked") ? "Check again" : COPY.checkWithClaude}</Button>
                  ) : null}
                </div>
                <Text role="body-sm" muted>{COPY.checkHow}</Text>
                {check.error ? <Text role="body-sm" className="chrome-setup__problem">{check.error}</Text> : null}
              </>
            ) : <Text role="body-sm" muted>Available after the steps above.</Text>}
          </Step>
        </ol>
      )}

      {/* No Finish: setup turns itself on when it connects (step 4). Turn on is for a setup that was never turned on, or was turned off. */}
      <div className="csetup__row">
        {isOn ? (
          <Button variant="ghost" loading={busy === "off"} onClick={() => void call("off", () => c.turnOff(), "Search in my Chrome is off. Claude will search the web.")}>Turn off</Button>
        ) : s.helper.found || s.offer_turn_on || s.settings.set_up_at ? (
          <>
            <Button variant="primary" disabled={!!why} title={why || undefined} loading={busy === "finish"}
              onClick={() => void run("finish", async () => {
                await c.finish(ticked);
                st.reload();
                toast({ tone: "success", text: `${COPY.done} ${COPY.turnOffHint}` });
              })}>Turn on</Button>
            {why ? <Text role="body-sm" muted>{why}</Text> : <Text role="body-sm" muted>{s.offer_turn_on ? "You set this up earlier but it was never turned on." : "Off. Claude searches the web until you turn it on."}</Text>}
          </>
        ) : <Text role="body-sm" muted>Search in my Chrome turns on by itself once it connects (step 4).</Text>}
      </div>
      {isOn ? <Text role="body-sm" muted>{s.connected ? COPY.turnOffHint : "On. If Chrome isn't connected when a search starts, the app connects then, and Chrome may ask you to Allow."}</Text> : null}
      {st.error ? <Text role="body-sm" muted>{errorText(st.error)}</Text> : null}
    </Card>
  );
}
