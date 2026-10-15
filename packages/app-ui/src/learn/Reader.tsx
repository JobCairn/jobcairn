import { useEffect, useState, type ReactNode } from "react";
import { Button, Checkbox, Icons, Text, PRODUCT_NAME } from "@careeros/brand";
import type { LearnEntry, LearnItem } from "@careeros/contract";
import { useBridge, useLoad } from "../bridge-context";
import { displayName } from "../components/displayName";
import { Markdown } from "../components/Markdown";
import { ListenButton } from "../listen";
import { ErrorState, Loading } from "../components/States";
import { fmtDate } from "../format";
import { sourceText, TYPE_TEXT } from "./LearnCard";

const dirOf = (p: string) => p.split("/").slice(0, -1).join("/");

function VideoPlayer({ item }: { item: Pick<LearnItem, "path" | "title"> }) {
  const bridge = useBridge();
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [item.path]);
  const shown = displayName(item.title);
  if (broken) return <ErrorState title="This video can't be played" text={`${shown} didn't load. It may have been moved or deleted from your ${PRODUCT_NAME} folder.`} />;
  return (
    <div className="stack">
      {/* Always the workspace's own careeros-file: URL, never a remote one, and never autoplaying. */}
      <video className="media" controls preload="metadata" src={bridge.fileUrl(item.path)} aria-label={shown} onError={() => setBroken(true)}>
        <track kind="captions" />
      </video>
      <Text role="body-sm" muted>No captions for this video yet.</Text>
    </div>
  );
}

/** The body of one item: a guide's Markdown, or a video. */
export function ItemBody({ item }: { item: Pick<LearnItem, "path" | "title" | "kind"> }) {
  const isVideo = item.kind === "video";
  const text = useLoad((b) => (isVideo ? Promise.resolve("") : b.files.readText(item.path)), [item.path], ["learn"]);
  if (isVideo) return <VideoPlayer item={item} />;
  // Loading first: `text.data` can still hold the previous guide while the next one loads.
  if (text.loading) return <Loading />;
  if (text.error) return <ErrorState title="This guide can't be opened" text={text.error} />;
  return text.data !== undefined ? <Markdown text={text.data} baseDir={dirOf(item.path)} /> : <Loading />;
}

/** Reading view: comfortable width, the item's details, and a "done" checkbox that saves progress. */
export function Reader({ entry, onBack, onProgress, busy, actions }: {
  entry: LearnEntry; onBack: () => void; onProgress: (done: boolean) => void; busy: boolean;
  /** Buttons for the top row, next to Listen (the topic's video). */
  actions?: ReactNode;
}) {
  const title = displayName(entry.title);
  const kind = entry.type === "video" || /\.(mp4|webm|m4v|mov)$/i.test(entry.path) ? "video" : "guide";
  return (
    <article className="reader" aria-label={title}>
      <div className="reader__bar">
        <Button size="sm" variant="ghost" icon={Icons.back} onClick={onBack}>All topics</Button>
        <div className="reader__actions">
          {kind === "guide" ? (
            <span className="reader__listen" data-slot="listen"><ListenButton title={title} source={entry.path} target="listen-guide" /></span>
          ) : null}
          {actions}
        </div>
      </div>
      <header className="reader__head">
        <p className="t-label">{TYPE_TEXT[entry.type]}{entry.at ? ` · ${fmtDate(entry.at)}` : ""}</p>
        <Text role="heading-1">{title}</Text>
        {entry.source ? <Text role="body" muted>{sourceText(entry)}</Text> : null}
      </header>
      <div className="reader__body" id="listen-guide"><ItemBody item={{ path: entry.path, title: entry.title, kind }} /></div>
      <footer className="reader__foot">
        <Checkbox label="I've finished this" checked={entry.progress === "done"} disabled={busy}
          onChange={(e) => onProgress(e.target.checked)}
          help={entry.progress === "done" && entry.progress_at ? `Finished ${fmtDate(entry.progress_at)}` : "Ticking it moves it to your history."} />
      </footer>
    </article>
  );
}
