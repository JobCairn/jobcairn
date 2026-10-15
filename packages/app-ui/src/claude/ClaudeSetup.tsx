import { useState, type ReactNode } from "react";
import { Button, Checkbox, PRODUCT_NAME, Text } from "@careeros/brand";
import { CLAUDE_INSTALL_URL, CLAUDE_NOTICE, isActiveRun, type ClaudeEngineState } from "@careeros/contract";
import { useAction, useBridge } from "../bridge-context";
import { ErrorState, Loading } from "../components/States";
import { ToolInstall } from "../components/ToolInstall";
import { formatCost } from "./ClaudeRunPanel";
import { useClaudeEngine, useClaudeRuns } from "./useClaudeRun";
import "./claude.css";

const PRODUCT = PRODUCT_NAME;

type StepState = "done" | "current" | "blocked";
const CLAUDE_TOOL = ["claude-code"] as const;

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

/** Which step comes next, in order. "app": this copy of the app lacks its bundled plugin (reinstall). */
export function setupStep(e: ClaudeEngineState): "consent" | "cli" | "login" | "test" | "app" {
  if (!e.consent.given) return "consent";
  if (e.cli.problem) return "cli";
  if (e.login === "signed_out") return "login";
  if (!e.plugin.found) return "app";
  return "test";
}

/**
 * Sets up the Claude Code engine: the notice and consent, then three steps: Claude Code found, signed in, a test
 * run. Nothing is installed into Claude Code; the app's own plugin is loaded for each run. Used in onboarding and
 * in Settings > Claude. The app never sees or handles the Claude login.
 */
export function ClaudeSetup({ onDone, variant = "settings" }: { onDone?: () => void; variant?: "onboarding" | "settings" }) {
  const bridge = useBridge();
  const engine = useClaudeEngine();
  const runs = useClaudeRuns();
  const { busy, run } = useAction();
  const [agree, setAgree] = useState(false);
  const e = engine.data;
  if (!e) return engine.error ? <ErrorState title="Claude's setup can't be checked" text={engine.error} /> : <Loading />;

  const next = setupStep(e);
  const test = (runs.data ?? []).find((r) => r.action === "test") ?? null;
  const recheck = () => run("recheck", async () => { await bridge.claude.engine(true); engine.reload(); });
  const consent = () => run("consent", async () => { await bridge.claude.consent(); engine.reload(); }, "Thanks. Claude can now run for you.");
  const signIn = () => run("signin", async () => {
    const ok = await bridge.claude.openSignIn();
    if (!ok) throw new Error("Terminal didn't open. Open it yourself, type claude and press Return to sign in.");
  });
  const runTest = () => run("test", async () => { await bridge.claude.testRun(); runs.reload(); });
  const order = ["consent", "cli", "login", "test", "app"] as const;
  const at = (s: (typeof order)[number]): StepState => (order.indexOf(s) < order.indexOf(next) ? "done" : s === next ? "current" : "blocked");
  const testDone = test?.status === "succeeded";
  const testRunning = !!test && isActiveRun(test.status);

  return (
    <div className="csetup">
      <div className="csetup__notice" role="note">
        <Text role="label">Before you start</Text>
        <ul>{CLAUDE_NOTICE.map((l) => <li key={l}><Text role="body-sm">{l.replaceAll("{product}", PRODUCT)}</Text></li>)}</ul>
        {e.consent.given ? (
          <Text role="body-sm" muted>You agreed to this notice.</Text>
        ) : (
          <div className="csetup__row">
            <Checkbox label="I understand" checked={agree} onChange={(ev) => setAgree(ev.target.checked)} />
            <Button size="sm" variant="primary" disabled={!agree} title={agree ? undefined : "Tick \"I understand\" first"} loading={busy === "consent"} onClick={() => void consent()}>Continue</Button>
          </div>
        )}
      </div>

      <ol className="csetup__steps">
        <Step n={1} title={e.cli.found && !e.cli.problem ? `Claude Code found (version ${e.cli.version})` : "Claude Code on this computer"} state={at("cli")}>
          {e.cli.problem === "missing" ? (
            <>
              <Text role="body-sm">Claude Code isn't installed yet. {PRODUCT} can install it with Anthropic's official installer, after you agree. Then sign in below.</Text>
              <ToolInstall ids={CLAUDE_TOOL} bare onInstalled={() => void recheck()} />
              <div className="csetup__row">
                <Button size="sm" variant="secondary" title="How to install Claude Code" onClick={() => void bridge.links.open(CLAUDE_INSTALL_URL)}>Install guide</Button>
                <Button size="sm" variant="ghost" loading={busy === "recheck"} onClick={() => void recheck()}>Check again</Button>
              </div>
            </>
          ) : e.cli.problem === "too_old" ? (
            <>
              <Text role="body-sm">This Claude Code is version {e.cli.version}. {PRODUCT} needs {e.cli.min_version} or newer. To update, open Terminal and run:</Text>
              <code className="csetup__code">claude update</code>
              <div className="csetup__row"><Button size="sm" variant="ghost" loading={busy === "recheck"} onClick={() => void recheck()}>Check again</Button></div>
            </>
          ) : e.cli.problem === "broken" ? (
            <>
              <Text role="body-sm">Claude Code is installed but didn't answer. Try opening it once in Terminal, then check again.</Text>
              <div className="csetup__row"><Button size="sm" variant="ghost" loading={busy === "recheck"} onClick={() => void recheck()}>Check again</Button></div>
            </>
          ) : null}
        </Step>

        <Step n={2} title={e.login === "signed_in" ? "Signed in to Claude" : "Sign in to Claude"} state={e.cli.problem ? "blocked" : at("login")}>
          {!e.cli.problem && e.login !== "signed_in" ? (
            <>
              <Text role="body-sm">
                {e.login === "signed_out" ? "Claude Code isn't signed in." : "We couldn't tell whether Claude Code is signed in. The test run below will show it."}
                {" "}Sign in inside Terminal with your own Claude account. {PRODUCT} never sees your login.
              </Text>
              <div className="csetup__row">
                <Button size="sm" variant={e.login === "signed_out" ? "primary" : "secondary"} loading={busy === "signin"} title="Opens Terminal to sign in" onClick={() => void signIn()}>Sign in</Button>
                <Button size="sm" variant="ghost" loading={busy === "recheck"} onClick={() => void recheck()}>Check again</Button>
              </div>
            </>
          ) : e.cli.problem ? <Text role="body-sm" muted>Available once Claude Code is installed.</Text> : null}
        </Step>

        <Step n={3} title={testDone ? "Test run passed" : "Run a test"} state={testDone ? "done" : next === "app" ? "blocked" : at("test")}>
          {next === "app" ? (
            <Text role="body-sm">This copy of {PRODUCT} is missing its Claude add-on, so Claude can't run yet. Reinstall {PRODUCT}, then check again.</Text>
          ) : next === "test" ? (
            <>
              <Text role="body-sm">
                {testRunning ? "Claude is answering a one-word test…" : test?.status === "failed" ? test.error : testDone ? "Claude answered. Everything works." : "A tiny run in an empty folder, with no access to your files, to check that everything works."}
              </Text>
              <div className="csetup__row">
                {!testDone ? <Button size="sm" variant="primary" loading={busy === "test" || testRunning} onClick={() => void runTest()}>{test ? "Test again" : "Run test"}</Button> : null}
                {variant === "onboarding" && onDone ? <Button size="sm" variant={testDone ? "primary" : "ghost"} onClick={onDone}>{testDone ? "Finish" : "Not now"}</Button> : null}
              </div>
            </>
          ) : <Text role="body-sm" muted>Available after the steps above.</Text>}
        </Step>
      </ol>
      {variant === "settings" && e.consent.given && e.cost.runs > 0 ? (
        <Text role="body-sm" muted className="csetup__cost" title="Claude Code's own estimates for runs billed to your API key.">
          {`API key cost this month: ${formatCost(e.cost.usd)} estimated across ${e.cost.runs} ${e.cost.runs === 1 ? "run" : "runs"}.`}
        </Text>
      ) : null}
      {variant === "onboarding" && onDone && next !== "test" ? (
        <div className="csetup__row"><Button size="sm" variant="ghost" onClick={onDone}>Not now</Button></div>
      ) : null}
    </div>
  );
}
