import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Icon, Icons } from "@careeros/brand";
import { useBridge } from "../bridge-context";
import { Diagram } from "./Diagram";
import "./markdown-visual.css";
import { CALLOUTS, remarkCallouts, sectionIcon, type CalloutKind } from "./markdown-callouts";
import { ExternalLink, hostLabel } from "./ExternalLink";
import { remarkGfmLite, remarkPlainPaths } from "./markdown-gfm";

/** Returns a URL that is safe to render, or "" to drop it. */
export function safeUrl(url: string, kind: "link" | "image", baseDir: string | undefined, fileUrl: (rel: string) => string): string {
  const u = url.trim();
  if (kind === "link") return /^https:\/\//i.test(u) ? u : "";
  // Images: never fetch from the network, never escape the workspace.
  if (!baseDir || /^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith("/") || u.includes("\\") || /[\x00-\x1f]/.test(u)) return "";
  // The author may have percent-encoded a segment (a space, a non-ASCII name, or an attempt to
  // smuggle ".." / "/" past the raw check below). Decode each segment once so the workspace-root
  // and traversal checks see the real characters, and so `fileUrl` encodes the result exactly
  // once instead of re-escaping an already-escaped string (which doubled "%" to "%25").
  const decoded: string[] = [];
  for (const seg of u.split("/")) {
    let d: string;
    try { d = decodeURIComponent(seg); } catch { return ""; }
    if (d.includes("/") || d.includes("\\")) return "";
    decoded.push(d);
  }
  const parts = [...baseDir.split("/"), ...decoded].filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) return "";
  return fileUrl(parts.join("/"));
}

// ---- autolinks --------------------------------------------------------------
// Bare URLs in pasted ads ("Apply via: https://…") become links. Only https is matched (http, file:,
// javascript: and the rest stay plain text). Balanced parentheses stay in the URL (Wikipedia-style
// "Foo_(bar)"); trailing punctuation is left out.
const BARE_URL = /https:\/\/(?:[^\s<>()]|\([^\s<>()]*\))+/g;
const TRAILING = /[.,;:!?'"]+$/;
interface MdNode { type: string; value?: string; url?: string; children?: MdNode[] }

export function autolinkNodes(node: MdNode): void {
  if (!node.children || node.type === "link" || node.type === "linkReference") return;
  node.children = node.children.flatMap((child): MdNode[] => {
    if (child.type !== "text" || !child.value) { autolinkNodes(child); return [child]; }
    const out: MdNode[] = [];
    let last = 0;
    for (const m of child.value.matchAll(BARE_URL)) {
      const url = m[0].replace(TRAILING, "");
      if (url.length <= "https://".length) continue;
      if (m.index! > last) out.push({ type: "text", value: child.value.slice(last, m.index) });
      out.push({ type: "link", url, children: [{ type: "text", value: url }] });
      last = m.index! + url.length;
    }
    if (!out.length) return [child];
    if (last < child.value.length) out.push({ type: "text", value: child.value.slice(last) });
    return out;
  });
}
const remarkAutolink = () => (tree: MdNode) => { autolinkNodes(tree); };

const textOf = (children: unknown): string =>
  Array.isArray(children) ? children.map(textOf).join("") : typeof children === "string" || typeof children === "number" ? String(children) : "";
/** The text of a hast node (a code block's source). */
interface HastNode { type: string; tagName?: string; value?: string; properties?: { className?: unknown }; children?: HastNode[] }
const hastText = (n: HastNode | undefined): string => (n ? n.value ?? (n.children ?? []).map(hastText).join("") : "");
const CALLOUT_ICONS: Record<CalloutKind, keyof typeof Icons> = { tldr: "checklist", tip: "tip", interview: "interview", watch: "watchOut", note: "info" };

function Callout({ kind, children }: { kind: CalloutKind; children: ReactNode }) {
  return (
    <aside className={`callout callout--${kind}`} aria-label={CALLOUTS[kind]}>
      <p className="callout__title"><Icon icon={Icons[CALLOUT_ICONS[kind]]} size="sm" />{CALLOUTS[kind]}</p>
      <div className="callout__body">{children}</div>
    </aside>
  );
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/**
 * Markdown for reading: raw HTML is skipped, links go through the bridge (system browser, never this
 * window), a link whose text is its own URL shows just the host, and images only come from the workspace.
 * GitHub-style tables, task lists and strikethrough work (markdown-gfm.ts), as do callouts and section icons
 * (markdown-callouts.ts) and ```mermaid diagrams (Diagram.tsx).
 */
export function Markdown({ text, baseDir, plain = false }: { text: string; baseDir?: string; /** Claude output: show workspace paths as plain names. */ plain?: boolean }) {
  const bridge = useBridge();
  const components: Components = {
    a: ({ href, children }) => {
      if (!href) return <span>{children}</span>;
      const raw = textOf(children);
      return <ExternalLink href={href}>{!raw || sameUrl(raw, href) ? hostLabel(href) : children}</ExternalLink>;
    },
    img: ({ src, alt }) => (typeof src === "string" && src
      ? <img src={src} alt={alt ?? ""} className="media" />
      : <span className="t-body-sm t-muted">Image not shown: {alt || "remote image"}</span>),
    // Wide tables scroll sideways in their own focusable region instead of stretching the page.
    table: ({ children }) => <div className="md-table" role="region" aria-label="Table" tabIndex={0}><table>{children}</table></div>,
    // ```mermaid blocks draw as diagrams (Diagram.tsx); every other code block stays as it is.
    pre: ({ node, children }) => {
      const code = (node as HastNode | undefined)?.children?.find((c) => c.tagName === "code");
      const cls = code?.properties?.className;
      return Array.isArray(cls) && cls.includes("language-mermaid") ? <Diagram code={hastText(code).replace(/\n$/, "")} /> : <pre>{children}</pre>;
    },
    blockquote: ({ node: _node, children, ...rest }) => {
      const kind = (rest as Record<string, unknown>)["data-callout"] as CalloutKind | undefined;
      return kind && kind in CALLOUTS ? <Callout kind={kind}>{children}</Callout> : <blockquote>{children}</blockquote>;
    },
    // Guide sections get a small icon by what they cover ("Key terms", "Practice this week"...).
    h2: ({ children }) => {
      const name = sectionIcon(textOf(children)) as keyof typeof Icons | null;
      return <h2>{name && Icons[name] ? <Icon icon={Icons[name]} size="sm" className="md-section-icon" /> : null}{children}</h2>;
    },
  };
  return (
    <div className="markdown prose">
      <ReactMarkdown skipHtml remarkPlugins={plain ? [remarkGfmLite, remarkCallouts, remarkAutolink, remarkPlainPaths] : [remarkGfmLite, remarkCallouts, remarkAutolink]} urlTransform={(url, key) => safeUrl(url, key === "src" ? "image" : "link", baseDir, bridge.fileUrl)} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
