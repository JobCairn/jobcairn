import { useEffect, useRef, useState } from "react";
import { Button, Icons, Text } from "@careeros/brand";
import { BOARD_NAMES, compareBoardSites, type BoardId, type ChromeRunProgress, type ChromeSearchState, type FindJobsMode } from "@careeros/contract";
import { useAction, useBridge } from "../bridge-context";
import { useClaudeRun } from "../claude";
import { navigate } from "../router";
import { BoardChips } from "./BoardChips";
import { useChromeSearch } from "./ChromeSearchSetup";
import { boardLine, COPY, FIX_LABEL, pauseText, searchModeLine, webLine, type ModeFix } from "./state";
import "./chrome.css";

const WORKSPACE = { kind: "workspace" } as const;
const POLL_MS = 1_500;

/**
 * The live strip while a find-jobs run searches in the person's Chrome: per-board progress ("SEEK: 18 ads read"),
 * a pause banner with Continue and Skip when a board needs the person, and Stop. When the run ends,
 * a reminder that Chrome's remote control can be turned off.
 */
export function ChromeRunStrip() {
  const bridge = useBridge();
  const claude = useClaudeRun("find_jobs", WORKSPACE);
  const { busy, run } = useAction();
  const [p, setP] = useState<ChromeRunProgress | null>(null);
  const [mode, setMode] = useState<{ last: FindJobsMode; state: ChromeSearchState } | null>(null);
  const [ended, setEnded] = useState(false);
  const seen = useRef(false);
  const c = bridge.chrome;

  useEffect(() => {
    if (!c || !claude.running) return undefined;
    let live = true;
    const tick = () => { void c.progress().then((x) => { if (live) { setP(x); if (x) seen.current = true; } }, () => undefined); };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [c, claude.running]);

  // Which way this run searches (main decided at its start): never a silent fallback to the web.
  useEffect(() => {
    if (!c || !claude.running) { setMode(null); return undefined; }
    let live = true;
    void c.state(false).then((st) => { if (live && st.last_run) setMode({ last: st.last_run, state: st }); }, () => undefined);
    return () => { live = false; };
  }, [c, claude.running]);

  useEffect(() => {
    if (!claude.running && seen.current) { seen.current = false; setP(null); setEnded(true); }
    if (claude.running) setEnded(false);
  }, [claude.running]);

  if (!c) return null;
  if (claude.running && !p && mode?.last.mode === "web") {
    const fix = searchModeLine(mode.state).fix ?? null;
    return (
      <section className="crunstrip crunstrip--web" aria-label="Searching the web">
        <div className="crunstrip__head">
          <Text role="body-sm" as="span" className="crunstrip__title">{webLine(mode.last.reason)}</Text>
          <div className="csetup__row">
            {fix ? <ModeFixButton fix={fix} state={mode.state} after={() => setMode(null)} /> : null}
            <Button size="sm" variant="ghost" icon={Icons.close} loading={busy === "stop"} onClick={() => void run("stop", () => claude.cancel())}>Stop</Button>
          </div>
        </div>
      </section>
    );
  }
  if (!claude.running || !p) {
    return ended ? <Text role="body-sm" muted className="crunstrip__after">{`The search in your Chrome finished and its tabs are closed. ${COPY.turnOffHint}`}</Text> : null;
  }
  const answer = (b: BoardId, a: "continue" | "skip") => run(`answer-${b}`, async () => { setP(await c.answer(b, a)); });
  const paused = p.boards.filter((b) => b.state === "paused");
  const boards = [...p.boards].sort((a, b) => compareBoardSites(a.id, b.id));
  return (
    <section className="crunstrip" aria-label="Searching in your Chrome">
      <div className="crunstrip__head">
        <Text role="body" as="span" className="crunstrip__title">{`Searching in your Chrome: ${boards.map((b) => b.name).join(", ")}`}</Text>
        <Button size="sm" variant="ghost" icon={Icons.close} loading={busy === "stop"} onClick={() => void run("stop", () => claude.cancel())}>Stop</Button>
      </div>
      <ul className="crunstrip__boards" aria-live="polite">
        {boards.map((b) => <li key={b.id} data-state={b.state}><Text role="body-sm" as="span">{boardLine(b)}</Text></li>)}
      </ul>
      {paused.map((b) => (
        <div key={b.id} className="crunstrip__pause" role="alert">
          <Text role="body-sm">{pauseText(b)}</Text>
          <div className="csetup__row">
            <Button size="sm" variant="primary" loading={busy === `answer-${b.id}`} onClick={() => void answer(b.id, "continue")}>Continue</Button>
            <Button size="sm" variant="ghost" onClick={() => void answer(b.id, "skip")} aria-label={`Skip board: ${b.name}`} title={`Skip ${b.name} for this search`}>Skip board</Button>
          </div>
        </div>
      ))}
    </section>
  );
}

/**
 * While a find-jobs run is starting (`show`) and it will search in Chrome: the app has brought Chrome to the front,
 * and Chrome may be asking "Allow remote debugging?". One plain line says what to click. Nothing when it searches
 * the web. Mounted before the click, so the search mode is already known: no bridge call waits on main while it
 * waits for Allow.
 */
export function AllowHint({ show }: { show: boolean }) {
  const st = useChromeSearch();
  const line = st.data ? searchModeLine(st.data) : null;
  if (!show || line?.mode !== "chrome") return null;
  return <Text role="body-sm" className="callowhint" aria-live="polite">{COPY.allowHint}</Text>;
}

/**
 * Does what a "Searching the web (…)" line offers: turn Search in my Chrome on (no setup again), connect to Chrome
 * (Chrome asks to Allow), open Chrome's remote control page, or go to the setup card.
 */
export function ModeFixButton({ fix, state, after, label }: { fix: Exclude<ModeFix, null>; state: ChromeSearchState; after?: () => void; label?: string }) {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const c = bridge.chrome;
  const go = () => navigate({ screen: "settings", tab: "connections", c: "chrome" });
  const act = async () => {
    if (!c || fix === "set_up") { go(); return; }
    if (fix === "turn_on") await c.finish(state.settings.boards);
    else if (fix === "connect") await c.connect();
    else await c.openRemote();
    after?.();
  };
  return (
    <Button size="sm" variant={fix === "turn_on" ? "primary" : "secondary"} icon={fix === "set_up" ? Icons.settings : undefined} loading={busy === `fix-${fix}`}
      onClick={() => void run(`fix-${fix}`, act, fix === "turn_on" ? `${COPY.done} The next search uses your Chrome.` : undefined)}>{label ?? FIX_LABEL[fix]}</Button>
  );
}

/**
 * The find-jobs composer's search mode, always shown: "Searching in your Chrome: LinkedIn, SEEK, …" with the boards
 * as chips the person can untick for this run only, or "Searching the web (why)" with the one-click fix.
 */
export function ComposerBoards({ value, onChange }: { value: BoardId[] | null; onChange(b: BoardId[] | null): void }) {
  const st = useChromeSearch();
  const s = st.data;
  const line = s ? searchModeLine(s) : null;
  useEffect(() => { if (line?.mode === "chrome" && value === null) onChange([...line.boards]); }, [line?.mode]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s || !line) return null;
  if (line.mode === "web") {
    return (
      <div className="composer__section cboards__fallback" data-mode="web">
        <Text role="body" as="h3" className="composer__label">Where Claude searches</Text>
        <Text role="body-sm">{line.text}</Text>
        {line.hint ? <Text role="body-sm" muted>{line.hint}</Text> : null}
        {line.fix ? <div><ModeFixButton fix={line.fix} state={s} after={() => st.reload()} /></div> : null}
      </div>
    );
  }
  const ticked = value ?? line.boards;
  return (
    <div className="composer__section" data-mode="chrome">
      <Text role="body" as="h3" className="composer__label">Where Claude searches</Text>
      <Text role="body-sm">{ticked.length ? `Searching in your Chrome: ${line.boards.filter((b) => ticked.includes(b)).map((b) => BOARD_NAMES[b]).join(", ")}.` : line.text}</Text>
      {line.hint ? <Text role="body-sm" muted>{line.hint}</Text> : null}
      <BoardChips boards={line.boards} ticked={ticked} onChange={(b) => onChange(b)} label="Job boards for this search" />
      {!ticked.length ? <Text role="body-sm">Tick at least one job board for this search.</Text> : null}
    </div>
  );
}
