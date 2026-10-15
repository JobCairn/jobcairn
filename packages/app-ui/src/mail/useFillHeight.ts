import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * The height that takes an element from where it starts down to the bottom of the scrolling main area,
 * so a list-and-reader layout fills the window and the page itself doesn't scroll. Never below `min`
 * (a short window scrolls the page instead of squashing the reader).
 */
export function useFillHeight<T extends HTMLElement>(min = 360): [React.RefObject<T | null>, number | null] {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number | null>(null);
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const main = el.closest<HTMLElement>(".app__main");
    const box = main ?? document.documentElement;
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    // Room the element's own containers keep below it (a tab panel's padding, say), up to and including main's.
    let pad = 0;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      pad += (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      if (p === main) break;
    }
    const next = Math.max(min, Math.floor(box.clientHeight - top - pad));
    setHeight((h) => (h === next ? h : next));
  }, [min]);
  // Re-measured after every render: a warning or banner above the split moves its top.
  useLayoutEffect(measure);
  useEffect(() => {
    window.addEventListener("resize", measure);
    const main = ref.current?.closest<HTMLElement>(".app__main");
    const ro = typeof ResizeObserver === "undefined" || !main ? null : new ResizeObserver(measure);
    if (ro && main) ro.observe(main);
    return () => { window.removeEventListener("resize", measure); ro?.disconnect(); };
  }, [measure]);
  return [ref, height];
}
