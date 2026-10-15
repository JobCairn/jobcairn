import { useLoad } from "../bridge-context";
import { WORKSPACE } from "../components/ActionButton";
import { errorSentence } from "../components/ErrorBanner";
import { MakeVideoButton } from "../components/MakeVideo";
import { EmptyState, ErrorState, Loading, ScreenHead } from "../components/States";
import { VideoRegions } from "../components/VideoList";

/**
 * Videos: every video CareerOS made in this workspace, by topic, job, company and week, with play, render again
 * and delete. New videos start from a job, a Learn topic, or here (this week's recap).
 */
export function VideosScreen() {
  const { data, error } = useLoad((b) => b.learn.list(), [], ["learn", "jobs", "video"]);
  if (error && !data) return <ErrorState title="Videos can't be shown" text={errorSentence(error)} />;
  if (!data) return <Loading />;
  const any = data.videos.length + data.video_recaps.length > 0;
  return (
    <>
      <ScreenHead title="Videos" sub="Every video you've made: job walkthroughs, company briefings, lessons and weekly recaps."
        right={<MakeVideoButton target={WORKSPACE} typeId="weekly-recap" label="Weekly recap" title="Make this week's recap video" variant="primary" size="md" />} settings="videos" />
      <div data-tour="videos-list">
        {any ? <VideoRegions videos={data.videos} recaps={data.video_recaps} />
          : <EmptyState boxed text="No videos yet. Make one from a job's page, a Learn topic, or start with this week's recap." />}
      </div>
    </>
  );
}
