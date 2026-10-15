import type { MouseEvent, ReactNode } from "react";
import { Icon, Icons, useToast } from "@careeros/brand";
import { errorText, useBridge } from "../bridge-context";

/** "https://www.linkedin.com/jobs/view/1/" → "linkedin.com". */
export function hostLabel(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/**
 * A link that opens in the system browser through the bridge (links.open: https only, behind the
 * shell's confirm). The app window itself never navigates. Without children it shows the host.
 */
export function ExternalLink({ href, children, className }: { href: string; children?: ReactNode; className?: string }) {
  const bridge = useBridge();
  const toast = useToast();
  const open = () => void bridge.links.open(href).catch((e: unknown) => toast({ tone: "danger", text: `Couldn't open the link: ${errorText(e)}` }));
  const onClick = (e: MouseEvent) => { e.preventDefault(); open(); };
  return (
    <a href={href} className={className ? `ext-link ${className}` : "ext-link"} title={href} draggable={false} onClick={onClick}
      onAuxClick={(e) => { e.preventDefault(); if (e.button === 1) open(); }}>
      {children ?? hostLabel(href)}
      <Icon icon={Icons.openExternal} size="sm" className="ext-link__icon" />
    </a>
  );
}
