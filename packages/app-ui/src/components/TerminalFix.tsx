import { useState } from "react";
import { Button, Text } from "@careeros/brand";
import type { TerminalFix, TerminalOption } from "@careeros/contract";
import "./tool-install.css";

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

function Option({ o }: { o: TerminalOption }) {
  const [copied, setCopied] = useState<"" | "yes" | "no">("");
  const copy = async () => setCopied((await copyText(o.command)) ? "yes" : "no");
  return (
    <div className="tinstall__option">
      <Text role="body-sm" as="span" className="csetup__title">{o.title}</Text>
      <code className="csetup__code tinstall__cmd tinstall__lines">{o.command}</code>
      <div className="csetup__row">
        <Button size="sm" variant="secondary" aria-label={`Copy: ${o.title}`} onClick={() => void copy()}>{copied === "yes" ? "Copied" : "Copy"}</Button>
      </div>
      {o.note ? <Text role="body-sm" muted>{o.note}</Text> : null}
      <Text role="body-sm" muted aria-live="polite">{copied === "no" ? "Copying didn't work here. Select the lines and copy them yourself." : ""}</Text>
    </div>
  );
}

/**
 * "Run it in Terminal": after a failed install, the exact lines to finish it by hand (built in main from known
 * commands and folders, never from the installer's output), each with Copy. Permission problems add the fixes.
 */
export function TerminalFallback({ fix }: { fix: TerminalFix }) {
  return (
    <div className="tinstall__brew tinstall__terminal" role="group" aria-label="Run it in Terminal">
      <Text role="body-sm">
        You can run it yourself instead: open Terminal (in Applications › Utilities, or search Spotlight for Terminal), paste the lines, press Return, and wait for it to finish.
      </Text>
      {fix.options.map((o) => <Option key={o.title} o={o} />)}
    </div>
  );
}
