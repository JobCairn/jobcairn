import type { Route } from "../router";

export interface SettingsCommand { id: string; label: string; keywords: string; to: Route }

/** Settings the command bar (Cmd/Ctrl+K) can find by everyday words, each linking to its exact place. */
export const SETTINGS_COMMANDS: SettingsCommand[] = [
  { id: "set-claude", label: "Claude settings", keywords: "claude code ai sign in set up test run", to: { screen: "settings", tab: "connections", c: "claude" } },
  { id: "set-api-key", label: "Anthropic API key", keywords: "api key anthropic secret token", to: { screen: "settings", tab: "connections", c: "claude", section: "anthropic-api-key" } },
  { id: "set-email", label: "Email (Gmail)", keywords: "gmail email mail app password inbox", to: { screen: "settings", tab: "connections", c: "email" } },
  { id: "set-chrome", label: "Search in my Chrome", keywords: "chrome browser job boards linkedin seek", to: { screen: "settings", tab: "connections", c: "chrome" } },
  { id: "set-profile", label: "Your profile", keywords: "profile name email phone city contact links", to: { screen: "settings", tab: "profile" } },
  { id: "set-rights", label: "Work rights", keywords: "work rights visa sponsorship citizen residency expiry", to: { screen: "settings", tab: "profile", section: "work-rights" } },
  { id: "set-roles", label: "Roles you want", keywords: "target roles related titles job types search", to: { screen: "settings", tab: "search", section: "search-roles" } },
  { id: "set-salary", label: "Salary", keywords: "salary pay minimum currency super", to: { screen: "settings", tab: "search", section: "pay" } },
  { id: "set-search", label: "Search plan", keywords: "search deadline weekly goal applications per week", to: { screen: "settings", tab: "search" } },
  { id: "set-voice", label: "Voice and reading aloud", keywords: "voice read aloud listen speech speed", to: { screen: "settings", tab: "voice" } },
  { id: "set-theme", label: "Theme and appearance", keywords: "theme appearance dark light graphite paper tour guide", to: { screen: "settings", tab: "appearance" } },
];

export function matchCommand(c: SettingsCommand, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${c.label} ${c.keywords}`.toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}
