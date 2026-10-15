import { useEffect, useState, type ReactNode } from "react";
import { Button, Drawer, Icon, Icons, Text, useToast } from "@careeros/brand";
import { canOpenExternally, type FilePreview } from "@careeros/contract";
import { useBridge, useLoad } from "../bridge-context";
import { showInFolderLabel } from "../components/files";
import { Markdown } from "../components/Markdown";
import { Loading } from "../components/States";
import { ListenButton } from "../listen";
import { navigate } from "../router";
import { noticeFor, paragraphs, textOf, viewerMeta, viewerTitle, type ViewerFile } from "./model";
import "./viewer.css";

const DOC_ID = "listen-viewer-doc";
const dirOf = (rel: string) => rel.split("/").slice(0, -1).join("/");

export interface FileViewerProps {
  files: ViewerFile[];
  /** The open file's position in `files`, or null when closed. */
  index: number | null;
  onIndex: (i: number) => void;
  onClose: () => void;
}

/**
 * One file at a time in a side panel: Markdown and text rendered, Word as a text preview, PDFs in the built-in
 * PDF viewer, images and video inline. Everything comes through files.preview (main decides locks and caps) and the
 * app's own file URL; nothing remote and no raw path is ever shown. Left and Right step through the list.
 */
export function FileViewer({ files, index, onIndex, onClose }: FileViewerProps) {
  const f = index === null ? null : files[index] ?? null;
  const [full, setFull] = useState(false);
  // One load per file, shared by the header and the body (a Word file goes through the reader once).
  const preview = usePreview(f?.rel ?? "");
  if (!f || index === null) return null;
  const many = files.length > 1;
  return (
    <Drawer open onClose={onClose} title={viewerTitle(f)} itemLabel="file" stepKeys="horizontal" size={full ? "full" : "wide"} className="viewer"
      subtitle={<span>{viewerMeta(f, preview.data ?? null)}</span>}
      onPrev={index > 0 ? () => onIndex(index - 1) : undefined}
      onNext={index < files.length - 1 ? () => onIndex(index + 1) : undefined}
      position={many ? `${index + 1} of ${files.length}` : undefined}
      toolbar={
        <button type="button" className="drawer__icon-btn" aria-pressed={full} aria-label={full ? "Show as a side panel" : "Expand to full width"}
          title={full ? "Show as a side panel" : "Expand to full width"} onClick={() => setFull((v) => !v)}>
          <Icon icon={full ? Icons.narrow : Icons.widen} size="sm" />
        </button>
      }>
      <ViewerBody key={f.rel} file={f} p={preview} />
    </Drawer>
  );
}

/** The preview for `rel`. `data` is null while another file's answer is still the latest one. */
function usePreview(rel: string): { data: FilePreview | null; error: string | null } {
  // Reloads when files change (Claude wrote a new version) or a folder is locked or allowed.
  const r = useLoad((b) => (rel ? b.files.preview(rel).then((p) => ({ rel, p })) : Promise.resolve(null)), [rel], ["jobs", "inbox", "learn", "privacy", "mail"]);
  const mine = r.data?.rel === rel ? r.data.p : null;
  return { data: mine, error: r.error && !r.loading ? r.error : null };
}

function ViewerBody({ file, p }: { file: ViewerFile; p: ReturnType<typeof usePreview> }) {
  const bridge = useBridge();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  useEffect(() => { setCopied(false); }, [file.rel]);
  const title = viewerTitle(file);

  if (!p.data && !p.error) return <Loading />;
  // A refusal from main quotes the path; the viewer says it in its own words instead.
  if (p.error || !p.data) return <Notice title="This file can't be shown" text="The app couldn't open it for a preview." actions={<Reveal rel={file.rel} />} />;
  const preview = p.data;
  const text = textOf(preview);
  const notice = noticeFor(file, preview);
  const canOpen = canOpenExternally(file.rel) && preview.state !== "locked" && preview.state !== "missing";

  const open = () => void bridge.files.open(file.rel).catch(() => toast({ tone: "danger", text: `Couldn't open this file in another app. Try ${showInFolderLabel()}.` }));
  const copy = async () => {
    if (text === null) return;
    try { await navigator.clipboard.writeText(text); setCopied(true); toast({ tone: "success", text: "Text copied" }); }
    catch { toast({ tone: "danger", text: "Couldn't copy. Select the text and copy it instead." }); }
  };

  return (
    <div className="viewer__body">
      <div className="viewer__actions" role="group" aria-label="File actions">
        {text !== null ? <ListenButton title={title} text={preview.kind === "word" ? undefined : text} blocks={preview.kind === "word" ? paragraphs(text) : undefined} target={DOC_ID} /> : null}
        {text !== null ? <Button size="sm" variant="ghost" icon={copied ? Icons.check : Icons.copy} onClick={() => void copy()}>{copied ? "Copied" : "Copy text"}</Button> : null}
        {canOpen && !notice?.open ? <Button size="sm" variant="ghost" icon={Icons.openExternal} title="Open in default app" onClick={open}>Open externally</Button> : null}
        {preview.state !== "missing" ? <Reveal rel={file.rel} /> : null}
      </div>
      {notice ? (
        <Notice title={notice.title} text={notice.text} locked={preview.state === "locked"}
          actions={notice.privacy ? <Button size="sm" icon={Icons.privacy} onClick={() => navigate({ screen: "privacy" })}>Open Privacy</Button>
            : notice.open ? <Button size="sm" variant="primary" icon={Icons.openExternal} title="Open in default app" onClick={open}>Open externally</Button> : null} />
      ) : preview.state === "ready" ? <Content file={file} preview={preview} title={title} /> : null}
    </div>
  );
}

function Content({ file, preview, title }: { file: ViewerFile; preview: FilePreview & { state: "ready" }; title: string }) {
  const bridge = useBridge();
  const [broken, setBroken] = useState(false);
  const text = preview.text ?? "";
  switch (preview.kind) {
    case "markdown":
      return <article id={DOC_ID} className="viewer__doc reading"><Markdown text={text} baseDir={dirOf(file.rel)} /></article>;
    case "text":
      return <pre id={DOC_ID} className="viewer__text" tabIndex={0} aria-label={title}>{text}</pre>;
    case "word":
      return (
        <>
          <Text role="body-sm" muted>A text preview of the Word file. Layout, fonts and images show only in Word.</Text>
          <article id={DOC_ID} className="viewer__doc viewer__word">{paragraphs(text).map((t, i) => <p key={i}>{t}</p>)}</article>
        </>
      );
    case "pdf":
      // No sandbox attribute: it stops the built-in PDF viewer from drawing anything. The frame can only load this
      // workspace PDF (main's frame rules and CSP), served by careeros-file: after the lock and kind checks.
      return broken ? <Notice title="This PDF didn't load" text="Open it in its default app instead." />
        : <iframe className="viewer__pdf" title={`PDF: ${title}`} src={bridge.fileUrl(file.rel)} referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
    case "image":
      return broken ? <Notice title="This image didn't load" text="It may have been moved or deleted." />
        : <div className="viewer__media"><img src={bridge.fileUrl(file.rel)} alt={title} onError={() => setBroken(true)} /></div>;
    case "video":
      return <div className="viewer__media"><video controls preload="metadata" src={bridge.fileUrl(file.rel)} aria-label={title}><track kind="captions" /></video></div>;
    default:
      return null;
  }
}

function Reveal({ rel }: { rel: string }) {
  const bridge = useBridge();
  const toast = useToast();
  const label = showInFolderLabel();
  return <Button size="sm" variant="ghost" icon={Icons.showInFolder} onClick={() => void bridge.files.reveal(rel).catch(() => toast({ tone: "danger", text: "Couldn't show this file. It may have been moved or deleted." }))}>{label}</Button>;
}

function Notice({ title, text, actions, locked = false }: { title: string; text: string; actions?: ReactNode; locked?: boolean }) {
  return (
    <div className="viewer__notice" role="status">
      <Icon icon={locked ? Icons.locked : Icons.file} />
      <Text role="heading-2" as="h3">{title}</Text>
      <Text role="body" muted>{text}</Text>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}
