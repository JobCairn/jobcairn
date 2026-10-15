import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Badge } from "./Badge";
import { cx } from "../cx";

export interface TabDef { id: string; label: string; count?: number; /** Read out instead of the bare count ("2 running"). */ countLabel?: string }
export interface TabsProps {
  tabs: TabDef[]; value: string; onChange: (id: string) => void; label: string; children: ReactNode;
  /**
   * Keep the tab bar at the top of the scrolling screen so you can switch without scrolling back up (default on, for
   * screen-level tabs). It gets the screen's background and a hairline once it's stuck. Turn off for tabs inside a
   * dialog or a card.
   */
  sticky?: boolean;
}

/** Tabs per the ARIA pattern: arrow keys, Home and End move between tabs (and select them). */
export function Tabs({ tabs, value, onChange, label, children, sticky = true }: TabsProps) {
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const sentinel = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = sentinel.current;
    if (!sticky || !el || typeof IntersectionObserver === "undefined") return undefined;
    // The sentinel sits just above the bar: once it scrolls out of view, the bar is stuck.
    const io = new IntersectionObserver(([e]) => setStuck(!!e && !e.isIntersecting && e.boundingClientRect.top < (e.rootBounds?.top ?? 0) + 1), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [sticky]);
  const move = (i: number) => {
    const n = (i + tabs.length) % tabs.length;
    onChange(tabs[n]!.id);
    refs.current[n]?.focus();
  };
  const onKey = (e: KeyboardEvent, i: number) => {
    if (e.key === "ArrowRight") { e.preventDefault(); move(i + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); move(i - 1); }
    else if (e.key === "Home") { e.preventDefault(); move(0); }
    else if (e.key === "End") { e.preventDefault(); move(tabs.length - 1); }
  };
  return (
    <div className={cx("tabs", sticky && "tabs--sticky")}>
      {sticky ? <div ref={sentinel} className="tabs__sentinel" aria-hidden="true" /> : null}
      <div role="tablist" aria-label={label} className={cx("tabs__list", stuck && "is-stuck")} data-stuck={stuck || undefined}>
        {tabs.map((t, i) => (
          <button
            key={t.id} ref={(el) => { refs.current[i] = el; }} type="button" role="tab" id={`${base}-tab-${t.id}`}
            aria-selected={t.id === value} aria-controls={`${base}-panel`} tabIndex={t.id === value ? 0 : -1}
            className="tabs__tab" onClick={() => onChange(t.id)} onKeyDown={(e) => onKey(e, i)}
          >
            {t.label}{t.count ? (t.countLabel ? <><span aria-hidden="true"><Badge>{t.count}</Badge></span><span className="sr-only">({t.countLabel})</span></> : <Badge>{t.count}</Badge>) : null}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${value}`} className="tabs__panel" tabIndex={0}>{children}</div>
    </div>
  );
}
