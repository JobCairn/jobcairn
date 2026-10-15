import { Button, Card, Icon, Icons, Text } from "@careeros/brand";
import type { VideoDraftView } from "@careeros/contract";
import { useAction, useBridge } from "../bridge-context";
import { TimeTaken } from "./TimeTaken";

type Stopped = NonNullable<VideoDraftView["stopped"]>;

/** The heading for a stopped video: what stopped, in the person's words. */
export function stoppedTitle(s: Stopped): string {
  if (s.stage === "lint") return "The video check hit a problem";
  if (s.stage === "draft" || s.stage === "final") return "The video stopped while rendering";
  if (s.stage === "narrate") return "The narration didn't finish";
  return `Making the video stopped at "${s.label}"`;
}

/** The reason without its technical tail: "The video check found 1 problem" from "...problem. First: ...". */
export function plainReason(reason: string): string {
  const text = String(reason ?? "").replace(/\s+/g, " ").trim();
  const first = text.split(/(?<=\.)\s/)[0] ?? "";
  return first || "Something went wrong while making the video.";
}

/**
 * Making the video stopped after the script was done. Says so first, with the reason, that the script is fine, and
 * what to do: try again from the failed step, make it without the check (when the check stopped it), or see the
 * details. Never the review page as if nothing happened.
 */
export function StoppedCard({ stopped, folder, onRetried, timings }: { stopped: Stopped; folder: string; onRetried(): void; timings?: VideoDraftView["timings"] }) {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const what = stopped.quality === "final" ? "the final video" : "the draft";
  const retry = (skip: boolean) => run(skip ? "retry-skip" : "retry", async () => {
    await bridge.video.retry(folder, skip ? { skip_check: true } : {});
    onRetried();
  }, skip ? `Making ${what} without the layout check` : `Trying ${what} again`);
  const reason = plainReason(stopped.reason);
  const more = stopped.reason.trim() !== reason ? stopped.reason.trim() : "";
  return (
    <Card role="alert" className="video-stopped" aria-labelledby="video-stopped-title" data-testid="video-stopped">
      <div className="video-stopped__head">
        <Icon icon={Icons.info} size="sm" />
        <div className="stack video-stopped__text">
          <Text role="heading-2" as="h2" id="video-stopped-title">{stoppedTitle(stopped)}</Text>
          <Text role="body">{reason.replace(/\.?$/, ".")} Your script is fine.</Text>
          <Text role="body-sm" muted>
            Finished steps are kept, so trying again starts from &ldquo;{stopped.label}&rdquo;.
          </Text>
        </div>
      </div>
      <div className="row video-stopped__actions">
        <Button variant="primary" icon={Icons.redo} loading={busy === "retry"} disabled={busy === "retry-skip"} onClick={() => void retry(false)}>Try again</Button>
        {stopped.can_skip_check ? (
          <Button loading={busy === "retry-skip"} disabled={busy === "retry"} onClick={() => void retry(true)}
            title="Skips the layout and contrast check this once. The quick check for broken scenes still runs.">Skip check</Button>
        ) : null}
      </div>
      <details className="video-details video-stopped__details">
        <summary><Text role="body-sm" as="span">Show details</Text></summary>
        <dl className="video-stopped__facts">
          <dt>Stopped at</dt><dd>{stopped.label}</dd>
          <dt>Making</dt><dd>{stopped.quality === "final" ? "The final video" : "A draft video"}</dd>
          <dt>What it said</dt><dd>{more || reason}</dd>
        </dl>
        <TimeTaken timings={timings} embedded />
      </details>
    </Card>
  );
}
