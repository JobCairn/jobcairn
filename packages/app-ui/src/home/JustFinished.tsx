import { Button, Card, Icons, SectionTitle, Text } from "@careeros/brand";
import { useActivity } from "../claude";
import { fmtDateTime } from "../format";
import { navigate } from "../router";

const STATUS: Record<string, string> = { done: "Done", review: "Script ready for your review", failed: "Didn't finish", stopped: "Stopped" };

/**
 * Home's "Just finished": the last few things Claude finished in this workspace, each with a link to its result,
 * so a score or a video made while you were elsewhere is one click away. Hidden until something has finished.
 */
export function JustFinished({ limit = 3 }: { limit?: number }) {
  const activity = useActivity();
  const recent = (activity?.history ?? []).slice(0, limit);
  if (!recent.length) return null;
  return (
    <Card className="home-card just-finished" aria-labelledby="just-finished-title">
      <SectionTitle icon={Icons.activity} title="Just finished" id="just-finished-title"
        status={<Button size="sm" variant="ghost" onClick={() => activity?.openDrawer()}>See all</Button>} />
      <ul className="list-plain just-finished__list">
        {recent.map((h) => (
          <li key={h.id} className="just-finished__row">
            <span className="grow">
              <Text role="body" as="span" className="just-finished__label">{h.label}</Text>
              <Text role="body-sm" muted as="span"> · {STATUS[h.status] ?? h.status} · {fmtDateTime(h.ended_at)}</Text>
            </span>
            {h.open.to
              ? <Button size="sm" variant="secondary" aria-label={`${h.open.label}: ${h.label}`} onClick={() => navigate(h.open.to!)}>{h.open.label}</Button>
              : <Button size="sm" variant="ghost" aria-label={`Details: ${h.label}`} onClick={() => activity?.openDrawer(h.id.replace(/^[a-z]+:/, ""))}>Details</Button>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
