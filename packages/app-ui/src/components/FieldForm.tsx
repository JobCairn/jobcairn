import { useEffect, useRef, useState, type ReactNode } from "react";
import { TagInput } from "../filters/TagInput";
import { Button, Checkbox, Icon, Icons, Input, SectionTitle, Select, Text } from "@careeros/brand";
import { groupFields } from "../settings/fieldGroups";
import type { FieldDef, SettingsKind } from "@careeros/contract";
import { errorText, useBridge, useLoad } from "../bridge-context";
import { useAutosave, useReportSaveState } from "../settings/autosave";
import { errorSentence } from "./ErrorBanner";
import { ErrorState, Loading } from "./States";
import { checkRows, ListField, type ListRow } from "./ListField";
import { MAX_JOBS, PLACE_SUGGESTIONS } from "@careeros/contract";

/** Lists of records whose name field offers suggestions: the preferred places get the place picker's places. */
const LIST_SUGGESTIONS: Record<string, readonly string[]> = { locations: PLACE_SUGGESTIONS };
/** Search lists edited as chips (type, then Enter or a comma). Places among them get the place suggestions. */
const CHIP_LISTS = new Set(["targets.roles", "skip_companies", "industries.include", "industries.exclude"]);
const isChipList = (f: FieldDef) => f.type === "string[]" && (f.path.startsWith("filters.") || CHIP_LISTS.has(f.path));
const PLACE_LISTS = new Set(["filters.fallback_locations"]);
/** One item of a chip list in words, and an example, so the box reads "Add a company", not "Add a companies to skip". */
const CHIP_WORDS: Record<string, { item: string; placeholder: string }> = {
  "targets.roles": { item: "target role", placeholder: "Add a role, like AI Engineer" },
  "filters.related_titles": { item: "related job title", placeholder: "Add a related job title" },
  "filters.fallback_locations": { item: "place", placeholder: "Add a place, like Sydney" },
  "filters.countries": { item: "country", placeholder: "Add a country, like Australia" },
  "filters.exclude_keywords": { item: "word", placeholder: "Add a word, like clearance" },
  skip_companies: { item: "company", placeholder: "Add a company" },
  "industries.include": { item: "industry", placeholder: "Add an industry, like fintech" },
  "industries.exclude": { item: "industry", placeholder: "Add an industry, like gambling" },
};
/** Whole numbers shown with their default (never a blank box) and a small stepper. */
const STEPPERS: Record<string, { fallback: number; min: number; max: number }> = {
  "filters.min_results": { fallback: 10, min: 1, max: 200 },
  "filters.max_jobs": { fallback: MAX_JOBS.default, min: MAX_JOBS.min, max: MAX_JOBS.max },
};
/** Extra controls under a field, given by the screen (Settings › Search: Suggest titles under Related job titles). */
export type FieldAddons = Record<string, (value: unknown, save: (v: unknown) => Promise<unknown>) => ReactNode>;

// Segments that would let a dotted path walk onto Object.prototype instead of an own
// property. Refused outright so a path built from untrusted text can never pollute it.
const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Reads a dotted path off an object, following only the object's own properties.
 * Returns undefined for a missing path, a non-object along the way, or a segment
 * that would reach the prototype chain (`__proto__`, `prototype`, `constructor`).
 */
export function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => {
    if (UNSAFE_PATH_SEGMENTS.has(k)) return undefined;
    if (o !== null && typeof o === "object" && Object.hasOwn(o, k)) return (o as Record<string, unknown>)[k];
    return undefined;
  }, obj);
}

/** A date-only text field (the schema says "YYYY-MM-DD" in its label or pattern). Edited with a date picker, label without the format hint. */
export const isDateField = (f: FieldDef): boolean =>
  f.type === "string" && (/\(YYYY-MM-DD\)/.test(f.label) || /^\^\(?\\d\{4\}-\\d\{2\}-\\d\{2\}\)?\??\$$/.test(f.pattern));
const fieldLabel = (f: FieldDef): string => f.label.replace(/\s*\(YYYY-MM-DD\)\s*$/, "");

/** An option's words: the schema's label, else the value made readable ("full_time" → "Full time"), never a raw slug. */
export const optionLabel = (f: FieldDef, o: string): string => f.optionLabels[o] ?? (o.charAt(0).toUpperCase() + o.slice(1)).replace(/_/g, " ");
/** Text fields whose values are a few characters (a currency code) get a short box, not the full form width. */
const isShortText = (f: FieldDef) => /(^|\.)currency$/.test(f.path);

const isNumber = (f: FieldDef) => /^(number|integer)(\|null)?$/.test(f.type);

/** What the form control shows for a stored value. Lists and numbers are edited as text. */
export function toDisplay(f: FieldDef, v: unknown): unknown {
  if (f.type === "object[]") return Array.isArray(v) ? v : [];
  if (f.type === "string[]") return Array.isArray(v) ? v.join(", ") : "";
  if (isNumber(f)) return v === null || v === undefined ? "" : String(v);
  if (f.type === "enum[]") return Array.isArray(v) ? v : [];
  if (f.type === "boolean") return v === true;
  return v ?? "";
}

/** Turns what the person typed into the stored value, or an error to show. */
export function toValue(f: FieldDef, raw: unknown): { value?: unknown; error?: string } {
  if (f.type === "object[]") return checkRows(f, raw);
  if (f.type === "string[]") return { value: String(raw).split(",").map((s) => s.trim()).filter(Boolean) };
  if (isNumber(f)) {
    const s = String(raw).trim();
    if (s === "") return f.type.endsWith("|null") ? { value: null } : { error: "Enter a number." };
    const n = Number(s);
    if (!Number.isFinite(n)) return { error: "Enter a number." };
    if (f.type.startsWith("integer") && !Number.isInteger(n)) return { error: "Enter a whole number." };
    return { value: n };
  }
  if (f.pattern && typeof raw === "string" && !new RegExp(f.pattern).test(raw)) return { error: "Doesn't match the expected format." };
  return { value: raw };
}

/** Same stored value? Compares through JSON so lists and numbers compare by content. */
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** How long typing pauses before a text field saves itself. Blur saves straight away. */
export const AUTOSAVE_DELAY_MS = 800;
/** How long a field's "Saved" note stays before it fades out. */
const SAVED_NOTE_MS = 2400;

type FieldStatus = { state: "saving" } | { state: "saved" } | { state: "failed"; text: string };

/** The small per-field note: "Saving…", then "Saved" (fading), or what went wrong with Try again. */
function FieldNote({ status, label, onRetry }: { status: FieldStatus | undefined; label: string; onRetry: () => void }) {
  if (!status) return null;
  if (status.state === "failed") {
    return (
      <div className="autosave-note autosave-note--failed">
        <span>Not saved: {status.text}</span>
        <Button size="sm" variant="ghost" onClick={onRetry} aria-label={`Try again to save ${label}`}>Try again</Button>
      </div>
    );
  }
  return (
    <span className={`autosave-tag autosave-tag--${status.state}`} aria-hidden="true">
      {status.state === "saving" ? "Saving…" : <><Icon icon={Icons.check} size="sm" />Saved</>}
    </span>
  );
}

/**
 * `only` limits the form to some fields (each path and everything under it, in the order given), e.g. "video" in
 * Settings › Video; `exclude` leaves some out. `bare` drops the section titles and anchors, for a screen that puts the
 * fields under its own sections (Settings › Search mixes profile and search fields).
 *
 * Every field saves itself: text fields when you leave them or pause typing, selects, toggles and dates as soon as they
 * change. Each save sends only that one field. A value that doesn't pass its check is never saved: the field shows
 * why and the last good value stays stored.
 */
export function FieldForm({ kind, only, exclude, titled = false, bare = false, addons = {}, choices = [] }: {
  kind: SettingsKind; only?: string | readonly string[]; exclude?: readonly string[]; titled?: boolean; bare?: boolean; addons?: FieldAddons;
  /** Enum fields shown as radio choices (label and a one-line hint) instead of a dropdown, to match Find jobs' chips. */
  choices?: readonly string[];
}) {
  const bridge = useBridge();
  const { saved: announceSaved } = useAutosave();
  const { data, error } = useLoad((b) => b.settings.get(kind), [kind], ["settings"]);
  // What's typed but not yet stored (or not yet reloaded). Lists and numbers are kept as typed text here.
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, FieldStatus>>({});
  // Values saved but not yet reloaded: shown until the next reload, so a dropped draft never flashes the old value.
  const [saved, setSaved] = useState<Record<string, unknown>>({});
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dataRef = useRef(data);
  dataRef.current = data;
  const brokenRef = useRef(false);
  brokenRef.current = !!error;
  const focused = useRef<string | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const noteTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Saves run one at a time, in order, so a slow earlier save can never land after a later one.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // The last value sent (or being sent) per field, so a blur right after a debounced save doesn't save it twice.
  const sent = useRef(new Map<string, unknown>());
  const pending = useRef(new Map<string, number>());
  const live = useRef(true);
  const commitRef = useRef<(f: FieldDef, raw: unknown) => void>(() => undefined);

  const labelOf = (path: string) => { const f = data?.fields.find((x) => x.path === path); return f ? fieldLabel(f) : path; };
  const failed = Object.entries(status).flatMap(([path, s]) => (s.state === "failed" ? [labelOf(path)] : []));
  // Typed but not sent yet (inside the typing pause): the page line must not claim everything is saved.
  const typing = Object.entries(draft).some(([path, raw]) => {
    const f = data?.fields.find((x) => x.path === path);
    if (!f || errors[path] || status[path]?.state === "failed") return false;
    const r = toValue(f, raw);
    if (r.error) return true;
    const last = sent.current.has(path) ? sent.current.get(path) : getPath(data?.values, path);
    return !same(r.value, last) && !(last === undefined && same(r.value, toValue(f, toDisplay(f, undefined)).value));
  });
  useReportSaveState(`${kind}:${only === undefined ? "all" : [only].flat().join(",")}:${exclude?.join(",") ?? ""}`, {
    saving: typing || Object.values(status).some((s) => s.state === "saving"),
    failed,
    invalid: Object.keys(errors).map(labelOf),
  });

  useEffect(() => {
    live.current = true;
    const t = timers.current;
    const n = noteTimers.current;
    return () => {
      // Leaving the screen mid-typing still saves what was typed.
      for (const [path, id] of t) {
        clearTimeout(id);
        const f = dataRef.current?.fields.find((x) => x.path === path);
        if (f && Object.hasOwn(draftRef.current, path)) commitRef.current(f, draftRef.current[path]);
      }
      t.clear();
      for (const id of n.values()) clearTimeout(id);
      live.current = false;
    };
  }, []);

  /**
   * Once the stored values catch up with a field (after its save reloads them), forget the draft and the sent value,
   * so a later change from elsewhere (Fill from my resume, a hand edit) shows through and retyping an old value saves
   * again. The field being typed in keeps its text; a save still in flight settles when it finishes.
   */
  const settle = (paths?: string[], reloaded = false) => {
    const d = dataRef.current;
    if (!d) return;
    if (reloaded) setSaved({});
    const done: Record<string, unknown> = {};
    for (const path of paths ?? [...sent.current.keys()]) {
      if (pending.current.get(path) || !sent.current.has(path)) continue;
      if (!reloaded) done[path] = sent.current.get(path);
      // A reload after the save finished is the truth now, even if something else changed the value since.
      if (reloaded || same(sent.current.get(path), getPath(d.values, path))) sent.current.delete(path);
    }
    const cur = draftRef.current;
    const next = { ...cur };
    const keep: Record<string, unknown> = {};
    let changed = false;
    for (const [path, raw] of Object.entries(cur)) {
      if ((paths && !paths.includes(path)) || focused.current === path || pending.current.get(path)) continue;
      const f = d.fields.find((x) => x.path === path);
      if (!f) continue;
      const r = toValue(f, raw);
      if (r.error) continue;
      if (same(r.value, getPath(d.values, path))) { delete next[path]; changed = true; }
      else if (Object.hasOwn(done, path) && same(r.value, done[path])) { delete next[path]; keep[path] = r.value; changed = true; }
    }
    if (changed) { draftRef.current = next; setDraft(next); }
    if (Object.keys(keep).length) setSaved((s) => ({ ...s, ...keep }));
  };
  const settleRef = useRef(settle);
  settleRef.current = settle;
  useEffect(() => { settleRef.current(undefined, true); }, [data]);

  const setNote = (path: string, s: FieldStatus | null) => {
    if (!live.current) return;
    const old = noteTimers.current.get(path);
    if (old) { clearTimeout(old); noteTimers.current.delete(path); }
    setStatus((st) => { const { [path]: _drop, ...rest } = st; return s ? { ...rest, [path]: s } : rest; });
    if (s?.state === "saved") {
      noteTimers.current.set(path, setTimeout(() => {
        noteTimers.current.delete(path);
        if (live.current) setStatus((st) => (st[path]?.state === "saved" ? (({ [path]: _d, ...rest }) => rest)(st) : st));
      }, SAVED_NOTE_MS));
    }
  };

  /** Sends one field's value. `prev` is what was stored before, kept so Undo can put it back. */
  const send = (f: FieldDef, value: unknown, prev: unknown, offerUndo: boolean) => {
    sent.current.set(f.path, value);
    pending.current.set(f.path, (pending.current.get(f.path) ?? 0) + 1);
    setNote(f.path, { state: "saving" });
    const job = queue.current.then(() => bridge.settings.save(kind, [{ path: f.path, value }]));
    queue.current = job.catch(() => undefined);
    job.then(
      () => {
        setNote(f.path, { state: "saved" });
        announceSaved(offerUndo && prev !== undefined ? {
          label: fieldLabel(f),
          undo: () => {
            const stored = getPath(dataRef.current?.values, f.path);
            setDraft((d) => { const { [f.path]: _drop, ...rest } = d; return rest; });
            setErrors((e) => { const { [f.path]: _drop, ...rest } = e; return rest; });
            send(f, prev, stored, false);
          },
        } : null);
      },
      (e: unknown) => {
        sent.current.delete(f.path);
        setNote(f.path, { state: "failed", text: errorText(e) });
      },
    ).finally(() => { pending.current.set(f.path, (pending.current.get(f.path) ?? 1) - 1); if (live.current) settleRef.current([f.path]); });
  };

  /** Checks a field's typed value and saves it if it's valid and different. An invalid value shows why and isn't saved. */
  const commit = (f: FieldDef, raw: unknown) => {
    const t = timers.current.get(f.path);
    if (t) { clearTimeout(t); timers.current.delete(f.path); }
    if (brokenRef.current || !dataRef.current) return;
    const r = toValue(f, raw);
    if (r.error) {
      setErrors((e) => ({ ...e, [f.path]: r.error! }));
      return;
    }
    setErrors((e) => { if (!(f.path in e)) return e; const { [f.path]: _drop, ...rest } = e; return rest; });
    const stored = getPath(dataRef.current.values, f.path);
    const last = sent.current.has(f.path) ? sent.current.get(f.path) : stored;
    if (same(r.value, last) && status[f.path]?.state !== "failed") return;
    // A field that was never set and is still empty stays unset; don't write an empty value just for visiting it.
    if (stored === undefined && same(r.value, toValue(f, toDisplay(f, undefined)).value) && !sent.current.has(f.path)) return;
    send(f, r.value, stored, true);
  };
  commitRef.current = commit;

  if (error && !data) return <ErrorState title="Settings can't load" text={errorSentence(error)} />;
  if (!data) return <Loading />;
  // A reload can fail (the settings file became unreadable, or edited by hand into something
  // invalid) while we still hold the last-known values. Show the error over the stale form and
  // stop saving, instead of saving changes against values we no longer trust.
  const broken = !!error;
  // A part of a form shown on another tab (Settings › Search shows the profile's places) gets its own anchors.
  const anchor = only ? `${kind}-` : "";
  const under = (f: FieldDef, p: string) => f.path === p || f.path.startsWith(`${p}.`);
  const picked = only === undefined ? data.fields : [only].flat().flatMap((p) => data.fields.filter((f) => under(f, p)));
  const fields = exclude ? picked.filter((f) => !exclude.some((p) => under(f, p))) : picked;

  const shown = (f: FieldDef) => (Object.hasOwn(draft, f.path) ? draft[f.path]
    : toDisplay(f, Object.hasOwn(saved, f.path) ? saved[f.path] : getPath(data.values, f.path)));
  const setRaw = (f: FieldDef, v: unknown) => {
    setDraft((d) => ({ ...d, [f.path]: v }));
    draftRef.current = { ...draftRef.current, [f.path]: v };
    if (status[f.path]?.state === "failed") setNote(f.path, null);
  };
  /** Selects, toggles, dates and chips: save as soon as they change. */
  const pick = (f: FieldDef, v: unknown) => { setRaw(f, v); commit(f, v); };
  /** Text: save after a short pause in typing, and on leaving the field. */
  const type = (f: FieldDef, v: unknown) => {
    setRaw(f, v);
    const old = timers.current.get(f.path);
    if (old) clearTimeout(old);
    timers.current.set(f.path, setTimeout(() => { timers.current.delete(f.path); commitRef.current(f, draftRef.current[f.path]); }, AUTOSAVE_DELAY_MS));
  };
  const textProps = (f: FieldDef) => ({
    onFocus: () => { focused.current = f.path; },
    onBlur: () => {
      focused.current = null;
      if (Object.hasOwn(draftRef.current, f.path)) commit(f, draftRef.current[f.path]);
      settle([f.path]);
    },
  });
  const retry = (f: FieldDef) => commit(f, Object.hasOwn(draftRef.current, f.path) ? draftRef.current[f.path] : shown(f));
  const note = (f: FieldDef) => <FieldNote status={status[f.path]} label={fieldLabel(f)} onRetry={() => retry(f)} />;

  return (
    <form className="stack field-form" onSubmit={(e) => e.preventDefault()}>
      {broken ? <ErrorState title="Settings can't be refreshed" text={`${errorSentence(error)} Changes won't save until it loads again.`} /> : null}
      <fieldset className="field-form__fields" disabled={broken}>
      {(bare ? [{ id: "bare", title: "", icon: Icons.settings, fields }] : groupFields(kind, fields)).map((g, _i, all) => (
        <div key={g.id} className="field-group" id={bare ? undefined : `settings-${anchor}${g.id}`} data-section={bare ? undefined : `${anchor}${g.id}`}>
          {!bare && (all.length > 1 || titled) ? <SectionTitle icon={g.icon} title={g.title} as="h3" id={`settings-${anchor}${g.id}-title`} className="section-title--compact" /> : null}
          <div className="field-group__body">
      {g.fields.map((f) => {
        const v = shown(f);
        const err = errors[f.path];
        if (f.type === "object") return <Text key={f.path} role="heading-2">{f.label}</Text>;
        if (f.type === "boolean") {
          return <div key={f.path} className="autosave-field"><Checkbox label={f.label} help={f.help || undefined} checked={v === true} onChange={(e) => pick(f, e.target.checked)} />{note(f)}</div>;
        }
        if (f.type === "enum" && choices.includes(f.path)) {
          return (
            <div key={f.path} className="autosave-field">
              <fieldset className="qf-choices field-choices" aria-describedby={f.help ? `${f.path}-help` : undefined}>
                <legend className="field__label">{f.label}</legend>
                {f.options.map((o) => {
                  // "Focused: up to 5 searches…" reads as a label and a hint, the same way the Find jobs chip shows it.
                  const [name, ...rest] = optionLabel(f, o).split(": ");
                  const hint = rest.join(": ");
                  return (
                    <label key={o} className="qf-choice field-choice">
                      <input type="radio" name={f.path} value={o} checked={String(v) === o} onChange={() => pick(f, o)} />
                      <span className="qf-choice__label">{name}{hint ? <span className="field-choice__hint">{hint.charAt(0).toUpperCase() + hint.slice(1)}</span> : null}</span>
                    </label>
                  );
                })}
              </fieldset>
              {err ? <span className="field__error">{err}</span> : f.help ? <span className="field__help" id={`${f.path}-help`}>{f.help}</span> : null}
              {note(f)}
            </div>
          );
        }
        if (f.type === "enum") {
          return (
            <div key={f.path} className="autosave-field">
              <Select label={f.label} help={f.help || undefined} error={err} value={String(v)} data-tour={f.path === "work_rights.status" ? "settings-rights" : undefined} onChange={(e) => pick(f, e.target.value)}
                options={f.options.map((o) => ({ value: o, label: optionLabel(f, o) }))} />
              {note(f)}
            </div>
          );
        }
        if (f.type === "enum[]") {
          const list = v as string[];
          return (
            <fieldset key={f.path} className="autosave-field">
              <legend>{f.label}</legend>
              <div className="chip-group">
                {f.options.map((o) => (
                  <Checkbox key={o} label={optionLabel(f, o)} checked={list.includes(o)}
                    onChange={(e) => pick(f, e.target.checked ? [...list, o] : list.filter((x) => x !== o))} />
                ))}
              </div>
              {note(f)}
            </fieldset>
          );
        }
        if (isChipList(f)) {
          const raw = Object.hasOwn(draft, f.path) ? draft[f.path] : Object.hasOwn(saved, f.path) ? saved[f.path] : getPath(data.values, f.path);
          const cur = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : typeof raw === "string" ? raw.split(",").map((x) => x.trim()).filter(Boolean) : [];
          return (
            <fieldset key={f.path} className="autosave-field chip-field">
              <legend className="list-field__legend">{f.label}</legend>
              <TagInput label={f.label} values={cur} places={PLACE_LISTS.has(f.path)} max={40} onChange={(v) => pick(f, v)}
                item={CHIP_WORDS[f.path]?.item} placeholder={CHIP_WORDS[f.path]?.placeholder} />
              {f.help ? <Text role="body-sm" muted>{f.help.replace(/\s*Separate with commas\.?/, "")}</Text> : null}
              {addons[f.path]?.(cur, async (v) => { pick(f, v); })}
              {note(f)}
            </fieldset>
          );
        }
        const step = STEPPERS[f.path];
        if (step && isNumber(f)) {
          const n = Number(v === "" ? step.fallback : v);
          const to = (x: number) => pick(f, Math.max(step.min, Math.min(step.max, Math.round(x))));
          return (
            <div key={f.path} className="autosave-field stepper-field">
              <span className="field__label" id={`${f.path}-label`}>{f.label}</span>
              <div className="stepper" role="group" aria-labelledby={`${f.path}-label`}>
                <button type="button" className="stepper__btn" aria-label={`Fewer: ${n - 1}`} disabled={n <= step.min} onClick={() => to(n - 1)}>−</button>
                <input className="input stepper__value" inputMode="numeric" aria-labelledby={`${f.path}-label`} value={String(v === "" ? step.fallback : v)}
                  onChange={(e) => type(f, e.target.value)} {...textProps(f)} aria-invalid={err ? true : undefined} />
                <button type="button" className="stepper__btn" aria-label={`More: ${n + 1}`} disabled={n >= step.max} onClick={() => to(n + 1)}>+</button>
              </div>
              {err ? <span className="field__error">{err}</span> : f.help ? <span className="field__help">{f.help}</span> : null}
              {note(f)}
            </div>
          );
        }
        if (f.type === "object[]") {
          const raw = getPath(data.values, f.path);
          // A hand-edited settings file can hold anything under this path. Only an array is a list of records;
          // anything else would crash the form, so offer to start the list again instead (nobody edits files).
          if (raw !== undefined && !Array.isArray(raw) && !Object.hasOwn(draft, f.path)) {
            return (
              <fieldset key={f.path} className="list-field">
                <legend className="list-field__legend">{f.label}</legend>
                <Text role="body-sm" muted>This list couldn't be read, so it can't be shown.</Text>
                <div><Button size="sm" title="Start the list again" onClick={() => pick(f, [])}>Reset list</Button></div>
                {note(f)}
              </fieldset>
            );
          }
          return (
            <ListField key={f.path} field={f} rows={v as ListRow[]} error={err} help={f.help || undefined} suggestions={LIST_SUGGESTIONS[f.path]}
              onChange={(rows, how) => (how === "now" ? pick(f, rows) : type(f, rows))}
              onEnter={() => { focused.current = f.path; }}
              onLeave={() => { focused.current = null; if (Object.hasOwn(draftRef.current, f.path)) commit(f, draftRef.current[f.path]); settle([f.path]); }}
              note={note(f)} />
          );
        }
        return (
          // Number fields stay type="text": a native type="number" input silently reports an
          // empty value for a perfectly normal in-progress keystroke (a lone "-" while typing a
          // negative number, a trailing "." or "e"), which toValue would then read as "cleared"
          // and happily save as null. Text + inputMode="decimal" keeps the numeric keypad on
          // mobile/touch while letting toValue see exactly what was typed and validate it.
          <div key={f.path} className="autosave-field">
            {isDateField(f) ? (
              <Input label={fieldLabel(f)} error={err} type="date" value={String(v)} className="input--date"
                help={f.help || "Leave empty if it doesn't apply."} onChange={(e) => pick(f, e.target.value)} />
            ) : (
              <Input label={f.label} error={err} type="text" inputMode={isNumber(f) ? "decimal" : undefined} value={String(v)} className={isNumber(f) || isShortText(f) ? "input--short" : undefined}
                help={f.help || (f.type === "string[]" ? "Separate with commas." : undefined)} onChange={(e) => type(f, e.target.value)} {...textProps(f)} />
            )}
            {note(f)}
          </div>
        );
      })}
          </div>
        </div>
      ))}
      </fieldset>
    </form>
  );
}
