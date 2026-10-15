import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button, Icon, Icons, SectionTitle, Select, Text } from "@careeros/brand";
import {
  formatLength, parseCustomLength, PRESET_LABELS, PRESET_SECONDS, presetsFor, videoLengthPath,
  type FieldDef, type LengthPreset, type VideoTypeView,
} from "@careeros/contract";
import { useLoad } from "../bridge-context";
import { AUTOSAVE_DELAY_MS, getPath } from "../components/FieldForm";
import { errorSentence } from "../components/ErrorBanner";
import { ErrorState, Loading } from "../components/States";
import { useFieldSaver, type SaveNote } from "./autosave";

const CAPTIONS = "video.captions";
const lengthPath = videoLengthPath;
type Choice = "default" | LengthPreset | "custom";

/** A short sample line in each caption style, so the choice isn't just a word. */
const SAMPLE = ["I", "rebuilt", "the", "search", "service"];
function CaptionPreview({ style }: { style: string }) {
  if (style === "none") return <Text role="body-sm" muted as="p" className="caption-preview">Videos have no captions burned in.</Text>;
  return (
    <div className="caption-preview-wrap">
      <span className="field__label" aria-hidden="true">Preview</span>
      <p className={`caption-preview caption-preview--${style}`} aria-label="Caption preview">
        {SAMPLE.map((w, i) => <span key={i} className={i === 1 ? "is-now" : undefined}>{w}</span>)}
      </p>
    </div>
  );
}

function Note({ note, label, onRetry }: { note: SaveNote | undefined; label: string; onRetry: () => void }) {
  if (!note) return null;
  if (note.state === "failed") {
    return (
      <div className="autosave-note autosave-note--failed">
        <span>Not saved: {note.text}</span>
        <Button size="sm" variant="ghost" onClick={onRetry} aria-label={`Try again to save ${label}`}>Try again</Button>
      </div>
    );
  }
  return (
    <span className={`autosave-tag autosave-tag--${note.state}`} aria-hidden="true">
      {note.state === "saving" ? "Saving…" : <><Icon icon={Icons.check} size="sm" />Saved</>}
    </span>
  );
}

/**
 * One row of the lengths table: the type's name, then Type default · Quick · Standard · In-depth · Custom (only the
 * presets inside the type's range). Custom opens a small m:ss box. A pick saves at once; a custom length saves when
 * it's valid, after a short pause or on leaving the box.
 */
function LengthRow({ type, stored, note, onSave, onRetry, onInvalid }: {
  type: VideoTypeView; stored: number; note: SaveNote | undefined;
  onSave(seconds: number): void; onRetry(): void; onInvalid(bad: boolean): void;
}) {
  const name = useId();
  const customId = useId();
  const errorId = useId();
  const presets = presetsFor(type.length);
  const storedChoice: Choice = stored <= 0 ? "default" : presets.find((p) => PRESET_SECONDS[p] === stored) ?? "custom";
  const [choice, setChoice] = useState<Choice>(storedChoice);
  const [custom, setCustom] = useState(formatLength(stored > 0 ? stored : type.length.target_s));
  const [error, setError] = useState<string | null>(null);
  const editing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Follow the stored value when it changes elsewhere (Undo, another window), unless the custom box is being typed in.
  useEffect(() => {
    if (editing.current) return;
    setChoice(storedChoice);
    if (stored > 0) setCustom(formatLength(stored));
  }, [stored]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearTimeout(timer.current), []);

  const commitCustom = (text: string) => {
    clearTimeout(timer.current);
    const r = parseCustomLength(text, type.length, type.label);
    if (!r.ok) { setError(r.error); onInvalid(true); return; }
    setError(null); onInvalid(false);
    if (r.seconds !== stored) onSave(r.seconds);
  };
  const pick = (c: Choice) => {
    setChoice(c);
    setError(null); onInvalid(false);
    if (c === "default") { if (stored !== 0) onSave(0); }
    else if (c !== "custom") { if (PRESET_SECONDS[c] !== stored) onSave(PRESET_SECONDS[c]); }
    // Custom waits for a length: the box opens with the current length to edit.
  };
  const options: { id: Choice; label: string; hint: string }[] = [
    { id: "default", label: "Type default", hint: `about ${formatLength(type.length.target_s)}` },
    ...presets.map((p) => ({ id: p, label: PRESET_LABELS[p].label, hint: formatLength(PRESET_SECONDS[p]) })),
    { id: "custom", label: "Custom", hint: "m:ss" },
  ];
  const lo = Math.max(30, type.length.min_s);
  const hi = Math.min(600, type.length.max_s);

  return (
    <div className="vlen-row" role="group" aria-labelledby={`${name}-label`}>
      <div className="vlen-row__name">
        <Text role="body" as="span" id={`${name}-label`}>{type.label}</Text>
        <Text role="body-sm" muted as="span">{formatLength(lo)} to {formatLength(hi)}{type.origin === "workspace" ? " · your own type" : ""}</Text>
      </div>
      <div className="vlen-row__control autosave-field">
        <div className="segmented" role="radiogroup" aria-label={`${type.label} length`}>
          {options.map((o) => (
            <label key={o.id} className="segmented__option">
              <input type="radio" name={name} value={o.id} checked={choice === o.id} onChange={() => pick(o.id)} />
              <span className="segmented__text"><span>{o.label}</span><span className="segmented__hint">{o.hint}</span></span>
            </label>
          ))}
        </div>
        {choice === "custom" ? (
          <div className="vlen-row__custom">
            <label htmlFor={customId} className="sr-only">{type.label} custom length (minutes:seconds)</label>
            <input id={customId} className="input vlen-row__input" inputMode="numeric" placeholder="4:30" autoComplete="off" value={custom}
              aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
              onFocus={() => { editing.current = true; }}
              onChange={(e) => {
                const v = e.target.value;
                setCustom(v);
                clearTimeout(timer.current);
                timer.current = setTimeout(() => commitCustom(v), AUTOSAVE_DELAY_MS);
              }}
              onBlur={(e) => { editing.current = false; commitCustom(e.target.value); }} />
            <Text role="body-sm" muted as="span">minutes:seconds</Text>
            {error ? <span id={errorId} className="field__error vlen-row__error">{error}</span> : null}
          </div>
        ) : null}
        <Note note={note} label={`${type.label} length`} onRetry={onRetry} />
      </div>
    </div>
  );
}

/** Settings › Video: caption style with a preview, and each video type's default length. Every change saves itself. */
export function VideoDefaults() {
  const settings = useLoad((b) => b.settings.get("integrations"), [], ["settings"]);
  const types = useLoad((b) => b.video.types("all"), [], ["video", "settings"]);
  const fields = settings.data?.fields ?? [];
  const labelOf = useCallback((path: string) => {
    if (path === CAPTIONS) return "Caption style";
    const t = types.data?.types.find((x) => lengthPath(x.id) === path);
    return t ? `${t.label} length` : path;
  }, [types.data]);
  const saver = useFieldSaver("integrations", "integrations:video", labelOf);
  // The value last sent per field, so a failed save keeps showing it and Try again resends it.
  const tried = useRef(new Map<string, unknown>());
  const save = (path: string, value: unknown, prev: unknown) => { tried.current.set(path, value); saver.save(path, value, prev); };
  const retry = (path: string, prev: unknown) => { if (tried.current.has(path)) saver.save(path, tried.current.get(path), prev); };

  if ((settings.error && !settings.data) || (types.error && !types.data)) {
    return <ErrorState title="Video settings can't load" text={errorSentence(settings.error ?? types.error ?? "")} />;
  }
  if (!settings.data || !types.data) return <Loading />;
  const broken = !!settings.error;
  const values = settings.data.values;
  const captionsField = fields.find((f) => f.path === CAPTIONS) as FieldDef | undefined;
  const storedCaption = String(getPath(values, CAPTIONS) ?? captionsField?.options[0] ?? "rail");
  const unsettled = saver.notes[CAPTIONS] && saver.notes[CAPTIONS].state !== "saved";
  const caption = unsettled && tried.current.has(CAPTIONS) ? String(tried.current.get(CAPTIONS)) : storedCaption;
  // Built-in types have a settings field each; custom types (settings/video-types) are saved at the same path.
  const rows = types.data.types.filter((t) => t.origin === "workspace" || fields.some((f) => f.path === lengthPath(t.id)));
  const storedOf = (t: VideoTypeView) => { const v = getPath(values, lengthPath(t.id)); return typeof v === "number" ? v : 0; };

  return (
    <div className="stack video-defaults">
      {broken ? <ErrorState title="Settings can't be refreshed" text={`${errorSentence(settings.error ?? "")} Changes won't save until it loads again.`} /> : null}
      <fieldset className="field-form__fields" disabled={broken}>
        {captionsField ? (
          <div className="video-defaults__captions autosave-field" id="settings-video-captions">
            <Select label="Caption style" className="select--narrow" value={caption}
              options={captionsField.options.map((o) => ({ value: o, label: captionsField.optionLabels[o] ?? o }))}
              onChange={(e) => { if (e.target.value !== storedCaption) save(CAPTIONS, e.target.value, storedCaption); }} />
            <CaptionPreview style={caption} />
            <Note note={saver.notes[CAPTIONS]} label="Caption style" onRetry={() => retry(CAPTIONS, storedCaption)} />
          </div>
        ) : null}
        {rows.length ? (
          <section className="stack video-defaults__lengths" aria-labelledby="settings-video-lengths-title" id="settings-video-lengths">
            <SectionTitle icon={Icons.history} title="Default lengths" as="h3" id="settings-video-lengths-title" className="section-title--compact" />
            <Text role="body-sm" muted as="p">Where Make video starts for each type. You can still change it for any one video.</Text>
            <div className="vlen-table">
              {rows.map((t) => {
                const path = lengthPath(t.id);
                const stored = storedOf(t);
                return (
                  <LengthRow key={t.id} type={t} stored={stored} note={saver.notes[path]}
                    onSave={(s) => save(path, s, stored)} onRetry={() => retry(path, stored)}
                    onInvalid={(bad) => saver.markInvalid(path, bad)} />
                );
              })}
            </div>
          </section>
        ) : null}
      </fieldset>
    </div>
  );
}
