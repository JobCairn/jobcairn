import { useId, useMemo, useRef, useEffect, useState, type FormEvent } from "react";
import { Button, Checkbox, Pill, Text, cx } from "@careeros/brand";
import {
  RESUME_FIELD_KEYS, RESUME_FIELD_PATHS, type ResumeFieldKey, type ResumeFillState, type ResumeValues, type SettingsChange, type WorkRightsStatus,
} from "@careeros/contract";
import { errorText, useBridge } from "../bridge-context";
import { getPath } from "../components/FieldForm";
import { WR_STATUS_TEXT } from "../format";
import type { ResumePicked, ResumeSource } from "./ResumePicker";

export const FIELD_LABEL: Record<ResumeFieldKey, string> = {
  name: "Full name", email: "Email for applications", phone: "Phone", city: "City", links: "Links (LinkedIn, GitHub, portfolio)",
};
/** Short names for sentences ("Phone and city weren't in your resume"). */
export const FIELD_WORD: Record<ResumeFieldKey, string> = { name: "name", email: "email", phone: "phone", city: "city", links: "links" };
// "Prefer not to say" first, as in onboarding.
export const RIGHTS_ORDER: WorkRightsStatus[] = ["unknown", "citizen", "pr", "full_visa", "limited_visa", "needs_sponsorship"];

type Mode = "new" | "same" | "conflict" | "missing";
export interface FieldRow { key: ResumeFieldKey; mode: Mode; resume: string; current: string }

const show = (v: unknown): string => (Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : typeof v === "string" ? v.trim() : "");
const linkList = (s: string) => [...new Set(s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean))];

/** How each resume field compares with the profile: new (fills an empty field), same, conflict (both have a value) or missing. */
export function compareFields(fields: ResumePicked["read"]["fields"], profile: Record<string, unknown>): FieldRow[] {
  return RESUME_FIELD_KEYS.map((key) => {
    const resume = show(fields[key]);
    const current = show(getPath(profile, RESUME_FIELD_PATHS[key]));
    if (!resume) return { key, mode: "missing", resume, current };
    if (!current) return { key, mode: "new", resume, current };
    const same = key === "links" ? linkList(resume).every((l) => linkList(current).map((c) => c.toLowerCase()).includes(l.toLowerCase())) : resume.toLowerCase() === current.toLowerCase();
    return { key, mode: same ? "same" : "conflict", resume, current };
  });
}

/** "a", "a and b", "a, b and c". */
export const listWords = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Review before save (Settings › Profile). Fields the profile doesn't have yet are filled and tagged "From your
 * resume" and can be edited. A field that already has a different value keeps it unless "Use resume value" is
 * ticked. Work rights are never read from a resume: they stay a one-tap choice.
 */
export function ResumeReview({ picked, profile, onSaved, onCancel }: {
  picked: ResumeSource;
  profile: Record<string, unknown>;
  onSaved: (s: ResumeFillState) => void;
  onCancel: () => void;
}) {
  const bridge = useBridge();
  const id = useId();
  const rows = useMemo(() => compareFields(picked.read.fields, profile), [picked, profile]);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(rows.filter((r) => r.mode === "new").map((r) => [r.key, r.resume])));
  const [use, setUse] = useState<Record<string, boolean>>({});
  const startRights = (getPath(profile, "work_rights.status") as WorkRightsStatus | undefined) ?? "unknown";
  const [rights, setRights] = useState<WorkRightsStatus>(startRights);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headRef.current?.focus(); }, []);

  const found = rows.filter((r) => r.mode !== "missing");
  // Matching fields need no decision: one line for all of them, so the form only shows what does.
  const same = rows.filter((r) => r.mode === "same").map((r) => FIELD_WORD[r.key]);
  const shown = rows.filter((r) => r.mode === "new" || r.mode === "conflict");
  const missing = rows.filter((r) => r.mode === "missing").map((r) => FIELD_WORD[r.key]);

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const out: ResumeValues = {};
    const overwrite: ResumeFieldKey[] = [];
    for (const r of rows) {
      if (r.mode === "new") {
        const v = (values[r.key] ?? "").trim();
        if (!v) continue;
        if (r.key === "links") out.links = linkList(v).slice(0, 5); else out[r.key] = v;
      } else if (r.mode === "conflict") {
        // Sent either way, so the record says which values were kept; replaced only when ticked.
        if (r.key === "links") out.links = use.links ? [...new Set([...linkList(r.current), ...linkList(r.resume)])].slice(0, 5) : linkList(r.resume).slice(0, 5);
        else out[r.key] = r.resume;
        if (use[r.key]) overwrite.push(r.key);
      }
    }
    setBusy(true); setError(null);
    try {
      const state = "inbox" in picked
        ? await bridge.inbox.fillProfile(picked.inbox, out, overwrite)
        : await bridge.profile.fillFromResume(picked.path, out, overwrite);
      if (rights !== startRights) {
        const changes: SettingsChange[] = [{ path: "work_rights.status", value: rights }];
        await bridge.settings.save("profile", changes);
      }
      onSaved(state);
    } catch (err) {
      setError(`${errorText(err).replace(/\.$/, "")}. Nothing was changed.`);
    } finally { setBusy(false); }
  };

  return (
    <form className="rfill-review" onSubmit={(e) => void save(e)} aria-labelledby={`${id}-title`} noValidate>
      <div className="rfill-review__head">
        <h3 className="t-heading-2 rfill-review__title" id={`${id}-title`} tabIndex={-1} ref={headRef}>Check what we found</h3>
        <Text role="body-sm" muted as="p">
          {found.length
            ? <>From <span className="rfill-file" title={picked.read.file}>{picked.read.file}</span>. Fix anything that's wrong, then save. Nothing is saved until you do.</>
            : <>We couldn't find contact details in <span className="rfill-file" title={picked.read.file}>{picked.read.file}</span>. You can still keep a copy of it for tailoring and scoring.</>}
        </Text>
      </div>

      {same.length ? (
        <p className="rfill-same"><Pill tone="success">Already in your profile</Pill> <span>{sentenceCase(listWords(same))} {same.length === 1 ? "matches" : "match"} your resume.</span></p>
      ) : null}
      {shown.length ? (
        <ul className="rfill-rows list-plain">
          {shown.map((r) => {
            const inputId = `${id}-${r.key}`;
            return (
              <li key={r.key} className={cx("rfill-row", `rfill-row--${r.mode}`)}>
                <div className="rfill-row__head">
                  {r.mode === "new" ? <label className="rfill-row__label" htmlFor={inputId}>{FIELD_LABEL[r.key]}</label> : <span className="rfill-row__label">{FIELD_LABEL[r.key]}</span>}
                  {r.mode === "new" ? <Pill tone="accent">From your resume</Pill> : <Pill tone="neutral">Different in your resume</Pill>}
                </div>
                {r.mode === "new" ? (
                  <input id={inputId} className="input" value={values[r.key] ?? ""} spellCheck={false}
                    autoComplete={r.key === "name" ? "name" : r.key === "email" ? "email" : r.key === "phone" ? "tel" : "off"}
                    aria-describedby={r.key === "links" ? `${inputId}-help` : undefined}
                    onChange={(e) => setValues((v) => ({ ...v, [r.key]: e.target.value }))} />
                ) : (
                  <div className="rfill-row__conflict">
                    <span className="rfill-row__value"><span className="t-muted">In your profile: </span>{r.current}</span>
                    <Checkbox label={r.key === "links" ? `Add the resume's links: ${r.resume}` : `Use resume value: ${r.resume}`}
                      checked={!!use[r.key]} onChange={(e) => setUse((u) => ({ ...u, [r.key]: e.target.checked }))} />
                  </div>
                )}
                {r.mode === "new" && r.key === "links" ? <span id={`${inputId}-help`} className="field__help">Separate links with commas.</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {missing.length && found.length ? (
        <Text role="body-sm" muted as="p">{sentenceCase(listWords(missing))} {missing.length === 1 ? "wasn't" : "weren't"} in your resume. Add {missing.length === 1 ? "it" : "them"} in your profile below if you like.</Text>
      ) : null}

      <fieldset className="rfill-rights">
        <legend className="rfill-rights__legend">Your right to work</legend>
        <span id={`${id}-rights-help`} className="field__help">Never read from a resume. Pick one, or leave it as it is.</span>
        <div className="choice-group" role="radiogroup" aria-label="Your right to work" aria-describedby={`${id}-rights-help`}>
          {RIGHTS_ORDER.map((s) => (
            <label key={s} className={cx("choice", rights === s && "is-on")}>
              <input type="radio" className="sr-only" name={`${id}-rights`} value={s} checked={rights === s} onChange={() => setRights(s)} />
              <span>{WR_STATUS_TEXT[s]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {error ? <p className="rfill-error" role="alert">{error}</p> : null}
      <div className="rfill-review__actions">
        <Button type="submit" variant="primary" loading={busy}>Save profile</Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Text role="body-sm" muted as="span" className="rfill-review__note">A copy of your resume is kept in this workspace's Resumes folder, so tailoring and scoring can use it.</Text>
      </div>
    </form>
  );
}
