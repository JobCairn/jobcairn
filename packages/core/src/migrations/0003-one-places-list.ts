import { layout } from "../paths.js";
import { readRecord, RecordError, updateRecord } from "../store.js";
import type { Profile } from "../types.js";
import type { Migration } from "./index.js";

const MODES = ["onsite", "hybrid", "remote"] as const;
const text = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 80) : "");

type Place = Profile["locations"][number];

/** The search's places first (an existing profile entry keeps its modes), then the profile's other places. */
function mergePlaces(extra: readonly string[], cur: readonly Place[], fresh: Place["modes"]): Place[] {
  const out: Place[] = [];
  const seen = new Set<string>();
  const add = (key: string, p: Place) => { if (!seen.has(key)) { seen.add(key); out.push(p); } };
  for (const place of extra) add(place.toLowerCase(), cur.find((l) => text(l.place).toLowerCase() === place.toLowerCase()) ?? { place, modes: [...fresh], will_relocate: false });
  for (const l of cur) add(text(l.place).toLowerCase(), l);
  return out;
}

/**
 * One list of preferred places. The find-jobs work added `filters.locations` in settings/search.json, which
 * overrode the profile's `locations`. Now the profile's list is the only one (Settings edits it), so this folds the
 * search list in front of the profile's places (search order first, then any profile place not already there,
 * matched without regard to case), keeps each existing place's work modes, gives new places the search's work
 * modes (or all of them), and removes the search list. Find jobs still reads an old list if one turns up again.
 */
export const placesMigration: Migration = {
  id: 3,
  name: "one preferred places list",
  files: (root) => [layout(root).profile, layout(root).search],
  run: (root) => {
    const L = layout(root);
    let search: Record<string, unknown>;
    try { search = readRecord("search", L.search) as unknown as Record<string, unknown>; } catch (e) { if (e instanceof RecordError) return; throw e; }
    const filters = (search.filters && typeof search.filters === "object" ? search.filters : {}) as Record<string, unknown>;
    const extra = (Array.isArray(filters.locations) ? filters.locations : []).map(text).filter(Boolean);
    if (!Object.hasOwn(filters, "locations")) return;
    const wanted = Array.isArray(filters.work_modes) ? MODES.filter((m) => (filters.work_modes as unknown[]).includes(m)) : [];
    const fresh = wanted.length ? [...wanted] : [...MODES];
    if (extra.length) {
      try {
        updateRecord("profile", L.profile, (p) => { p.locations = mergePlaces(extra, p.locations ?? [], fresh); });
      } catch (e) {
        // A hand-broken profile is reported by `careeros validate`. Keep the search list (Find jobs still reads it).
        if (e instanceof RecordError) return;
        throw e;
      }
    }
    updateRecord("search", L.search, (s) => { delete (s.filters as Record<string, unknown>).locations; });
  },
};
