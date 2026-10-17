import { useCallback, useMemo, useState, type ReactNode } from "react";
import { CommandBar, NavRail, useCommandShortcut, type CommandItem, type NavRailItem, Icons } from "@careeros/brand";
import { privacyNavLabel, type MailStatus } from "@careeros/contract";
import { useLoad } from "./bridge-context";
import { navigate, type Route } from "./router";
import { useThemePref } from "./theme";
import { ClaudeActivityProvider, ClaudeWorkingIndicator, StatusIcon, type StatusTone } from "./claude"; // sidebar Claude line + the global Activity panel
import { AppVersion } from "./components/AppVersion";
import { SETTINGS_COMMANDS, matchCommand } from "./settings/commands";
import { VideoIntentListener } from "./components/MakeVideo";
import { TourHelpButton, TourLayer } from "./tour"; // guided tours: overlay + "Show me around"
import { WorkspaceSwitcher } from "./workspaces/WorkspaceSwitcher";
import { useSidebarPrefs } from "./nav/sidebar-prefs";
import { useNewJobsCount } from "./nav/new-jobs";

const SCREEN_LABELS: [Route, string][] = [
  [{ screen: "home" }, "Home"], [{ screen: "jobs" }, "Jobs"], [{ screen: "searches" }, "Searches"], [{ screen: "companies" }, "Companies"], [{ screen: "recruiters" }, "Recruiters"],
  [{ screen: "applications" }, "Applications"], [{ screen: "resumes" }, "Resumes"], [{ screen: "approvals" }, "Approvals"], [{ screen: "inbox" }, "Drop box"], [{ screen: "mail" }, "Mail"],
  [{ screen: "learn" }, "Learn"], [{ screen: "research" }, "Research"], [{ screen: "videos" }, "Videos"], [{ screen: "privacy" }, "Privacy"], [{ screen: "settings" }, "Settings"],
];

/**
 * When mail last synced, in full but short: "today 3:42 pm", "yesterday 9:05 am", "8 Oct, 3:42 pm", and the year
 * only when it isn't this year. Local time.
 */
// TODO(lane-B): move to format.ts
export function syncedAt(iso: string, now = new Date()): string {
  const t = new Date(iso);
  if (!iso || Number.isNaN(t.getTime())) return "never";
  const time = t.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", hour12: true }).replace(/\s*([ap])\.?m\.?$/i, " $1m").toLowerCase();
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(t)) / 86_400_000);
  if (diff === 0) return `today ${time}`;
  if (diff === 1) return `yesterday ${time}`;
  const date = t.toLocaleDateString("en-AU", { day: "numeric", month: "short", ...(t.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
  return `${date}, ${time}`;
}

/** Mail's state word and dot: synced (green), syncing (amber), needs attention (red), or off (grey). */
export function mailState(status?: MailStatus): { state: string; tone: StatusTone } {
  if (!status || !status.available) return { state: "not available", tone: "off" };
  if (!status.connected) return { state: "not connected", tone: "off" };
  if (status.last_error) return { state: "needs attention", tone: "alert" };
  if (status.syncing) return { state: "syncing…", tone: "busy" };
  return { state: `synced ${syncedAt(status.last_sync)}`, tone: "ok" };
}

/** The footer's Mail icon: its dot says how mail is doing, the tooltip says it in words; it opens mail settings. */
function MailStatus({ status }: { status?: MailStatus }) {
  const { state, tone } = mailState(status);
  return (
    <StatusIcon icon={Icons.mail} tone={tone} status={`Mail · ${state}`} action="Open mail settings"
      onClick={() => navigate({ screen: "settings", tab: "connections", c: "email" })} />
  );
}

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const counts = useLoad(async (b) => {
    const [home, privacy, mail] = await Promise.all([b.home.summary(), b.privacy.get(), b.mail.status()]);
    return { home, privacy, mail };
  }, [], ["home", "jobs", "inbox", "approvals", "privacy", "settings", "mail"]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const openCommand = useCallback(() => { setQuery(""); setOpen(true); }, []);
  useCommandShortcut(openCommand);
  const [, setTheme] = useThemePref();
  // Companies are matched by name in the command bar. List-only employers (sponsor research) stay out of it.
  const companyList = useLoad((b) => (open ? b.companies.list() : Promise.resolve(null)), [open], ["jobs", "sponsors"]);
  const hits = useLoad((b) => (query.trim().length >= 2 ? b.jobs.list({ text: query.trim(), limit: 6, showIneligible: true }) : Promise.resolve(null)), [query], []);

  const h = counts.data?.home;
  // Jobs' badge: found since you last looked (the same count as the Jobs list's "N new" chip), not the total.
  const newJobs = useNewJobsCount(route.screen);
  // A folder with an open grant isn't locked right now, and a moved folder needs a look, so the rail says so.
  const privacy = counts.data?.privacy;
  const privacyLabel = privacy ? privacyNavLabel(privacy, new Date()) : undefined;
  const current = route.screen === "job" ? "jobs" : route.screen === "company" ? "companies" : route.screen === "recruiter" ? "recruiters" : route.screen === "apply" || route.screen === "applications" ? "apply" : route.screen === "video" ? "videos"
    : route.screen === "resume" || route.screen === "resume-variant" ? "resumes" : route.screen;
  // Grouped by what you're doing (owner, 2026-10-10): find jobs, apply, prepare. Labels, not sub-menus: there are
  // few items, and folding them away would cost clicks.
  const items: NavRailItem[] = [
    { id: "home", label: "Home", icon: Icons.home },
    { id: "jobs", label: "Jobs", icon: Icons.jobs, count: newJobs, group: "Find" },
    { id: "searches", label: "Searches", icon: Icons.searches, group: "Find" },
    { id: "companies", label: "Companies", icon: Icons.company, group: "Find" },
    { id: "recruiters", label: "Recruiters", icon: Icons.recruiters, group: "Find" },
    { id: "apply", label: "Applications", icon: Icons.apply, count: h?.counts.Applying, group: "Apply" },
    { id: "resumes", label: "Resumes", icon: Icons.file, group: "Apply" },
    { id: "approvals", label: "Approvals", icon: Icons.approvals, count: h?.pendingApprovals, group: "Apply" },
    { id: "inbox", label: "Drop box", icon: Icons.dropBox, count: h?.inboxCount, group: "Apply" },
    { id: "mail", label: "Mail", icon: Icons.mail, count: h?.unreadMail, group: "Apply" },
    { id: "learn", label: "Learn", icon: Icons.learn, group: "Prepare" },
    { id: "research", label: "Research", icon: Icons.research, group: "Prepare" },
    { id: "videos", label: "Videos", icon: Icons.video, group: "Prepare" },
    { id: "privacy", label: "Privacy", icon: Icons.privacy, trailing: privacyLabel, section: "secondary" },
    { id: "settings", label: "Settings", icon: Icons.settings, section: "secondary" },
  ];
  const onNavigate = (id: string) => navigate(id === "apply" ? { screen: "applications" } : ({ screen: id } as Route));

  const commands = useMemo<CommandItem[]>(() => {
    const q = query.trim().toLowerCase();
    const screens: CommandItem[] = SCREEN_LABELS.map(([r, label]) => ({ id: `go-${label}`, label: `Go to ${label}`, group: "Page", run: () => navigate(r) }));
    const actions: CommandItem[] = [
      { id: "theme-graphite", label: "Use the Graphite (dark) theme", group: "Theme", run: () => setTheme("graphite") },
      { id: "theme-paper", label: "Use the Paper (light) theme", group: "Theme", run: () => setTheme("paper") },
      { id: "theme-system", label: "Follow the system theme", group: "Theme", run: () => setTheme("system") },
    ];
    const jobs: CommandItem[] = (hits.data?.rows ?? []).map((r) => ({
      id: `job-${r.company_slug}-${r.id}`, label: `${r.title} · ${r.company_name}`, group: "Job", run: () => navigate({ screen: "job", slug: r.company_slug, id: r.id }),
    }));
    const companies: CommandItem[] = q.length >= 2 ? (companyList.data ?? []).filter((c) => c.slug && [c.name, ...c.aliases].some((n) => n.toLowerCase().includes(q)))
      .slice(0, 5).map((c) => ({ id: `company-${c.key}`, label: c.name, group: "Company", run: () => navigate({ screen: "company", slug: c.key }) })) : [];
    // Settings are found by everyday words ("api key", "gmail", "theme") and open their exact place.
    const settings: CommandItem[] = q ? SETTINGS_COMMANDS.filter((c) => matchCommand(c, q)).map((c) => ({ id: c.id, label: c.label, group: "Settings", run: () => navigate(c.to) })) : [];
    return [...jobs, ...companies, ...[...screens, ...actions].filter((c) => !q || c.label.toLowerCase().includes(q)), ...settings];
  }, [query, hits.data, companyList.data, setTheme]);

  const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
  const sidebar = useSidebarPrefs(isMac);
  return (
    <ClaudeActivityProvider>
    <div className="app">
      <NavRail
        items={items} current={current} onNavigate={onNavigate} onOpenCommand={openCommand} shortcut={isMac ? "⌘K" : "Ctrl K"}
        header={<WorkspaceSwitcher />}
        collapsed={sidebar.collapsed} onToggleCollapsed={sidebar.toggleCollapsed} toggleShortcut={isMac ? "⌘\\" : "Ctrl \\"}
        closedGroups={sidebar.closedGroups} onToggleGroup={sidebar.toggleGroup}
        footer={
          // One compact row: status icons on the left, then the version and help on the right.
          <div className="rail-foot">
            <div className="rail-status" role="group" aria-label="Connections" data-tour="rail-status">
              <ClaudeWorkingIndicator />
              <MailStatus status={counts.data?.mail} />
            </div>
            <div className="rail-foot__end"><AppVersion /><TourHelpButton route={route} /></div>
          </div>
        }
      />
      <main className="app__main" id="main">{children}</main>
      <TourLayer route={route} />
      {/* Claude asking for a video opens Make video here, on whatever page the candidate is on (Task 23). */}
      <VideoIntentListener />
      <CommandBar open={open} onClose={() => setOpen(false)} items={commands} query={query} onQueryChange={setQuery} />
    </div>
    </ClaudeActivityProvider>
  );
}
