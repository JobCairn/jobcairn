import { Button, Icons } from "@careeros/brand";
import { topicSlug as slugOfTopic, type VideoListItem } from "@careeros/contract";
import { MakeVideoButton } from "../components/MakeVideo";
import { navigate } from "../router";

/** The newest video on this topic that can be played (a final cut or a draft), if any. */
export function latestTopicVideo(videos: VideoListItem[], topic: string): VideoListItem | undefined {
  return videos
    .filter((v) => v.subject.kind === "topic" && slugOfTopic(v.subject.topic) === topic && !v.legacy && (v.final || v.draft))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
}

/**
 * The reader's video button, next to Listen: "Watch video" opens the topic's newest video when there is one,
 * with "New video" beside it; otherwise "Make video".
 */
export function TopicVideoActions({ topic, name, videos }: { topic: string; name: string; videos: VideoListItem[] | undefined }) {
  const target = { kind: "topic" as const, topic, label: name };
  const latest = videos ? latestTopicVideo(videos, topic) : undefined;
  if (!latest) return <MakeVideoButton target={target} label="Make video" ariaLabel={`Make video: ${name}`} />;
  return (
    <>
      <Button size="sm" variant="secondary" icon={Icons.play} aria-label={`Watch video: ${name}`}
        onClick={() => navigate({ screen: "video", folder: latest.folder })}>Watch video</Button>
      <MakeVideoButton target={target} label="New video" ariaLabel={`Make video: ${name}`} variant="ghost" />
    </>
  );
}
