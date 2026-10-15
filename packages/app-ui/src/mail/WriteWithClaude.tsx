import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, Icon, Icons, Text, cx } from "@careeros/brand";
import { isActiveRun, NOTE_MAX, noteProblems, optionsFor, outputNames, type ActionTarget, type DraftAssist } from "@careeros/contract";
import { errorText, useBridge } from "../bridge-context";
import { formatElapsed, useClaudeRun } from "../claude";
import { useElapsed } from "../resumefill/SuggestTargets";
import { CLAUDE_SETTINGS, navigate } from "../router";

export type EmailPurpose = "application" | "follow_up" | "thank_you" | "reply" | "question" | "negotiate" | "custom";
export type EmailChange = "new" | "shorter" | "warmer" | "formal" | "grammar";

/** The purposes, in the catalogue's order and words (request.ts draft_email). */
export const PURPOSES: { value: EmailPurpose; label: string }[] = (() => {
  const o = optionsFor("draft_email").find((x) => x.key === "purpose");
  return o?.kind === "select" ? o.choices.map((c) => ({ value: c.value as EmailPurpose, label: c.label })) : [];
})();
/** Quick changes to the text already there. Two words at most each. */
export const CHANGES: { value: Exclude<EmailChange, "new">; label: string; done: string }[] = [
  { value: "shorter", label: "Shorter", done: "Made shorter" },
  { value: "warmer", label: "Warmer", done: "Made warmer" },
  { value: "formal", label: "More formal", done: "Made more formal" },
  { value: "grammar", label: "Fix grammar", done: "Grammar fixed" },
];
/** Purposes where the "what to say" box is the point, not an extra. */
const NEEDS_NOTE: EmailPurpose[] = ["question", "custom"];

export interface Applied { subject: string; body: string; to?: string }

/**
 * "Write with Claude" at the top of the email composer. Pick what the email is for, add what to say if you like, then
 * Draft; or rework the text already there (Shorter, Warmer, More formal, Fix grammar). It runs the draft_email action
 * through the usual Claude engine: the composer's draft is saved first (Claude reads that file, and the email it
 * answers, as data), and Claude's suggestion fills the fields. Nothing is sent: sending stays Review and send.
 */
export function WriteWithClaude({ slug, id, initialPurpose, hasBody, toEmpty, save, onApply, onUndo, canUndo }: {
  slug: string; id: string; initialPurpose: EmailPurpose; hasBody: boolean; toEmpty: boolean;
  /** Saves the composer's draft and returns its id (Claude reads the saved copy). Throws a plain message. */
  save: () => Promise<string>;
  onApply: (a: Applied, what: string) => void;
  onUndo: () => void;
  canUndo: boolean;
}) {
  const bridge = useBridge();
  const target = useMemo<ActionTarget>(() => ({ kind: "job", company_slug: slug, id }), [slug, id]);
  const c = useClaudeRun("draft_email", target);
  const [purpose, setPurpose] = useState<EmailPurpose>(initialPurpose);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<EmailChange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** The run this composer started, and what it was for: only its result is ever applied. */
  const mine = useRef<{ runId: string; started: string; change: EmailChange } | null>(null);
  const noteId = useId();
  const run = c.run;
  const active = !!run && isActiveRun(run.status);
  const ownActive = active && mine.current?.runId === run.id;
  const elapsed = useElapsed(run, ownActive);
  const problems = note.trim() ? noteProblems(note, outputNames("draft_email")) : [];
  const needsNote = NEEDS_NOTE.includes(purpose) && !note.trim();

  // When the run this composer started finishes, read Claude's suggestion and fill the fields (never on mount).
  useEffect(() => {
    const m = mine.current;
    if (!m || !run || run.id !== m.runId || isActiveRun(run.status)) return;
    mine.current = null;
    if (run.status !== "succeeded") {
      setBusy(null);
      setError(run.status === "cancelled" ? null : run.error || "Claude didn't finish. Try again.");
      return;
    }
    void (async () => {
      let a: DraftAssist;
      try { a = await bridge.mail.drafts.assist(slug, id); } catch (e) { setError(errorText(e)); setBusy(null); return; }
      setBusy(null);
      if (!a.suggestion || Date.parse(a.suggestion.at) < Date.parse(m.started) - 1_000) { setError(a.problem || "Claude didn't write a draft. Try again."); return; }
      const to = toEmpty && a.recipient ? (a.recipient.name ? `${a.recipient.name} <${a.recipient.address}>` : a.recipient.address) : undefined;
      const what = m.change === "new" ? "Drafted by Claude" : `${CHANGES.find((x) => x.value === m.change)?.done ?? "Changed"} by Claude`;
      onApply({ subject: a.suggestion.subject, body: a.suggestion.body, ...(to ? { to } : {}) }, what);
      setDone(what);
    })();
  }, [run, bridge, slug, id, toEmpty, onApply]);

  const start = async (change: EmailChange) => {
    setError(null); setDone(null);
    if (problems.length) { setError(problems[0]!); return; }
    setBusy(change);
    try {
      const draftId = await save();
      // Explicit options every time: an empty request would make the engine reuse saved ones.
      const r = await c.start({ options: { purpose, mode: change, draft_id: draftId }, note: change === "new" ? note : "" });
      mine.current = { runId: r.id, started: r.started_at, change };
    } catch (e) {
      setBusy(null);
      setError(errorText(e));
    }
  };

  const engine = c.engine;
  const notReady = !!engine && !engine.ready;
  const off = !engine || notReady || active || busy !== null;
  const offWhy = !engine ? "Checking whether Claude is set up…" : notReady ? "Claude Code needs a one-time setup first." : active ? "Claude is still working on this job's email." : undefined;

  return (
    <section className="wwc" aria-labelledby={`${noteId}-title`}>
      <div className="wwc__head">
        <Icon icon={Icons.ai} size="sm" />
        <Text role="label" as="h3" id={`${noteId}-title`} className="wwc__title">Write with Claude</Text>
        <Text role="body-sm" muted as="span" className="wwc__sub">Uses only your profile, resume and this job.</Text>
      </div>

      <div className="wwc__purposes" role="radiogroup" aria-label="What the email is for">
        {PURPOSES.map((p, i) => (
          <button key={p.value} type="button" role="radio" aria-checked={purpose === p.value} className={cx("chip-toggle", purpose === p.value && "is-active")}
            tabIndex={purpose === p.value ? 0 : -1} onClick={() => setPurpose(p.value)}
            onKeyDown={(e) => {
              // The radio group pattern: one tab stop, arrow keys move and pick.
              const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              const next = PURPOSES[(i + step + PURPOSES.length) % PURPOSES.length]!;
              setPurpose(next.value);
              (e.currentTarget.parentElement?.children[(i + step + PURPOSES.length) % PURPOSES.length] as HTMLElement | undefined)?.focus();
            }}>
            {purpose === p.value ? <Icon icon={Icons.check} size="sm" /> : null}{p.label}
          </button>
        ))}
      </div>

      <div className="wwc__ask">
        <div className="field wwc__note">
          <label className="sr-only" htmlFor={noteId}>What to say</label>
          <input id={noteId} className="input" value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)}
            placeholder={NEEDS_NOTE.includes(purpose) ? (purpose === "question" ? "What do you want to ask?" : "What should the email say?") : "Anything to mention? (optional)"}
            aria-invalid={problems.length ? true : undefined} aria-describedby={problems.length ? `${noteId}-why` : undefined}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (!off && !needsNote) void start("new"); } }} />
        </div>
        {notReady ? (
          <Button icon={Icons.ai} onClick={() => navigate(CLAUDE_SETTINGS)} title="Claude Code needs a one-time setup first.">Claude setup</Button>
        ) : (
          <Button variant="secondary" icon={Icons.ai} loading={busy === "new"} disabled={off || needsNote || problems.length > 0}
            title={offWhy ?? (needsNote ? "Say what the email should say first." : "Draft the subject and message")} onClick={() => void start("new")}>
            Draft
          </Button>
        )}
      </div>
      {problems.length ? <p id={`${noteId}-why`} className="wwc__error" role="alert">{problems[0]}</p> : null}

      <div className="wwc__foot">
        <div className="wwc__changes" role="group" aria-label="Change the message">
          <span className="wwc__label" aria-hidden="true">Rewrite</span>
          {CHANGES.map((ch) => (
            <Button key={ch.value} size="sm" variant="secondary" loading={busy === ch.value} disabled={off || !hasBody}
              title={offWhy ?? (!hasBody ? "Write or draft a message first." : `${ch.label}: Claude keeps every fact`)} onClick={() => void start(ch.value)}>
              {ch.label}
            </Button>
          ))}
        </div>
        <div className="wwc__status" aria-live="polite">
          {ownActive ? (
            <span className="wwc__run" role="status">
              <span className="crun__pulse" aria-hidden="true" />
              <span>{run.status === "queued" ? "Waiting for Claude…" : "Claude is writing…"}</span>
              <span className="wwc__time" aria-label={`Time taken ${formatElapsed(elapsed)}`}>{formatElapsed(elapsed)}</span>
              <button type="button" className="wwc__link" onClick={() => void c.cancel()}>Cancel</button>
            </span>
          ) : done ? (
            <span className="wwc__done">
              <Icon icon={Icons.info} size="sm" />
              <span>{done}. Check it before sending.</span>
              {canUndo ? <button type="button" className="wwc__link" onClick={() => { onUndo(); setDone(null); }}>Undo</button> : null}
            </span>
          ) : null}
        </div>
      </div>
      {error ? <p className="wwc__error" role="alert">{error}</p> : null}
    </section>
  );
}
