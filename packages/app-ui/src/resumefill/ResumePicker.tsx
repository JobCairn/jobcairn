import { useRef, useState, type DragEvent } from "react";
import { Button, Icon, Icons, cx } from "@careeros/brand";
import type { ResumeRead } from "@careeros/contract";
import { errorText, useBridge } from "../bridge-context";
import "./resumefill.css";

export interface ResumePicked { read: ResumeRead; path: string }
/** A resume to review: a file picked or dropped here (`path`), or one waiting in the Drop box (`inbox`, its name only). */
export type ResumeSource = ResumePicked | { read: ResumeRead; inbox: string };

/**
 * "Fill from my resume": one button that is also a drop target. The file goes to main through the same safe
 * drop/pick path as the Drop box; main reads it on this computer and sends back only the contact details.
 * Errors stay on screen in plain words until the next try.
 */
export function ResumePicker({ onPicked, tour, compact = false, heading = "Start from your resume", label = "Choose resume", disabled = false, disabledReason = "Not available right now." }: {
  onPicked: (p: ResumePicked) => void;
  /** data-tour anchor for the guided tour. */
  tour?: string;
  /** A quieter row (onboarding, or "Use a different resume"). */
  compact?: boolean;
  heading?: string;
  /** The button. */
  label?: string;
  disabled?: boolean;
  /** Shown on the button while it is disabled. */
  disabledReason?: string;
}) {
  const bridge = useBridge();
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const read = async (path: string) => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setReading(path.split(/[\\/]/).pop() ?? "your resume");
    try {
      onPicked({ read: await bridge.profile.readResume(path), path });
    } catch (e) {
      setError(errorText(e).replace(/\.?$/, "."));
    } finally {
      busy.current = false;
      setReading(null);
    }
  };

  const choose = async () => {
    setError(null);
    try {
      const p = await bridge.files.pick();
      if (p) await read(p);
    } catch (e) { setError(errorText(e).replace(/\.?$/, ".")); }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (disabled) return;
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length !== 1) { setError("Drop one file: your resume."); return; }
    const p = bridge.pathForFile(files[0]!);
    if (!p) { setError("That file couldn't be read from here. Drag it from Finder or File Explorer, or choose it instead."); return; }
    void read(p);
  };

  return (
    <div className={cx("rfill-pick", compact && "rfill-pick--compact", over && "is-over")} role="group" aria-label={`${label}: drop your resume here or choose it`}
      data-tour={tour} onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <span className="rfill-pick__icon" aria-hidden="true"><Icon icon={Icons.file} /></span>
      <div className="rfill-pick__body">
        <span className="rfill-pick__title">{heading}</span>
        <span className="rfill-pick__text" aria-live="polite">
          {reading ? `Reading ${reading}…` : "Drop a PDF, Word, Markdown or text file here. It's read on this computer. Nothing is sent anywhere."}
        </span>
      </div>
      <Button variant={compact ? "secondary" : "primary"} icon={Icons.file} loading={!!reading} disabled={disabled} onClick={() => void choose()}
        title={disabled ? disabledReason : undefined}>
        {label}
      </Button>
      {error ? <p className="rfill-pick__error" role="alert">{error}</p> : null}
    </div>
  );
}
