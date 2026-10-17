import { useEffect, useState, type FormEvent } from "react";
import { Button, Dialog, Input, Text, Textarea, useToast } from "@careeros/brand";
import {
  noteProblems, outputNames, researchRequest, RESEARCH_QUESTIONS_MAX, topicLabel, type ResearchDepth, type ResearchTopic,
} from "@careeros/contract";
import { errorText, useAction, useBridge } from "../bridge-context";
import { ClaudeRunPanel, useClaudeEngine } from "../claude";

/** Ideas for the topic box (plain examples, nothing about the person). */
export const RESEARCH_IDEAS = [
  "Express Entry in Canada for software engineers",
  "Skilled visa 482 vs 186",
  "Salary bands for ML engineers in Sydney",
  "Graduate programs in data science in Melbourne",
];

const DEPTHS: { value: ResearchDepth; label: string; help: string }[] = [
  { value: "quick", label: "Quick", help: "A one-page brief" },
  { value: "thorough", label: "Thorough", help: "More sources, more depth" },
];

/** The depth choice as a two-way switch (a radio group). */
export function DepthPicker({ value, onChange }: { value: ResearchDepth; onChange: (d: ResearchDepth) => void }) {
  return (
    <div className="stack">
      <Text role="label" id="research-depth-label">Depth</Text>
      <div className="research-depth" role="radiogroup" aria-labelledby="research-depth-label">
        {DEPTHS.map((d) => (
          <button key={d.value} type="button" role="radio" aria-checked={value === d.value} className="research-depth__item" title={d.help} onClick={() => onChange(d.value)}>
            {d.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface NewResearchDialogProps {
  open: boolean;
  onClose: () => void;
  /** Text to start with (an idea the person clicked). */
  initial?: string;
  /** Called once the topic is saved and Claude has started on it. */
  onStarted: (topic: ResearchTopic) => void;
}

/**
 * New research: a topic, optional questions and Quick or Thorough. The app saves the topic (research/<slug>/topic.json),
 * then asks Claude to research it (research_topic, a web run).
 */
export function NewResearchDialog({ open, onClose, initial = "", onStarted }: NewResearchDialogProps) {
  const bridge = useBridge();
  const toast = useToast();
  const engine = useClaudeEngine();
  const { busy, run } = useAction();
  const [text, setText] = useState("");
  const [questions, setQuestions] = useState("");
  const [depth, setDepth] = useState<ResearchDepth>("quick");
  const [error, setError] = useState<string | undefined>();
  const [noteError, setNoteError] = useState<string | undefined>();
  const [setup, setSetup] = useState(false);
  useEffect(() => { if (open) { setText(initial); setQuestions(""); setDepth("quick"); setError(undefined); setNoteError(undefined); setSetup(false); } }, [open, initial]);

  const label = text.trim() ? topicLabel(text) : "";
  const working = busy === "research";

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!label || !/[\p{L}\p{N}]/u.test(text)) { setError("Type a topic, or pick an idea below."); return; }
    const problems = noteProblems(questions, outputNames("research_topic"));
    if (problems.length) { setNoteError(problems[0]); return; }
    if (!engine.data?.ready) { setSetup(true); return; }
    await run("research", async () => {
      let topic: ResearchTopic;
      try { topic = await bridge.research.create(label, questions, depth); } catch (err) { setError(errorText(err)); return; }
      // The topic is saved: open it even when the run can't start (its page offers Research again and says why).
      try {
        await bridge.claude.run("research_topic", { kind: "research", topic: topic.slug, label: topic.title }, researchRequest(topic));
      } catch (err) { toast({ tone: "danger", text: `Claude didn't start: ${errorText(err)}` }); }
      onStarted(topic);
      onClose();
    });
  };

  return (
    <Dialog open={open} onClose={onClose} title="New research"
      actions={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={working} title="Ask Claude to research this topic" onClick={() => void submit()}>Research</Button>
        </>
      )}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <Input label="What do you want to know about?" placeholder="For example: Express Entry in Canada" value={text} maxLength={80} error={error}
          onChange={(e) => { setText(e.target.value); setError(undefined); }}
          help="Claude reads official sources first, cites every fact and dates the report. You get a report you can read, export and turn into a video." />
        <div className="stack">
          <Text role="label">Ideas</Text>
          <div className="research-ideas">
            {RESEARCH_IDEAS.map((p) => (
              <button key={p} type="button" className="topic-chip" aria-pressed={label === p} onClick={() => { setText(p); setError(undefined); }}>{p}</button>
            ))}
          </div>
        </div>
        <Textarea label="Questions to answer (optional)" rows={3} maxLength={RESEARCH_QUESTIONS_MAX} value={questions} error={noteError}
          placeholder="For example: Which program suits a software engineer? How long does it usually take?"
          onChange={(e) => { setQuestions(e.target.value); setNoteError(undefined); }} />
        <DepthPicker value={depth} onChange={setDepth} />
        <Text role="body-sm" muted>General information only, not legal, migration or financial advice.</Text>
        {setup ? <ClaudeRunPanel action="research_topic" target={{ kind: "research", topic: "topic", label: label || "topic" }} compact /> : null}
      </form>
    </Dialog>
  );
}
