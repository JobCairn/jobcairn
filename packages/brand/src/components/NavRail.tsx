import { useEffect, useId, useRef, type ReactNode } from "react";
import type { IconGlyph } from "../icons";
import { identity } from "../../identity";
import { cx } from "../cx";
import { Kbd } from "./Kbd";
import { Mark } from "./Mark";
import { Icon } from "./Icon";
import { Icons } from "../icons";
import { NavItem } from "./NavItem";

export interface NavRailItem {
  id: string; label: string; icon: IconGlyph; count?: number; trailing?: ReactNode; section?: "main" | "secondary";
  /** A small label over a run of related items ("Find", "Apply"). Items with the same group sit together, in order. */
  group?: string;
}
export interface NavRailProps {
  items: NavRailItem[]; current: string; onNavigate: (id: string) => void; onOpenCommand: () => void; shortcut?: string; footer?: ReactNode;
  /** Shown just below the brand (the app puts the workspace switcher here). */
  header?: ReactNode;
  /** Icons only: names, counts and the footer's words move into tooltips. */
  collapsed?: boolean;
  /** Shows the toggle at the top of the rail when given. */
  onToggleCollapsed?: () => void;
  /** The toggle's shortcut, shown in its tooltip ("⌘\"). */
  toggleShortcut?: string;
  /** Groups folded to their header. A folded group still shows the item for the current page. */
  closedGroups?: readonly string[];
  /** Makes group headers buttons that fold and unfold their group. */
  onToggleGroup?: (group: string) => void;
}

/** What a folded group still shows: only the current page's item, so you never lose your place. */
export function shownInGroup(items: readonly NavRailItem[], current: string, closed: boolean): NavRailItem[] {
  return closed ? items.filter((i) => i.id === current) : [...items];
}

/** True when a folded group hides an item with a count, so its header can show a dot. */
export function hiddenHasCount(items: readonly NavRailItem[], current: string): boolean {
  return items.some((i) => i.id !== current && (i.count ?? 0) > 0);
}

/** The collapsed rail's tooltip for an item: its name, then its count or state ("Jobs · 49", "Privacy · Locked"). */
export function navTip(i: Pick<NavRailItem, "label" | "count" | "trailing">): string {
  const extra = i.count !== undefined && i.count > 0 ? String(i.count) : typeof i.trailing === "string" ? i.trailing : "";
  return extra ? `${i.label} · ${extra}` : i.label;
}

export function NavRail({
  items, current, onNavigate, onOpenCommand, shortcut = "Ctrl K", footer, header, collapsed = false, onToggleCollapsed, toggleShortcut,
  closedGroups = [], onToggleGroup,
}: NavRailProps) {
  const uid = useId();
  // The toggle is a different button in each state, so a click hands focus to the new one (keyboard users keep their place).
  const refocus = useRef(false);
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    navRef.current?.querySelector<HTMLElement>(".rail__toggle")?.focus();
  }, [collapsed]);
  const toggle = () => { refocus.current = true; onToggleCollapsed?.(); };
  const item = (i: NavRailItem) => (
    <li key={i.id}>
      <NavItem icon={i.icon} label={i.label} count={i.count} trailing={i.trailing} tip={navTip(i)} current={i.id === current} onClick={() => onNavigate(i.id)} />
    </li>
  );
  // Runs of items that share a group become one labelled list; ungrouped items keep a plain list.
  const list = (section: "main" | "secondary") => {
    const runs: { group?: string; items: NavRailItem[] }[] = [];
    for (const i of items.filter((x) => (x.section ?? "main") === section)) {
      const last = runs.at(-1);
      if (last && last.group === i.group) last.items.push(i); else runs.push({ group: i.group, items: [i] });
    }
    return runs.map((r, n) => {
      if (!r.group) return <ul key={`plain-${n}`} className="rail__list">{r.items.map(item)}</ul>;
      const group = r.group;
      // In the icon rail a header is only a thin rule, so every icon shows and nothing is folded.
      const foldable = !!onToggleGroup && !collapsed;
      const closed = foldable && closedGroups.includes(group);
      const shown = shownInGroup(r.items, current, closed);
      const dot = closed && hiddenHasCount(r.items, current);
      const listId = `${uid}-${group}`;
      return (
        <div key={`${group}-${n}`} className={cx("rail__group", closed && "is-closed")}>
          {foldable ? (
            <button type="button" className="rail__label rail__label--toggle" aria-expanded={!closed} aria-controls={listId} onClick={() => onToggleGroup(group)}>
              <span className="rail__label-text">{group}</span>
              {dot ? <><span className="rail__label-dot" aria-hidden="true" /><span className="sr-only">(has new items)</span></> : null}
              <Icon icon={closed ? Icons.folded : Icons.expand} size="sm" className="rail__label-chevron" />
            </button>
          ) : <div className="rail__label" aria-hidden="true">{group}</div>}
          <div role="group" aria-label={group} id={listId}>
            {shown.length ? <ul className="rail__list">{shown.map(item)}</ul> : null}
          </div>
        </div>
      );
    });
  };
  const keys = toggleShortcut ? ` (${toggleShortcut})` : "";
  return (
    <nav ref={navRef} className={cx("rail", collapsed && "is-collapsed")} aria-label="Main">
      <div className="rail__brand">
        {collapsed && onToggleCollapsed ? (
          // Collapsed: the mark is the way back. Hover or keyboard focus swaps it for the "open" icon.
          <button type="button" className="rail__toggle rail__toggle--mark" aria-label="Expand sidebar" aria-expanded={false}
            data-tip={`Expand sidebar${keys}`} data-tour="sidebar-toggle" onClick={toggle}>
            <span className="rail__mark"><Mark size={28} /></span>
            <span className="rail__toggle-icon"><Icon icon={Icons.sidebarExpand} /></span>
          </button>
        ) : <span className="rail__mark"><Mark size={28} /></span>}
        <span className="rail__wordmark">{identity.name}</span>
        {!collapsed && onToggleCollapsed ? (
          <button type="button" className="rail__toggle" aria-label="Collapse sidebar" aria-expanded={true}
            data-tip={`Collapse sidebar${keys}`} data-hint={`Collapse sidebar${keys}`} data-tour="sidebar-toggle" onClick={toggle}>
            <Icon icon={Icons.sidebarCollapse} size="sm" />
          </button>
        ) : null}
      </div>
      {header ? <div className="rail__header">{header}</div> : null}
      <button type="button" className="cmd-trigger" onClick={onOpenCommand} aria-label="Search" title={collapsed ? undefined : `Search (${shortcut})`} data-tip={`Search (${shortcut})`}>
        <Icon icon={Icons.searches} size="sm" /><span className="cmd-trigger__text">Search…</span><Kbd>{shortcut}</Kbd>
      </button>
      {list("main")}
      <div className="rail__sep" role="separator" />
      {list("secondary")}
      {footer ? <div className="rail__footer">{footer}</div> : null}
    </nav>
  );
}
