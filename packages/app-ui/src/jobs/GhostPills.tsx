import type { GhostFlags } from "@careeros/contract";
import "./extras.css";

/**
 * Quiet hints that an ad may not be live: "Possibly stale" (posted over 30 days ago) and "Reposted" (the same ad
 * saved before). The tooltip says why; screen readers hear the reason with the label.
 */
export function GhostPills({ ghost }: { ghost?: GhostFlags }) {
  if (!ghost?.stale && !ghost?.repost) return null;
  return (
    <span className="ghost-pills">
      {ghost.stale ? <span className="pill pill--neutral ghost-pill" title={ghost.stale}>Possibly stale<span className="sr-only">: {ghost.stale}</span></span> : null}
      {ghost.repost ? <span className="pill pill--neutral ghost-pill" title={ghost.repost}>Reposted<span className="sr-only">: {ghost.repost}</span></span> : null}
    </span>
  );
}
