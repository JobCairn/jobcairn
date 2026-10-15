import icons from "../packs/icons.json" with { type: "json" };
import logos from "../packs/logos.json" with { type: "json" };
import arch from "../packs/architecture.json" with { type: "json" };

/**
 * The bundled asset packs (packages/video/packs, built once by scripts/build-packs.mjs from open-licence sources).
 * Nothing is fetched: every picture a scene shows comes from these tables or the workspace's own files.
 * Names from a spec are looked up with Object.hasOwn, never interpolated, so only pack data reaches the page.
 */
export interface Icon { tags: string[]; svg: string }
export interface Logo { title: string; hex: string; path: string; license: string; source?: string; names: string[] }
export interface ArchKind { label: string; icon: string; tags: string[] }

const ICONS = icons.icons as Record<string, Icon>;
const LOGOS = logos.logos as Record<string, Logo>;
const ARCH = arch.kinds as Record<string, ArchKind>;

export const ICON_NAMES: readonly string[] = Object.keys(ICONS).sort();
export const LOGO_SLUGS: readonly string[] = Object.keys(LOGOS).sort();
export const ARCH_KINDS: readonly string[] = Object.keys(ARCH);
export const FLOW_KINDS = ["screen", "decision", "start", "end"] as const;
export const PACK_CREDITS = [
  { pack: "Icons", source: icons.source, license: icons.license },
  { pack: "Technology logos", source: logos.source, license: logos.license, note: logos.note },
  { pack: "Architecture nodes", source: arch.source, license: arch.license },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9+#.& ]/g, " ").replace(/\s+/g, " ").trim();
const LOGO_BY_NAME = new Map<string, string>();
for (const [slug, l] of Object.entries(LOGOS)) for (const n of l.names) LOGO_BY_NAME.set(norm(n), slug);

export function icon(name: string | undefined): Icon | null {
  return name && Object.hasOwn(ICONS, name) ? ICONS[name]! : null;
}
export function archKind(kind: string | undefined): ArchKind | null {
  return kind && Object.hasOwn(ARCH, kind) ? ARCH[kind]! : null;
}
/** A logo by slug or by any of its names ("Prometheus", "k8s", "postgres"). */
export function logo(name: string | undefined): (Logo & { slug: string }) | null {
  if (!name) return null;
  const slug = Object.hasOwn(LOGOS, name) ? name : LOGO_BY_NAME.get(norm(name));
  return slug ? { ...LOGOS[slug]!, slug } : null;
}

/** The logos named in a label, in order ("Prometheus and Grafana" gives both). Whole words only. */
export function logosIn(label: string): (Logo & { slug: string })[] {
  const words = norm(label).split(" ");
  const out: (Logo & { slug: string })[] = [];
  for (let i = 0; i < words.length; i++) {
    for (const len of [3, 2, 1]) {
      const hit = logo(words.slice(i, i + len).join(" "));
      if (hit && i + len <= words.length) { if (!out.some((o) => o.slug === hit.slug)) out.push(hit); i += len - 1; break; }
    }
  }
  return out;
}

/** The best icon for a label: the first word that is an icon name or one of its tags. */
export function iconFor(label: string): string | null {
  const words = norm(label).split(" ").filter((w) => w.length > 1);
  for (const w of words) if (Object.hasOwn(ICONS, w)) return w;
  for (const w of words) for (const [name, ic] of Object.entries(ICONS)) if (ic.tags.includes(w)) return name;
  // plural or "-ing" forms: "agents", "checkpointing"
  for (const w of words) {
    const stem = w.replace(/(ing|s)$/, "");
    if (stem.length < 3) continue;
    for (const [name, ic] of Object.entries(ICONS)) if (ic.tags.some((t) => t === stem || t.startsWith(stem))) return name;
  }
  return null;
}

export type Picture = { kind: "logo"; logo: Logo & { slug: string } } | { kind: "icon"; name: string; icon: Icon } | { kind: "initials"; text: string };

/** Initials for a label with no picture: "Data sharding" gives "DS", "AWS" stays "AWS". */
export function initials(label: string): string {
  const w = label.trim().split(/\s+/).filter(Boolean);
  if (w.length === 1 && /^[A-Z0-9]{2,4}$/.test(w[0]!)) return w[0]!;
  return w.slice(0, 2).map((x) => Array.from(x)[0]!.toUpperCase()).join("") || "?";
}

/** What an item shows: its named logo, its named icon, a logo or icon its label suggests, else initials. */
export function pictureFor(label: string, p: { icon?: string; logo?: string; kind?: string } = {}): Picture {
  const l = logo(p.logo);
  if (l) return { kind: "logo", logo: l };
  const named = icon(p.icon);
  if (named) return { kind: "icon", name: p.icon!, icon: named };
  const ak = archKind(p.kind);
  if (ak) return { kind: "icon", name: ak.icon, icon: icon(ak.icon)! };
  const inLabel = logosIn(label)[0];
  if (inLabel) return { kind: "logo", logo: inLabel };
  const guess = iconFor(label);
  if (guess) return { kind: "icon", name: guess, icon: icon(guess)! };
  return { kind: "initials", text: initials(label) };
}
