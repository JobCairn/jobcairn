export class CancelledError extends Error {
  constructor(message = "Cancelled.") { super(message); this.name = "CancelledError"; }
}

/** A failure with a plain message for the person and a short code for tests and logs. */
export class VideoError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "VideoError"; }
}

/** C0 controls (incl. ESC) and C1 controls - but not CR/LF, which `lastLine` below needs intact
 * to split on - plus the Unicode bidi formatting characters, the Arabic Letter Mark, zero-width
 * space, BOM/zero-width no-break space, and the line/paragraph separators (Fix round 1: added so
 * these can't survive either, same reasoning as the rest). Shared by `lastLine` below and by
 * `expander.ts`'s `assertSaneWords` (one set, not two independently maintained ones) because both
 * strip the same kind of untrusted text for the same reason: a hostile tool's stdout/stderr, or a
 * word straight from a transcript, must not be able to forge a second log line or disguise itself
 * with a bidi override just by carrying one of these. */
const CONTROL = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

export function stripControl(text: string): string {
  return text.replace(CONTROL, "");
}

/**
 * The last non-empty line of `text`, trimmed and capped at 300 characters - used on a hostile
 * tool's stdout/stderr, so the steps matter in this order (Fix round 1): strip control characters
 * from the *whole* text first, THEN split into lines and drop any that are empty, THEN pick the
 * last of what's left and trim it. Stripping first (rather than stripping only the already-picked
 * line, as this used to do) matters because a trailing line made of nothing but a control
 * character - not whitespace, so the old trim-then-filter order didn't treat it as empty - would
 * otherwise get picked as "the last line" and only then get stripped down to "", silently losing
 * the real last line entirely.
 */
export function lastLine(text: string): string {
  // Split on "\r\n", a lone "\n", OR a lone "\r" (Fix round 2, item 1) - the old /\r?\n/ matched
  // only the first two, so a bare CR with no following LF survived inline instead of acting as a
  // line break; in a terminal or a naive log viewer a bare CR moves the cursor back to the start
  // of the line, so whatever follows it visually overwrites what came before.
  const lines = stripControl(text).split(/\r\n|\n|\r/).filter((l) => l.length > 0);
  return (lines.at(-1) ?? "").trim().slice(0, 300);
}

/** Collapses `text` to one line, trimmed and capped at 300 characters: strips control characters
 * (same CONTROL set as everything else here), then folds any run of CR/LF into a single space -
 * unlike `lastLine` above, this isn't about picking the last of several lines, it's about never
 * letting embedded CR/LF forge an extra line at all, for text (a lint finding's code, severity or
 * message) that's displayed as one field, not scanned for "the last line" (Fix round 2, item 2). */
export function oneLine(text: string): string {
  return stripControl(text).replace(/[\r\n]+/g, " ").trim().slice(0, 300);
}
