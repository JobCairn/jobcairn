import type { ReactNode } from "react";
import { Card, Text } from "@careeros/brand";
import { PageSettings, type PageSettingsId } from "./PageSettings";

export function Loading() {
  return <p className="t-body-sm t-muted" role="status">Loading…</p>;
}

export function ErrorState({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return (
    <Card className="state-error" role="alert">
      <Text role="heading-2">{title}</Text>
      <Text role="body" muted>{text}</Text>
      {action}
    </Card>
  );
}

/** The one empty state: a single plain sentence, plus at most one action that fixes it. */
export function EmptyState({ text, action, boxed = false }: { text: string; action?: ReactNode; boxed?: boolean }) {
  const body = <><Text role="body" muted>{text}</Text>{action ?? null}</>;
  return boxed ? <Card className="empty-line" data-empty="">{body}</Card> : <div className="empty-line" data-empty="">{body}</div>;
}

/** `settings`: the screen's gear, linking to the Settings sections that change what it shows (see PAGE_SETTINGS). */
export function ScreenHead({ title, sub, right, settings }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; settings?: PageSettingsId }) {
  return (
    <header className="screen-head">
      <div>
        <Text role="display" className={typeof title === "string" && title.length > 48 ? "screen-head__title--long" : undefined}>{title}</Text>
        {sub ? <Text role="body" muted className="screen-head__sub">{sub}</Text> : null}
      </div>
      {right || settings ? <div className="screen-head__actions">{right}{settings ? <PageSettings page={settings} /> : null}</div> : null}
    </header>
  );
}
