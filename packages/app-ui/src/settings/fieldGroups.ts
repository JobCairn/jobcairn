import type { FieldDef, SettingsKind } from "@careeros/contract";
import { Icons, type IconGlyph } from "@careeros/brand";

export interface FieldGroup { id: string; title: string; icon: IconGlyph; fields: FieldDef[] }
interface GroupDef { id: string; title: string; icon: IconGlyph; match: (path: string) => boolean }

const top = (p: string) => p.split(".")[0]!;
const GROUPS: Partial<Record<SettingsKind, GroupDef[]>> = {
  profile: [
    { id: "about-you", title: "About you", icon: Icons.user, match: (p) => top(p) === "contact" },
    { id: "work-rights", title: "Work rights", icon: Icons.privacy, match: (p) => top(p) === "work_rights" },
    { id: "languages", title: "Languages", icon: Icons.interview, match: (p) => top(p) === "languages" },
    // Target roles and job types are search filters (Settings › Search); what's left here describes you.
    { id: "roles", title: "Experience", icon: Icons.target, match: (p) => top(p) === "targets" },
    { id: "locations", title: "Where you want to work", icon: Icons.company, match: (p) => top(p) === "locations" },
    { id: "salary", title: "Salary", icon: Icons.salary, match: (p) => top(p) === "salary" },
    { id: "companies", title: "Companies and industries", icon: Icons.jobs, match: (p) => top(p) === "industries" || p.startsWith("skip_") },
  ],
  search: [
    // Find jobs reads these with the profile's roles and minimum salary (contract find-prefs.ts).
    { id: "looking", title: "What you're looking for", icon: Icons.target, match: (p) => p.startsWith("filters.") },
    { id: "plan", title: "Your search plan", icon: Icons.calendar, match: (p) => p === "search_deadline" || p === "weekly_goal" },
  ],
};

/**
 * Splits a settings form into short titled sections ("About you", "Work rights"...) by field path, keeping the
 * schema's field order inside each. Fields no group claims land in "More", so nothing is ever dropped.
 */
export function groupFields(kind: SettingsKind, fields: readonly FieldDef[]): FieldGroup[] {
  const defs = GROUPS[kind] ?? [];
  const out: FieldGroup[] = defs.map((d) => ({ id: d.id, title: d.title, icon: d.icon, fields: [] }));
  const more: FieldGroup = { id: "more", title: "More", icon: Icons.settings, fields: [] };
  for (const f of fields) {
    const i = defs.findIndex((d) => d.match(f.path));
    (i >= 0 ? out[i]! : more).fields.push(f);
  }
  return [...out, more].filter((g) => g.fields.length);
}
