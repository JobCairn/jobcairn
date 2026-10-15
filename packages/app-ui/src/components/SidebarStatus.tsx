import type { Route } from "../router";
import { navigate } from "../router";

/**
 * The sidebar footer's status lines other than Claude's. Each one links to its exact place in Settings. Data-driven,
 * so another branch can repoint a line (for example Mail to its own screen) by changing one entry.
 */
export const SIDEBAR_STATUS: Record<string, { text: string; on: boolean; to: Route; label: string }> = {
  mail: { text: "Mail · coming soon", on: false, to: { screen: "settings", tab: "connections", c: "email" }, label: "Email settings" },
};

export function SidebarStatusLink({ id }: { id: keyof typeof SIDEBAR_STATUS }) {
  const s = SIDEBAR_STATUS[id]!;
  return (
    <button type="button" className="cind" aria-label={`${s.text}. ${s.label}`} title={s.label} onClick={() => navigate(s.to)}>
      <span className={`status-dot${s.on ? "" : " status-dot--off"}`} aria-hidden="true" />{s.text}
    </button>
  );
}
