import { fieldsFor, layout, readRecord, updateRecord } from "@careeros/core";
import { isCalendarDate, isDefaultLength, VIDEO_LENGTH_PATH, videoLengthPath, type SettingsChange, type SettingsData, type SettingsKind } from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { touch } from "./read.js";
import { loadRegistry } from "@careeros/video";

export function settingsFile(root: string, kind: SettingsKind): string {
  const L = layout(root);
  return kind === "profile" ? L.profile : kind === "search" ? L.search : L.integrations;
}

// Segments that would let a dotted path reach Object.prototype instead of an own property.
const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/** Exported only so prototype-pollution safety can be unit-tested directly; `save()` below is the only real caller. */
export function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const keys = dotted.split(".");
  if (keys.some((k) => UNSAFE_PATH_SEGMENTS.has(k))) throw new Error(`${dotted} can't be changed here`);
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    const next = Object.hasOwn(o, k) ? o[k] : undefined;
    if (typeof next !== "object" || next === null || Array.isArray(next)) o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  o[keys.at(-1)!] = value;
}

function get(ctx: ServiceContext, kind: SettingsKind): SettingsData {
  const root = ctx.requireRoot();
  return { kind, fields: fieldsFor(kind), values: readRecord(kind, settingsFile(root, kind)) as unknown as Record<string, unknown> };
}

/**
 * Writes only fields the schema labels as editable: leaves, and whole lists of records (Settings' list editor saves
 * the full list, e.g. the preferred places). The store validates the whole record before writing.
 */
function save(ctx: ServiceContext, kind: SettingsKind, changes: SettingsChange[]): SettingsData {
  const root = ctx.requireRoot();
  const editable = new Set(fieldsFor(kind).filter((f) => f.type !== "object").map((f) => f.path));
  // Custom video types (settings/video-types) have no schema field, but get a default length like the built-in ones.
  // Built-in types already have fields, so only the workspace's own types are read here (no video host needed).
  const lengthPaths = () => new Set(loadRegistry({ builtinDir: "", workspaceRoot: root }).types.map((t) => videoLengthPath(t.id)));
  for (const c of changes) {
    if (editable.has(c.path)) continue;
    if (kind === "integrations" && VIDEO_LENGTH_PATH.test(c.path) && lengthPaths().has(c.path)) {
      if (!isDefaultLength(c.value)) throw new Error("A default length must be whole seconds from 0 to 600.");
      continue;
    }
    throw new Error(`${c.path} can't be changed here`);
  }
  // The schema pattern only checks the shape; "2026-02-30" must not reach the file either.
  for (const c of changes) {
    if (kind === "search" && c.path === "search_deadline" && typeof c.value === "string" && c.value !== "" && !isCalendarDate(c.value)) {
      throw new Error("Search deadline must be a real date, like 2026-03-31.");
    }
  }
  const file = settingsFile(root, kind);
  updateRecord(kind, file, (cur) => { for (const c of changes) setPath(cur as unknown as Record<string, unknown>, c.path, c.value); });
  // A profile change can change eligibility; settings/ paths trigger a full index rebuild.
  touch(root, `settings/${kind}.json`);
  return get(ctx, kind);
}

export const settingsHandlers = {
  "settings.get": get,
  "settings.save": save,
} satisfies Partial<HandlerTable>;
