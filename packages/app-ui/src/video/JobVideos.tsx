import type { ActionTarget, VideoListItem } from "@careeros/contract";
import { useLoad } from "../bridge-context";
import { ActionButton } from "../components/ActionButton";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { VideoRows } from "../components/VideoList";

/**
 * A job's videos on its Interview tab, each with its stage ("Script ready for your review", "Video ready"), so a
 * video started here is never out of sight. Shows nothing until the job has a video.
 */
export function JobVideos({ slug, id }: { slug: string; id: string }) {
  const list = useLoad((b) => b.learn.list(), [], ["learn", "jobs", "video"]);
  const mine = (list.data?.videos ?? []).filter((v) => v.subject.kind === "job" && v.subject.company_slug === slug && v.subject.id === id);
  return mine.length ? <VideoRows items={mine} label="This job's videos" /> : null;
}

/**
 * Is this video about this job? Its own videos (JD walkthrough, interview prep, pitch, application summary), lessons
 * made from its gaps, and the company's briefings: "Make a company background video" sits on this job's page, so the
 * video it makes is listed here too.
 */
export function isJobVideo(v: VideoListItem, slug: string, id: string): boolean {
  const s = v.subject;
  if (s.kind === "job") return s.company_slug === slug && s.id === id;
  if (s.kind === "topic") return s.company_slug === slug && s.id === id;
  if (s.kind === "company") return s.company_slug === slug;
  return false;
}

/** This job's videos, newest first. One source for the Videos tab, its count and the Description toolbar's link. */
export function useJobVideos(slug: string, id: string): { items: VideoListItem[] | null; error: string | null } {
  const list = useLoad((b) => b.video.list({ company_slug: slug }), [slug], ["video", "learn", "jobs"]);
  return { items: list.data ? list.data.filter((v) => isJobVideo(v, slug, id)) : null, error: list.error ?? null };
}

/**
 * The job page's Videos tab: every video for this job with where it is up to, how long it is and how long it took
 * to make. Opening one goes to its page; Back comes here. With none yet, the two Make buttons from Description.
 */
export function JobVideosPanel({ slug, id, items, error, canMake }: { slug: string; id: string; items: VideoListItem[] | null; error: string | null; canMake: boolean }) {
  const job: ActionTarget = { kind: "job", company_slug: slug, id };
  if (!items) return error ? <ErrorState title="This job's videos can't be shown" text={error} /> : <Loading />;
  const make = canMake ? (
    <div className="row">
      <ActionButton action="jd_walkthrough_video" target={job} />
      <ActionButton action="company_background_video" target={job} />
    </div>
  ) : undefined;
  if (!items.length) return <EmptyState boxed text="No videos for this job yet. A JD walkthrough explains the role and how you match it." action={make} />;
  return (
    <div className="stack job-panel" data-tour="job-videos">
      <VideoRows items={items} label="This job's videos" context={false} heading={false} />
      {make}
    </div>
  );
}
