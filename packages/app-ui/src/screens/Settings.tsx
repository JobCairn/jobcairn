import { useEffect, useState } from "react";
import { Button, Card, Icons, SectionTitle, Tabs, Text } from "@careeros/brand";
import { FieldForm } from "../components/FieldForm";
import { SearchSettings, SEARCH_PROFILE_PATHS } from "../settings/SearchSettings";
import { VideoSettingsPanel } from "../components/VideoList";
import { GuideSetting } from "../guide";
import { TourSettings } from "../tour";
import { ScreenHead } from "../components/States";
import { Connections } from "../settings/Connections";
import { SETTINGS_TABS, useRoute, type SettingsTab } from "../router";
import { useThemePref, type ThemePref } from "../theme";
import { VoiceSettings } from "../listen";
import { ResumeFillPanel } from "../resumefill";
import { VideoDefaults } from "../settings/VideoDefaults";
import { notificationsOn, setNotificationsOn } from "../claude/Activity";
import { AutosaveProvider, AutosaveStatus } from "../settings/autosave";
import { RecentlyDeleted } from "../trash";

export { SEARCH_ADDONS } from "../settings/SearchSettings";

const THEMES: [ThemePref, string][] = [["graphite", "Graphite (dark)"], ["paper", "Paper (light)"], ["system", "Follow the system"]];
const TAB_LABELS: Record<SettingsTab, string> = { profile: "Profile", search: "Search", connections: "Connections", voice: "Voice", video: "Video", appearance: "Appearance", workspace: "Workspace" };
const TABS = SETTINGS_TABS.map((id) => ({ id, label: TAB_LABELS[id] }));

/** Scrolls to a section a link asked for (settings?tab=profile&section=work-rights) and flashes it briefly. */
function useSectionAnchor(tab: string, section: string | undefined, ready: unknown) {
  useEffect(() => {
    if (!section || tab === "connections") return undefined;
    const el = document.getElementById(`settings-${section}`);
    if (!el) return undefined;
    el.scrollIntoView?.({ block: "start", behavior: "smooth" });
    el.classList.add("is-flash");
    const t = setTimeout(() => el.classList.remove("is-flash"), 1700);
    return () => clearTimeout(t);
  }, [tab, section, ready]);
}

/** Settings › Appearance: OS notifications when a long task finishes while you're in another app. */
function NotificationSetting() {
  const [on, setOn] = useState(notificationsOn);
  return (
    <Card className="stack" aria-labelledby="settings-notify-title">
      <SectionTitle icon={Icons.activity} title="Notifications" id="settings-notify-title" />
      <label className="checkbox">
        <input type="checkbox" checked={on} onChange={(e) => { setNotificationsOn(e.target.checked); setOn(e.target.checked); }} />
        Tell me when a task that took over 30 seconds finishes while I&apos;m in another app
      </label>
      <Text role="body-sm" muted>Your computer shows the message. Finished tasks are always listed in the Activity panel.</Text>
    </Card>
  );
}

export function SettingsScreen() {
  const route = useRoute();
  const r = route.screen === "settings" ? route : null;
  const routeTab = r?.tab;
  const [tab, setTab] = useState<string>(routeTab ?? "profile");
  // A link such as Home's "Set a search deadline" opens a given section.
  useEffect(() => { if (routeTab) setTab(routeTab); }, [routeTab]);
  const [mounted, setMounted] = useState(0);
  useEffect(() => { const t = setTimeout(() => setMounted((n) => n + 1), 300); return () => clearTimeout(t); }, [tab, r?.section]);
  useSectionAnchor(tab, r?.section, mounted);
  // The Video section loads the tool check and the custom video types, so it mounts the first time it's opened
  // (then stays mounted like the others, so a half-edited caption style survives switching tabs).
  const [videoSeen, setVideoSeen] = useState(tab === "video");
  useEffect(() => { if (tab === "video") setVideoSeen(true); }, [tab]);
  const [theme, setTheme] = useThemePref();
  return (
    <AutosaveProvider>
      <ScreenHead title="Settings" sub="Your profile, what to search for, connected services, the reading voice, videos, how the app looks and recently deleted items." />
      {/*
        Every section stays mounted; only the active one is shown. Form fields save themselves, but
        a half-typed secret or a field that doesn't pass its check yet lives in that section's own
        component state, so switching tabs must not unmount it - that would silently throw it away. Hiding with the
        `hidden` attribute keeps the section out of the accessibility tree and off-screen
        without tearing down its state.
      */}
      {/* One calm line for every form on this page, pinned on the right of the tab bar. */}
      <AutosaveStatus />
      <Tabs label="Settings sections" value={tab} onChange={setTab} tabs={TABS}>
        <div hidden={tab !== "profile"} data-tour="settings-profile">
          <ResumeFillPanel visible={tab === "profile"} />
          {/* Roles, places, pay and companies to skip are search filters: they live under Search, not twice. */}
          <FieldForm kind="profile" exclude={SEARCH_PROFILE_PATHS} />
          <div className="settings-profile__more">
            <Text role="body-sm" muted as="span">Roles, places, pay and companies to skip are in Search.</Text>
            <Button size="sm" variant="ghost" onClick={() => setTab("search")}>Open Search</Button>
          </div>
        </div>
        <div hidden={tab !== "search"}><SearchSettings /></div>
        {/* Claude, Email and Search in my Chrome, each a row; secrets live inside their own service. settings?tab=claude still lands on Claude. */}
        <div hidden={tab !== "connections"} data-tour="settings-connections"><Connections asked={r?.c} section={r?.section} /></div>
        <div hidden={tab !== "voice"} data-tour="settings-voice"><VoiceSettings /></div>
        <div hidden={tab !== "video"}>
          {videoSeen ? (
            <div className="stack">
              {/* Caption style and default lengths live in settings/integrations.json; they save as you change them. */}
              <Card className="stack">
                <SectionTitle icon={Icons.video} title="Video" />
                <VideoDefaults />
                {/* No off switch: the narration voice's licence requires the disclosure on every video. */}
                <Text role="body-sm" muted as="p">Videos show an "AI voice" mark, as the voice model's licence requires.</Text>
              </Card>
              <VideoSettingsPanel />
            </div>
          ) : null}
        </div>
        <div hidden={tab !== "appearance"}>
          <div className="settings-appearance" data-tour="settings-appearance">
            <Card className="stack" aria-labelledby="settings-theme-title">
              <SectionTitle icon={Icons.palette} title="Theme" id="settings-theme-title" />
              <fieldset className="settings-theme" aria-labelledby="settings-theme-title">
                <div className="settings-theme__choices">
                  {THEMES.map(([value, label]) => (
                    <label key={value} className="checkbox">
                      <input type="radio" name="theme" value={value} checked={theme === value} onChange={() => setTheme(value)} /> {label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <GuideSetting />
            </Card>
            <Card className="stack"><TourSettings /></Card>
            <NotificationSetting />
          </div>
        </div>
        <div hidden={tab !== "workspace"}>
          <div className="settings-workspace" data-tour="settings-workspace">
            <Card className="stack settings-workspaces" aria-labelledby="settings-workspaces-title">
              <SectionTitle icon={Icons.folder} title="Workspaces" id="settings-workspaces-title" />
              <Text role="body" as="p">Each person can have their own workspace. For full privacy, use separate computer accounts.</Text>
              <Text role="body-sm" muted as="p">Switch workspaces from the top of the sidebar. API keys and passwords are kept separately for each workspace.</Text>
            </Card>
            {tab === "workspace" ? <RecentlyDeleted /> : null}
          </div>
        </div>
      </Tabs>
    </AutosaveProvider>
  );
}
