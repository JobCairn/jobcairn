import { useEffect, useId, useRef, useState } from "react";
import { Icon, Icons } from "@careeros/brand";
import { navigate, type Route } from "../router";

export interface SettingsLink { label: string; to: Route }

/**
 * Each screen's settings gear: the exact Settings sections that change what the screen shows. Data-driven, so a
 * screen gets a gear by adding a line here. One link opens straight away; more open a short menu.
 */
export const PAGE_SETTINGS = {
  home: { name: "Home settings", links: [{ label: "Weekly plan", to: { screen: "settings", tab: "search", section: "plan" } }] },
  // Filters live on the page itself (quick-filter chips; the Find jobs composer). The gear opens the one place
  // where the search's defaults are kept.
  jobs: { name: "Search settings", links: [{ label: "Search settings", to: { screen: "settings", tab: "search" } }] },
  searches: { name: "Search settings", links: [{ label: "Search settings", to: { screen: "settings", tab: "search" } }] },
  learn: {
    name: "Voice and video settings",
    links: [
      { label: "Reading voice", to: { screen: "settings", tab: "voice" } },
      { label: "Videos", to: { screen: "settings", tab: "video" } },
    ],
  },
  videos: { name: "Video settings", links: [{ label: "Video tools", to: { screen: "settings", tab: "video" } }] },
  applications: { name: "Email settings", links: [{ label: "Email & signature", to: { screen: "settings", tab: "connections", c: "email" } }] },
  companies: {
    name: "Sponsor settings",
    links: [
      { label: "Work rights", to: { screen: "settings", tab: "profile", section: "work-rights" } },
      { label: "Locations", to: { screen: "settings", tab: "profile", section: "locations" } },
    ],
  },
} as const satisfies Record<string, { name: string; links: readonly SettingsLink[] }>;
export type PageSettingsId = keyof typeof PAGE_SETTINGS;

export function PageSettings({ page }: { page: PageSettingsId }) {
  const def = PAGE_SETTINGS[page];
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      ref.current?.querySelector<HTMLButtonElement>(".page-settings__btn")?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const links: readonly SettingsLink[] = def.links;
  const single = links.length === 1 ? links[0]! : null;
  return (
    <div className="page-settings" ref={ref} data-tour="page-settings">
      <button type="button" className="page-settings__btn" aria-label={def.name} title={single ? `${def.name}: ${single.label}` : def.name}
        aria-expanded={single ? undefined : open} aria-controls={single ? undefined : menuId}
        onClick={() => (single ? navigate(single.to) : setOpen((o) => !o))}>
        <Icon icon={Icons.settings} />
      </button>
      {open && !single ? (
        <div className="page-settings__menu" id={menuId} role="group" aria-label={def.name}>
          <ul className="list-plain">
            {links.map((l) => (
              <li key={l.label}>
                <button type="button" className="page-settings__item" onClick={() => { setOpen(false); navigate(l.to); }}>
                  {l.label}<Icon icon={Icons.next} size="sm" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
