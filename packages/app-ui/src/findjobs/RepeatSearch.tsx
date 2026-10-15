import { useEffect, useState } from "react";
import { Button, Checkbox, Input, PRODUCT_NAME, Select, Text, useToast } from "@careeros/brand";
import { SCHEDULE_HOURS, scheduleWords, WEEKDAY_WORDS, type ScheduleMode, type SearchSchedule } from "@careeros/contract";
import { errorText, useBridge, useLoad } from "../bridge-context";
import "./looking-for.css";

/** "Tue 15 Oct, 8:00 am" in the computer's own time. */
export function nextRunText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/**
 * Find jobs › "Repeat this search": off, every N hours (N times or until stopped), or daily at a time on chosen
 * weekdays. Saved in the workspace; the app runs it while it's open (each run asks only for ads since the last one,
 * newest first) and says when it next runs. "Open at login" keeps the app open so schedules run.
 */
export function RepeatSearch() {
  const bridge = useBridge();
  const toast = useToast();
  const v = useLoad((b) => b.schedule.get(), [], ["settings"]);
  const [draft, setDraft] = useState<SearchSchedule | null>(null);
  const [login, setLogin] = useState<boolean | null>(null);
  useEffect(() => { if (v.data) { setDraft(v.data.schedule); setLogin(v.data.open_at_login); } }, [v.data]);
  if (!v.data || !draft) return null;
  const set = (p: Partial<SearchSchedule>) => setDraft({ ...draft, ...p });
  const saved = v.data.schedule;
  const changed = JSON.stringify({ ...draft, since: "", last_run_at: "", runs: 0, searched_at: "", history: [] }) !== JSON.stringify({ ...saved, since: "", last_run_at: "", runs: 0, searched_at: "", history: [] }) || login !== v.data.open_at_login;
  const noDays = draft.mode === "daily" && !draft.days.length;
  const save = async () => {
    try {
      await bridge.schedule.save(draft, login === null ? undefined : login);
      v.reload();
      toast({ tone: "success", text: draft.mode === "off" ? "This search won't repeat." : `Saved: ${scheduleWords(draft)}` });
    } catch (e) { toast({ tone: "danger", text: `Not saved: ${errorText(e)}` }); }
  };
  return (
    <div className="repeat stack" role="group" aria-label="Repeat this search">
      <div className="repeat__row">
        <Select label="Repeat this search" value={draft.mode} onChange={(e) => set({ mode: e.target.value as ScheduleMode })}
          options={[{ value: "off", label: "Off" }, { value: "hours", label: "Every few hours" }, { value: "daily", label: "Daily at a time" }]} />
        {draft.mode === "hours" ? (
          <>
            <Select label="Every" value={String(draft.every_hours)} onChange={(e) => set({ every_hours: Number(e.target.value) })}
              options={SCHEDULE_HOURS.map((h) => ({ value: String(h), label: h === 1 ? "1 hour" : `${h} hours` }))} />
            <Select label="How many times" value={draft.times === null ? "" : String(draft.times)} onChange={(e) => set({ times: e.target.value ? Number(e.target.value) : null })}
              options={[{ value: "", label: "Until I stop it" }, ...[1, 2, 3, 5, 10].map((n) => ({ value: String(n), label: n === 1 ? "Once" : `${n} times` }))]} />
          </>
        ) : null}
        {draft.mode === "daily" ? (
          <Input label="At" type="time" value={draft.at} onChange={(e) => { if (/^\d{2}:\d{2}$/.test(e.target.value)) set({ at: e.target.value }); }} />
        ) : null}
      </div>
      {draft.mode === "daily" ? (
        <fieldset className="repeat__days">
          <legend className="qf-panel__label">On</legend>
          {[1, 2, 3, 4, 5, 6, 0].map((d) => (
            <Checkbox key={d} label={WEEKDAY_WORDS[d]!} checked={draft.days.includes(d)}
              onChange={(e) => set({ days: e.target.checked ? [...draft.days, d].sort((a, b) => a - b) : draft.days.filter((x) => x !== d) })} />
          ))}
        </fieldset>
      ) : null}
      {login !== null ? (
        <Checkbox label={`Open ${PRODUCT_NAME} at login, so repeated searches run`} checked={login} onChange={(e) => setLogin(e.target.checked)} />
      ) : null}
      <div className="repeat__foot">
        <Text role="body-sm" muted as="p" aria-live="polite">
          {saved.mode === "off" ? "Runs only when you press Find jobs."
            : v.data.next_run_at ? `${scheduleWords(saved)}. Next run: ${nextRunText(v.data.next_run_at)}, while ${PRODUCT_NAME} is open. Each run looks for ads since the last one, newest first.`
            : `${scheduleWords(saved)}: finished.`}
          {saved.mode !== "off" && saved.history[0] ? ` Last: ${saved.history[0].text} (${nextRunText(saved.history[0].at)}).` : ""}
        </Text>
        {changed ? <Button size="sm" variant="primary" disabled={noDays} title={noDays ? "Choose at least one day." : undefined} onClick={() => void save()}>Save</Button> : null}
      </div>
    </div>
  );
}
