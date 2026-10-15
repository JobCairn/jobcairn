import { useEffect, useId, useState } from "react";
import { Icon, Icons, Text } from "@careeros/brand";
import {
  choiceFor, formatLength, makingTimeText, parseCustomLength, PRESET_LABELS, PRESET_SECONDS, presetsFor,
  type LengthChoice, type MakingRate, type VideoTypeView,
} from "@careeros/contract";

/** "this Mac" on a Mac, else "this computer". */
export function thisComputer(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  return /Mac/i.test(ua) ? "this Mac" : "this computer";
}

/**
 * Length for a video: the presets the type offers (Quick, Standard, In-depth) and a custom m:ss length, with how long
 * the video takes to make here. `onChange` gets the seconds, or null while the custom length can't be read.
 */
export function VideoLengthPicker({ type, making, onChange }: {
  type: Pick<VideoTypeView, "id" | "label" | "length" | "default_s">; making?: MakingRate; onChange(seconds: number | null): void;
}) {
  const name = useId();
  const customId = useId();
  const errorId = useId();
  const start = type.default_s ?? type.length.target_s;
  const [choice, setChoice] = useState<LengthChoice>(() => choiceFor(type.length, start));
  const [custom, setCustom] = useState(() => formatLength(start));
  const [touched, setTouched] = useState(false);
  useEffect(() => { setChoice(choiceFor(type.length, start)); setCustom(formatLength(start)); setTouched(false); }, [type.id, start]); // eslint-disable-line react-hooks/exhaustive-deps

  const presets = presetsFor(type.length);
  const parsed = parseCustomLength(custom, type.length, type.label);
  const seconds = choice === "custom" ? (parsed.ok ? parsed.seconds : null) : PRESET_SECONDS[choice];
  useEffect(() => { onChange(seconds); }, [seconds, onChange]);
  const showError = choice === "custom" && !parsed.ok && touched;

  return (
    <fieldset className="stack video-length" data-tour="video-length">
      <legend className="field__label">Length</legend>
      <div className="video-length__options">
        {presets.map((p) => (
          <label key={p} className="video-types__option video-length__option">
            <input type="radio" name={name} value={p} checked={choice === p} onChange={() => setChoice(p)} />
            <span className="video-types__text">
              <Text role="body" as="span">{PRESET_LABELS[p].label}</Text>
              <Text role="body-sm" as="span" muted>{PRESET_LABELS[p].hint}</Text>
            </span>
          </label>
        ))}
        <label className="video-types__option video-length__option">
          <input type="radio" name={name} value="custom" checked={choice === "custom"} onChange={() => setChoice("custom")} />
          <span className="video-types__text">
            <Text role="body" as="span">Custom</Text>
            <Text role="body-sm" as="span" muted>
              {type.length.min_s <= 30 ? `Up to ${formatLength(Math.min(600, type.length.max_s))}` : `${formatLength(type.length.min_s)} to ${formatLength(Math.min(600, type.length.max_s))}`}
            </Text>
          </span>
        </label>
      </div>
      {choice === "custom" ? (
        <div className="video-length__custom">
          <label htmlFor={customId} className="field__label">Custom length (minutes:seconds)</label>
          <input id={customId} className="input video-length__input" inputMode="numeric" placeholder="4:30" value={custom} autoComplete="off"
            aria-invalid={showError ? true : undefined} aria-describedby={showError ? errorId : undefined}
            onChange={(e) => setCustom(e.target.value)} onBlur={() => setTouched(true)} />
          {showError && !parsed.ok ? <span id={errorId} className="field__error">{parsed.error}</span> : null}
        </div>
      ) : null}
      <span className="video-length__estimate" aria-live="polite">
        <Icon icon={Icons.history} size="sm" />
        {seconds !== null
          ? <Text role="body-sm" as="span" muted>{makingTimeText(seconds, making, thisComputer())}{making?.measured ? ", based on your last videos" : ""}.</Text>
          : <Text role="body-sm" as="span" muted>Type a length to see how long it takes to make.</Text>}
      </span>
    </fieldset>
  );
}
