import { layout } from "../paths.js";
import { readRecord, RecordError, updateRecord } from "../store.js";
import type { Migration } from "./index.js";

const MODES = ["onsite", "hybrid", "remote"] as const;

/**
 * One place for work modes: each preferred place's own modes. Settings › Search had a second, global "Work modes"
 * (filters.work_modes). When it was set, it goes into every place that still takes any mode (all three ticked, or
 * none), and the global value is removed. A place with its own narrower modes keeps them. Find jobs still reads
 * an old global value if one turns up again.
 */
export const placeModesMigration: Migration = {
  id: 4,
  name: "work modes per place",
  files: (root) => [layout(root).profile, layout(root).search],
  run: (root) => {
    const L = layout(root);
    let search: Record<string, unknown>;
    try { search = readRecord("search", L.search) as unknown as Record<string, unknown>; } catch (e) { if (e instanceof RecordError) return; throw e; }
    const filters = (search.filters && typeof search.filters === "object" ? search.filters : {}) as Record<string, unknown>;
    if (!Object.hasOwn(filters, "work_modes")) return;
    const wanted = Array.isArray(filters.work_modes) ? MODES.filter((m) => (filters.work_modes as unknown[]).includes(m)) : [];
    if (wanted.length && wanted.length < MODES.length) {
      try {
        updateRecord("profile", L.profile, (p) => {
          p.locations = (p.locations ?? []).map((l) => {
            const any = !l.modes?.length || MODES.every((m) => l.modes.includes(m));
            return any ? { ...l, modes: [...wanted] } : l;
          });
        });
      } catch (e) {
        // A hand-broken profile is reported by `careeros validate`. Keep the global value (Find jobs still reads it).
        if (e instanceof RecordError) return;
        throw e;
      }
    }
    updateRecord("search", L.search, (s) => { delete (s.filters as Record<string, unknown>).work_modes; });
  },
};
