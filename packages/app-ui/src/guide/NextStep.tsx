import type { ReactNode } from "react";
import { Card, cx, Icon, Text, type IconGlyph } from "@careeros/brand";
import "./guide.css";


export interface NextStepProps {
  title: string;
  body: ReactNode;
  /** The one thing to do next: a Button, an ActionButton or a link. */
  action?: ReactNode;
  /** A quieter second option. */
  secondary?: ReactNode;
  icon?: IconGlyph;
  className?: string;
}

/**
 * The empty state every screen can use: what this place is for, and the next step as a real button.
 * Never a dead end: give it an `action` whenever there is something to do.
 */
export function NextStep({ title, body, action, secondary, icon, className }: NextStepProps) {
  return (
    <Card className={cx("next-step", className)}>
      {icon ? <span className="next-step__icon"><Icon icon={icon} /></span> : null}
      <div className="next-step__text">
        <Text role="heading-2">{title}</Text>
        <Text role="body" muted>{body}</Text>
      </div>
      {action || secondary ? <div className="next-step__actions">{action}{secondary}</div> : null}
    </Card>
  );
}
