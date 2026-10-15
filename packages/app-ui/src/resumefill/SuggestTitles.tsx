import { useEffect, useMemo, useState } from "react";
import { Button, Icon, Icons, Text, cx } from "@careeros/brand";
import { isActiveRun, type ActionTarget } from "@careeros/contract";
import { errorText, useLoad } from "../bridge-context";
import { formatElapsed, useClaudeRun } from "../claude";
import { getPath } from "../components/FieldForm";
import { CLAUDE_SETTINGS, navigate } from "../router";
import { useElapsed } from "./SuggestTargets";
import "./resumefill.css";

const TARGET: ActionTarget = { kind: "workspace" };
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const has = (list: readonly string[], x: string) => list.some((y) => y.toLowerCase() === x.toLowerCase());

/**
 * Settings › Search › Related job titles: "Suggest" runs the same Claude action as the profile's suggestions
 * (suggest_targets: reads only the resume copy, no web) and offers its 5 to 10 related titles as chips. Titles already
 * in Roles you want or Related titles are left out. Nothing is added until the person picks and presses Add.
 */
export function SuggestTitles({ current, onAdd }: { current: readonly string[]; onAdd(titles: string[]): Promise<unknown> }) {
  const c = useClaudeRun("suggest_targets", TARGET);
  const run = c.run;
  const active = !!run && isActiveRun(run.status);
  const elapsed = useElapsed(run, active);
  const sugg = useLoad((b) => b.profile.suggestions(), [run?.id, run?.status], ["claude", "settings"]);
  const profile = useLoad((b) => b.settings.get("profile"), [], ["settings"]);
  const roles = strings(getPath(profile.data?.values, "targets.roles"));
  const data = sugg.data ?? null;
  const offered = useMemo(() => (data?.related_titles ?? []).filter((t) => !has(roles, t) && !has(current, t)), [data, roles, current]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [asked, setAsked] = useState(false);
  useEffect(() => { setPicked(new Set(offered)); }, [data?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const start = async () => { setAsked(true); setNote(""); setError(""); try { await c.start(); } catch { /* c.error shows it */ } };
  const toggle = (t: string) => setPicked((p) => { const n = new Set(p); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  const chosen = offered.filter((t) => picked.has(t));
  const add = async () => {
    if (!chosen.length) return;
    setBusy(true); setError("");
    try { await onAdd(chosen); setNote(`Added ${chosen.length} ${chosen.length === 1 ? "title" : "titles"}.`); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const failed = run && (run.status === "failed" || run.status === "cancelled");
  const chipText = run?.status === "queued" ? "Waiting for Claude…" : failed ? (run.status === "cancelled" ? "Stopped" : "Claude didn't finish") : "Reading your resume…";
  const engine = c.engine;

  return (
    <div className="rfill-titles">
      <div className="rfill-sugg__slot">
        {active || failed ? (
          <div className={cx("rfill-chip", failed && "rfill-chip--failed")} role="status" aria-live="polite" title={failed && run?.error ? run.error : chipText}>
            {active ? <span className="crun__pulse" aria-hidden="true" /> : <Icon icon={Icons.info} size="sm" />}
            <span className="rfill-chip__text">{chipText}</span>
            {active ? <span className="rfill-chip__time" aria-label={`Time taken ${formatElapsed(elapsed)}`}>{formatElapsed(elapsed)}</span> : null}
            {active
              ? <button type="button" className="rfill-chip__btn" onClick={() => void c.cancel()}>Cancel</button>
              : <button type="button" className="rfill-chip__btn" onClick={() => void start()}>Try again</button>}
          </div>
        ) : engine && !engine.ready ? (
          <Button size="sm" icon={Icons.ai} onClick={() => navigate(CLAUDE_SETTINGS)} title="Claude Code needs a one-time setup before it can suggest titles.">Claude setup</Button>
        ) : (
          <Button size="sm" icon={Icons.ai} disabled={!engine} title={!engine ? "Checking whether Claude is set up…" : "Suggest 5-10 titles from your resume"}
            aria-description="Suggest 5-10 titles from your resume" onClick={() => void start()}>Suggest</Button>
        )}
      </div>
      {c.error && !active ? <p className="rfill-error" role="alert">{c.error}</p> : null}
      {data && (asked || offered.length) ? (
        offered.length ? (
          <div className="rfill-sugg__result">
            <div className="rfill-chips" role="group" aria-label="Suggested titles">
              {offered.map((t) => (
                <button key={t} type="button" className={cx("rfill-toggle", picked.has(t) && "is-on")} aria-pressed={picked.has(t)} onClick={() => toggle(t)}>
                  {picked.has(t) ? <Icon icon={Icons.check} size="sm" /> : null}{t}
                </button>
              ))}
            </div>
            <div className="rfill-sugg__actions">
              <Button size="sm" variant="primary" loading={busy} disabled={!chosen.length} title={chosen.length ? undefined : "Tick at least one title first."} onClick={() => void add()}>
                {`Add ${chosen.length} ${chosen.length === 1 ? "title" : "titles"}`}
              </Button>
              <Text role="body-sm" muted as="span">From your resume. Tick or untick any first.</Text>
            </div>
          </div>
        ) : asked ? <Text role="body-sm" muted as="p">{note || (data.related_titles?.length ? "Every suggested title is already in your list." : "Claude didn't suggest other titles this time.")}</Text> : null
      ) : null}
      {note && offered.length ? <Text role="body-sm" as="p" aria-live="polite">{note}</Text> : null}
      {error ? <p className="rfill-error" role="alert">{error}</p> : null}
    </div>
  );
}
