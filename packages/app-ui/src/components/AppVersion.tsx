import { useState } from "react";
import { RELEASES_URL, type UpdateView } from "@careeros/contract";
import { Button, Checkbox, Dialog, PRODUCT_NAME, Text } from "@careeros/brand";
import { useAction, useBridge, useLoad } from "../bridge-context";
import { ExternalLink } from "./ExternalLink";
import { Markdown } from "./Markdown";

/** Shown in About: marks identify services only. */
export const TRADEMARKS_NOTE = "Gmail, Google Chrome, Claude, Anthropic, LinkedIn, SEEK and other names and logos are trademarks of their owners. They appear only to show which service something comes from.";

/**
 * "v0.1.0" at the foot of the sidebar (beside Show me around), with a dot once an update has downloaded. Opens the
 * About dialog: the version, the update status (check, progress, Restart to update, what's new), the automatic
 * checks setting and the trademarks note. Updates come from main (app.updates.*), which pushes "updates" as they move.
 */
export function AppVersion() {
  const info = useLoad((b) => b.app.info(), [], []);
  const updates = useLoad((b) => b.app.updates.state(), [], ["updates"]);
  const [open, setOpen] = useState(false);
  const bridge = useBridge();
  const { busy, run } = useAction();
  const v = info.data?.version;
  if (!v) return null;
  const full = `${PRODUCT_NAME} version ${v}`;
  const u = updates.data;
  const ready = u?.status.kind === "ready" ? u.status : null;
  const restart = () => void run("update-install", () => bridge.app.updates.install());
  return (
    <>
      <button type="button" className={ready ? "app-version has-update" : "app-version"}
        aria-label={ready ? `${full}. Update ready: version ${ready.version}. About ${PRODUCT_NAME}` : `${full}. About ${PRODUCT_NAME}`}
        data-tip={ready ? `Update ready · version ${ready.version}` : `About ${PRODUCT_NAME} · version ${v}`} data-hint={`About ${PRODUCT_NAME}`} onClick={() => setOpen(true)}>
        v{v}{ready ? <span className="app-version__dot" aria-hidden="true" /> : null}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`About ${PRODUCT_NAME}`}
        actions={<>
          <Button variant={ready ? "secondary" : "primary"} onClick={() => setOpen(false)}>{ready ? "Later" : "Close"}</Button>
          {ready ? <Button onClick={restart} disabled={busy === "update-install"} aria-label="Restart to update">Restart</Button> : null}
        </>}>
        <Text role="body">{full}</Text>
        {u ? <UpdatePanel view={u} /> : null}
        <Text role="body-sm" muted>{TRADEMARKS_NOTE}</Text>
      </Dialog>
    </>
  );
}

/** One plain line for where the update is. */
export function updateLine(u: UpdateView): string {
  const s = u.status;
  if (!u.supported) return "This copy can't update itself. Updates install themselves in the app downloaded from GitHub.";
  switch (s.kind) {
    case "checking": return "Checking for updates…";
    case "available": return `Version ${s.version} is available. Downloading it now…`;
    case "downloading": return `Downloading version ${s.version || "update"}… ${s.percent}%`;
    case "ready": return `Version ${s.version} is ready. Restart ${PRODUCT_NAME} to finish updating. It opens again by itself.`;
    case "none": return "You have the newest version.";
    case "error": return s.message;
    default: return u.auto ? "Checks for updates automatically." : "Automatic checks are off.";
  }
}

function UpdatePanel({ view: u }: { view: UpdateView }) {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const s = u.status;
  const working = s.kind === "checking" || s.kind === "available" || s.kind === "downloading";
  return (
    <section className="about-update" aria-label="Updates">
      <Text role="body-sm" className="about-update__line" aria-live="polite">{updateLine(u)}</Text>
      {s.kind === "downloading"
        ? <progress className="about-update__bar" max={100} value={s.percent} aria-label="Update download progress" />
        : null}
      {s.kind === "ready" && s.notes ? (
        <div className="about-update__notes">
          <Text role="label">What's new in {s.version}</Text>
          <Markdown text={s.notes} plain />
        </div>
      ) : null}
      {!u.supported || s.kind === "error"
        ? <ExternalLink href={RELEASES_URL}>Download from GitHub</ExternalLink>
        : null}
      {u.supported ? (
        <div className="about-update__row">
          {s.kind !== "ready" ? (
            <Button variant="secondary" disabled={working || busy === "update-check"} aria-label="Check for updates" onClick={() => void run("update-check", () => bridge.app.updates.check())}>
              {s.kind === "checking" || busy === "update-check" ? "Checking…" : "Check now"}
            </Button>
          ) : null}
          <Checkbox label="Check for updates automatically" checked={u.auto} disabled={busy === "update-auto"}
            onChange={(e) => void run("update-auto", () => bridge.app.updates.setAuto(e.currentTarget.checked))} />
        </div>
      ) : null}
    </section>
  );
}
