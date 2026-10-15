import { cx, useToast } from "@careeros/brand";
import { isSafeHttpsUrl } from "@careeros/contract";
import { errorText, useBridge } from "../bridge-context";
import { boardById, resolveBoard, type Board, type SourceLike } from "./boards";
import "./source.css";

export interface SourceBadgeProps {
  job: SourceLike;
  size?: "sm" | "md";
  /** Show the board's name next to the icon. Without it, only the icon shows (for tight
   * table cells) - the name is still available as the tooltip and accessible name. */
  showName?: boolean;
  className?: string;
}

function BoardIconView({ board }: { board: Board }) {
  if (board.icon.kind === "image") {
    // Decorative: the parent span/button already carries the accessible name ("Found on X").
    return <img className="source-badge__mark" data-board={board.id} src={board.icon.src} alt="" />;
  }
  return <span className={cx("source-badge__mono", `source-badge__mono--${board.icon.tone}`)}>{board.icon.letters}</span>;
}

/** A board's logo (brand mark or monogram) by board id, decorative: callers show the name next to it. */
export function BoardIcon({ id, size = "sm", className }: { id: string; size?: "sm" | "md"; className?: string }) {
  const board = boardById(id);
  if (!board) return null;
  return <span className={cx("source-badge", `source-badge--${size}`, className)} aria-hidden="true"><BoardIconView board={board} /></span>;
}

/**
 * Where a job came from: a brand mark (Simple Icons, CC0) for a board that has one, a quiet
 * monogram for every other board (never a redrawn logo). When `job.url` is a safe https
 * address, the badge is clickable and opens the original ad through the same safe-link IPC
 * as every other external link in the app (bridge.links.open - https only, behind the
 * shell's own confirm); any other scheme or shape (javascript:, file:, plain http, a
 * malformed address) is refused and the badge stays a plain, non-interactive tag.
 */
export function SourceBadge({ job, size = "md", showName = false, className }: SourceBadgeProps) {
  const bridge = useBridge();
  const toast = useToast();
  const board = resolveBoard(job);
  const url = job.url;
  const openable = typeof url === "string" && url.startsWith("https://") && isSafeHttpsUrl(url);
  const tooltip = openable ? `Open the ad on ${board.name}` : `Found on ${board.name}`;
  const accessibleName = `Found on ${board.name}`;
  const cls = cx("source-badge", `source-badge--${size}`, openable && "source-badge--link", className);
  const body = (
    <>
      <BoardIconView board={board} />
      {showName ? <span className="source-badge__name">{board.name}</span> : null}
    </>
  );

  if (!openable) {
    return <span className={cls} title={tooltip} aria-label={accessibleName}>{body}</span>;
  }
  const open = () => void bridge.links.open(url!).catch((e: unknown) => toast({ tone: "danger", text: `Couldn't open the link: ${errorText(e)}` }));
  return (
    <button type="button" className={cls} title={tooltip} aria-label={tooltip} onClick={open}>
      {body}
    </button>
  );
}
