import { BOARD_NAMES, DEFAULT_BOARDS, type BoardId, type ChromeSearchState, type ClaudeRunView } from "@careeros/contract";

type Row = ChromeSearchState["boards"][number];

/**
 * `?chrome` previews Search in my Chrome at step 5 (fictional, no browser): helper installed, remote control on,
 * connected. Check my boards gives the owner's 2026-10-11 report (signed in to SEEK by their word, the other tabs
 * read from another Chrome profile), so the reasons, the contradiction and the profile hint all show.
 * `on`: set up and turned on, as after a finished setup (`?chrome=on`), so Find jobs says it searches in your Chrome.
 */
export function chromeMock(runs?: () => Promise<ClaudeRunView[]>, opts: { on?: boolean } = {}) {
  const boards: BoardId[] = [...DEFAULT_BOARDS];
  const rows = new Map<BoardId, Pick<Row, "signed_in" | "why" | "diag">>();
  const confirmed = new Map<BoardId, string>([["seek", "2026-10-10T09:00:00.000Z"]]);
  // Fictional Chrome profiles. None is chosen yet, so the select shows the last used one.
  const profiles = [{ dir: "Profile 2", name: "Job search" }, { dir: "Default", name: "Personal" }];
  let profileDir = "";
  const SEES: Record<string, Pick<Row, "signed_in" | "why">> = {
    linkedin: { signed_in: "signed_out", why: { page: "login", matched: "" } },
    seek: { signed_in: "signed_out", why: { page: "board", matched: "sign_in" } },
    indeed: { signed_in: "signed_out", why: { page: "board", matched: "sign_in" } },
    glassdoor: { signed_in: "unknown", why: { page: "board", matched: "none" } },
    jora: { signed_in: "not_loaded", why: { page: "board", matched: "no_controls" } },
  };
  const state = (): ChromeSearchState => ({
    available: true, chrome: { found: true }, problem: "",
    helper: { found: true, version: "0.38.2", min_version: "0.38.0", too_old: false, installing: false, can_install: true, size_mb: 118, can_remove: true },
    remote: { on: true }, connected: true,
    profiles, last_used_profile: "Default", profile_failed: false,
    boards: boards.map((id) => ({ id, name: BOARD_NAMES[id], signed_in: rows.get(id)?.signed_in ?? "unchecked", confirmed_at: confirmed.get(id) ?? "", why: rows.get(id)?.why ?? { page: "", matched: "" }, ...(rows.get(id)?.diag ? { diag: rows.get(id)!.diag! } : {}) })),
    settings: { enabled: !!opts.on, boards: [...boards], set_up_at: opts.on ? "2026-01-10T09:00:00.000Z" : "", confirmed: Object.fromEntries(confirmed), ...(profileDir ? { profile_dir: profileDir } : {}) },
    ready: !!opts.on,
  });
  const ok = <T,>(fn: () => T) => new Promise<T>((r) => setTimeout(() => r(fn()), 300));
  // Claude's sign-in check (a chrome_check run in the Claude mock): once it succeeds, its answers show here.
  let seenCheck = "";
  const syncCheck = async () => {
    const done = (await runs?.() ?? []).find((r) => r.action === "chrome_check" && r.status === "succeeded");
    if (!done || done.id === seenCheck) return;
    seenCheck = done.id;
    // How each tab opened, for Details: in the chosen profile (the first one brought its window forward once), or
    // the window used last when none is chosen.
    boards.forEach((id, i) => rows.set(id, {
      ...(SEES[id] ?? { signed_in: "unknown", why: { page: "board", matched: "none" } }),
      diag: profileDir
        ? { mode: "profile", profile_dir: profileDir, outcome: "ok", launched: i === 0, tries: i === 0 ? 2 : 1, ms: i === 0 ? 2300 : 640 }
        : { mode: "last_window", profile_dir: "", outcome: "ok", launched: false, tries: 1, ms: 520 },
    }));
  };
  return {
    state: async () => { await syncCheck(); return ok(state); }, install: () => ok(state), openRemote: () => ok(state), connect: () => ok(state),
    showBoard: () => ok(state), openHome: () => ok(() => undefined),
    setProfile: (dir: string) => ok(() => { profileDir = dir; return state(); }),
    confirmSignIn: (id: BoardId) => ok(() => { confirmed.set(id, "2026-10-11T09:00:00.000Z"); rows.delete(id); return state(); }),
    removeHelper: () => ok(state), finish: () => ok(state), setBoards: () => ok(state), turnOff: () => ok(state),
    runBoards: () => ok(() => undefined), progress: () => ok(() => null), answer: () => ok(() => null),
  };
}
