import type { VideoSceneDraft } from "@careeros/contract";

type Field = VideoSceneDraft["fields"][number];

const TITLE = ["title", "headline", "question", "label", "name", "city", "text"];
const SUB = ["subtitle", "closing", "verdict", "source", "prompt", "note", "by", "location", "region", "detail"];

/**
 * A scene's on-screen text sorted into the slide's parts: the small kicker, the big title, a subtitle line and up to
 * four points. Field paths decide the part (spec.ts editableFields), so every scene type maps the same way.
 */
export function slideParts(fields: { path: string; value: string }[]): { kicker: string; title: string; subtitle: string; points: string[]; more: number } {
  const get = (keys: string[]) => keys.map((k) => fields.find((f) => f.path === k)?.value.trim() ?? "").find(Boolean) ?? "";
  const used = new Set([...TITLE, ...SUB, "kicker"]);
  const rest = fields.filter((f) => !used.has(f.path) && f.value.trim()).map((f) => f.value.trim());
  return { kicker: get(["kicker"]), title: get(TITLE), subtitle: get(SUB), points: rest.slice(0, 4), more: Math.max(0, rest.length - 4) };
}

/**
 * A small picture of the scene's slide: the kicker, title, subtitle and points in the dark Graphite palette, as the video
 * is always dark whatever the app theme. Decorative for screen readers: the same words are in the scene's fields.
 */
export function SlidePreview({ fields, label }: { fields: Field[] | { path: string; value: string }[]; label: string }) {
  const p = slideParts(fields);
  const empty = !p.kicker && !p.title && !p.subtitle && !p.points.length;
  return (
    <div className="vslide" data-theme="graphite" aria-hidden="true" title={label}>
      {empty ? <span className="vslide__empty">No on-screen text</span> : (
        <>
          {p.kicker ? <span className="vslide__kicker">{p.kicker}</span> : null}
          {p.title ? <span className="vslide__title">{p.title}</span> : null}
          {p.subtitle ? <span className="vslide__sub">{p.subtitle}</span> : null}
          {p.points.length ? (
            <span className="vslide__points">
              {p.points.map((x, i) => <span key={i} className="vslide__point">{x}</span>)}
              {p.more ? <span className="vslide__more">{`+${p.more} more`}</span> : null}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}
