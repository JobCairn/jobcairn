import { loadSchema } from "./schema.js";
import type { Kind } from "./types.js";

export interface FieldDef {
  path: string; label: string; type: string; options: string[]; optionLabels: Record<string, string>;
  help: string; pattern: string; fields: FieldDef[];
  /** A list row's choice that starts set to the schema's default (a new language row: Professional). Only on list sub-fields. */
  default?: string;
}

type Node = {
  type?: string | string[]; enum?: string[]; pattern?: string; properties?: Record<string, Node>; items?: Node; default?: unknown;
  "x-ui"?: { label?: string; help?: string; options?: Record<string, string> };
};

function typeOf(n: Node): string {
  if (n.enum) return "enum";
  const t = Array.isArray(n.type) ? n.type.join("|") : n.type;
  if (t === "array") {
    if (n.items?.enum) return "enum[]";
    if (n.items?.properties) return "object[]";
    if (typeof n.items?.type === "string") return `${n.items.type}[]`;
    return "array";
  }
  return t ?? "unknown";
}

function walk(node: Node, prefix: string, out: FieldDef[], inList = false): FieldDef[] {
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    const ui = child["x-ui"];
    if (ui?.label) {
      const type = typeOf(child);
      out.push({
        path, label: ui.label, type,
        options: child.enum ?? child.items?.enum ?? [],
        optionLabels: ui.options ?? {},
        help: ui.help ?? "",
        pattern: child.pattern ?? "",
        fields: type === "object[]" && child.items ? walk(child.items, "", [], true) : [],
        ...(inList && type === "enum" && typeof child.default === "string" ? { default: child.default } : {}),
      });
    }
    if (child.properties) walk(child, path, out);
  }
  return out;
}

export function fieldsFor(kind: Kind): FieldDef[] {
  return walk(loadSchema(kind) as Node, "", []);
}
