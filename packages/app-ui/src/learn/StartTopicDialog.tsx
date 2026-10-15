import { useEffect, useState, type FormEvent } from "react";
import { Button, Dialog, Input, Text } from "@careeros/brand";
import { topicLabel, topicSlug, type ActionTarget, type SkillSuggestion } from "@careeros/contract";
import { useAction, useBridge } from "../bridge-context";
import { ClaudeRunPanel, useClaudeEngine } from "../claude";

export const EXAMPLE_TOPICS = ["Kubernetes basics", "System design for LLM apps", "SQL window functions", "Behavioural interview answers"];

export interface StartTopicDialogProps {
  open: boolean;
  onClose: () => void;
  /** Text to start with, for example a gap the person clicked. */
  initial?: string;
  suggestions: SkillSuggestion[];
  /** Called with the topic once Claude has started on it, so Learn can follow the run. */
  onStarted?: (target: Extract<ActionTarget, { kind: "topic" }>) => void;
}

/** Asks Claude for a study guide on any topic. The guide lands in learning/<topic>/guide.md and shows up in Learn. */
export function StartTopicDialog({ open, onClose, initial = "", suggestions, onStarted }: StartTopicDialogProps) {
  const bridge = useBridge();
  const engine = useClaudeEngine();
  const { busy: running, run } = useAction();
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | undefined>();
  const [setup, setSetup] = useState(false);
  useEffect(() => { if (open) { setText(initial); setError(undefined); setSetup(false); } }, [open, initial]);

  const label = text.trim() ? topicLabel(text) : "";
  const target = { kind: "topic" as const, topic: topicSlug(label || "topic"), label: label || "topic" };
  const busy = running === "study_topic";
  const picks = suggestions.length ? suggestions.filter((s) => !s.started).map((s) => s.skill).slice(0, 6) : EXAMPLE_TOPICS;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!label) { setError("Type a topic, or pick one below."); return; }
    // The topic is typed here, so the run goes straight to the bridge; Learn follows it with a fixed-topic panel.
    if (!engine.data?.ready) { setSetup(true); return; }
    const r = await run("study_topic", () => bridge.claude.run("study_topic", target, {}));
    if (r) { onStarted?.(target); onClose(); }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Start a topic"
      actions={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} title="Ask Claude for a study guide" onClick={() => void submit()}>Ask Claude</Button>
        </>
      )}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <Input label="What do you want to learn?" placeholder="For example: Kubernetes basics" value={text} maxLength={80} error={error}
          onChange={(e) => { setText(e.target.value); setError(undefined); }}
          help="Claude writes a study guide with examples, a one-week plan and how to talk about it in interviews. It shows up in Learn when it's saved." />
        <div className="stack">
          <Text role="label">{suggestions.length ? "Asked for in your saved jobs" : "Ideas"}</Text>
          <div className="topic-chips">
            {picks.map((p) => (
              <button key={p} type="button" className="topic-chip" aria-pressed={label === p} onClick={() => { setText(p); setError(undefined); }}>{p}</button>
            ))}
          </div>
        </div>
        {setup ? <ClaudeRunPanel action="study_topic" target={target} compact /> : null}
      </form>
    </Dialog>
  );
}
