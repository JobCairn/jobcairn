import { Button, PRODUCT_NAME, Text } from "@careeros/brand";
import type { ClaudeEngineState } from "@careeros/contract";
import { useAction, useBridge } from "../bridge-context";
import { useClaudeEngine } from "./useClaudeRun";

/** Words for Settings › Claude: the workspace checklist and auto mode. Plain, short, no jargon. */
export const WORKSPACE_COPY = {
  ready: "Claude ready", skills: "Skills installed", browser: "Browser helper ready",
  needsRepair: "Some of Claude's setup for this project is missing or out of date.",
  repair: "Repair",
  autoOn: "Auto mode: on for this project",
  autoOff: "Auto mode: off for this project",
  autoWhat: `Claude can read and write files in this project without asking. Locked folders, your settings and secrets stay off limits.`,
  autoOffWhat: `Claude can only read this project and write the files each task names.`,
  split: `Searches in your Chrome always use a fixed list of allowed steps: ${PRODUCT_NAME}'s browser command, the task's files, nothing else.`,
} as const;

function Item({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="cws__item" data-ok={ok}>
      <span aria-hidden="true">{ok ? "✓" : "!"}</span>
      <Text role="body-sm" as="span">{label}<span className="sr-only">{ok ? " (done)" : " (needs repair)"}</span></Text>
    </li>
  );
}

/** Settings › Claude, always in view: this project's Claude setup and auto mode, once the notice is agreed. */
export function ClaudeProjectSettings() {
  const engine = useClaudeEngine();
  const e = engine.data;
  if (!e || !e.consent.given) return null;
  return <ClaudeWorkspace e={e} onChange={() => engine.reload()} />;
}

/** Settings › Claude: the project's Claude setup (with Repair) and the auto mode switch. Shown once consent is given. */
export function ClaudeWorkspace({ e, onChange }: { e: ClaudeEngineState; onChange(): void }) {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const w = e.workspace;
  if (!w) return null;
  const skills = e.plugin.found && w.claude_md && w.plugin;
  const repair = () => void run("repair", async () => { await bridge.claude.repair(); onChange(); }, "Claude's setup for this project is repaired.");
  const toggle = () => void run("auto-mode", async () => { await bridge.claude.setAutoMode(!w.auto_mode); onChange(); },
    w.auto_mode ? "Auto mode is off for this project." : "Auto mode is on for this project.");
  return (
    <section className="cws stack" aria-label="Claude in this project">
      <ul className="cws__list" aria-label="Claude setup for this project">
        <Item ok={e.ready} label={WORKSPACE_COPY.ready} />
        <Item ok={skills} label={WORKSPACE_COPY.skills} />
        <Item ok={w.browser_command && w.settings} label={WORKSPACE_COPY.browser} />
      </ul>
      {!w.current ? (
        <div className="csetup__row">
          <Text role="body-sm">{WORKSPACE_COPY.needsRepair}</Text>
          <Button size="sm" variant="secondary" loading={busy === "repair"} onClick={repair}>{WORKSPACE_COPY.repair}</Button>
        </div>
      ) : null}
      <div className="cws__auto">
        <div className="stack">
          <Text role="body" className="t-strong" id="claude-auto-label">{w.auto_mode ? WORKSPACE_COPY.autoOn : WORKSPACE_COPY.autoOff}</Text>
          <Text role="body-sm" muted id="claude-auto-help">{w.auto_mode ? WORKSPACE_COPY.autoWhat : WORKSPACE_COPY.autoOffWhat} {WORKSPACE_COPY.split}</Text>
        </div>
        <button type="button" role="switch" className="switch" aria-checked={w.auto_mode} aria-labelledby="claude-auto-label" aria-describedby="claude-auto-help"
          disabled={busy === "auto-mode"} onClick={toggle} />
      </div>
    </section>
  );
}
