import { useEffect, useState } from "react";
import { Button, Icons, Input, Text } from "@careeros/brand";
import { followUpDate, INTERVIEW_AT, type JobDetail } from "@careeros/contract";
import { useAction, useBridge } from "../bridge-context";
import "./extras.css";

const dayText = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const whenText = (at: string) => new Date(at).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * The interview's date and time (saved with the job), and "Add to Calendar", which opens an .ics file with the
 * computer's calendar. `readOnly` when the job can't be changed right now.
 */
export function InterviewDate({ d, readOnly }: { d: JobDetail; readOnly?: boolean }) {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const j = d.job;
  const saved = j.interview_at ?? "";
  const [value, setValue] = useState(saved);
  useEffect(() => setValue(saved), [saved]);
  const ok = value === "" || INTERVIEW_AT.test(value);
  const save = (at: string) => run("interview-at", () => bridge.jobs.setInterview(j.company_slug, j.id, at), at ? "Interview time saved" : "Interview time cleared");
  const addToCalendar = () => run("calendar-interview", () => bridge.jobs.addToCalendar(j.company_slug, j.id, "interview"), "Opened in your calendar");
  return (
    <section className="job-dates stack" aria-label="Interview date">
      {readOnly ? (
        <Text role="body">{saved ? `Interview: ${whenText(saved)}` : "No interview time set."}</Text>
      ) : (
        <form className="job-dates__row" onSubmit={(e) => { e.preventDefault(); if (ok && value !== saved) void save(value); }}>
          <Input type="datetime-local" label="Interview date and time" value={value} onChange={(e) => setValue(e.target.value)}
            error={ok ? undefined : "Pick a date and a time."} />
          <Button type="submit" disabled={!ok || value === saved} loading={busy === "interview-at"}>Save</Button>
          {saved ? <Button variant="ghost" onClick={() => void save("")}>Clear</Button> : null}
        </form>
      )}
      {saved ? (
        <div className="row">
          <Button icon={Icons.calendar} loading={busy === "calendar-interview"} onClick={() => void addToCalendar()}
            title="Opens the interview in your calendar app, which asks before adding it" aria-label="Add to Calendar">Calendar</Button>
        </div>
      ) : null}
    </section>
  );
}

/** While applied with no reply: when to follow up, with "Add to Calendar". Nothing for other statuses. */
export function FollowUpDate({ d }: { d: JobDetail }) {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const date = followUpDate(d.job);
  if (!date) return null;
  const addToCalendar = () => run("calendar-follow-up", () => bridge.jobs.addToCalendar(d.job.company_slug, d.job.id, "follow_up"), "Opened in your calendar");
  return (
    <section className="job-dates job-dates__row" aria-label="Follow-up date">
      <Text role="body">Follow up by {dayText(date)} if there&apos;s no reply.</Text>
      <Button size="sm" icon={Icons.calendar} loading={busy === "calendar-follow-up"} onClick={() => void addToCalendar()}
        title="Opens the follow-up in your calendar app, which asks before adding it" aria-label="Add to Calendar">Calendar</Button>
    </section>
  );
}
