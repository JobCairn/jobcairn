import { Text } from "@careeros/brand";
import type { VideoDraftView } from "@careeros/contract";
import { took } from "./RunProgress";

type Timings = NonNullable<VideoDraftView["timings"]>;

/** "8:35" for the summary, or null when there is nothing to show. */
export function timeTakenLine(t: Timings | null | undefined): string | null {
  if (!t || !t.slowest.length) return null;
  return t.total_ms ? `Time taken: ${took(t.total_ms)}` : "Where the time went";
}

/** The parts of a step, slowest first: "Render 2:30 · Contact sheet 0:03". One part is just its name (its time is
 * the step's). Empty when it has none. */
export function partsLine(parts: Timings["slowest"][number]["parts"]): string {
  if (parts.length === 1) return parts[0]!.name;
  return [...parts].sort((a, b) => b.ms - a.ms).map((p) => `${p.name} ${took(p.ms)}`).join(" · ");
}

/**
 * Where the time went on the last run: the total, then the slowest steps (most first) with what each spent its time
 * on. Folded away by default, so it is there when a video felt slow and out of the way otherwise.
 */
export function TimeTaken({ timings, embedded = false }: { timings: Timings | null | undefined; embedded?: boolean }) {
  const line = timeTakenLine(timings);
  if (!line || !timings) return null;
  const list = (
    <div className="video-time__body">
      <Text role="body-sm" muted>Slowest steps</Text>
      <ol className="vstep video-time__list" aria-label="Slowest steps">
        {timings.slowest.map((s) => {
          const parts = partsLine(s.parts);
          return (
            <li key={s.stage} className="vstep__row video-time__row">
              <span className="vstep__label">{s.label}{parts ? <span className="video-time__parts">{parts}</span> : null}</span>
              <span className="vstep__time">{took(s.ms)}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
  if (embedded) return <div className="video-time video-time--embedded" data-testid="video-time"><Text role="body-sm" as="span">{line}</Text>{list}</div>;
  return (
    <details className="video-details video-time" data-testid="video-time">
      <summary><Text role="body-sm" as="span">{line}</Text></summary>
      {list}
    </details>
  );
}
