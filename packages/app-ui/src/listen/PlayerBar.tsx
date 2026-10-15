import { Button, Icon, Text } from "@careeros/brand";
import { READ_ALOUD_SPEEDS } from "@careeros/contract";
import { useListenPlayer } from "./context";
import { Pause, Play, RotateCcw, SkipBack, SkipForward, Square, Volume2 } from "./icons";

export const speedLabel = (s: number) => `${s}×`;

/** The slim read-aloud bar pinned to the bottom of the window while something is being read. */
export function PlayerBar() {
  const p = useListenPlayer();
  if (!p || p.view.status === "idle") return null;
  const v = p.view;
  const where = `Part ${v.index + 1} of ${v.total}`;
  const state = v.status === "preparing" ? (v.wait ?? "Preparing voice…") : v.status === "paused" ? `Paused · ${where}` : v.status === "error" ? (v.error ?? "Something went wrong.") : where;
  const last = v.index + 1 >= v.total;
  // A slow start or a failure can always switch to the Mac's own voice, which starts at once.
  const offerMac = !v.macVoice && ((v.status === "preparing" && !!v.wait) || v.status === "error");
  return (
    <section className="listen-bar" role="region" aria-label="Read aloud">
      <div className="listen-bar__what">
        <Icon icon={Volume2} size="sm" className="listen-bar__glyph" />
        <div className="listen-bar__text">
          <Text role="body-sm" as="div" truncate title={v.title}>{v.title}</Text>
          <Text role="body-sm" as="div" muted className={v.status === "error" ? "listen-bar__error" : undefined}>
            <span aria-live="polite">{v.status === "preparing" ? <span className="listen-bar__spinner" aria-hidden="true" /> : null}{state}</span>
            {v.note ? <span className="listen-bar__note"> · {v.note}</span> : null}
          </Text>
        </div>
      </div>
      <div className="listen-bar__controls">
        {offerMac ? <Button size="sm" variant="secondary" title="Use the Mac voice instead" onClick={p.switchToMac}>Mac voice</Button> : null}
        <Button size="sm" variant="ghost" icon={SkipBack} aria-label={v.index === 0 ? "Restart this part" : "Previous part"} title={v.index === 0 ? "Restart this part" : "Previous part"} onClick={p.prev} />
        {v.status === "error" ? (
          <Button size="sm" variant="primary" icon={RotateCcw} onClick={p.toggle}>Try again</Button>
        ) : (
          <Button size="sm" variant="primary" icon={v.status === "paused" ? Play : Pause} onClick={p.toggle}>
            {v.status === "paused" ? "Play" : "Pause"}
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={SkipForward} aria-label={last ? "Finish" : "Next part"} title={last ? "Finish" : "Next part"} onClick={last ? p.stop : p.next} />
        <label className="listen-bar__speed">
          <span className="sr-only">Speed</span>
          <select className="input select listen-bar__select" value={String(v.speed)} aria-label="Speed" onChange={(e) => p.setSpeed(Number(e.target.value))}>
            {READ_ALOUD_SPEEDS.map((s) => <option key={s} value={String(s)}>{speedLabel(s)}</option>)}
          </select>
        </label>
        <Button size="sm" variant="ghost" icon={Square} aria-label="Stop reading" title="Stop reading" onClick={p.stop}>Stop</Button>
      </div>
    </section>
  );
}
