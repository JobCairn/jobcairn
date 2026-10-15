import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon, Icons, Pill, Text } from "@careeros/brand";
import { parseResume, parseResumeStyle, type ResumeItemRef, type ResumeModel, type ResumeStyle } from "@careeros/contract";
import { useBridge } from "../bridge-context";
import { MoreMenu, type MoreItem } from "../mail/MoreMenu";
import { PageThumb } from "./Preview";

/** Grid or list on the Resumes screen, remembered on this computer. */
export type FilesView = "grid" | "list";
export const VIEW_KEY = "careeros.resumes.view";
export const readView = (): FilesView => { try { return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid"; } catch { return "grid"; } };
export const saveView = (v: FilesView) => { try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode: not remembered */ } };

/** Tailored resumes group into one folder per company once there are more than this many. */
export const GROUP_OVER = 8;

/** A long file name shortened in the middle, keeping its start and its extension ("Alex Example - Ac…Resume.pdf"). */
export function middleEllipsis(name: string, max = 40): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : "";
  const stem = name.slice(0, name.length - ext.length);
  const keep = max - ext.length - 1;
  const head = Math.ceil(keep * 0.6);
  return `${stem.slice(0, head)}…${stem.slice(stem.length - (keep - head))}${ext}`;
}

/** The kind of file, from its name, for tiles that can't show a page. */
export function fileKind(name: string): { label: string; tone: "pdf" | "word" | "text" | "other" } {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return { label: "PDF", tone: "pdf" };
  if (ext === "docx" || ext === "doc") return { label: "Word", tone: "word" };
  if (ext === "md" || ext === "markdown" || ext === "txt") return { label: ext === "txt" ? "Text" : "Markdown", tone: "text" };
  return { label: ext.toUpperCase() || "File", tone: "other" };
}

// Page thumbnails are read once per resume and change time; the screen re-reads when a resume changes.
const cache = new Map<string, Promise<{ model: ResumeModel; style: ResumeStyle } | null>>();

function useThumb(source: ResumeItemRef | null, at: string, visible: boolean) {
  const bridge = useBridge();
  const [doc, setDoc] = useState<{ model: ResumeModel; style: ResumeStyle } | null>(null);
  const key = source ? `${JSON.stringify(source)}@${at}` : "";
  useEffect(() => {
    if (!source || !visible) return undefined;
    let on = true;
    let p = cache.get(key);
    if (!p) {
      p = (source.kind === "base"
        ? bridge.files.readText(source.rel).then((md) => ({ model: parseResume(md), style: parseResumeStyle({}) }))
        : bridge.resume.load(source, "resume.md").then((s) => ({ model: parseResume(s.markdown), style: s.style }))
      ).catch(() => null);
      cache.set(key, p);
    }
    void p.then((d) => { if (on) setDoc(d); });
    return () => { on = false; };
  }, [key, visible]); // eslint-disable-line react-hooks/exhaustive-deps
  return doc;
}

/** True once the element has come near the screen (always true without IntersectionObserver). */
function useNearScreen<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (near || !ref.current || typeof IntersectionObserver === "undefined") return undefined;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); } }, { rootMargin: "200px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [near]);
  return [ref, near];
}

export interface Tile {
  key: string;
  name: string;
  /** A short line under the name: when, and for a tailored resume the job's status. */
  meta: ReactNode;
  /** What draws the page: a resume the studio can read, or nothing (a PDF or Word file shows its kind). */
  source: ResumeItemRef | null;
  /** Changes when the resume does, so the thumbnail is read again. */
  at: string;
  /** The file's own name, for the kind badge when there's no page to show. */
  fileName?: string;
  /** A state shown on the tile ("Being written"). */
  badge?: string;
  /** Folder tiles: a company with its resumes inside. */
  folder?: number;
  open(): void;
  openLabel: string;
  actions: MoreItem[];
}

function Thumb({ tile }: { tile: Tile }) {
  const [ref, near] = useNearScreen<HTMLSpanElement>();
  const doc = useThumb(tile.source, tile.at, near);
  if (tile.folder !== undefined) {
    return <span ref={ref} className="rf-thumb rf-thumb--folder"><Icon icon={Icons.folder} /></span>;
  }
  if (tile.source && doc) return <span ref={ref} className="rf-thumb rf-thumb--page"><PageThumb model={doc.model} style={doc.style} /></span>;
  const kind = fileKind(tile.fileName ?? tile.name);
  return (
    <span ref={ref} className={`rf-thumb rf-thumb--kind rf-kind--${kind.tone}`}>
      <Icon icon={Icons.file} />
      <span className="rf-thumb__kind">{(tile.source && !doc) || tile.badge ? "" : kind.label}</span>
    </span>
  );
}

/**
 * A responsive grid of file tiles, like a file browser: the arrow keys move between tiles (one tab stop for the grid),
 * Enter opens, and each tile has a ⋯ menu that shows on hover and focus.
 */
export function TileGrid({ tiles, label, empty }: { tiles: Tile[]; label: string; empty: ReactNode }) {
  const [at, setAt] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  if (!tiles.length) return <div className="rf-empty">{empty}</div>;
  const cur = Math.min(at, tiles.length - 1);
  const focus = (i: number) => { setAt(i); list.current?.querySelectorAll<HTMLElement>(".rf-tile__open")[i]?.focus(); };
  const onKey = (e: KeyboardEvent, i: number) => {
    const opens = [...(list.current?.querySelectorAll<HTMLElement>(".rf-tile__open") ?? [])];
    // Tiles per row, from where they sit.
    const top = opens[0]?.getBoundingClientRect().top ?? 0;
    const cols = Math.max(1, opens.filter((o) => Math.abs(o.getBoundingClientRect().top - top) < 4).length);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + cols, ArrowUp: i - cols, Home: 0, End: tiles.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    // Up or down past the first or last row stays put, as in a file browser.
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && (next < 0 || next >= tiles.length)) return;
    focus(Math.max(0, Math.min(tiles.length - 1, next)));
  };
  return (
    <ul ref={list} className="rf-grid" aria-label={label}>
      {tiles.map((t, i) => (
        <li key={t.key} className={`rf-tile${t.folder !== undefined ? " rf-tile--folder" : ""}`}>
          <button type="button" className="rf-tile__open" tabIndex={i === cur ? 0 : -1} aria-label={t.openLabel} title={t.name}
            onClick={() => { setAt(i); t.open(); }} onKeyDown={(e) => onKey(e, i)} onFocus={() => setAt(i)}>
            <Thumb tile={t} />
            <span className="rf-tile__text">
              <span className="rf-tile__name">{middleEllipsis(t.name)}</span>
              <Text role="body-sm" muted as="span" className="rf-tile__meta">{t.meta}</Text>
            </span>
          </button>
          {t.badge ? <span className="rf-tile__badge"><Pill tone="neutral">{t.badge}</Pill></span> : null}
          {t.actions.length ? <div className="rf-tile__menu"><MoreMenu label={`Actions for ${t.name}`} items={t.actions} /></div> : null}
        </li>
      ))}
    </ul>
  );
}

/** A section heading that folds the section, with its count. */
export function FoldHeading({ id, icon, title, count, open, onToggle, right }: {
  id: string; icon: typeof Icons.file; title: string; count: number; open: boolean; onToggle(): void; right?: ReactNode;
}) {
  return (
    <div className="rf-head">
      <h2 className="rf-head__title" id={id}>
        <button type="button" className="rf-head__fold" aria-expanded={open} onClick={onToggle}>
          <Icon icon={open ? Icons.expand : Icons.folded} size="sm" />
          <Icon icon={icon} size="sm" />
          <span>{title}</span>
          <span className="rf-head__count" aria-label={`${count} ${count === 1 ? "item" : "items"}`}>{count}</span>
        </button>
      </h2>
      {right ? <div className="rf-head__right">{right}</div> : null}
    </div>
  );
}
