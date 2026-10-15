import { useState } from "react";
import { Button, useToast } from "@careeros/brand";
import { chunkMarkdown, mergeSpoken } from "@careeros/contract";
import { errorText, useBridge } from "../bridge-context";
import { listenParts } from "./blocks";
import { useListenPlayer, type ListenChunk } from "./context";
import { Pause, Play, RotateCcw, Volume2 } from "./icons";

export interface ListenButtonProps {
  /** What is being read, shown in the player bar ("Job description", a guide's title). */
  title: string;
  /** Markdown or plain text to read. */
  text?: string;
  /** Already-split paragraphs to read. */
  blocks?: string[];
  /** The workspace file the text comes from. With no text, the button reads this file when pressed. */
  source?: string;
  /** Element id of the rendered text: paragraphs come from it and the one being read is highlighted. */
  target?: string;
  /** Shown when `source` is read on demand and isn't there yet. */
  missingText?: string;
  label?: string;
}

/**
 * The Listen button for a reading view. Renders nothing outside a PlayerProvider or when there is nothing
 * to read. While its text is playing it becomes the pause/resume control.
 */
export function ListenButton({ title, text, blocks, source = "", target, missingText, label = "Listen" }: ListenButtonProps) {
  const player = useListenPlayer();
  const bridge = useBridge();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  if (!player) return null;
  const onDemand = !!source && text === undefined && blocks === undefined;
  if (!onDemand && !text?.trim() && !blocks?.some((b) => b.trim())) return null;
  const key = target ?? (source || title);
  const v = player.view;
  const current = v.key === key && v.status !== "idle";

  const start = async () => {
    let chunks: ListenChunk[] = [];
    const el = target ? document.getElementById(target) : null;
    let targetId: string | null = null;
    // Short neighbours (headings, list items, key-fact rows) are joined so the voice doesn't stop after each line.
    const fromText = (md: string) => mergeSpoken(chunkMarkdown(md).map((t) => ({ text: t, block: -1 })));
    if (el) { chunks = mergeSpoken(listenParts(el)); targetId = target!; }
    if (!chunks.length && blocks) chunks = mergeSpoken(blocks.map((b, i) => ({ text: b, block: targetId ? i : -1 })));
    if (!chunks.length && text !== undefined) chunks = fromText(text);
    if (!chunks.length && onDemand) {
      setLoading(true);
      try {
        chunks = fromText(await bridge.files.readText(source));
      } catch (e) {
        const msg = errorText(e);
        const missing = !!missingText && !/locked/i.test(msg); // not written yet (or unreadable): say what to do
        toast({ tone: missing ? "neutral" : "danger", text: missing ? missingText! : msg });
        return;
      } finally { setLoading(false); }
    }
    if (!chunks.length) { toast({ tone: "neutral", text: "There's nothing to read aloud here." }); return; }
    player.start({ key, title, chunks, source, targetId });
  };

  if (current) {
    const lbl = v.status === "playing" ? "Pause" : v.status === "paused" ? "Resume" : v.status === "error" ? "Try again" : "Preparing voice…";
    return (
      <Button size="sm" icon={v.status === "preparing" ? undefined : v.status === "playing" ? Pause : v.status === "error" ? RotateCcw : Play}
        aria-label={v.status === "preparing" ? `Preparing voice for ${title}. Press to pause` : `${lbl}: ${title}`} aria-pressed onClick={player.toggle}
        className="listen-button listen-button--on">
        {v.status === "preparing" ? <span className="listen-bar__spinner" aria-hidden="true" /> : null}
        {lbl}
      </Button>
    );
  }
  return (
    <Button size="sm" icon={Volume2} loading={loading} aria-label={`${label}: ${title}`} onClick={() => void start()} className="listen-button">
      {label}
    </Button>
  );
}
