import fs from "node:fs";
import path from "node:path";
import { check, isVideoFolderRel, slugify } from "@careeros/core";
import { SLIDE_SCENE_TYPES, type EntryPoint, type SceneType, type VideoSubject, type VideoType } from "./types.js";

export const TEMPLATE_WRITERS: ReadonlySet<string> = new Set(["weekly-recap"]);
export const BRIEF_KEYS: ReadonlySet<string> = new Set(["name", "gap", "role", "company", "week"]);
export const MAX_TYPE_BYTES = 64 * 1024;
const TOKENS = new Set(["slug", "id", "topic", "week", "n", "type"]);
const GLOB_RESOLVERS = new Set(["application.files", "history", "company.research"]);

export interface RegistryError { file: string; origin: "builtin" | "workspace"; problems: string[] }
export interface Registry {
  types: VideoType[]; errors: RegistryError[];
  byId(id: string): VideoType | undefined;
  forEntry(ep: EntryPoint | "all"): VideoType[];
}

export function lengthKey(typeId: string): string { return typeId.replace(/-/g, "_"); }

export function validateVideoType(data: unknown, origin: "builtin" | "workspace" = "workspace"): { value: Omit<VideoType, "origin" | "file"> | null; problems: string[] } {
  const r = check("video_type", data);
  if (!r.ok) return { value: null, problems: r.problems };
  const t = r.value;
  const p: string[] = [];
  if (!(t.length.min_s <= t.length.target_s && t.length.target_s <= t.length.max_s)) p.push("/length min_s, target_s and max_s must be in order");
  const tokens = [...t.output.matchAll(/\{([a-z]*)\}/g)].map((m) => m[1]!);
  for (const k of tokens) if (!TOKENS.has(k)) p.push(`/output uses an unknown token {${k}}`);
  if (t.output.replace(/\{[a-z]*\}/g, "").includes("{") || t.output.replace(/\{[a-z]*\}/g, "").includes("}")) p.push("/output has an unclosed { or }");
  if (t.output.startsWith("recaps/") && t.output !== "recaps/{week}/") p.push("/output under recaps/ must be exactly recaps/{week}/");
  // Ruling F5 / U2: recaps/ is written by a deterministic template, never Claude, so only a
  // built-in template writer may use it.
  if (t.output.startsWith("recaps/") && t.writer !== "template") p.push("/output: only a template writer may write under recaps/");
  if (tokens.includes("week") && t.subject !== "week") p.push("/output uses {week} but the subject is not a week");
  if (tokens.includes("topic") && t.subject !== "topic") p.push("/output uses {topic} but the subject is not a topic");
  if (t.subject === "job" && !t.output.startsWith("companies/{slug}/jobs/{id}/")) p.push("/output for a job video must be inside companies/{slug}/jobs/{id}/");
  if (t.subject === "company" && (!t.output.startsWith("companies/{slug}/") || t.output.startsWith("companies/{slug}/jobs/"))) p.push("/output for a company video must be inside companies/{slug}/ and not inside a job");
  if (t.subject === "week" && t.output !== "recaps/{week}/") p.push("/output for a weekly video must be recaps/{week}/");
  if (t.subject === "topic" && !t.output.startsWith("learning/{topic}/")) p.push("/output for a topic video must be inside learning/{topic}/");
  // Final review I2: a workspace type always makes a new folder of its own (its last segment has {n}), so it can
  // never point at a job's application/, research/ or any other folder the person keeps files in.
  if (origin === "workspace" && !/\{n\}[^/]*\/$/.test(t.output)) p.push("/output for your own video type must end in a numbered folder, like videos/my-video-{n}/");
  if (t.writer === "template" && !TEMPLATE_WRITERS.has(t.id)) p.push("/writer: only built-in types can use the template writer");
  if (t.skill === "video-slides") {
    const bad = t.scene_types.filter((s) => !SLIDE_SCENE_TYPES.includes(s as SceneType));
    if (bad.length) p.push(`/scene_types: the video-slides skill has no ${bad.join(", ")} scenes`);
  }
  for (const [s, c] of Object.entries(t.scene_counts)) {
    if (!t.scene_types.includes(s)) p.push(`/scene_counts.${s} is not in scene_types`);
    if (c.min > c.max) p.push(`/scene_counts.${s} min is above max`);
  }
  if (t.extras.includes("sources.md")) p.push("/extras: sources.md is always written; do not list it");
  if (t.modes.length && !t.scene_types.includes("quiz")) p.push("/modes only apply to types with quiz scenes");
  for (const s of t.sources) if (s.glob && !GLOB_RESOLVERS.has(s.resolver)) p.push(`/sources: ${s.resolver} takes no glob`);
  if (t.subject === "week" && t.sources.some((s) => s.resolver !== "index.stats")) p.push("/sources: a weekly video can only use index.stats");
  for (const m of t.brief_template.matchAll(/\{([^}]*)\}/g)) if (!BRIEF_KEYS.has(m[1]!)) p.push(`/brief_template uses an unknown placeholder {${m[1]}}`);
  if (p.length) return { value: null, problems: p };
  const { schema: _s, custom: _c, ...rest } = t;
  return { value: rest as unknown as Omit<VideoType, "origin" | "file">, problems: [] };
}

export function loadRegistry(o: { builtinDir: string; workspaceRoot?: string | null }): Registry {
  const types: VideoType[] = [];
  const errors: RegistryError[] = [];
  const load = (dir: string, origin: "builtin" | "workspace", shown: string) => {
    let st: fs.Stats;
    try { st = fs.lstatSync(dir); } catch { return; }
    if (st.isSymbolicLink() || !st.isDirectory()) { errors.push({ file: shown, origin, problems: ["is not a plain folder"] }); return; }
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort()) {
      const file = path.join(dir, name);
      const label = `${shown}/${name}`;
      const fst = fs.lstatSync(file);
      if (!fst.isFile()) { errors.push({ file: label, origin, problems: ["is not a regular file"] }); continue; }
      if (fst.size > MAX_TYPE_BYTES) { errors.push({ file: label, origin, problems: ["is larger than 64 KB"] }); continue; }
      let data: unknown;
      try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { errors.push({ file: label, origin, problems: [`invalid JSON: ${(e as Error).message}`] }); continue; }
      const { value, problems } = validateVideoType(data, origin);
      if (!value) { errors.push({ file: label, origin, problems }); continue; }
      if (types.some((t) => t.id === value.id)) {
        errors.push({ file: label, origin, problems: [origin === "workspace" ? `uses the id "${value.id}" of a built-in type` : `duplicate id "${value.id}"`] });
        continue;
      }
      if (name !== `${value.id}.json`) { errors.push({ file: label, origin, problems: [`the file name must be ${value.id}.json`] }); continue; }
      types.push({ ...value, origin, file: label });
    }
  };
  load(o.builtinDir, "builtin", "plugin/video-types");
  if (o.workspaceRoot) load(path.join(o.workspaceRoot, "settings", "video-types"), "workspace", "settings/video-types");
  return {
    types, errors,
    byId: (id) => types.find((t) => t.id === id),
    forEntry: (ep) => types.filter((t) => ep === "all" || t.entry_points.includes(ep)),
  };
}

/** Fills the type's output template for this subject. {n} becomes the lowest number with no folder yet. */
export function resolveOutputFolder(type: VideoType, subject: VideoSubject, root: string): string {
  if (subject.kind !== type.subject) throw new Error(`${type.label} is about a ${type.subject}, not a ${subject.kind}.`);
  const values: Record<string, string | undefined> = {
    type: type.id,
    slug: "company_slug" in subject ? subject.company_slug : undefined,
    id: "id" in subject ? subject.id : undefined,
    topic: subject.kind === "topic" ? slugify(subject.topic, "topic") : undefined,
    week: subject.kind === "week" ? subject.week : undefined,
  };
  let rel = type.output.replace(/\/$/, "");
  for (const [k, v] of Object.entries(values)) {
    if (!rel.includes(`{${k}}`)) continue;
    if (!v) throw new Error(`${type.label} needs a ${k === "id" ? "job" : k === "slug" ? "company" : k}.`);
    rel = rel.split(`{${k}}`).join(v);
  }
  const ok = (r: string) => { if (!isVideoFolderRel(r)) throw new Error(`"${r}" is not a valid video folder.`); return r; };
  if (!rel.includes("{n}")) return ok(rel);
  for (let n = 1; n < 10_000; n++) {
    const candidate = rel.split("{n}").join(String(n));
    if (!fs.existsSync(path.join(root, candidate))) return ok(candidate);
  }
  throw new Error("There are too many videos in this folder.");
}
