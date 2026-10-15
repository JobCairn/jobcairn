import { PRODUCT_NAME, Text } from "@careeros/brand";
import { useAction, useBridge, useLoad } from "../bridge-context";
import "./guide.css";

/** Settings row: bring the first-run checklists (Set up, then Getting started) back after they were hidden (or hide it). */
export function GuideSetting() {
  const bridge = useBridge();
  const st = useLoad((b) => b.guide.state(), [], ["home", "learn"]);
  const { busy, run } = useAction();
  if (!st.data) return null;
  const shown = !st.data.dismissed;
  const toggle = () => void run("guide-setting", () => bridge.guide.setDismissed(shown).then(() => st.reload()),
    shown ? "Getting started is hidden." : "Getting started is back on Home.");
  return (
    <div className="row row--between guide-setting">
      <div className="stack">
        <Text role="body" className="t-strong" id="guide-setting-label">Show getting started</Text>
        <Text role="body-sm" muted>The Set up {PRODUCT_NAME} and first-week checklists on Home. Each hides itself once every step is done.</Text>
      </div>
      <button type="button" role="switch" className="switch" aria-checked={shown} aria-labelledby="guide-setting-label"
        disabled={busy === "guide-setting"} onClick={toggle} />
    </div>
  );
}
