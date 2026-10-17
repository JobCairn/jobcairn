import { Button, Card, Icons, Pill, SectionTitle, Text } from "@careeros/brand";
import { REVIEW_REASON_TEXT, type ApplicationReview, type StretchChoice, type StretchState } from "@careeros/contract";
import { useAction, useBridge } from "../bridge-context";

/**
 * Claude's second pass over its own drafts (application/review.json, spec 2026-10-17-resume-checks): what it changed
 * and why, the bullets that are a stretch, and new facts from your note. Your answers are the confirmations: "It's
 * true" and "Save" add the fact to your work history, so later claim checks keep it.
 */

const DOC: Record<string, string> = { "resume.md": "Resume", "cover-letter.md": "Cover letter" };
const STATE_TEXT: Record<Exclude<StretchState, "open">, string> = { kept: "Kept: saved to your history", softened: "Softened", dropped: "Dropped" };
const DONE: Record<StretchChoice, string> = { keep: "Saved to your work history", soften: "Softened in your draft", drop: "Removed from your draft" };

export function ReviewCard({ slug, id, review, readOnly = false }: { slug: string; id: string; review: ApplicationReview; readOnly?: boolean }) {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const decide = (i: number, text: string, choice: StretchChoice) => run(`stretch-${i}-${choice}`, () => bridge.apply.stretch(slug, id, i, text, choice), DONE[choice]);
  const save = (i: number, fact: string) => run(`fact-${i}`, () => bridge.apply.saveFact(slug, id, i, fact), "Saved to your work history");
  const open = review.stretch.filter((s) => s.state === "open").length;
  return (
    <Card className="stack" aria-label="Claude's review">
      <SectionTitle icon={Icons.checklist} title="Review" />
      {review.notes ? <Text role="body">{review.notes}</Text> : null}

      {review.stretch.length ? (
        <div className="stack-tight">
          <Text role="label" as="div">{`Could you defend these in an interview? (${open} to answer)`}</Text>
          <Text role="body-sm" muted>Claude thinks these go further than your evidence shows. If it&apos;s true, say so and it&apos;s saved to your work history for next time.</Text>
          <ul className="list-plain review-list">
            {review.stretch.map((s, i) => (
              <li key={`${i}-${s.text}`} className="stack-tight">
                <Text role="body" as="div">{s.text}</Text>
                <Text role="body-sm" muted as="div">{`${DOC[s.file] ?? s.file}. ${s.why}`}</Text>
                {s.soften ? <Text role="body-sm" muted as="div">{`Softer: ${s.soften}`}</Text> : null}
                {s.state !== "open" ? <div><Pill tone={s.state === "kept" ? "success" : "neutral"}>{STATE_TEXT[s.state]}</Pill></div> : readOnly ? null : (
                  <div className="row">
                    <Button size="sm" variant="secondary" icon={Icons.check} loading={busy === `stretch-${i}-keep`} aria-label="It's true: keep it and save it to my work history" onClick={() => void decide(i, s.text, "keep")}>It&apos;s true</Button>
                    {s.soften ? <Button size="sm" variant="ghost" loading={busy === `stretch-${i}-soften`} aria-label="Use the softer wording" onClick={() => void decide(i, s.text, "soften")}>Soften</Button> : null}
                    <Button size="sm" variant="ghost" loading={busy === `stretch-${i}-drop`} aria-label="Drop this line from the draft" onClick={() => void decide(i, s.text, "drop")}>Drop</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : <Text role="body-sm" muted>No stretch claims: every bullet passed the interview test.</Text>}

      {review.facts.length ? (
        <div className="stack-tight">
          <Text role="label" as="div">New facts from your note</Text>
          <Text role="body-sm" muted>Save each one that&apos;s true, so later checks treat it as evidence.</Text>
          <ul className="list-plain review-list">
            {review.facts.map((f, i) => (
              <li key={`${i}-${f.fact}`} className="row">
                <Text role="body" as="span" className="grow">{f.fact}</Text>
                {f.saved ? <Pill tone="success">Saved</Pill> : readOnly ? null : (
                  <Button size="sm" variant="secondary" loading={busy === `fact-${i}`} aria-label={`Save to my work history: ${f.fact}`} onClick={() => void save(i, f.fact)}>Save</Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {review.edits.length ? (
        <details>
          <summary><Text role="label" as="span">{`Claude's edits (${review.edits.length})`}</Text></summary>
          <ul className="list-plain review-list">
            {review.edits.map((e, i) => (
              <li key={i} className="stack-tight">
                <div className="row"><Pill tone={e.reason === "grounding" ? "warning" : "neutral"}>{REVIEW_REASON_TEXT[e.reason]}</Pill><Text role="body-sm" muted as="span">{DOC[e.file] ?? e.file}</Text></div>
                <Text role="body-sm" as="div" className="review-edit__old">{e.old}</Text>
                <Text role="body-sm" as="div">{e.new || "(removed)"}</Text>
                {e.why ? <Text role="body-sm" muted as="div">{e.why}</Text> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
  );
}
