import { Icon, Icons } from "@careeros/brand";
import { parseHash, type Route } from "../router";
import { originFor, useTrail } from "./trail";
import "./nav.css";

/** Long names are cut here, with the whole name in the tooltip (breadcrumb items truncate at about 30 characters). */
const MAX = 32;
const short = (s: string) => (s.length > MAX ? `${s.slice(0, MAX - 1).trimEnd()}…` : s);

/**
 * "← Jobs" above a detail screen's title: back to where the person came from (the Videos list, the job they opened
 * this from), else the screen's natural parent. It's a real link, so it shows its target and opens with Enter.
 * Cmd or Ctrl + [ and Alt + Left do the same (NavMemory).
 */
export function BackLink({ route }: { route: Route }) {
  const entries = useTrail();
  const o = originFor(route, entries);
  if (!o) return null;
  const label = short(o.label);
  const go = parseHash(o.hash);
  return (
    <nav className="backlink" aria-label="Back">
      <a href={o.hash} className="backlink__a" title={o.label !== label ? `Back to ${o.label}` : undefined}
        aria-label={`Back to ${o.label}`} aria-keyshortcuts="Meta+BracketLeft Control+BracketLeft Alt+ArrowLeft" data-to={go.screen}>
        <Icon icon={Icons.back} size="sm" />
        <span>{label}</span>
      </a>
    </nav>
  );
}
