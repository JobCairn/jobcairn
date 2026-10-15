import { useEffect, useId, useRef, useState } from "react";
import { Button, Dialog, Icon, Icons, Pill, Text, type IconGlyph } from "@careeros/brand";
import { guideUrl, JOURNEYS, useVideoState, type Journey } from "./journeys";
import "./tour.css";

const GLYPH: Record<string, IconGlyph> = {
  "find-and-score": Icons.jobs, "tailor-and-apply": Icons.file, "interview-prep": Icons.interview, "track-everything": Icons.home,
};

function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** A still poster: the bundled image when there is one, otherwise a calm drawn card. Never animated. */
export function JourneyPoster({ journey, soon }: { journey: Journey; soon: boolean }) {
  const [broken, setBroken] = useState(soon);
  useEffect(() => setBroken(soon), [soon]);
  return (
    <span className="journey-poster" aria-hidden="true">
      {broken ? (
        <span className="journey-poster__drawn"><Icon icon={GLYPH[journey.id] ?? Icons.video} /></span>
      ) : (
        <img className="journey-poster__img" src={guideUrl(journey.poster)} alt="" onError={() => setBroken(true)} />
      )}
      {soon ? null : <span className="journey-poster__play"><Icon icon={Icons.play} size="sm" /></span>}
    </span>
  );
}

/**
 * The in-app player: captions on, the video's own play, pause and scrub controls, Esc to close, focus back where
 * it was. A missing or unplayable file shows a "coming soon" note instead of a broken player.
 */
export function JourneyPlayer({ journey, onClose }: { journey: Journey | null; onClose: () => void }) {
  const state = useVideoState(journey);
  const [failed, setFailed] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const descId = useId();
  useEffect(() => setFailed(false), [journey]);
  // Captions start on.
  useEffect(() => {
    const v = video.current;
    if (!v || !v.textTracks) return;
    for (const t of Array.from(v.textTracks)) t.mode = "showing";
  }, [state, journey]);
  if (!journey) return null;
  const playable = state === "ready" && !failed;
  return (
    <Dialog open onClose={onClose} title={journey.title} actions={<Button onClick={onClose}>Close</Button>}>
      <div className="journey-player">
        {playable ? (
          <video ref={video} className="journey-player__video" src={guideUrl(journey.video)} controls autoPlay={!reducedMotion()} preload="metadata" playsInline
            poster={guideUrl(journey.poster)} controlsList="nodownload noremoteplayback noplaybackrate" disablePictureInPicture
            aria-describedby={descId} onError={() => setFailed(true)}>
            <track kind="captions" src={guideUrl(journey.captions)} srcLang="en" label="English" default />
          </video>
        ) : (
          <div className="journey-player__soon" role="status">
            <JourneyPoster journey={journey} soon />
            <Text role="body">
              {state === "checking" ? "Getting the video ready…" : "This video is coming soon. In the meantime, Show me around on any page walks you through it step by step."}
            </Text>
          </div>
        )}
        <Text role="body-sm" muted id={descId}>{journey.description} · {journey.length}</Text>
      </div>
    </Dialog>
  );
}

function JourneyCard({ journey, onPlay }: { journey: Journey; onPlay: (j: Journey) => void }) {
  const state = useVideoState(journey);
  const ready = state === "ready";
  const body = (
    <>
      <JourneyPoster journey={journey} soon={!ready} />
      <span className="journey-card__text">
        <span className="journey-card__title">{journey.title}</span>
        <span className="journey-card__meta">{ready ? journey.length : state === "checking" ? journey.length : "Video coming soon"}</span>
      </span>
    </>
  );
  return ready ? (
    <button type="button" className="journey-card" aria-label={`Watch: ${journey.title}, ${journey.length}`} onClick={() => onPlay(journey)}>{body}</button>
  ) : (
    <div className="journey-card is-soon" aria-label={`${journey.title}: video coming soon`}>{body}</div>
  );
}

/**
 * The guide videos. "welcome": a light "See how it works" row for the first screen (never in the way of Get started).
 * "settings": every journey with its description, for Settings.
 */
export function JourneyVideos({ variant }: { variant: "welcome" | "settings" }) {
  const [playing, setPlaying] = useState<Journey | null>(null);
  const headId = useId();
  const player = <JourneyPlayer journey={playing} onClose={() => setPlaying(null)} />;
  if (variant === "welcome") {
    return (
      <section className="journeys journeys--welcome" aria-labelledby={headId}>
        <Text role="label" as="h2" id={headId}>See how it works</Text>
        <ul className="journeys__row">
          {JOURNEYS.map((j) => <li key={j.id}><JourneyCard journey={j} onPlay={setPlaying} /></li>)}
        </ul>
        {player}
      </section>
    );
  }
  return (
    <section className="journeys journeys--settings stack" aria-labelledby={headId}>
      <Text role="body" className="t-strong" as="h3" id={headId}>Guide videos</Text>
      <Text role="body-sm" muted>A minute each, following a made-up job search from start to finish.</Text>
      <ul className="list-plain journeys__list">
        {JOURNEYS.map((j) => <JourneyRow key={j.id} journey={j} onPlay={setPlaying} />)}
      </ul>
      {player}
    </section>
  );
}

function JourneyRow({ journey, onPlay }: { journey: Journey; onPlay: (j: Journey) => void }) {
  const state = useVideoState(journey);
  return (
    <li className="journeys__item">
      <JourneyPoster journey={journey} soon={state !== "ready"} />
      <span className="grow">
        <Text role="body" as="div">{journey.title}</Text>
        <Text role="body-sm" muted as="div">{journey.description}</Text>
      </span>
      {state === "ready"
        ? <Button size="sm" icon={Icons.play} aria-label={`Watch: ${journey.title}, ${journey.length}`} onClick={() => onPlay(journey)}>Watch · {journey.length}</Button>
        : <Pill>{state === "checking" ? journey.length : "Coming soon"}</Pill>}
    </li>
  );
}
