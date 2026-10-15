import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Icon, Icons, Text, cx } from "@careeros/brand";
import { isActiveRun, type ActionTarget, type ClaudeRunView, type SettingsChange } from "@careeros/contract";
import { errorText, useBridge, useLoad } from "../bridge-context";
import { useClaudeRun, formatElapsed } from "../claude";
import { getPath } from "../components/FieldForm";
import { CLAUDE_SETTINGS, navigate } from "../router";

const TARGET: ActionTarget = { kind: "workspace" };
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const has = (list: string[], x: string) => list.some((y) => y.toLowerCase() === x.toLowerCase());

/** The run's time so far: main's figure, counted on locally every second between updates (as the run panel does). */
export function useElapsed(run: ClaudeRunView | null, active: boolean): number {
  const base = useRef<{ id: string; ms: number; at: number } | null>(null);
  const [, setTick] = useState(0);
  if (run && (base.current?.id !== run.id || base.current.ms !== run.elapsed_ms)) base.current = { id: run.id, ms: run.elapsed_ms, at: Date.now() };
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(t);
  }, [active]);
  if (!run || !base.current) return 0;
  return active ? base.current.ms + (Date.now() - base.current.at) : run.elapsed_ms;
}

/**
 * The optional second step: Claude reads the resume copy in the workspace (no web) and suggests job titles and
 * skills. While it works, one fixed-size status chip sits where the button was; nothing expands. Suggestions are
 * only added to the profile when the person picks them.
 */
export function SuggestTargets({ profile }: { profile: Record<string, unknown> }) {
  const bridge = useBridge();
  const c = useClaudeRun("suggest_targets", TARGET);
  const run = c.run;
  const active = !!run && isActiveRun(run.status);
  const elapsed = useElapsed(run, active);
  const sugg = useLoad((b) => b.profile.suggestions(), [run?.id, run?.status], ["claude", "settings"]);
  const roles = strings(getPath(profile, "targets.roles"));
  const keywords = strings(getPath(profile, "targets.keywords"));
  const seniority = String(getPath(profile, "targets.seniority") ?? "");
  const data = sugg.data ?? null;
  const offered = useMemo(() => ({
    roles: (data?.roles ?? []).filter((r) => !has(roles, r)),
    keywords: (data?.keywords ?? []).filter((k) => !has(keywords, k)),
  }), [data, roles, keywords]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // New suggestions start with everything not in the profile ticked.
  useEffect(() => { setPicked(new Set([...offered.roles.map((r) => `r:${r}`), ...offered.keywords.map((k) => `k:${k}`)])); }, [data?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState<"start" | "add" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy("start"); setNote(null); setError(null);
    try { await c.start(); } catch { /* c.error shows it */ } finally { setBusy(null); }
  };
  const toggle = (key: string) => setPicked((p) => { const n = new Set(p); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const add = async () => {
    const r = offered.roles.filter((x) => picked.has(`r:${x}`));
    const k = offered.keywords.filter((x) => picked.has(`k:${x}`));
    const changes: SettingsChange[] = [];
    if (r.length) changes.push({ path: "targets.roles", value: [...roles, ...r] });
    if (k.length) changes.push({ path: "targets.keywords", value: [...keywords, ...k] });
    if (!seniority && data?.seniority) changes.push({ path: "targets.seniority", value: data.seniority });
    if (!changes.length) return;
    setBusy("add"); setError(null);
    try {
      await bridge.settings.save("profile", changes);
      setNote(`Added to your profile: ${[r.length ? `${r.length} ${r.length === 1 ? "role" : "roles"}` : "", k.length ? `${k.length} ${k.length === 1 ? "skill" : "skills"}` : ""].filter(Boolean).join(" and ") || "seniority"}. They're under Target roles and Keywords below.`);
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  };

  const engine = c.engine;
  const failed = run && (run.status === "failed" || run.status === "cancelled");
  const chipText = run?.status === "queued" ? "Waiting for Claude…" : failed ? (run.status === "cancelled" ? "Stopped" : "Claude didn't finish") : "Reading your resume…";
  const anyOffered = offered.roles.length + offered.keywords.length > 0 || (!seniority && !!data?.seniority);

  return (
    <section className="rfill-sugg" aria-labelledby="rfill-sugg-title">
      <div className="rfill-sugg__bar">
        <div className="rfill-sugg__intro">
          <Text role="body" as="h4" id="rfill-sugg-title" className="rfill-sugg__title">Not sure what to search for?</Text>
          <Text role="body-sm" muted as="p">Claude can suggest job titles and skills from your resume. It reads only that copy of your resume and doesn't use the web.</Text>
        </div>
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
            <Button icon={Icons.ai} onClick={() => navigate(CLAUDE_SETTINGS)} title="Claude Code needs a one-time setup first.">Claude setup</Button>
          ) : (
            <Button icon={Icons.ai} loading={busy === "start"} disabled={!engine} title={!engine ? "Checking whether Claude is set up…" : undefined} onClick={() => void start()}
              data-tour="settings-resume-suggest">
              {data ? "Suggest again" : "Suggest targets"}
            </Button>
          )}
        </div>
      </div>
      {failed && run?.status === "failed" && run.error ? <Text role="body-sm" muted as="p" className="rfill-sugg__why">{run.error}</Text> : null}
      {c.error && !active ? <p className="rfill-error" role="alert">{c.error}</p> : null}

      {data ? (
        <div className="rfill-sugg__result">
          {anyOffered ? (
            <>
              {offered.roles.length ? (
                <fieldset className="rfill-sugg__group">
                  <legend className="rfill-sugg__legend">Job titles</legend>
                  <div className="rfill-chips">
                    {offered.roles.map((r) => (
                      <button key={r} type="button" className={cx("rfill-toggle", picked.has(`r:${r}`) && "is-on")} aria-pressed={picked.has(`r:${r}`)} onClick={() => toggle(`r:${r}`)}>
                        {picked.has(`r:${r}`) ? <Icon icon={Icons.check} size="sm" /> : null}{r}
                      </button>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              {offered.keywords.length ? (
                <fieldset className="rfill-sugg__group">
                  <legend className="rfill-sugg__legend">Skills to search for</legend>
                  <div className="rfill-chips">
                    {offered.keywords.map((k) => (
                      <button key={k} type="button" className={cx("rfill-toggle", picked.has(`k:${k}`) && "is-on")} aria-pressed={picked.has(`k:${k}`)} onClick={() => toggle(`k:${k}`)}>
                        {picked.has(`k:${k}`) ? <Icon icon={Icons.check} size="sm" /> : null}{k}
                      </button>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              {!seniority && data.seniority ? <Text role="body-sm" muted as="p">Seniority: {data.seniority}. It's added too, since your profile doesn't say yet.</Text> : null}
              <div className="rfill-sugg__actions">
                <Button variant="primary" loading={busy === "add"} disabled={!picked.size && !(!seniority && data.seniority)} onClick={() => void add()}
                  title={!picked.size ? "Tick at least one suggestion first." : "Add to my profile"}>Add selected</Button>
                <Text role="body-sm" muted as="span">Tick or untick any of them first.</Text>
              </div>
            </>
          ) : (
            <Text role="body-sm" muted as="p">{note ?? "Everything Claude suggested is already in your profile."}</Text>
          )}
          {note && anyOffered ? <Text role="body-sm" as="p" aria-live="polite">{note}</Text> : null}
          {error ? <p className="rfill-error" role="alert">{error}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
