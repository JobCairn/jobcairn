import { useEffect, useRef, useState } from "react";
import { Button, Card, Icon, Icons, Text, useToast } from "@careeros/brand";
import type { ResumeFillState } from "@careeros/contract";
import { errorText, useBridge, useLoad } from "../bridge-context";
import { errorSentence } from "../components/ErrorBanner";
import { fmtDate } from "../format";
import { navigate } from "../router";
import { FIELD_WORD, listWords, ResumeReview } from "./ResumeReview";
import { ResumePicker, type ResumeSource } from "./ResumePicker";
import { SuggestTargets } from "./SuggestTargets";
import { clearDropBoxResume, pendingDropBoxResume } from "./handoff";
import "./resumefill.css";

/** "Name, email and phone filled. City kept as you had it." */
export function fillSummary(s: ResumeFillState): string {
  const filled = s.filled.map((k) => FIELD_WORD[k]);
  const kept = s.kept.map((k) => FIELD_WORD[k]);
  const a = filled.length ? `${listWords(filled).replace(/^./, (c) => c.toUpperCase())} filled in.` : "";
  const b = kept.length ? `Kept your own ${listWords(kept)}.` : "";
  return [a, b].filter(Boolean).join(" ") || "Your profile already matched it.";
}

/**
 * Top of Settings › Profile: "Fill from my resume", the review form, and afterwards a lasting note of what was
 * filled with the optional Claude suggestions. Shown while the Profile tab is open (`visible`), which also counts as
 * reviewing, so Home's notice goes.
 */
export function ResumeFillPanel({ visible }: { visible: boolean }) {
  const bridge = useBridge();
  const toast = useToast();
  const state = useLoad((b) => b.profile.fillState(), [], ["settings", "home"]);
  const [picked, setPicked] = useState<ResumeSource | null>(null);
  // The profile is read only once there is something to compare with or suggest for (the form below reads its own).
  const need = !!state.data || !!picked;
  const settings = useLoad((b) => (need ? b.settings.get("profile") : Promise.resolve(null)), [need], ["settings"]);
  const doneRef = useRef<HTMLDivElement>(null);
  const [focusDone, setFocusDone] = useState(false);
  const fill = state.data ?? null;
  // A file handed over from the Drop box: read it by name (main knows where it is), then review it as usual.
  const [handed] = useState(pendingDropBoxResume);
  const [handoff, setHandoff] = useState<{ name: string; error: string | null } | null>(() => (handed ? { name: handed, error: null } : null));
  useEffect(() => {
    const name = handed;
    if (!name) return undefined;
    clearDropBoxResume(name);
    let live = true;
    bridge.inbox.readResume(name).then(
      (read) => { if (live) { setHandoff(null); setPicked({ read, inbox: name }); } },
      (e: unknown) => { if (live) setHandoff({ name, error: errorText(e).replace(/\.?$/, ".") }); },
    );
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (p: ResumeSource) => { setHandoff(null); setPicked(p); };

  useEffect(() => {
    if (visible && fill && !fill.seen) void bridge.profile.markFillSeen().catch(() => undefined);
  }, [visible, fill?.at, fill?.seen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (focusDone && fill) { doneRef.current?.focus(); setFocusDone(false); } }, [focusDone, fill]);

  if (picked && settings.error && !settings.data) {
    return (
      <Card className="rfill-card">
        <p className="rfill-error" role="alert">Your profile can't be read right now, so nothing from your resume was used. {errorSentence(settings.error)}.</p>
        <Button variant="ghost" onClick={() => setPicked(null)}>Back</Button>
      </Card>
    );
  }
  if (picked && settings.data) {
    return (
      <Card className="rfill-card" data-tour="settings-resume-fill">
        <ResumeReview picked={picked} profile={settings.data.values}
          onSaved={() => {
            // Saving keeps a copy in Resumes; main then moves the Drop box file to the Trash so there is no second copy.
            if ("inbox" in picked) toast({ tone: "success", text: `${picked.inbox} is saved in your Resumes folder.` });
            setPicked(null); state.reload(); setFocusDone(true);
          }}
          onCancel={() => setPicked(null)} />
      </Card>
    );
  }

  if (picked) return <Card className="rfill-card"><Text role="body-sm" muted as="p" aria-live="polite">Comparing with your profile…</Text></Card>;
  if (handoff && !handoff.error) {
    return <Card className="rfill-card"><Text role="body-sm" muted as="p" aria-live="polite">Reading {handoff.name} from the Drop box…</Text></Card>;
  }
  // Couldn't read the Drop box file: say so above the usual picker, so another file can still be used.
  const handoffError = handoff?.error ? <p className="rfill-error" role="alert">{handoff.error}</p> : null;

  if (fill) {
    return (
      <Card className="rfill-card rfill-card--done">
        <div className="rfill-done" ref={doneRef} tabIndex={-1} aria-live="polite">
          <span className="rfill-done__icon" aria-hidden="true"><Icon icon={Icons.check} /></span>
          <div className="rfill-done__body">
            <Text role="body" as="h3" className="rfill-done__title">Profile filled from your resume</Text>
            <Text role="body-sm" muted as="p">
              {fmtDate(fill.at)} from <span className="rfill-file" title={fill.file}>{fill.file}</span>. {fillSummary(fill)} A copy of your resume is in this workspace's Resumes folder.
            </Text>
          </div>
        </div>
        {handoffError}
        <ResumePicker compact heading="Got a newer resume?" label="Change resume" tour="settings-resume-fill" onPicked={choose} />
        {settings.data ? <SuggestTargets profile={settings.data.values} /> : null}
      </Card>
    );
  }

  // Nothing filled yet: just the drop row (no card around it, so there is one frame, not two).
  return (
    <div className="rfill-card">
      {state.error ? <Text role="body-sm" muted as="p">{errorSentence(state.error)}.</Text> : null}
      {handoffError}
      <ResumePicker tour="settings-resume-fill" heading="Save typing: start from your resume" onPicked={choose} />
    </div>
  );
}

/**
 * Home: after a fill (onboarding or Settings), "Profile filled from your resume · Review" stays until the person
 * opens the review or dismisses it.
 */
export function ResumeFillNotice() {
  const bridge = useBridge();
  const state = useLoad((b) => b.profile.fillState(), [], ["settings", "home"]);
  const fill = state.data;
  if (!fill || fill.seen) return null;
  const review = () => {
    navigate({ screen: "settings", tab: "profile" });
    void bridge.profile.markFillSeen().catch(() => undefined);
  };
  return (
    <div className="rfill-notice" role="status" data-tour="home-resume-fill">
      <Icon icon={Icons.check} size="sm" />
      <Text role="body-sm" as="span" className="rfill-notice__text">Profile filled from your resume</Text>
      <span className="rfill-notice__dot" aria-hidden="true">·</span>
      <button type="button" className="rfill-notice__link" onClick={review}>Review</button>
      <Button size="sm" variant="ghost" className="rfill-notice__close" aria-label="Dismiss: profile filled from your resume" title="Dismiss"
        onClick={() => void bridge.profile.markFillSeen().catch(() => undefined)}>
        <Icon icon={Icons.close} size="sm" />
      </Button>
    </div>
  );
}
